import { describe, it, expect, beforeEach } from "vitest";
import { hex, base64 } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    TEST_PRIVKEYS,
    createVirtualTx,
    signVirtualTx,
    fakeCommitmentTxid,
    makeP2TRScript,
    MockIndexerProvider,
    MockOnchainProvider,
} from "./vtxoDAGVerification.test.js";
import { VerificationStorageProvider, ChainTxType } from "../../src/tree/vtxoDAGVerification.js";
import {
    onReceiveVtxo,
    getBroadcastSequence,
    persistVtxoForExit,
    extractExitSequence,
    executeSovereignExit,
} from "../../src/storage/sovereignStorage.js";
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
    let masterKey: Uint8Array;

    beforeEach(async () => {
        indexer = new MockIndexerProvider();
        onchain = new MockOnchainProvider();
        storage = new MockStorageProvider();

        const salt = new Uint8Array(16).fill(0xaa);
        masterKey = WalletAuthenticator.deriveMasterKey("test-password-123", salt);
    });

    it("should successfully extract and store an exit sequence from a valid DAG", async () => {
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

        const outpoint = { txid: vtxoTx.txid, vout: 0 };

        const result = await onReceiveVtxo(outpoint, indexer, onchain, storage, masterKey);
        if (!result.success) console.error("Test 1 error:", result.error);
        expect(result.success).toBe(true);
        expect(result.diagnostics).toContain(
            ` Local sovereign exit data secured for ${vtxoTx.txid}`,
        );

        const broadcastSequence = await getBroadcastSequence(vtxoTx.txid, storage, masterKey);

        // With a 1-node DAG, the extracted path has exactly 1 tx
        expect(broadcastSequence).toHaveLength(1);
        expect(broadcastSequence[0]).toBe(hex.encode(vtxoTx.tx.toBytes()));
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
            masterKey,
        );

        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();

        const stored = await storage.getItem(`arkade_exit_data_${vtxoTx.txid}`);
        expect(stored).toBeNull();
    });

    it("should independently execute a sovereign exit natively using the local Bitcoin node", async () => {
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

        // Stage 1: The user initially receives the Vtxo while online, natively storing it.
        await onReceiveVtxo({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain, storage, masterKey);

        // Stage 2: Simulating ASP crash entirely. No indexer queries made here.
        const result = await executeSovereignExit(vtxoTx.txid, storage, onchain, masterKey);

        expect(result.success).toBe(true);
        expect(result.broadcastedTxids).toHaveLength(1);

        // Verify OnchainProvider natively received the transaction payload
        expect(onchain.broadcastedTxs).toHaveLength(1);
        expect(onchain.broadcastedTxs[0]).toBe(hex.encode(vtxoTx.tx.toBytes()));
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
            masterKey,
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

    it("should fail executeSovereignExit when broadcast fails with bad-txns-inputs-spent", async () => {
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

        await onReceiveVtxo({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain, storage, masterKey);

        // Mock onchain broadcast to throw bad-txns-inputs-spent (e.g. input already spent)
        onchain.broadcastTransaction = vi
            .fn()
            .mockRejectedValue(new Error("bad-txns-inputs-spent"));

        const result = await executeSovereignExit(vtxoTx.txid, storage, onchain, masterKey);
        expect(result.success).toBe(false);
        expect(result.error).toContain("bad-txns-inputs-spent");
        expect(result.broadcastedTxids).toHaveLength(0);
    });
});
