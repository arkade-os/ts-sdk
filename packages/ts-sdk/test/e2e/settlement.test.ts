import { expect, describe, it, beforeEach } from "vitest";
import {
    Wallet,
    EsploraProvider,
    SingleKey,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../../src";
import { RestDelegatorProvider } from "../../src/providers/delegator";
import { arkdExec, beforeEachFaucet, execCommand, waitFor } from "./utils";

describe("Settlement - Auto-settle boarding UTXOs", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should auto-settle new boarding UTXOs into Ark",
        { timeout: 120000 },
        async () => {
            const identity = SingleKey.fromRandomBytes();

            // Settlement enabled with fast polling so the auto-settle triggers quickly
            const wallet = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
                settlementConfig: {
                    pollIntervalMs: 5000,
                },
            });

            const boardingAddress = await wallet.getBoardingAddress();
            execCommand(`nigiri faucet ${boardingAddress} 0.001`);

            // Wait for boarding UTXOs to appear
            await waitFor(
                async () => (await wallet.getBoardingUtxos()).length > 0
            );

            // The poll loop should auto-settle the boarding UTXO into Ark.
            // Wait for a VTXO to appear (meaning settle succeeded).
            await waitFor(
                async () => {
                    const vtxos = await wallet.getVtxos();
                    return vtxos.length > 0;
                },
                { timeout: 60000, interval: 2000 }
            );

            const vtxos = await wallet.getVtxos();
            expect(vtxos.length).toBeGreaterThan(0);
            expect(vtxos[0].virtualStatus.state).toBe("settled");

            await wallet.dispose();
        }
    );
});

describe("Settlement - Auto-sweep expired boarding UTXOs", () => {
    beforeEach(beforeEachFaucet, 60000);

    it(
        "should auto-sweep an expired boarding UTXO via poll loop",
        { timeout: 120000 },
        async () => {
            const identity = SingleKey.fromRandomBytes();

            // Get boarding address first with settlement disabled,
            // fund and expire UTXOs before creating the real wallet.
            // This ensures the poll loop sees already-expired UTXOs.
            const setupWallet = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                settlementConfig: false,
                boardingTimelock: { type: "blocks", value: 20n },
            });

            const boardingAddress = await setupWallet.getBoardingAddress();
            execCommand(`nigiri faucet ${boardingAddress} 0.001`);

            await waitFor(
                async () => (await setupWallet.getBoardingUtxos()).length > 0
            );

            const initialUtxos = await setupWallet.getBoardingUtxos();
            expect(initialUtxos).toHaveLength(1);
            const initialTxid = initialUtxos[0].txid;

            // Mine to expire the boarding UTXO
            execCommand("nigiri rpc --generate 21");

            // Wait for esplora to index the new blocks so the chain tip
            // is consistent when the wallet's poll loop starts.
            const esplora = new EsploraProvider("http://localhost:3000", {
                forcePolling: true,
                pollingInterval: 2000,
            });
            const expectedHeight = initialUtxos[0].status.block_height! + 21;
            await waitFor(
                async () => {
                    const tip = await esplora.getChainTip();
                    return tip.height >= expectedHeight;
                },
                { timeout: 30000, interval: 1000 }
            );

            await setupWallet.dispose();

            // Now create the real wallet with settlement + sweep enabled.
            // The poll loop should detect the expired UTXO and auto-sweep it.
            const wallet = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                boardingTimelock: { type: "blocks", value: 20n },
                settlementConfig: {
                    boardingUtxoSweep: true,
                    pollIntervalMs: 5000,
                },
            });

            // Wait for the sweep to happen automatically — the boarding UTXO
            // txid should change as it gets swept to a fresh boarding address.
            // Mine a block each iteration so the sweep tx confirms and the new
            // UTXO appears in esplora's confirmed UTXO set.
            await waitFor(
                async () => {
                    execCommand("nigiri rpc --generate 1");
                    const utxos = await wallet.getBoardingUtxos();
                    const hasUtxos = utxos.length > 0;
                    const hasDifferentUtxos = utxos.every(
                        (u) => u.txid !== initialTxid
                    );
                    return hasUtxos && hasDifferentUtxos;
                },
                { timeout: 60000, interval: 5000 }
            );

            const sweptUtxos = await wallet.getBoardingUtxos();
            expect(sweptUtxos.length).toBeGreaterThan(0);
            // All UTXOs should have new txids (the sweep output)
            expect(sweptUtxos.every((u) => u.txid !== initialTxid)).toBe(true);

            await wallet.dispose();
        }
    );
});

