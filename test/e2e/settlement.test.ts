import { expect, describe, it, beforeEach } from "vitest";
import {
    Wallet,
    EsploraProvider,
    SingleKey,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../../src";
import { RestDelegatorProvider } from "../../src/providers/delegator";
import { beforeEachFaucet, execCommand, waitFor } from "./utils";

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
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should auto-sweep a single expired boarding UTXO",
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
                boardingTimelock: { type: "blocks", value: 5n },
                settlementConfig: {
                    boardingUtxoSweep: true,
                    // Use long poll interval — we don't want auto-settle to
                    // grab the UTXO before we expire it.
                    pollIntervalMs: 120_000,
                },
            });

            const boardingAddress = await wallet.getBoardingAddress();
            execCommand(`nigiri faucet ${boardingAddress} 0.001`);

            await waitFor(
                async () => (await wallet.getBoardingUtxos()).length > 0
            );

            const boardingUtxos = await wallet.getBoardingUtxos();
            expect(boardingUtxos).toHaveLength(1);
            const initialTxid = boardingUtxos[0].txid;

            // Mine enough blocks to expire the boarding timelock
            execCommand("nigiri rpc --generate 6");

            // Now use the wallet's VtxoManager to verify and trigger sweep
            const manager = await wallet.getVtxoManager();
            await waitFor(async () => {
                const expired = await manager.getExpiredBoardingUtxos();
                return expired.length > 0;
            });

            const sweepTxid = await manager.sweepExpiredBoardingUtxos();
            expect(sweepTxid).toHaveLength(64);

            execCommand("nigiri rpc --generate 1");

            await waitFor(async () => {
                const utxos = await wallet.getBoardingUtxos();
                return utxos.some((u) => u.txid === sweepTxid);
            });

            const newUtxos = await wallet.getBoardingUtxos();
            // Swept UTXO should be a different txid (fresh boarding address)
            expect(newUtxos.some((u) => u.txid !== initialTxid)).toBe(true);
            // No more expired UTXOs after sweep
            expect(await manager.getExpiredBoardingUtxos()).toHaveLength(0);

            await wallet.dispose();
        }
    );

    it(
        "should batch-sweep multiple expired boarding UTXOs",
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
                boardingTimelock: { type: "blocks", value: 5n },
                settlementConfig: {
                    boardingUtxoSweep: true,
                    pollIntervalMs: 120_000,
                },
            });

            const boardingAddress = await wallet.getBoardingAddress();

            // Fund twice to create two separate boarding UTXOs
            execCommand(`nigiri faucet ${boardingAddress} 0.001`);
            execCommand(`nigiri faucet ${boardingAddress} 0.002`);

            await waitFor(
                async () => (await wallet.getBoardingUtxos()).length >= 2
            );

            const boardingUtxos = await wallet.getBoardingUtxos();
            expect(boardingUtxos.length).toBeGreaterThanOrEqual(2);
            const totalInitialValue = boardingUtxos.reduce(
                (sum, u) => sum + u.value,
                0
            );

            // Mine to expire all boarding UTXOs
            execCommand("nigiri rpc --generate 6");

            const manager = await wallet.getVtxoManager();
            await waitFor(async () => {
                const expired = await manager.getExpiredBoardingUtxos();
                return expired.length >= 2;
            });

            // A single sweep should batch all expired UTXOs into one tx
            const sweepTxid = await manager.sweepExpiredBoardingUtxos();
            expect(sweepTxid).toHaveLength(64);

            execCommand("nigiri rpc --generate 1");

            await waitFor(async () => {
                const utxos = await wallet.getBoardingUtxos();
                return utxos.some((u) => u.txid === sweepTxid);
            });

            // Should produce a single output (batched)
            const newUtxos = await wallet.getBoardingUtxos();
            const sweepOutput = newUtxos.filter((u) => u.txid === sweepTxid);
            expect(sweepOutput).toHaveLength(1);

            // Total value should be less (fees) but reasonable
            expect(sweepOutput[0].value).toBeLessThan(totalInitialValue);
            expect(sweepOutput[0].value).toBeGreaterThan(330);

            expect(await manager.getExpiredBoardingUtxos()).toHaveLength(0);

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
                    // Long poll interval to avoid auto-settle interference
                    pollIntervalMs: 120_000,
                },
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
                settlementConfig: {
                    // Long poll interval to avoid auto-settle interference
                    pollIntervalMs: 120_000,
                },
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
                    "http://localhost:7002"
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
