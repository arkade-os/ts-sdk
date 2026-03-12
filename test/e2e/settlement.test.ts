import { expect, describe, it, beforeEach } from "vitest";
import {
    Wallet,
    EsploraProvider,
    SingleKey,
    VtxoManager,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../../src";
import { RestDelegatorProvider } from "../../src/providers/delegator";
import {
    beforeEachFaucet,
    execCommand,
    faucetOffchain,
    waitFor,
} from "./utils";

describe("Settlement - Boarding UTXO Sweep", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should sweep a single expired boarding UTXO",
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
                },
            });

            const boardingAddress = await wallet.getBoardingAddress();
            expect(boardingAddress).toBeDefined();

            // Fund the boarding address
            execCommand(`nigiri faucet ${boardingAddress} 0.001`);

            await waitFor(
                async () => (await wallet.getBoardingUtxos()).length > 0
            );

            const boardingUtxos = await wallet.getBoardingUtxos();
            expect(boardingUtxos).toHaveLength(1);
            const initialValue = boardingUtxos.reduce(
                (sum, u) => sum + u.value,
                0
            );

            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: true,
            });
            expect(await manager.getExpiredBoardingUtxos()).toHaveLength(0);

            // Mine enough blocks to expire the boarding timelock
            execCommand("nigiri rpc --generate 6");

            await waitFor(async () => {
                const expired = await manager.getExpiredBoardingUtxos();
                return expired.length > 0;
            });

            const expiredAfter = await manager.getExpiredBoardingUtxos();
            expect(expiredAfter).toHaveLength(1);

            // Sweep
            const sweepTxid = await manager.sweepExpiredBoardingUtxos();
            expect(sweepTxid).toHaveLength(64);

            execCommand("nigiri rpc --generate 1");

            await waitFor(async () => {
                const utxos = await wallet.getBoardingUtxos();
                return utxos.some((u) => u.txid === sweepTxid);
            });

            const newUtxos = await wallet.getBoardingUtxos();
            const newValue = newUtxos.reduce((sum, u) => sum + u.value, 0);
            expect(newValue).toBeLessThan(initialValue);
            expect(newValue).toBeGreaterThan(330);

            // No more expired UTXOs after sweep (timelock restarted)
            expect(await manager.getExpiredBoardingUtxos()).toHaveLength(0);
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

            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: true,
            });

            // Mine to expire all boarding UTXOs
            execCommand("nigiri rpc --generate 6");

            await waitFor(async () => {
                const expired = await manager.getExpiredBoardingUtxos();
                return expired.length >= 2;
            });

            const expired = await manager.getExpiredBoardingUtxos();
            expect(expired.length).toBeGreaterThanOrEqual(2);

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

            // Total value should be less than initial but reasonable
            const newValue = sweepOutput[0].value;
            expect(newValue).toBeLessThan(totalInitialValue);
            expect(newValue).toBeGreaterThan(330);

            expect(await manager.getExpiredBoardingUtxos()).toHaveLength(0);
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

            // VtxoManager should now see recoverable balance
            const manager = new VtxoManager(wallet, undefined, {
                vtxoThreshold: 259200,
            });

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
            // The recovered VTXO should have a new txid
            expect(vtxosAfter[0].txid).not.toBe(originalTxid);

            await manager.dispose();
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

            // renewVtxos should pick up swept VTXOs (via isRecoverable/isExpired filters)
            const manager = new VtxoManager(wallet, undefined, {
                vtxoThreshold: 259200,
            });

            const renewTxid = await manager.renewVtxos();
            expect(renewTxid).toHaveLength(64);

            await new Promise((resolve) => setTimeout(resolve, 2000));
            const vtxosAfter = await wallet.getVtxos();
            expect(vtxosAfter.length).toBeGreaterThan(0);
            expect(vtxosAfter[0].txid).not.toBe(originalTxid);

            await manager.dispose();
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

            // Create wallet with BOTH settlement enabled AND delegator configured.
            // When a vtxo_received event fires, initializeSubscription will call
            // delegatorManager.delegate(event.vtxos, destination).
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
            });

            const address = await wallet.getAddress();
            expect(address).toBeDefined();

            // Onboard: fund boarding and settle to create a VTXO
            const boardingAddress = await wallet.getBoardingAddress();
            execCommand(`nigiri faucet ${boardingAddress} 0.001`);
            await new Promise((resolve) => setTimeout(resolve, 5000));

            const boardingInputs = await wallet.getBoardingUtxos();
            expect(boardingInputs.length).toBeGreaterThanOrEqual(1);

            // Settle creates a VTXO and triggers a vtxo_received event.
            // The VtxoManager subscription should auto-delegate this VTXO.
            await wallet.settle({
                inputs: boardingInputs,
                outputs: [
                    {
                        address: address!,
                        amount: BigInt(100_000),
                    },
                ],
            });

            // Wait for the initial VTXO to appear
            await waitFor(async () => {
                const v = await wallet.getVtxos();
                return v.length > 0;
            });

            const vtxosBefore = await wallet.getVtxos();
            expect(vtxosBefore).toHaveLength(1);
            const originalTxid = vtxosBefore[0].txid;
            const originalValue = vtxosBefore[0].value;

            // Wait for the delegator to renew the VTXO (auto-delegation triggered
            // by vtxo_received event in initializeSubscription).
            // The delegator has 0 fee, so value should be preserved.
            // The delegation + round finalization may take up to ~30s.
            await waitFor(
                async () => {
                    const v = await wallet.getVtxos();
                    return (
                        v.length > 0 && v.some((c) => c.txid !== originalTxid)
                    );
                },
                { timeout: 60000, interval: 2000 }
            );

            const vtxosAfter = await wallet.getVtxos();
            expect(vtxosAfter.length).toBeGreaterThanOrEqual(1);

            // The VTXO txid should have changed (delegator renewed it)
            const delegatedVtxo = vtxosAfter.find(
                (v) => v.txid !== originalTxid
            );
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

            // VtxoManager should be initialized with settlement enabled (default)
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
        "should report no expiring VTXOs for freshly received funds",
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

            const address = await wallet.getAddress();

            faucetOffchain(address, 5000);
            await new Promise((resolve) => setTimeout(resolve, 1000));

            const vtxos = await wallet.getVtxos();
            expect(vtxos.length).toBeGreaterThan(0);

            // Fresh VTXOs should not be expiring
            const manager = new VtxoManager(wallet, undefined, {
                vtxoThreshold: 259200,
            });
            const expiring = await manager.getExpiringVtxos();
            expect(expiring).toHaveLength(0);

            // Recoverable balance should be zero
            const balance = await manager.getRecoverableBalance();
            expect(balance.recoverable).toBe(0n);
            expect(balance.vtxoCount).toBe(0);

            // renewVtxos should throw since nothing is expiring
            await expect(manager.renewVtxos()).rejects.toThrow(
                "No VTXOs available to renew"
            );

            await manager.dispose();
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