describe("Settlement - VtxoManager Recovery", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should recover swept VTXOs via recoverVtxos",
        { timeout: 120000 },
        async () => {
            const identity = SingleKey.fromRandomBytes();

            // Settlement disabled to prevent auto-renewal from interfering
            // with the manual recover/renew calls in these tests
            const wallet = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
                settlementConfig: false,
            });

            const address = await wallet.getAddress();
            const boardingAddress = await wallet.getBoardingAddress();

            // Onboard via boarding to create a settled VTXO
            execCommand(`nigiri faucet ${boardingAddress} 0.001`);
            await new Promise((resolve) => setTimeout(resolve, 5000));

            const boardingInputs = await wallet.getBoardingUtxos();
            expect(boardingInputs.length).toBeGreaterThanOrEqual(1);

            await wallet.settle({
                inputs: boardingInputs,
                outputs: [
                    {
                        address: address!,
                        amount: BigInt(100_000),
                    },
                ],
            });

            // Wait for settle to finalize
            await new Promise((resolve) => setTimeout(resolve, 10000));

            const vtxos = await wallet.getVtxos({ withRecoverable: false });
            expect(vtxos).toHaveLength(1);
            const originalTxid = vtxos[0].txid;
            expect(vtxos[0].virtualStatus.state).toBe("settled");

            // Mine 25 blocks to trigger server sweep (VTXO_TREE_EXPIRY=20)
            execCommand("nigiri rpc --generate 25");

            // Wait for VTXO to become swept
            await waitFor(async () => {
                const v = await wallet.getVtxos({ withRecoverable: true });
                return v.some(
                    (c) =>
                        c.txid === originalTxid &&
                        c.virtualStatus.state === "swept"
                );
            });

            // Use the wallet's VtxoManager
            const manager = await wallet.getVtxoManager();

            const balance = await manager.getRecoverableBalance();
            expect(balance.recoverable).toBeGreaterThan(0n);
            expect(balance.vtxoCount).toBeGreaterThan(0);

            // Recover the swept VTXO
            const recoverTxid = await manager.recoverVtxos();
            expect(recoverTxid).toHaveLength(64);

            // After recovery, wallet should have a fresh VTXO
            await new Promise((resolve) => setTimeout(resolve, 2000));
            const vtxosAfter = await wallet.getVtxos();
            expect(vtxosAfter.length).toBeGreaterThan(0);
            expect(vtxosAfter[0].txid).not.toBe(originalTxid);

            await wallet.dispose();
        }
    );

    it(
        "should renew swept VTXOs via renewVtxos",
        { timeout: 120000 },
        async () => {
            const identity = SingleKey.fromRandomBytes();

            const wallet = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
                settlementConfig: false,
            });

            const address = await wallet.getAddress();
            const boardingAddress = await wallet.getBoardingAddress();

            // Create a settled VTXO
            execCommand(`nigiri faucet ${boardingAddress} 0.001`);
            await new Promise((resolve) => setTimeout(resolve, 5000));

            const boardingInputs = await wallet.getBoardingUtxos();
            expect(boardingInputs.length).toBeGreaterThanOrEqual(1);

            await wallet.settle({
                inputs: boardingInputs,
                outputs: [
                    {
                        address: address!,
                        amount: BigInt(100_000),
                    },
                ],
            });

            await new Promise((resolve) => setTimeout(resolve, 10000));

            const vtxos = await wallet.getVtxos({ withRecoverable: false });
            expect(vtxos).toHaveLength(1);
            const originalTxid = vtxos[0].txid;

            // Mine 25 blocks to make VTXO swept (recoverable/expired)
            execCommand("nigiri rpc --generate 25");

            await waitFor(async () => {
                const v = await wallet.getVtxos({ withRecoverable: true });
                return v.some(
                    (c) =>
                        c.txid === originalTxid &&
                        c.virtualStatus.state === "swept"
                );
            });

            // Use the wallet's VtxoManager
            const manager = await wallet.getVtxoManager();

            const renewTxid = await manager.renewVtxos();
            expect(renewTxid).toHaveLength(64);

            await new Promise((resolve) => setTimeout(resolve, 2000));
            const vtxosAfter = await wallet.getVtxos();
            expect(vtxosAfter.length).toBeGreaterThan(0);
            expect(vtxosAfter[0].txid).not.toBe(originalTxid);

            await wallet.dispose();
        }
    );
});

