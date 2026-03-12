import { expect, describe, it, beforeEach } from "vitest";
import {
    Wallet,
    EsploraProvider,
    SingleKey,
    VtxoManager,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../../src";
import {
    arkdExec,
    beforeEachFaucet,
    execCommand,
    faucetOffchain,
    waitFor,
} from "./utils";

describe("Settlement - Boarding UTXO Sweep", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should sweep expired boarding UTXOs back to boarding address",
        { timeout: 120000 },
        async () => {
            const identity = SingleKey.fromRandomBytes();

            // Create wallet with a very short boarding timelock (5 blocks)
            // and enable boarding UTXO sweep
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

            // Wait for the boarding UTXO to appear
            await waitFor(
                async () => (await wallet.getBoardingUtxos()).length > 0
            );

            const boardingUtxos = await wallet.getBoardingUtxos();
            expect(boardingUtxos.length).toBeGreaterThan(0);
            const initialValue = boardingUtxos.reduce(
                (sum, u) => sum + u.value,
                0
            );

            // VtxoManager should see no expired UTXOs yet
            const manager = new VtxoManager(wallet, undefined, {
                boardingUtxoSweep: true,
            });
            const expiredBefore = await manager.getExpiredBoardingUtxos();
            expect(expiredBefore).toHaveLength(0);

            // Mine enough blocks to expire the boarding timelock (5 blocks)
            execCommand("nigiri rpc --generate 6");

            // Wait for the chain to advance and esplora to index
            await waitFor(async () => {
                const expired = await manager.getExpiredBoardingUtxos();
                return expired.length > 0;
            });

            // Verify expired UTXOs are detected
            const expiredAfter = await manager.getExpiredBoardingUtxos();
            expect(expiredAfter.length).toBeGreaterThan(0);

            // Sweep the expired boarding UTXOs
            const sweepTxid = await manager.sweepExpiredBoardingUtxos();
            expect(sweepTxid).toBeDefined();
            expect(typeof sweepTxid).toBe("string");
            expect(sweepTxid.length).toBe(64); // hex txid

            // Mine a block to confirm the sweep
            execCommand("nigiri rpc --generate 1");

            // Wait for new boarding UTXO to appear (the sweep output)
            await waitFor(async () => {
                const utxos = await wallet.getBoardingUtxos();
                // Should have a new UTXO at the boarding address
                // (the sweep output), different from the original
                return (
                    utxos.length > 0 && utxos.some((u) => u.txid === sweepTxid)
                );
            });

            const newUtxos = await wallet.getBoardingUtxos();
            const newValue = newUtxos.reduce((sum, u) => sum + u.value, 0);

            // New value should be less than initial (fees deducted)
            // but still reasonable (not dust)
            expect(newValue).toBeLessThan(initialValue);
            expect(newValue).toBeGreaterThan(330); // above dust

            // No more expired UTXOs (the sweep restarted the timelock)
            const expiredAfterSweep = await manager.getExpiredBoardingUtxos();
            expect(expiredAfterSweep).toHaveLength(0);
        }
    );
});

describe("Settlement - VtxoManager", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should initialize with settlement enabled and dispose cleanly",
        { timeout: 60000 },
        async () => {
            const identity = SingleKey.fromRandomBytes();

            // Create wallet with settlement enabled (default behavior)
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

            // VtxoManager should be initialized with settlement enabled
            const manager = await wallet.getVtxoManager();
            expect(manager).toBeDefined();
            expect(manager.settlementConfig).not.toBe(false);

            // Dispose cleanly without errors
            await manager.dispose();
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
            expect(address).toBeDefined();

            // Fund with an offchain VTXO
            faucetOffchain(address, 5000);
            await new Promise((resolve) => setTimeout(resolve, 1000));

            const vtxos = await wallet.getVtxos();
            expect(vtxos.length).toBeGreaterThan(0);

            // Fresh VTXOs should not be expiring (they have a long expiry)
            const manager = new VtxoManager(wallet, undefined, {
                vtxoThreshold: 259200,
            });
            const expiring = await manager.getExpiringVtxos();
            expect(expiring).toHaveLength(0);

            // Recoverable balance should be zero for healthy VTXOs
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
});
