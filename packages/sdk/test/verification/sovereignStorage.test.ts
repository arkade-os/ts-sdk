import { describe, it, expect, beforeEach, vi } from "vitest";
import { hex, base64 } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { Transaction } from "../../src/utils/transaction.js";
import {
    TEST_PRIVKEYS,
    createVirtualTx,
    signVirtualTx,
    fakeCommitmentTxid,
    makeP2TRScript,
    MockIndexerProvider,
    MockOnchainProvider,
} from "./vtxoDAGVerification.test.js";
import {
    computeTxid,
    type VerificationOnchainProvider,
    type ExitOnchainProvider,
    type VerificationStorageProvider,
    ChainTxType,
} from "../../src/tree/vtxoDAGVerification.js";
import {
    onReceiveVtxo,
    getBroadcastSequence,
    createSovereignUnrollPackage,
    executeSovereignUnroll,
} from "../../src/storage/sovereignStorage.js";
import type { ExitFeeWallet } from "../../src/wallet/exit/executor.js";
import { WalletAuthenticator } from "../../src/utils/authenticator.js";
import { StorageCrypto } from "../../src/utils/cryptoUtils.js";

class MockStorageProvider implements VerificationStorageProvider {
    private store: Map<string, string> = new Map();

    async setItem(key: string, value: string): Promise<void> {
        this.store.set(key, value);
    }

    async getItem(key: string): Promise<string | null> {
        return this.store.get(key) || null;
    }

    async removeItem(key: string): Promise<void> {
        this.store.delete(key);
    }
}