describe("Settlement - Auto-delegation on vtxo_received", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should auto-delegate incoming VTXOs when settlement is enabled with delegator",
        { timeout: 120000 },
        async () => {
            const identity = SingleKey.fromRandomBytes();

            // Create wallet with settlement enabled + delegator configured.
            // The poll loop will auto-settle the boarding UTXO, which triggers
            // vtxo_received → auto-delegate via initializeSubscription.
            const wallet = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
                delegatorProvider: new RestDelegatorProvider(
                    "http://localhost:7012"
                ),
                settlementConfig: {
                    pollIntervalMs: 5000,
                },
            });

            const boardingAddress = await wallet.getBoardingAddress();
            execCommand(`nigiri faucet ${boardingAddress} 0.001`);

            // The flow: poll detects boarding UTXO → auto-settle → vtxo_received
            // → auto-delegate. Wait for a delegated VTXO (txid changes after delegation).
            // First, wait for a VTXO to appear at all.
            await waitFor(
                async () => {
                    const v = await wallet.getVtxos();
                    return v.length > 0;
                },
                { timeout: 60000, interval: 2000 }
            );

            const vtxosBefore = await wallet.getVtxos();
            const firstTxid = vtxosBefore[0].txid;
            const originalValue = vtxosBefore[0].value;

            // Wait for delegation to produce a new VTXO (different txid).
            await waitFor(
                async () => {
                    const v = await wallet.getVtxos();
                    return v.length > 0 && v.some((c) => c.txid !== firstTxid);
                },
                { timeout: 60000, interval: 2000 }
            );

            const vtxosAfter = await wallet.getVtxos();
            const delegatedVtxo = vtxosAfter.find((v) => v.txid !== firstTxid);
            expect(delegatedVtxo).toBeDefined();
            // With zero delegator fee, value should be preserved
            expect(delegatedVtxo!.value).toBe(originalValue);

            await wallet.dispose();
        }
    );
});

describe("Settlement - VtxoManager Lifecycle", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should initialize with settlement enabled and dispose cleanly",
        { timeout: 60000 },
        async () => {
            const identity = SingleKey.fromRandomBytes();

            const wallet = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
            });

            const manager = await wallet.getVtxoManager();
            expect(manager).toBeDefined();
            expect(manager.settlementConfig).not.toBe(false);
            expect(manager.settlementConfig).toEqual(
                expect.objectContaining({
                    vtxoThreshold: expect.any(Number),
                    boardingUtxoSweep: true,
                })
            );

            // Dispose without errors
            await wallet.dispose();
        }
    );

    it(
        "should not subscribe to events when settlement is disabled",
        { timeout: 60000 },
        async () => {
            const identity = SingleKey.fromRandomBytes();

            const wallet = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
                settlementConfig: false,
            });

            const manager = await wallet.getVtxoManager();
            expect(manager.settlementConfig).toBe(false);

            // getExpiringVtxos should return empty when disabled
            const expiring = await manager.getExpiringVtxos();
            expect(expiring).toHaveLength(0);

            // sweepExpiredBoardingUtxos should throw when sweep is disabled
            await expect(manager.sweepExpiredBoardingUtxos()).rejects.toThrow(
                "Boarding UTXO sweep is not enabled in settlementConfig"
            );

            await wallet.dispose();
        }
    );
});

describe("Settlement - VtxoManager concurrent operations", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should send offchain while VtxoManager background activity is running",
        { timeout: 120000 },
        async () => {
            // Wallet A: VtxoManager enabled (SSE subscription + poll loop active)
            const identityA = SingleKey.fromRandomBytes();
            const walletA = await Wallet.create({
                identity: identityA,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
                settlementConfig: {
                    pollIntervalMs: 5000,
                },
            });

            // Wallet B: settlement disabled, used as counterparty
            const identityB = SingleKey.fromRandomBytes();
            const walletB = await Wallet.create({
                identity: identityB,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
                settlementConfig: false,
            });

            const addressB = await walletB.getAddress();

            // Fund wallet A via boarding and let VtxoManager auto-settle it
            const boardingAddress = await walletA.getBoardingAddress();
            execCommand(`nigiri faucet ${boardingAddress} 0.001`);

            // Wait for VtxoManager poll to auto-settle the boarding UTXO
            await waitFor(
                async () => {
                    const vtxos = await walletA.getVtxos();
                    return (
                        vtxos.length > 0 &&
                        vtxos[0].virtualStatus.state === "settled"
                    );
                },
                { timeout: 60000, interval: 2000 }
            );

            const vtxosBefore = await walletA.getVtxos();
            expect(vtxosBefore.length).toBeGreaterThan(0);
            const balanceBefore = vtxosBefore.reduce(
                (sum, v) => sum + v.value,
                0
            );

            // Now send from A to B while VtxoManager's SSE + poll loop are active.
            // This is the race-prone scenario: VtxoManager may try to renewVtxos()
            // in the background at the same time as this user-initiated send().
            const sendAmount = 5000;
            const sendTxid = await walletA.send({
                address: addressB,
                amount: sendAmount,
            });
            expect(sendTxid).toHaveLength(64);

            // Verify wallet B received funds
            await waitFor(
                async () => {
                    const vtxos = await walletB.getVtxos();
                    return vtxos.length > 0;
                },
                { timeout: 15000, interval: 1000 }
            );

            const balanceB = await walletB.getBalance();
            expect(balanceB.total).toBe(sendAmount);

            // Verify wallet A has change
            const balanceA = await walletA.getBalance();
            expect(balanceA.total).toBeLessThan(balanceBefore);
            expect(balanceA.total).toBeGreaterThan(0);

            await walletA.dispose();
            await walletB.dispose();
        }
    );

    it(
        "should receive offchain VTXO and immediately send while VtxoManager reacts to vtxo_received",
        { timeout: 120000 },
        async () => {
            // This test targets the specific race: VtxoManager's SSE subscription
            // fires vtxo_received → background renewVtxos() → settle(), while the
            // user simultaneously calls send() with the same VTXOs.

            const identityA = SingleKey.fromRandomBytes();
            const walletA = await Wallet.create({
                identity: identityA,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
                // VtxoManager enabled with fast polling
                settlementConfig: {
                    pollIntervalMs: 5000,
                },
            });

            const identityB = SingleKey.fromRandomBytes();
            const walletB = await Wallet.create({
                identity: identityB,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
                settlementConfig: false,
            });

            const addressA = await walletA.getAddress();
            const addressB = await walletB.getAddress();

            // Fund wallet A via arkd faucet (creates a preconfirmed VTXO directly)
            const fundAmount = 21_000;
            execCommand(
                `${arkdExec} ark send --to ${addressA} --amount ${fundAmount} --password secret`
            );

            // Wait for VTXO to appear — VtxoManager's SSE subscription should
            // fire vtxo_received around the same time
            await waitFor(
                async () => {
                    const vtxos = await walletA.getVtxos();
                    return vtxos.length > 0;
                },
                { timeout: 15000, interval: 500 }
            );

            // Settle the preconfirmed VTXO so it becomes spendable for send()
            const vtxos = await walletA.getVtxos();
            const settledTxid = await walletA.settle({
                inputs: vtxos,
                outputs: [
                    {
                        address: addressA,
                        amount: BigInt(
                            vtxos.reduce((sum, v) => sum + v.value, 0)
                        ),
                    },
                ],
            });
            expect(settledTxid).toHaveLength(64);

            // Wait for the settled VTXO to appear
            await waitFor(
                async () => {
                    const v = await walletA.getVtxos();
                    return (
                        v.length > 0 &&
                        v.some((c) => c.virtualStatus.state === "settled")
                    );
                },
                { timeout: 15000, interval: 1000 }
            );

            // Now send while VtxoManager is actively running in the background.
            // VtxoManager's SSE subscription may fire vtxo_received for the
            // settle output and try to renewVtxos() concurrently with this send.
            const sendAmount = 5000;
            const sendTxid = await walletA.send({
                address: addressB,
                amount: sendAmount,
            });
            expect(sendTxid).toHaveLength(64);

            // Verify receipt
            await waitFor(
                async () => {
                    const v = await walletB.getVtxos();
                    return v.length > 0;
                },
                { timeout: 15000, interval: 1000 }
            );

            const balanceB = await walletB.getBalance();
            expect(balanceB.total).toBe(sendAmount);

            await walletA.dispose();
            await walletB.dispose();
        }
    );

    it(
        "should handle multiple rapid sends while VtxoManager is active",
        { timeout: 120000 },
        async () => {
            // Stress test: multiple sequential sends while VtxoManager's
            // background poll + SSE are active, to surface race conditions
            // in VTXO selection / double-spend.

            const identityA = SingleKey.fromRandomBytes();
            const walletA = await Wallet.create({
                identity: identityA,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
                settlementConfig: {
                    pollIntervalMs: 5000,
                },
            });

            const identityB = SingleKey.fromRandomBytes();
            const walletB = await Wallet.create({
                identity: identityB,
                arkServerUrl: "http://localhost:7070",
                onchainProvider: new EsploraProvider("http://localhost:3000", {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
                settlementConfig: false,
            });

            const addressB = await walletB.getAddress();

            // Fund via boarding and let VtxoManager auto-settle
            const boardingAddress = await walletA.getBoardingAddress();
            execCommand(`nigiri faucet ${boardingAddress} 0.001`);

            await waitFor(
                async () => {
                    const vtxos = await walletA.getVtxos();
                    return (
                        vtxos.length > 0 &&
                        vtxos[0].virtualStatus.state === "settled"
                    );
                },
                { timeout: 60000, interval: 2000 }
            );

            // Rapid sequential sends while VtxoManager is active
            const sendAmount = 2000;
            for (let i = 0; i < 3; i++) {
                const txid = await walletA.send({
                    address: addressB,
                    amount: sendAmount,
                });
                expect(txid).toHaveLength(64);

                // Small delay between sends to let state propagate
                await new Promise((r) => setTimeout(r, 2000));
            }

            // Wait for all sends to be visible to B
            await waitFor(
                async () => {
                    const balance = await walletB.getBalance();
                    return balance.total >= sendAmount * 3;
                },
                { timeout: 30000, interval: 2000 }
            );

            const balanceB = await walletB.getBalance();
            expect(balanceB.total).toBe(sendAmount * 3);

            await walletA.dispose();
            await walletB.dispose();
        }
    );
});