describe("Tier 3: Sovereign Unilateral Exit Storage", () => {
    let indexer: MockIndexerProvider;
    let onchain: MockOnchainProvider;
    let storage: MockStorageProvider;
    let storageKey: Uint8Array;
    let mockFeeWallet: ExitFeeWallet;

    beforeEach(async () => {
        indexer = new MockIndexerProvider();
        onchain = new MockOnchainProvider();
        onchain.autoConfirmBroadcast = true;
        storage = new MockStorageProvider();

        const salt = new Uint8Array(16).fill(0xaa);
        storageKey = WalletAuthenticator.deriveMasterKey("app-storage-passphrase-123", salt);
        mockFeeWallet = {
            bumpAnchor: vi.fn(
                async (parentHex: string, _feeRate: number): Promise<[string, string]> => [
                    parentHex,
                    `cpfp_child_for_${parentHex.slice(0, 16)}`,
                ],
            ),
        };
    });

    it("should extract and store finalized, witness-bearing raw txs (never witnessless toBytes)", async () => {
        const commitmentRaw = createVirtualTx(fakeCommitmentTxid(3), 0, [
            { amount: 100000n, script: makeP2TRScript(1) },
        ]);
        const commitmentTxid = commitmentRaw.txid;
        onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
        onchain.confirmedTxids.add(commitmentTxid);

        const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
            parentScript: makeP2TRScript(1),
            tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
        });

        signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[1], [
            { script: makeP2TRScript(1), amount: 100000n },
        ]);

        indexer.chain = [
            {
                txid: vtxoTx.txid,
                expiresAt: "2000000000",
                type: ChainTxType.TREE,
                spends: [commitmentTxid],
            },
            {
                txid: commitmentTxid,
                expiresAt: "2000000000",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];
        indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

        const outpoint = { txid: vtxoTx.txid, vout: 0 };

        const result = await onReceiveVtxo(outpoint, indexer, onchain, storage, storageKey);
        if (!result.success) console.error("Test 1 error:", result.error);
        expect(result.success).toBe(true);
        expect(result.diagnostics).toContain(
            ` Local sovereign exit data secured for ${vtxoTx.txid}`,
        );

        const broadcastSequence = await getBroadcastSequence(vtxoTx.txid, storage, storageKey);

        // Must be finalized WITH full SegWit witness data, NOT witnessless tx.toBytes()
        expect(broadcastSequence).toHaveLength(1);
        const witnesslessHex = hex.encode(vtxoTx.tx.toBytes());
        expect(broadcastSequence[0]).not.toBe(witnesslessHex);
        expect(broadcastSequence[0].length).toBeGreaterThan(witnesslessHex.length);

        const reparsed = Transaction.fromRaw(hex.decode(broadcastSequence[0]), {
            allowUnknownOutputs: true,
        });
        expect(computeTxid(reparsed)).toBe(vtxoTx.txid);
        expect(reparsed.getInput(0).finalScriptWitness).toHaveLength(1);
        expect(reparsed.getInput(0).finalScriptWitness![0]).toEqual(
            vtxoTx.tx.getInput(0).tapKeySig,
        );

        // Canonical graph-mode unroll ExitPackage builder rejects witnessless raw txs
        expect(() =>
            createSovereignUnrollPackage(vtxoTx.txid, [witnesslessHex], {
                network: "regtest",
                feeRate: 2,
            }),
        ).toThrow(/missing SegWit witness data/);
    });

    it("should fail gracefully and bubble up errors if DAG validation fails", async () => {
        // Missing from onchain, creating validation fail
        const commitmentTxid = fakeCommitmentTxid(20);
        const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
            parentScript: makeP2TRScript(1),
            tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
        });
        signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[1], [
            { script: makeP2TRScript(1), amount: 100000n },
        ]);

        indexer.chain = [
            {
                txid: vtxoTx.txid,
                expiresAt: "2000000000",
                type: ChainTxType.ARK,
                spends: [commitmentTxid],
            },
            {
                txid: commitmentTxid,
                expiresAt: "2000000000",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];
        indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

        const result = await onReceiveVtxo(
            { txid: vtxoTx.txid, vout: 0 },
            indexer,
            onchain,
            storage,
            storageKey,
        );

        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();

        const stored = await storage.getItem(`arkade_exit_data_${vtxoTx.txid}`);
        expect(stored).toBeNull();
    });

    it("should execute a multi-hop sovereign exit via canonical Executor using 1P1C CPFP packages (never standalone)", async () => {
        const commitmentRaw = createVirtualTx(fakeCommitmentTxid(3), 0, [
            { amount: 100000n, script: makeP2TRScript(1) },
        ]);
        const commitmentTxid = commitmentRaw.txid;
        onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
        onchain.confirmedTxids.add(commitmentTxid);

        const hop1 = createVirtualTx(
            commitmentTxid,
            0,
            [{ amount: 100000n, script: makeP2TRScript(2) }],
            {
                parentScript: makeP2TRScript(1),
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
            },
        );
        signVirtualTx(hop1.tx, 0, TEST_PRIVKEYS[1], [
            { script: makeP2TRScript(1), amount: 100000n },
        ]);

        const hop2 = createVirtualTx(hop1.txid, 0, [{ amount: 100000n }], {
            parentScript: makeP2TRScript(2),
            tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[2]),
        });
        signVirtualTx(hop2.tx, 0, TEST_PRIVKEYS[2], [
            { script: makeP2TRScript(2), amount: 100000n },
        ]);

        indexer.chain = [
            {
                txid: hop2.txid,
                expiresAt: "2000000000",
                type: ChainTxType.TREE,
                spends: [hop1.txid],
            },
            {
                txid: hop1.txid,
                expiresAt: "2000000000",
                type: ChainTxType.TREE,
                spends: [commitmentTxid],
            },
            {
                txid: commitmentTxid,
                expiresAt: "2000000000",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];
        indexer.virtualTxs.set(hop1.txid, base64.encode(hop1.tx.toPSBT()));
        indexer.virtualTxs.set(hop2.txid, base64.encode(hop2.tx.toPSBT()));

        // Stage 1: Persist while online
        const received = await onReceiveVtxo(
            { txid: hop2.txid, vout: 0 },
            indexer,
            onchain,
            storage,
            storageKey,
        );
        expect(received.success).toBe(true);

        // Stage 2: Execute exit offline from ASP via canonical Executor (1P1C packages)
        const result = await executeSovereignUnroll(hop2.txid, storage, onchain, storageKey, {
            network: "regtest",
            feeRate: 2,
            feeWallet: mockFeeWallet,
            pollIntervalMs: 1,
        });

        expect(result.success).toBe(true);
        expect(result.swept).toBe(false);
        expect(result.broadcastedTxids).toEqual([hop1.txid, hop2.txid]);
        expect(result.confirmedTxids).toEqual([hop1.txid, hop2.txid]);

        // Every broadcast MUST be a 2-tx 1P1C package [parentHex, childHex], never standalone
        expect(onchain.broadcastedPackages).toHaveLength(2);
        for (const pkg of onchain.broadcastedPackages) {
            expect(pkg).toHaveLength(2);
            const parsedParent = Transaction.fromRaw(hex.decode(pkg[0]), {
                allowUnknownOutputs: true,
            });
            expect(parsedParent.getInput(0).finalScriptWitness?.length).toBeGreaterThan(0);
        }
        expect(mockFeeWallet.bumpAnchor).toHaveBeenCalledTimes(2);
    });

    it("should ensure data is encrypted in repose (Forensics Protection)", async () => {
        // 1. Setup a valid receipt
        const commitmentRaw = createVirtualTx(
            "0000000000000000000000000000000000000000000000000000000000000001",
            0,
            [{ amount: 100000n, script: makeP2TRScript(1) }],
        );
        const commitmentTxid = commitmentRaw.txid;
        onchain.confirmedTxids.add(commitmentTxid);
        onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));

        const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
            parentScript: makeP2TRScript(1),
            tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
        });

        indexer.chain = [
            {
                txid: vtxoTx.txid,
                expiresAt: "2000000000",
                type: ChainTxType.ARK,
                spends: [commitmentTxid],
            },
            {
                txid: commitmentTxid,
                expiresAt: "2000000000",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];

        // Sign the transaction so it passes verification
        signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[1], [
            { script: makeP2TRScript(1), amount: 100000n },
        ]);
        indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

        // 2. Persist natively
        const result = await onReceiveVtxo(
            { txid: vtxoTx.txid, vout: 0 },
            indexer,
            onchain,
            storage,
            storageKey,
        );
        expect(result.success, `onReceiveVtxo failed: ${result.error}`).toBe(true);

        // 3. Inspect raw storage
        const rawSaved = await storage.getItem(`arkade_exit_data_${vtxoTx.txid}`);

        // The data must NOT be readable JSON, it must be a Base64-encoded binary (encrypted)
        expect(rawSaved).not.toBeNull();
        expect(() => JSON.parse(rawSaved!)).toThrow(); // Should fail parsing because it's encrypted
    });

    it("should reject invalid key lengths in StorageCrypto encrypt and decrypt", async () => {
        const shortKey = new Uint8Array(16);
        const longKey = new Uint8Array(64);
        const validKey = new Uint8Array(32);

        await expect(StorageCrypto.encrypt("test", shortKey)).rejects.toThrow(
            "Invalid key length: AES-256 requires a 32-byte key",
        );
        await expect(StorageCrypto.encrypt("test", longKey)).rejects.toThrow(
            "Invalid key length: AES-256 requires a 32-byte key",
        );

        const ciphertext = await StorageCrypto.encrypt("test", validKey);
        await expect(StorageCrypto.decrypt(ciphertext, shortKey)).rejects.toThrow(
            "Invalid key length: AES-256 requires a 32-byte key",
        );
        await expect(StorageCrypto.decrypt(ciphertext, longKey)).rejects.toThrow(
            "Invalid key length: AES-256 requires a 32-byte key",
        );
    });

    it("should fail executeSovereignUnroll when package broadcast fails with bad-txns-inputs-spent", async () => {
        const commitmentRaw = createVirtualTx(fakeCommitmentTxid(4), 0, [
            { amount: 100000n, script: makeP2TRScript(1) },
        ]);
        const commitmentTxid = commitmentRaw.txid;
        onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
        onchain.confirmedTxids.add(commitmentTxid);

        const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
            parentScript: makeP2TRScript(1),
            tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
        });
        signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[1], [
            { script: makeP2TRScript(1), amount: 100000n },
        ]);

        indexer.chain = [
            {
                txid: vtxoTx.txid,
                expiresAt: "2000000000",
                type: ChainTxType.ARK,
                spends: [commitmentTxid],
            },
            {
                txid: commitmentTxid,
                expiresAt: "2000000000",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];
        indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

        await onReceiveVtxo({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain, storage, storageKey);

        // Mock onchain broadcast to throw bad-txns-inputs-spent (e.g. input already spent)
        onchain.broadcastTransaction = vi
            .fn()
            .mockRejectedValue(new Error("bad-txns-inputs-spent"));

        const result = await executeSovereignUnroll(vtxoTx.txid, storage, onchain, storageKey, {
            network: "regtest",
            feeRate: 2,
            feeWallet: mockFeeWallet,
            pollIntervalMs: 1,
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain("bad-txns-inputs-spent");
        expect(result.broadcastedTxids).toHaveLength(0);
    });

    it("should reject a replayed encrypted exit record whose vtxoRootTxid does not match", async () => {
        const commitmentRaw = createVirtualTx(fakeCommitmentTxid(5), 0, [
            { amount: 100000n, script: makeP2TRScript(1) },
        ]);
        const commitmentTxid = commitmentRaw.txid;
        onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
        onchain.confirmedTxids.add(commitmentTxid);

        const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
            parentScript: makeP2TRScript(1),
            tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
        });
        signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[1], [
            { script: makeP2TRScript(1), amount: 100000n },
        ]);

        indexer.chain = [
            {
                txid: vtxoTx.txid,
                expiresAt: "2000000000",
                type: ChainTxType.ARK,
                spends: [commitmentTxid],
            },
            {
                txid: commitmentTxid,
                expiresAt: "2000000000",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];
        indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

        // Persist using a read-only VerificationOnchainProvider (Finding F3)
        const readOnlyOnchain: VerificationOnchainProvider = {
            getRawTransaction: (txid) => onchain.getRawTransaction(txid),
            getTxStatus: (txid) => onchain.getTxStatus(txid),
            getBlockchainInfo: () => onchain.getBlockchainInfo(),
        };
        const receiveRes = await onReceiveVtxo(
            { txid: vtxoTx.txid, vout: 0 },
            indexer,
            readOnlyOnchain,
            storage,
            storageKey,
        );
        expect(receiveRes.success).toBe(true);

        // Replay ciphertext under a different VTXO root key
        const otherVtxoTxid = "f".repeat(64);
        const storedCiphertext = await storage.getItem(`arkade_exit_data_${vtxoTx.txid}`);
        expect(storedCiphertext).not.toBeNull();
        await storage.setItem(`arkade_exit_data_${otherVtxoTxid}`, storedCiphertext!);

        await expect(getBroadcastSequence(otherVtxoTxid, storage, storageKey)).rejects.toThrow(
            /mismatched exit record/,
        );

        // Execute exit using a minimal ExitOnchainProvider (getTxStatus + broadcastTransaction)
        let broadcasted = false;
        const minimalExitProvider: ExitOnchainProvider = {
            getTxStatus: vi.fn(async () => {
                if (!broadcasted) throw new Error("not found");
                return { confirmed: true as const, blockHeight: 101, blockTime: 1700000600 };
            }),
            broadcastTransaction: vi.fn(async (...txHexes: string[]) => {
                expect(txHexes).toHaveLength(2);
                broadcasted = true;
                return vtxoTx.txid;
            }),
        };
        const exitRes = await executeSovereignUnroll(
            vtxoTx.txid,
            storage,
            minimalExitProvider,
            storageKey,
            {
                network: "regtest",
                feeRate: 2,
                feeWallet: mockFeeWallet,
                pollIntervalMs: 1,
            },
        );
        expect(exitRes.success).toBe(true);
        expect(minimalExitProvider.broadcastTransaction).toHaveBeenCalledTimes(1);
    });
});
