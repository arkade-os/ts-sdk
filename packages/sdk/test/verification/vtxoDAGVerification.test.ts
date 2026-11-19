/**
 * ============================================================================
 *  Unit Tests — VTXO DAG Verification (Tier 1 & Tier 2)
 * ============================================================================
 *
 *  Tests the DAG reconstruction and validation logic using mock data
 *  that simulates the structures returned by the Arkade IndexerService.
 * ============================================================================
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { hex, base64 } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { taprootTweakPubkey, taprootTweakPrivKey } from "@scure/btc-signer/utils.js";
import { p2tr, tapLeafHash } from "@scure/btc-signer/payment.js";
import { Script } from "@scure/btc-signer/script.js";
import { Transaction } from "../../src/utils/transaction.js";
import {
    reconstructAndValidateVtxoDAG,
    verifyVtxoComplete,
    ChainTxType,
    type Outpoint,
    type ChainTx,
    type VerificationIndexerProvider,
    type VerificationOnchainProvider,
    type ExitOnchainProvider,
} from "../../src/tree/vtxoDAGVerification.js";
import {
    extractTimelockConstraints,
    validateTimelockConsistency,
    validateTimelockSatisfiability,
    verifyNodeTimelocks,
    resolveScriptNumber,
    type ChainState,
} from "../../src/tree/timelockVerification.js";
import {
    extractHashConditions,
    verifyPreimage,
    verifyNodeHashPreimages,
} from "../../src/tree/hashPreimageVerification.js";
import { verifyNodeSignature } from "../../src/tree/signatureVerification.js";
import { verifyNodeTaproot } from "../../src/tree/taprootVerification.js";
import { extractExitSequence } from "../../src/storage/sovereignStorage.js";
import { BitcoinRpcProvider, BitcoinRpcError } from "../../src/providers/bitcoinRpc.js";
import { ConcurrencyLimiter } from "../../src/utils/performanceUtils.js";
import { DefaultVtxo } from "../../src/script/default.js";
import { CSVMultisigTapscript } from "../../src/script/tapscript.js";
import { SingleKey } from "../../src/identity/singleKey.js";
import { buildOffchainTx } from "../../src/utils/arkTransaction.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { hex as _hex } from "@scure/base";

// ─── Test Helpers ────────────────────────────────────────────────────────────

export const TEST_PRIVKEYS = Array.from({ length: 10 }, (_, i) => {
    const key = new Uint8Array(32);
    key[31] = i + 1;
    return key;
});

export function makeP2TRScript(seed: number = 0, merkleRoot?: Uint8Array): Uint8Array {
    const privKey = TEST_PRIVKEYS[seed % TEST_PRIVKEYS.length];
    const internalKey = schnorr.getPublicKey(privKey);
    const [tweakedKey] = taprootTweakPubkey(internalKey, merkleRoot || new Uint8Array(0));
    const script = new Uint8Array(34);
    script[0] = 0x51;
    script[1] = 0x20;
    script.set(tweakedKey, 2);
    return script;
}

export function fakeCommitmentTxid(seed: number = 0): string {
    return (seed.toString(16) + "a").repeat(64).slice(0, 64);
}

/**
 * Compute a Bitcoin txid from an unsigned Transaction.
 * @scure/btc-signer@1.x throws "Transaction is not finalized" when accessing
 * `.id` on unsigned PSBTs. We calculate it manually:
 * txid = REVERSE(SHA256d(non-witness-serialization)).
 */
export function computeTxid(tx: Transaction): string {
    // toBytes(isExtended=true, isSigned=false) gives the raw non-witness bytes
    const rawBytes = tx.toBytes(true, false);
    const hash1 = sha256(rawBytes);
    const hash2 = sha256(hash1);
    // Bitcoin txid is displayed in little-endian (reversed)
    const reversed = new Uint8Array(hash2);
    reversed.reverse();
    return _hex.encode(reversed);
}

export function createVirtualTx(
    parentTxid: string,
    parentVout: number,
    outputs: { amount: bigint; script?: Uint8Array }[],
    opts?: {
        sequence?: number;
        lockTime?: number;
        tapInternalKey?: Uint8Array;
        parentScript?: Uint8Array;
        tapLeafScript?: any;
        tapMerkleRoot?: Uint8Array;
    },
): { tx: Transaction; psbtB64: string; txid: string } {
    if (parentTxid.length !== 64) {
        throw new Error(`Invalid parentTxid length: ${parentTxid.length}, expected 64`);
    }
    const hexTxid = parentTxid;
    const p2trScript = opts?.parentScript ?? makeP2TRScript(0);
    const tx = new Transaction({
        version: 2,
        allowUnknownOutputs: true,
        lockTime: opts?.lockTime ?? 0,
    });

    tx.addInput({
        txid: hexTxid,
        index: parentVout,
        sequence: opts?.sequence ?? 0xfffffffe,
        witnessUtxo: {
            amount: outputs.reduce((sum, o) => sum + o.amount, 0n),
            script: p2trScript,
        },
        tapInternalKey: opts?.tapInternalKey ?? schnorr.getPublicKey(TEST_PRIVKEYS[0]),
        ...(opts?.tapLeafScript ? { tapLeafScript: opts.tapLeafScript } : {}),
        ...(opts?.tapMerkleRoot ? { tapMerkleRoot: opts.tapMerkleRoot } : {}),
    });

    for (let i = 0; i < outputs.length; i++) {
        const out = outputs[i];
        tx.addOutput({
            amount: out.amount,
            script: out.script ?? makeP2TRScript(i),
        });
    }

    return { tx, psbtB64: base64.encode(tx.toPSBT()), txid: computeTxid(tx) };
}

export function signVirtualTx(
    tx: Transaction,
    inputIndex: number,
    privKey: Uint8Array,
    prevOuts: { script: Uint8Array; amount: bigint }[],
) {
    const scripts = prevOuts.map((o) => o.script);
    const amounts = prevOuts.map((o) => o.amount);
    const sighash = tx.preimageWitnessV1(inputIndex, scripts, 0, amounts);

    const input = tx.getInput(inputIndex);
    const merkleRoot = input.tapMerkleRoot || new Uint8Array(0);
    const tweakedPrivKey = taprootTweakPrivKey(privKey, merkleRoot);

    const sig = schnorr.sign(sighash, tweakedPrivKey);
    tx.updateInput(inputIndex, { tapKeySig: sig });
}

// ─── Mock Providers ──────────────────────────────────────────────────────────

export class MockIndexerProvider {
    public chain: ChainTx[] = [];
    public virtualTxs: Map<string, string> = new Map();

    async getVtxoChain(_outpoint: Outpoint) {
        return { chain: this.chain };
    }

    async getBatchVtxos(_commitmentTxid: string) {
        // In the mock, we assume the provided chain belongs to the requested batch
        return [{ chain: this.chain }];
    }

    async getVirtualTxs(txids: string[]) {
        const txs: string[] = [];
        for (const txid of txids) {
            const psbt = this.virtualTxs.get(txid);
            txs.push(psbt || "");
        }
        return { txs };
    }
}

export class MockOnchainProvider implements VerificationOnchainProvider, ExitOnchainProvider {
    public confirmedTxids = new Set<string>();
    public mempoolTxids = new Set<string>();
    public txs = new Map<string, string>();
    public txHeights = new Map<string, number>();
    public txTimes = new Map<string, number>();
    public chainHeight = 100;
    public chainMedianTime = 1700000000;
    public autoConfirmBroadcast = false;

    async getRawTransaction(txid: string) {
        return this.txs.get(txid) || "";
    }

    async getTxStatus(txid: string) {
        if (this.confirmedTxids.has(txid)) {
            return {
                confirmed: true as const,
                blockHeight: this.txHeights.get(txid) ?? this.chainHeight,
                blockTime: this.txTimes.get(txid) ?? this.chainMedianTime,
            };
        }
        return { confirmed: false as const, inMempool: this.mempoolTxids.has(txid) };
    }

    async getBlockchainInfo() {
        return { height: this.chainHeight, medianTime: this.chainMedianTime };
    }

    public broadcastedTxs: string[] = [];
    public broadcastedPackages: string[][] = [];
    async broadcastTransaction(...txHexes: string[]): Promise<string> {
        this.broadcastedPackages.push(txHexes);
        const parentHex = txHexes[0] ?? "";
        this.broadcastedTxs.push(parentHex);
        let txid: string;
        try {
            const parsed = Transaction.fromRaw(hex.decode(parentHex), {
                allowUnknownOutputs: true,
            });
            txid = computeTxid(parsed);
        } catch {
            txid = `broadcasted_${parentHex.substring(0, 10)}`;
        }
        if (this.autoConfirmBroadcast) {
            this.confirmedTxids.add(txid);
        } else {
            this.mempoolTxids.add(txid);
        }
        return txid;
    }
}

// ─── Test Suite ──────────────────────────────────────────────────────────────

describe("VTXO DAG Verification", () => {
    let indexer: MockIndexerProvider;
    let onchain: MockOnchainProvider;

    beforeEach(() => {
        indexer = new MockIndexerProvider();
        onchain = new MockOnchainProvider();
    });

    describe("Tier 1 Tasks", () => {
        it("should reconstruct and validate a simple signed DAG", async () => {
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

            const result = await reconstructAndValidateVtxoDAG(
                { txid: vtxoTx.txid, vout: 0 },
                indexer,
                onchain,
            );
            expect(result.valid).toBe(true);
        });

        it("should fail with INVALID_VOUT when outpoint vout does not exist", async () => {
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

            // vtxoTx only has 1 output (index 0). vout: 1 must be rejected!
            await expect(
                reconstructAndValidateVtxoDAG({ txid: vtxoTx.txid, vout: 1 }, indexer, onchain),
            ).rejects.toThrow(/INVALID_VOUT/);
        });

        it("should fail with INVALID_SIGNATURE on tamper", async () => {
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(7), 0, [{ amount: 100000n }]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: makeP2TRScript(0),
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[0]),
            });
            signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [
                { script: makeP2TRScript(0), amount: 100000n },
            ]);

            const tampered = Uint8Array.from(vtxoTx.tx.getInput(0).tapKeySig!);
            tampered[0] ^= 0x01;
            vtxoTx.tx.updateInput(0, { tapKeySig: tampered });

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

            await expect(
                reconstructAndValidateVtxoDAG({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain),
            ).rejects.toThrow(/INVALID_SIGNATURE/);
        });
    });

    describe("Tier 2 Phase 1: Taproot Script & Tree Verification", () => {
        it("should verify a node with a valid Taproot script tree", async () => {
            const internalKey = schnorr.getPublicKey(TEST_PRIVKEYS[0]);
            const userKey = schnorr.getPublicKey(TEST_PRIVKEYS[1]);
            const validArkScript = hex.decode(`0190b27520${hex.encode(userKey)}ac`);

            const tr = p2tr(internalKey, { script: validArkScript }, undefined, true);
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(11), 0, [
                { amount: 100000n, script: tr.script },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: tr.script,
                tapInternalKey: internalKey,
                sequence: 0x190, // 400-block relative delay (matches the script's CSV push of 0x0190)
                tapMerkleRoot: tr.tapMerkleRoot,
                tapLeafScript: tr.tapLeafScript,
            });

            signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [{ script: tr.script, amount: 100000n }]);

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

            const result = await reconstructAndValidateVtxoDAG(
                { txid: vtxoTx.txid, vout: 0 },
                indexer,
                onchain,
            );
            expect(result.valid).toBe(true);
        });

        it("should fail if the leaf script violates Ark exit policy", async () => {
            const internalKey = schnorr.getPublicKey(TEST_PRIVKEYS[0]);
            const badExitScript = hex.decode("0000");

            const tr = p2tr(internalKey, { script: badExitScript }, undefined, true);
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(15), 0, [
                { amount: 100000n, script: tr.script },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: tr.script,
                tapInternalKey: internalKey,
                tapMerkleRoot: tr.tapMerkleRoot,
                tapLeafScript: tr.tapLeafScript,
            });

            signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [{ script: tr.script, amount: 100000n }]);

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

            await expect(
                reconstructAndValidateVtxoDAG({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain),
            ).rejects.toThrow("INVALID_ARK_SCRIPT");
        });

        it("should verify genuine SDK buildOffchainTx CHECKPOINT and ARK script-path PSBTs missing optional tapInternalKey", async () => {
            const alice = SingleKey.fromHex(hex.encode(TEST_PRIVKEYS[1]));
            const server = SingleKey.fromHex(hex.encode(TEST_PRIVKEYS[2]));
            const alicePub = await alice.xOnlyPublicKey();
            const serverPub = await server.xOnlyPublicKey();

            const vtxoScript = new DefaultVtxo.Script({
                pubKey: alicePub,
                serverPubKey: serverPub,
                csvTimelock: { value: 512n, type: "seconds" },
            });
            const checkpointTapscript = CSVMultisigTapscript.encode({
                pubkeys: [serverPub],
                timelock: { value: 512n, type: "seconds" },
            });

            // Commitment -> TREE (MuSig2 key-path) -> CHECKPOINT (script-path, no tapInternalKey) -> ARK (script-path, no tapInternalKey)
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(51), 0, [
                { amount: 100000n, script: makeP2TRScript(0) },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const treeTx = createVirtualTx(
                commitmentTxid,
                0,
                [{ amount: 100000n, script: vtxoScript.pkScript }],
                {
                    parentScript: makeP2TRScript(0),
                    tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[0]),
                },
            );
            signVirtualTx(treeTx.tx, 0, TEST_PRIVKEYS[0], [
                { script: makeP2TRScript(0), amount: 100000n },
            ]);

            const { arkTx, checkpoints } = buildOffchainTx(
                [
                    {
                        txid: treeTx.txid,
                        vout: 0,
                        value: 100000,
                        tapLeafScript: vtxoScript.forfeit(),
                        tapTree: vtxoScript.encode(),
                    },
                ],
                [{ script: vtxoScript.pkScript, amount: 100000n }],
                checkpointTapscript,
            );

            const signedCheckpoint = await server.sign(await alice.sign(checkpoints[0]));
            const signedArkTx = await server.sign(await alice.sign(arkTx));

            // Confirm neither genuine SDK PSBT carries optional tapInternalKey / tapMerkleRoot
            expect(signedCheckpoint.getInput(0).tapInternalKey).toBeUndefined();
            expect(signedCheckpoint.getInput(0).tapMerkleRoot).toBeUndefined();
            expect(signedArkTx.getInput(0).tapInternalKey).toBeUndefined();
            expect(signedArkTx.getInput(0).tapMerkleRoot).toBeUndefined();

            const checkpointTxid = computeTxid(signedCheckpoint);
            const arkTxid = computeTxid(signedArkTx);

            indexer.chain = [
                {
                    txid: arkTxid,
                    expiresAt: "2000000000",
                    type: ChainTxType.ARK,
                    spends: [checkpointTxid],
                },
                {
                    txid: checkpointTxid,
                    expiresAt: "2000000000",
                    type: ChainTxType.CHECKPOINT,
                    spends: [treeTx.txid],
                },
                {
                    txid: treeTx.txid,
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
            indexer.virtualTxs.set(treeTx.txid, base64.encode(treeTx.tx.toPSBT()));
            indexer.virtualTxs.set(checkpointTxid, base64.encode(signedCheckpoint.toPSBT()));
            indexer.virtualTxs.set(arkTxid, base64.encode(signedArkTx.toPSBT()));

            const result = await verifyVtxoComplete({ txid: arkTxid, vout: 0 }, indexer, onchain);
            expect(result.valid).toBe(true);
            expect(result.checkpointValidations).toHaveLength(1);
            expect(result.checkpointValidations[0].expiryCoherent).toBe(true);

            // Also confirm extractExitSequence finalizes all 3 hops with real SegWit witnesses
            const exitSeq = extractExitSequence(result.anchoringLeaf, arkTxid);
            expect(exitSeq).toHaveLength(3);
            for (const rawHex of exitSeq) {
                const parsed = Transaction.fromRaw(hex.decode(rawHex), {
                    allowUnknownOutputs: true,
                });
                expect(parsed.getInput(0).finalScriptWitness?.length).toBeGreaterThan(0);
            }
        });

        it("should reject script-path PSBT with flipped control block parity bit or prevout mismatch", async () => {
            const alice = SingleKey.fromHex(hex.encode(TEST_PRIVKEYS[1]));
            const server = SingleKey.fromHex(hex.encode(TEST_PRIVKEYS[2]));
            const vtxoScript = new DefaultVtxo.Script({
                pubKey: await alice.xOnlyPublicKey(),
                serverPubKey: await server.xOnlyPublicKey(),
                csvTimelock: { value: 512n, type: "seconds" },
            });
            const [cb, scriptWithVer] = vtxoScript.forfeit();

            // 1. Flipped parity bit in control block version byte (matches arkd v0.9.25 parity check)
            const badParityNode: any = {
                txid: fakeCommitmentTxid(52),
                tx: {
                    getInput: () => ({
                        tapInternalKey: undefined,
                        tapMerkleRoot: undefined,
                        tapLeafScript: [[{ ...cb, version: cb.version ^ 1 }, scriptWithVer]],
                    }),
                },
                ancestor: null,
                prevOutContext: { script: vtxoScript.pkScript, amount: 100000n },
            };
            expect(() => verifyNodeTaproot(badParityNode)).toThrow("INVALID_MERKLE_PROOF");

            // 2. Prevout script mismatch
            const wrongPrevoutNode: any = {
                txid: fakeCommitmentTxid(53),
                tx: {
                    getInput: () => ({
                        tapInternalKey: undefined,
                        tapMerkleRoot: undefined,
                        tapLeafScript: [[cb, scriptWithVer]],
                    }),
                },
                ancestor: null,
                prevOutContext: { script: makeP2TRScript(9), amount: 100000n },
            };
            expect(() => verifyNodeTaproot(wrongPrevoutNode)).toThrow("INVALID_TAPROOT_TWEAK");

            // 3. Decoded control block object exceeding BIP-341 depth limit (128)
            const deepDecodedNode: any = {
                txid: fakeCommitmentTxid(54),
                tx: {
                    getInput: () => ({
                        tapInternalKey: undefined,
                        tapMerkleRoot: undefined,
                        tapLeafScript: [
                            [
                                {
                                    version: 0xc0,
                                    internalKey: cb.internalKey,
                                    merklePath: Array.from({ length: 129 }, () =>
                                        new Uint8Array(32).fill(1),
                                    ),
                                },
                                scriptWithVer,
                            ],
                        ],
                    }),
                },
                ancestor: null,
                prevOutContext: { script: vtxoScript.pkScript, amount: 100000n },
            };
            expect(() => verifyNodeTaproot(deepDecodedNode)).toThrow(/depth exceeds maximum/);
        });
    });

    describe("Tier 2 Phase 2: Timelock Verification", () => {
        it("should pass with a valid CSV timelock (nSequence=10, script OP_10 OP_CSV)", async () => {
            const internalKey = schnorr.getPublicKey(TEST_PRIVKEYS[0]);
            const userKey = schnorr.getPublicKey(TEST_PRIVKEYS[1]);
            // Script: <10> OP_CSV OP_DROP <userKey> OP_CHECKSIG
            // This is a standard Ark exit: relative timelock of 10 blocks + key check
            const csvScript = Script.encode([
                10, // OP_10 (push small int)
                "CHECKSEQUENCEVERIFY", // OP_CSV (0xb2)
                "DROP",
                userKey,
                "CHECKSIG",
            ]);

            const tr = p2tr(internalKey, { script: csvScript }, undefined, true);
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(21), 0, [
                { amount: 100000n, script: tr.script },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: tr.script,
                tapInternalKey: internalKey,
                sequence: 10, // nSequence = 10 blocks relative timelock
                tapMerkleRoot: tr.tapMerkleRoot,
                tapLeafScript: tr.tapLeafScript,
            });

            signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [{ script: tr.script, amount: 100000n }]);

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

            const result = await reconstructAndValidateVtxoDAG(
                { txid: vtxoTx.txid, vout: 0 },
                indexer,
                onchain,
            );
            expect(result.valid).toBe(true);
        });

        it("should fail when CSV is used but nSequence disables relative timelock", () => {
            // Unit test directly on the consistency validator
            const constraints = {
                nLockTime: 0,
                nSequence: 0xffffffff, // FINAL — disables relative timelock
                csvValues: [10],
                cltvValues: [],
                lockTimeType: "none" as const,
                sequenceType: "final" as const,
                isKeyPathSpend: false,
            };

            expect(() => validateTimelockConsistency(constraints, "deadbeef")).toThrow(
                "TIMELOCK_INCONSISTENT",
            );
        });

        it("should fail on CLTV/nLockTime domain mismatch (blocks vs time)", () => {
            // nLockTime uses block height, but CLTV uses timestamp
            const constraints = {
                nLockTime: 800000, // block-based
                nSequence: 0xfffffffe, // non-final so BIP 65 allows CLTV
                csvValues: [],
                cltvValues: [1700000000], // time-based (UNIX timestamp)
                lockTimeType: "blocks" as const,
                sequenceType: "disabled" as const,
                isKeyPathSpend: false,
            };

            expect(() => validateTimelockConsistency(constraints, "deadbeef")).toThrow(
                "TIMELOCK_INCONSISTENT",
            );
        });

        it("should report immature valid CLTV as satisfied=false without throwing", () => {
            const blockConstraints = {
                nLockTime: 999999,
                nSequence: 0xfffffffe, // non-final so BIP 65 allows CLTV
                csvValues: [],
                cltvValues: [999999],
                lockTimeType: "blocks" as const,
                sequenceType: "disabled" as const,
                isKeyPathSpend: false,
                txVersion: 2,
            };

            const timeConstraints = {
                nLockTime: 1800000000,
                nSequence: 0xfffffffe,
                csvValues: [],
                cltvValues: [1800000000],
                lockTimeType: "time" as const,
                sequenceType: "disabled" as const,
                isKeyPathSpend: false,
                txVersion: 2,
            };

            const chainState: ChainState = {
                currentHeight: 100,
                currentTime: 1700000000,
            };

            validateTimelockConsistency(blockConstraints, "deadbeef");
            validateTimelockConsistency(timeConstraints, "deadbeef");

            const blockDiags: string[] = [];
            expect(
                validateTimelockSatisfiability(
                    blockConstraints,
                    chainState,
                    "deadbeef",
                    blockDiags,
                ),
            ).toBe(false);
            expect(blockDiags.length).toBeGreaterThan(0);

            const timeDiags: string[] = [];
            expect(
                validateTimelockSatisfiability(timeConstraints, chainState, "deadbeef", timeDiags),
            ).toBe(false);
            expect(timeDiags.length).toBeGreaterThan(0);
        });

        it("should mark a DAG with valid immature CLTV as valid=true, timelocksSatisfied=false, broadcastable=false", async () => {
            const aliceKey = schnorr.getPublicKey(TEST_PRIVKEYS[1]);
            const refundScript = Script.encode([
                aliceKey,
                "CHECKSIGVERIFY",
                500, // future block height > chainHeight (100)
                "CHECKLOCKTIMEVERIFY",
            ]);
            const tr = p2tr(
                schnorr.getPublicKey(TEST_PRIVKEYS[0]),
                { script: refundScript },
                undefined,
                true,
            );

            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(57), 0, [
                { amount: 100000n, script: tr.script },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);
            onchain.chainHeight = 100;

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: tr.script,
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[0]),
                sequence: 0xfffffffe,
                lockTime: 500,
                tapMerkleRoot: tr.tapMerkleRoot,
                tapLeafScript: tr.tapLeafScript,
            });
            signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [{ script: tr.script, amount: 100000n }]);

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

            const result = await verifyVtxoComplete(
                { txid: vtxoTx.txid, vout: 0 },
                indexer,
                onchain,
            );
            expect(result.valid).toBe(true);
            expect(result.timelocksSatisfied).toBe(false);
            expect(result.broadcastable).toBe(false);
        });

        it("should fail consistency when OP_CLTV exceeds nLockTime (BIP 65 violation)", () => {
            const constraints = {
                nLockTime: 800000,
                nSequence: 0xfffffffe,
                csvValues: [],
                cltvValues: [800100],
                lockTimeType: "blocks" as const,
                sequenceType: "disabled" as const,
                isKeyPathSpend: false,
                txVersion: 2,
            };
            expect(() => validateTimelockConsistency(constraints, "deadbeef")).toThrow(
                "TIMELOCK_INCONSISTENT",
            );
        });

        it("should conservatively evaluate time-based CSV, key-path/implicit BIP-68, larger nSequence, and non-anchoring parents", () => {
            // 1. Time-based CSV (bit 22 set, 2 * 512s = 1024s)
            const timeCsvSeq = (1 << 22) | 2;
            const timeCsvConstraints = {
                nLockTime: 0,
                nSequence: timeCsvSeq,
                csvValues: [timeCsvSeq],
                cltvValues: [],
                lockTimeType: "none" as const,
                sequenceType: "time" as const,
                isKeyPathSpend: false,
                txVersion: 2,
            };
            validateTimelockConsistency(timeCsvConstraints, "tx_time");

            // Missing commitmentTime -> conservative false (never false maturity)
            expect(
                validateTimelockSatisfiability(
                    timeCsvConstraints,
                    { currentHeight: 500, currentTime: 1700005000, commitmentHeight: 100 },
                    "tx_time",
                    undefined,
                    { spendsCommitment: true },
                ),
            ).toBe(false);

            // Immature elapsed time (500s < 1024s) -> false
            expect(
                validateTimelockSatisfiability(
                    timeCsvConstraints,
                    {
                        currentHeight: 500,
                        currentTime: 1700000500,
                        commitmentHeight: 100,
                        commitmentTime: 1700000000,
                    },
                    "tx_time",
                    undefined,
                    { spendsCommitment: true },
                ),
            ).toBe(false);

            // Mature on anchoring node (1024s >= 1024s) -> true
            expect(
                validateTimelockSatisfiability(
                    timeCsvConstraints,
                    {
                        currentHeight: 500,
                        currentTime: 1700001024,
                        commitmentHeight: 100,
                        commitmentTime: 1700000000,
                    },
                    "tx_time",
                    undefined,
                    { spendsCommitment: true },
                ),
            ).toBe(true);

            // 2. Key-path / implicit BIP-68 (no OP_CSV in script, nVersion >= 2)
            const keyPathBip68 = {
                nLockTime: 0,
                nSequence: 20,
                csvValues: [],
                cltvValues: [],
                lockTimeType: "none" as const,
                sequenceType: "blocks" as const,
                isKeyPathSpend: true,
                txVersion: 2,
            };
            expect(
                validateTimelockSatisfiability(
                    keyPathBip68,
                    { currentHeight: 110, currentTime: 1700000000, commitmentHeight: 100 },
                    "tx_kp",
                    undefined,
                    { spendsCommitment: true },
                ),
            ).toBe(false);
            expect(
                validateTimelockSatisfiability(
                    keyPathBip68,
                    { currentHeight: 120, currentTime: 1700000000, commitmentHeight: 100 },
                    "tx_kp",
                    undefined,
                    { spendsCommitment: true },
                ),
            ).toBe(true);
            // nVersion = 1 disables BIP-68
            expect(
                validateTimelockSatisfiability(
                    { ...keyPathBip68, txVersion: 1 },
                    { currentHeight: 110, currentTime: 1700000000, commitmentHeight: 100 },
                    "tx_v1",
                    undefined,
                    { spendsCommitment: true },
                ),
            ).toBe(true);

            // 3. Larger nSequence than OP_CSV operand: nSequence=50 governs over maxCsv=10
            const largerSeqConstraints = {
                nLockTime: 0,
                nSequence: 50,
                csvValues: [10],
                cltvValues: [],
                lockTimeType: "none" as const,
                sequenceType: "blocks" as const,
                isKeyPathSpend: false,
                txVersion: 2,
            };
            validateTimelockConsistency(largerSeqConstraints, "tx_seq50");
            expect(
                validateTimelockSatisfiability(
                    largerSeqConstraints,
                    { currentHeight: 125, currentTime: 1700000000, commitmentHeight: 100 },
                    "tx_seq50",
                    undefined,
                    { spendsCommitment: true },
                ),
            ).toBe(false);

            // 4. Non-anchoring DAG node spending an off-chain ancestor: MUST NOT use commitment age
            const deepChildNode: any = {
                txid: fakeCommitmentTxid(55),
                ancestor: { txid: fakeCommitmentTxid(56) }, // spends off-chain ancestor, not commitment
                tx: {
                    version: 2,
                    lockTime: 0,
                    getInput: () => ({
                        sequence: 10,
                        tapKeySig: new Uint8Array(64),
                    }),
                },
                children: new Map(),
            };
            expect(
                verifyNodeTimelocks(deepChildNode, {
                    currentHeight: 1100,
                    currentTime: 1700500000,
                    commitmentHeight: 100, // 1000 confirmations on commitment, but parent is off-chain!
                    commitmentTime: 1700000000,
                }),
            ).toBe(false);
        });

        it("should pass with valid CLTV + CSV combined constraints when commitment height is matured", () => {
            const constraints = {
                nLockTime: 800000, // absolute lock: block 800000
                nSequence: 10, // relative lock: 10 blocks
                csvValues: [10],
                cltvValues: [800000],
                lockTimeType: "blocks" as const,
                sequenceType: "blocks" as const,
                isKeyPathSpend: false,
                txVersion: 2,
            };

            const chainState: ChainState = {
                currentHeight: 800100, // well past block 800000
                currentTime: 1700000000,
                commitmentHeight: 800080, // 20 blocks elapsed >= 10
            };

            validateTimelockConsistency(constraints, "deadbeef");
            expect(
                validateTimelockSatisfiability(constraints, chainState, "deadbeef", undefined, {
                    spendsCommitment: true,
                }),
            ).toBe(true);
            // Without commitmentHeight, maturity cannot be proven -> conservative false
            expect(
                validateTimelockSatisfiability(
                    constraints,
                    { currentHeight: 800100, currentTime: 1700000000 },
                    "deadbeef",
                    undefined,
                    { spendsCommitment: true },
                ),
            ).toBe(false);
        });
    });

    describe("Tier 2 Phase 3: Hash Preimage & Boltz Submarine Swap Verification", () => {
        it("should extract and verify a HASH160 preimage (Boltz claim pattern)", () => {
            // Direct unit test on the hash preimage module

            // Generate a random preimage (32 bytes — Boltz standard)
            const preimage = new Uint8Array(32);
            for (let i = 0; i < 32; i++) preimage[i] = (i * 7 + 13) % 256;

            // Boltz HASH160 = RIPEMD160(SHA256(preimage))
            const preimageHash = ripemd160(sha256(preimage));

            // Construct a Boltz-style claim script:
            //   OP_HASH160 <hash160(preimage)> OP_EQUALVERIFY <claimPubkey> OP_CHECKSIG
            const claimKey = schnorr.getPublicKey(TEST_PRIVKEYS[1]);
            const claimScript = Script.encode([
                "HASH160",
                preimageHash,
                "EQUALVERIFY",
                claimKey,
                "CHECKSIG",
            ]);

            // Decode and extract conditions
            const decoded = Script.decode(claimScript);
            const conditions = extractHashConditions(decoded);

            expect(conditions).toHaveLength(1);
            expect(conditions[0].opcode).toBe("HASH160");
            expect(hex.encode(conditions[0].expectedHash)).toBe(hex.encode(preimageHash));

            // Verify with correct preimage
            const result = verifyPreimage(preimage, conditions[0]);
            expect(result.valid).toBe(true);
            expect(result.computedHash).toBe(result.expectedHash);
        });

        it("should reject an incorrect preimage for HASH160", () => {
            const realPreimage = new Uint8Array(32).fill(0xaa);
            const fakePreimage = new Uint8Array(32).fill(0xbb);
            const expectedHash = ripemd160(sha256(realPreimage));

            const claimKey = schnorr.getPublicKey(TEST_PRIVKEYS[2]);
            const claimScript = Script.encode([
                "HASH160",
                expectedHash,
                "EQUALVERIFY",
                claimKey,
                "CHECKSIG",
            ]);

            const decoded = Script.decode(claimScript);
            const conditions = extractHashConditions(decoded);
            expect(conditions).toHaveLength(1);

            // Wrong preimage should fail
            const result = verifyPreimage(fakePreimage, conditions[0]);
            expect(result.valid).toBe(false);
            expect(result.computedHash).not.toBe(result.expectedHash);
        });

        it("should verify a SHA256 hash-lock condition", () => {
            const preimage = new Uint8Array(32).fill(0x42);
            const expectedHash = sha256(preimage);

            // SHA256 hash-lock script: OP_SHA256 <hash> OP_EQUALVERIFY <key> OP_CHECKSIG
            const key = schnorr.getPublicKey(TEST_PRIVKEYS[3]);
            const script = Script.encode(["SHA256", expectedHash, "EQUALVERIFY", key, "CHECKSIG"]);

            const decoded = Script.decode(script);
            const conditions = extractHashConditions(decoded);
            expect(conditions).toHaveLength(1);
            expect(conditions[0].opcode).toBe("SHA256");

            const result = verifyPreimage(preimage, conditions[0]);
            expect(result.valid).toBe(true);
        });

        it("should verify a full Boltz submarine swap (Ark → Lightning) HTLC", async () => {
            /**
             * Boltz Submarine Swap Scenario:
             * ═══════════════════════════════
             * Alice wants to pay Bob on Lightning via a Boltz submarine swap.
             *
             * 1. Boltz generates an invoice with payment_hash = SHA256(preimage)
             * 2. Alice locks funds in a Taproot HTLC on the Ark virtual tree
             * 3. The HTLC has TWO tapscript leaves:
             *    - Claim leaf: OP_HASH160 <ripemd160(sha256(preimage))> OP_EQUALVERIFY <boltzKey> OP_CHECKSIG
             *    - Refund leaf: <aliceKey> OP_CHECKSIGVERIFY <timeout> OP_CHECKLOCKTIMEVERIFY
             * 4. When the Lightning payment succeeds, Boltz reveals the preimage
             * 5. Boltz claims the on-chain HTLC using the claim leaf
             *
             * This test verifies the ENTIRE pipeline works end-to-end.
             */

            // ── Swap participants ──────────────────────────────────────────
            const boltzPrivKey = TEST_PRIVKEYS[3];
            const boltzPubKey = schnorr.getPublicKey(boltzPrivKey);
            const alicePrivKey = TEST_PRIVKEYS[4];
            const alicePubKey = schnorr.getPublicKey(alicePrivKey);

            // ── Generate the swap preimage (Lightning payment secret) ──────
            const swapPreimage = new Uint8Array(32);
            for (let i = 0; i < 32; i++) swapPreimage[i] = (i * 11 + 5) % 256;

            const preimageHashSha256 = sha256(swapPreimage);
            const preimageHashRipemd = ripemd160(preimageHashSha256);

            // ── Construct the Boltz HTLC tree (exact Boltz protocol) ───────
            // Claim leaf (Boltz claims with preimage):
            //   OP_HASH160 <RIPEMD160(SHA256(preimage))> OP_EQUALVERIFY <boltzKey> OP_CHECKSIG
            const claimScript = Script.encode([
                "HASH160",
                preimageHashRipemd,
                "EQUALVERIFY",
                boltzPubKey,
                "CHECKSIG",
            ]);

            // Refund leaf (Alice refunds after timeout):
            //   <aliceKey> OP_CHECKSIGVERIFY <timeout> OP_CHECKLOCKTIMEVERIFY
            const TIMEOUT_BLOCK = 800100;
            const refundScript = Script.encode([
                alicePubKey,
                "CHECKSIGVERIFY",
                TIMEOUT_BLOCK,
                "CHECKLOCKTIMEVERIFY",
            ]);

            // ── Build the Taproot tree with both leaves ────────────────────
            // Internal key = co-signing key (Boltz MuSig2 aggregate, simulated)
            const internalKey = schnorr.getPublicKey(TEST_PRIVKEYS[5]);

            const tr = p2tr(
                internalKey,
                [
                    { script: claimScript }, // Claim leaf
                    { script: refundScript }, // Refund leaf
                ],
                undefined,
                true, // allowUnknownOutputs
            );

            // ── Set up the on-chain commitment ─────────────────────────────
            const commitmentOut = createVirtualTx(fakeCommitmentTxid(31), 0, [
                { amount: 50000n, script: tr.script },
            ]);
            const commitmentTxid = commitmentOut.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentOut.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);
            onchain.chainHeight = 800200; // Past the refund timeout

            // ── Create the VTXO that locks funds in the HTLC ──────────────
            const htlcVtxo = createVirtualTx(commitmentTxid, 0, [{ amount: 50000n }], {
                parentScript: tr.script,
                tapInternalKey: internalKey,
                sequence: 0xffffffff, // No relative timelock on the main input
                tapMerkleRoot: tr.tapMerkleRoot,
                tapLeafScript: tr.tapLeafScript,
            });

            // Sign with the internal key (key-path signature)
            signVirtualTx(htlcVtxo.tx, 0, TEST_PRIVKEYS[5], [
                { script: tr.script, amount: 50000n },
            ]);

            // ── Register in the indexer ────────────────────────────────────
            indexer.chain = [
                {
                    txid: htlcVtxo.txid,
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
            indexer.virtualTxs.set(htlcVtxo.txid, base64.encode(htlcVtxo.tx.toPSBT()));

            // Build the preimage supply map: hash → preimage
            const preimages = new Map<string, Uint8Array>();
            preimages.set(hex.encode(preimageHashRipemd), swapPreimage);

            // ── Run the FULL verification pipeline ─────────────────────────
            // We MUST pass preimages now as they are mandatory for security
            const result = await reconstructAndValidateVtxoDAG(
                { txid: htlcVtxo.txid, vout: 0 },
                indexer,
                onchain,
                preimages,
            );

            // Pipeline must pass (structural + sig + taproot + timelock + hash)
            expect(result.valid).toBe(true);

            // ── Verify the HTLC preimage explicitly ────────────────────────
            // Now verify that the correct preimage satisfies the claim leaf

            // Build the preimage supply map: hash → preimage
            const witnessPreimages = new Map<string, Uint8Array>();
            witnessPreimages.set(hex.encode(preimageHashRipemd), swapPreimage);

            // The node from the pipeline result should verify cleanly
            expect(() => {
                verifyNodeHashPreimages(result.anchoringLeaf, witnessPreimages);
            }).not.toThrow();

            // ── Verify that a WRONG preimage is rejected ───────────────────
            const badPreimages = new Map<string, Uint8Array>();
            badPreimages.set(hex.encode(preimageHashRipemd), new Uint8Array(32).fill(0xff));

            expect(() => {
                verifyNodeHashPreimages(result.anchoringLeaf, badPreimages);
            }).toThrow("INVALID_HASH_PREIMAGE");
        });
    });

    describe("Tier 1 & Tier 2 Enhancements and Edge Cases", () => {
        it("should enforce minConfirmations against blockchain depth in verifyVtxoComplete", async () => {
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(10), 0, [
                { amount: 100000n, script: makeP2TRScript(0) },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);
            onchain.txHeights.set(commitmentTxid, 100);
            onchain.chainHeight = 105; // commitment blockHeight = 100 -> depth = 6

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: makeP2TRScript(0),
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[0]),
            });
            signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [
                { script: makeP2TRScript(0), amount: 100000n },
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

            // Depth is 6; minConfirmations = 6 should pass
            const passResult = await verifyVtxoComplete(
                { txid: vtxoTx.txid, vout: 0 },
                indexer,
                onchain,
                6,
            );
            expect(passResult.valid).toBe(true);

            // minConfirmations = 7 should fail
            await expect(
                verifyVtxoComplete({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain, 7),
            ).rejects.toThrow("COMMITMENT_NOT_CONFIRMED");
        });

        it("should format diagnostics cleanly when blockHeight is undefined without printing 'block undefined'", async () => {
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(11), 0, [
                { amount: 100000n, script: makeP2TRScript(0) },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: makeP2TRScript(0),
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[0]),
            });
            signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [
                { script: makeP2TRScript(0), amount: 100000n },
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

            // Mock getTxStatus returning confirmed without blockHeight (read-only VerificationOnchainProvider)
            const customOnchain: VerificationOnchainProvider = {
                async getRawTransaction(txid: string) {
                    return onchain.getRawTransaction(txid);
                },
                async getTxStatus(_txid: string) {
                    return { confirmed: true as const, blockHeight: undefined };
                },
            };

            const result = await verifyVtxoComplete(
                { txid: vtxoTx.txid, vout: 0 },
                indexer,
                customOnchain,
                1,
            );
            expect(result.valid).toBe(true);
            const confirmedDiag = result.diagnostics.find((d) => d.includes("confirmed"));
            expect(confirmedDiag).toBeDefined();
            expect(confirmedDiag).not.toContain("block undefined");
            expect(confirmedDiag).toBe(`✓ Commitment tx ${commitmentTxid} confirmed`);
        });

        it("should support Outpoint parameter in getVtxoChain", async () => {
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(12), 0, [
                { amount: 100000n, script: makeP2TRScript(0) },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: makeP2TRScript(0),
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[0]),
            });
            signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [
                { script: makeP2TRScript(0), amount: 100000n },
            ]);

            const singleArgIndexer = {
                // 1 parameter arity (outpoint)
                async getVtxoChain(_outpoint: Outpoint) {
                    return {
                        chain: [
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
                        ],
                    };
                },
                async getBatchVtxos(_txid: string) {
                    return [];
                },
                async getVirtualTxs(_txids: string[]) {
                    return { txs: [base64.encode(vtxoTx.tx.toPSBT())] };
                },
            };

            const result = await reconstructAndValidateVtxoDAG(
                { txid: vtxoTx.txid, vout: 0 },
                singleArgIndexer,
                onchain,
            );
            expect(result.valid).toBe(true);
        });

        it("should handle safe bigints and reject unsafe bigints in resolveScriptNumber", () => {
            expect(resolveScriptNumber(500n)).toBe(500);
            expect(resolveScriptNumber(0n)).toBe(0);
            expect(resolveScriptNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
                Number.MAX_SAFE_INTEGER,
            );
            expect(resolveScriptNumber(BigInt(Number.MIN_SAFE_INTEGER))).toBe(
                Number.MIN_SAFE_INTEGER,
            );
            expect(resolveScriptNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toBeNull();
            expect(resolveScriptNumber(BigInt(Number.MIN_SAFE_INTEGER) - 1n)).toBeNull();
            expect(resolveScriptNumber(10n ** 30n)).toBeNull();
        });

        it("Finding C: should reject bare <pk> CHECKSIG script without CSV timelock or multisig", async () => {
            const userPubkey = schnorr.getPublicKey(TEST_PRIVKEYS[0]);
            // Bare single-key checksig script: <pk> OP_CHECKSIG (no CSV timelock, 1 key)
            const bareScript = Script.encode([userPubkey, "CHECKSIG"]);
            const tr = p2tr(schnorr.getPublicKey(TEST_PRIVKEYS[1]), [
                { script: bareScript, leafVersion: 0xc0 },
            ]);

            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(13), 0, [
                { amount: 100000n, script: tr.script },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: tr.script,
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
                tapLeafScript: tr.tapLeafScript,
                tapMerkleRoot: tr.tapMerkleRoot,
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
            indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

            await expect(
                reconstructAndValidateVtxoDAG({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain),
            ).rejects.toThrow("INVALID_ARK_SCRIPT");
        });

        it("Finding C (Residual): should reject multisig script containing duplicate keys with distinct size < 2", async () => {
            const aspPubkey = schnorr.getPublicKey(TEST_PRIVKEYS[0]);
            // Duplicate keys in multisig: <aspKey> CHECKSIG <aspKey> CHECKSIGADD OP_2 OP_NUMEQUAL (2 keys in array, but only 1 distinct key)
            const duplicateKeyScript = Script.encode([
                aspPubkey,
                "CHECKSIG",
                aspPubkey,
                "CHECKSIGADD",
                2,
                "NUMEQUAL",
            ]);
            const tr = p2tr(schnorr.getPublicKey(TEST_PRIVKEYS[1]), [
                { script: duplicateKeyScript, leafVersion: 0xc0 },
            ]);

            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(133), 0, [
                { amount: 100000n, script: tr.script },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: tr.script,
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
                tapLeafScript: tr.tapLeafScript,
                tapMerkleRoot: tr.tapMerkleRoot,
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
            indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

            await expect(
                reconstructAndValidateVtxoDAG({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain),
            ).rejects.toThrow("INVALID_ARK_SCRIPT");
        });

        it("Finding 5: should require and use commitmentTxid in privacy-preserving mode", async () => {
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(14), 0, [
                { amount: 100000n, script: makeP2TRScript(0) },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: makeP2TRScript(0),
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[0]),
            });
            signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [
                { script: makeP2TRScript(0), amount: 100000n },
            ]);

            const privacyIndexer: VerificationIndexerProvider = {
                async getBatchVtxos(cid: string) {
                    if (cid !== commitmentTxid) return [];
                    return [
                        {
                            chain: [
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
                            ],
                        },
                    ];
                },
                async getVirtualTxs(_txids: string[]) {
                    return { txs: [base64.encode(vtxoTx.tx.toPSBT())] };
                },
            };

            // Failing when commitmentTxid is missing
            await expect(
                reconstructAndValidateVtxoDAG(
                    { txid: vtxoTx.txid, vout: 0 },
                    privacyIndexer,
                    onchain,
                ),
            ).rejects.toThrow("INVALID_PROVIDER");

            // Passing when commitmentTxid is provided
            const result = await reconstructAndValidateVtxoDAG(
                { txid: vtxoTx.txid, vout: 0 },
                privacyIndexer,
                onchain,
                undefined,
                commitmentTxid,
            );
            expect(result.valid).toBe(true);
        });

        it("Finding 18: should correctly match PSBTs by computed txid regardless of indexer response ordering", async () => {
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(15), 0, [
                { amount: 200000n, script: makeP2TRScript(0) },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const intermediateTx = createVirtualTx(
                commitmentTxid,
                0,
                [{ amount: 200000n, script: makeP2TRScript(1) }],
                {
                    parentScript: makeP2TRScript(0),
                    tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[0]),
                },
            );
            signVirtualTx(intermediateTx.tx, 0, TEST_PRIVKEYS[0], [
                { script: makeP2TRScript(0), amount: 200000n },
            ]);

            const vtxoTx = createVirtualTx(intermediateTx.txid, 0, [{ amount: 200000n }], {
                parentScript: makeP2TRScript(1),
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
            });
            signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[1], [
                { script: makeP2TRScript(1), amount: 200000n },
            ]);

            // Indexer returns virtual transactions in reverse/shuffled order
            const outOfOrderIndexer: VerificationIndexerProvider = {
                async getVtxoChain(_outpoint: Outpoint) {
                    return {
                        chain: [
                            {
                                txid: vtxoTx.txid,
                                expiresAt: "2000000000",
                                type: ChainTxType.ARK,
                                spends: [intermediateTx.txid],
                            },
                            {
                                txid: intermediateTx.txid,
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
                        ],
                    };
                },
                async getBatchVtxos(_cid: string) {
                    return [];
                },
                async getVirtualTxs(_txids: string[]) {
                    // Requested [vtxoTx, intermediateTx], return [intermediateTx, vtxoTx] (reversed)
                    return {
                        txs: [
                            base64.encode(intermediateTx.tx.toPSBT()),
                            base64.encode(vtxoTx.tx.toPSBT()),
                        ],
                    };
                },
            };

            const result = await reconstructAndValidateVtxoDAG(
                { txid: vtxoTx.txid, vout: 0 },
                outOfOrderIndexer,
                onchain,
            );
            expect(result.valid).toBe(true);
            expect(result.vtxoRoot.txid).toBe(vtxoTx.txid);
            expect(result.anchoringLeaf.txid).toBe(intermediateTx.txid);
        });

        it("Finding B: should enforce minConfirmations directly from getTxStatus confirmations count", async () => {
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(16), 0, [
                { amount: 100000n, script: makeP2TRScript(0) },
            ]);
            const commitmentTxid = commitmentRaw.txid;

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: makeP2TRScript(0),
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[0]),
            });
            signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [
                { script: makeP2TRScript(0), amount: 100000n },
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

            // Onchain provider returning confirmations: 2
            const customOnchain: VerificationOnchainProvider = {
                async getRawTransaction(_txid: string) {
                    return hex.encode(commitmentRaw.tx.toBytes());
                },
                async getTxStatus(_txid: string) {
                    return { confirmed: true as const, confirmations: 2 };
                },
            };

            // minConfirmations = 2 should pass
            const passResult = await verifyVtxoComplete(
                { txid: vtxoTx.txid, vout: 0 },
                indexer,
                customOnchain,
                2,
            );
            expect(passResult.valid).toBe(true);

            // minConfirmations = 3 should fail
            await expect(
                verifyVtxoComplete({ txid: vtxoTx.txid, vout: 0 }, indexer, customOnchain, 3),
            ).rejects.toThrow("COMMITMENT_NOT_CONFIRMED");
        });

        it("Finding C (Decorative Key): should reject 2-key script with only 1 CHECKSIG operation (<pk1> DROP <pk2> CHECKSIG)", async () => {
            const pk1 = schnorr.getPublicKey(TEST_PRIVKEYS[0]);
            const pk2 = schnorr.getPublicKey(TEST_PRIVKEYS[1]);
            // Decorative second key script: <pk1> OP_DROP <pk2> OP_CHECKSIG (2 distinct keys, but only 1 CHECKSIG)
            const decorativeScript = Script.encode([pk1, "DROP", pk2, "CHECKSIG"]);
            const tr = p2tr(
                schnorr.getPublicKey(TEST_PRIVKEYS[2]),
                [{ script: decorativeScript, leafVersion: 0xc0 }],
                undefined,
                true,
            );

            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(134), 0, [
                { amount: 100000n, script: tr.script },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: tr.script,
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[2]),
                tapLeafScript: tr.tapLeafScript,
                tapMerkleRoot: tr.tapMerkleRoot,
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
            indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

            await expect(
                reconstructAndValidateVtxoDAG({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain),
            ).rejects.toThrow("INVALID_ARK_SCRIPT");
        });

        it("Finding D: should validate script-path signature length and sighash type", () => {
            const leafHash = new Uint8Array(32).fill(0x01);
            const pubKey = schnorr.getPublicKey(TEST_PRIVKEYS[0]);

            // 1. Unmatched leafHash should throw INVALID_SIGNATURE
            const unmatchedNode: any = {
                tx: {
                    getInput: () => ({
                        tapKeySig: undefined,
                        tapScriptSig: [[{ pubKey, leafHash }, new Uint8Array(64).fill(0xaa)]],
                        tapLeafScript: [
                            [
                                new Uint8Array(33).fill(0xc0),
                                new Uint8Array([...Script.encode([pubKey, "CHECKSIG"]), 0xc0]),
                            ],
                        ],
                    }),
                    preimageWitnessV1: () => new Uint8Array(32),
                },
                txid: fakeCommitmentTxid(17),
                ancestor: null,
                prevOutContext: { script: makeP2TRScript(0), amount: 100000n },
                children: new Map(),
            };

            expect(() => verifyNodeSignature(unmatchedNode)).toThrow("INVALID_SIGNATURE");

            // 2. Invalid signature length (e.g. 32 bytes) should throw INVALID_SIGNATURE_LENGTH
            const script = Script.encode([pubKey, "CHECKSIG"]);
            const matchedLeafHash = tapLeafHash(script, 0xc0);
            const invalidLenNode: any = {
                tx: {
                    getInput: () => ({
                        tapKeySig: undefined,
                        tapScriptSig: [
                            [
                                { pubKey, leafHash: matchedLeafHash },
                                new Uint8Array(32).fill(0xaa), // Invalid 32-byte signature
                            ],
                        ],
                        tapLeafScript: [
                            [new Uint8Array(33).fill(0xc0), new Uint8Array([...script, 0xc0])],
                        ],
                    }),
                    preimageWitnessV1: () => new Uint8Array(32),
                },
                txid: fakeCommitmentTxid(17),
                ancestor: null,
                prevOutContext: { script: makeP2TRScript(0), amount: 100000n },
                children: new Map(),
            };

            expect(() => verifyNodeSignature(invalidLenNode)).toThrow("INVALID_SIGNATURE_LENGTH");
        });

        it("Finding B: should enforce minConfirmations in fallback path when prevOutContext is missing", async () => {
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(18), 0, [
                { amount: 100000n, script: makeP2TRScript(0) },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: makeP2TRScript(0),
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[0]),
            });
            signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [
                { script: makeP2TRScript(0), amount: 100000n },
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

            // Provider reporting confirmed: true, confirmations: 1
            const fallbackOnchain: VerificationOnchainProvider = {
                async getRawTransaction(_txid: string) {
                    return hex.encode(commitmentRaw.tx.toBytes());
                },
                async getTxStatus(_txid: string) {
                    return { confirmed: true as const, confirmations: 1 };
                },
            };

            // minConfirmations = 1 should pass
            const pass = await verifyVtxoComplete(
                { txid: vtxoTx.txid, vout: 0 },
                indexer,
                fallbackOnchain,
                1,
            );
            expect(pass.valid).toBe(true);

            // minConfirmations = 2 should fail
            await expect(
                verifyVtxoComplete({ txid: vtxoTx.txid, vout: 0 }, indexer, fallbackOnchain, 2),
            ).rejects.toThrow("COMMITMENT_NOT_CONFIRMED");
        });
        it("Finding C (Residual Gap): should reject 2-key script with vacuous first CHECKSIG (<pk1> CHECKSIG DROP <pk2> CHECKSIG)", async () => {
            const pk1 = schnorr.getPublicKey(TEST_PRIVKEYS[0]);
            const pk2 = schnorr.getPublicKey(TEST_PRIVKEYS[1]);
            // Residual gap vector: <pk1> CHECKSIG DROP <pk2> CHECKSIG
            // 2 keys and 2 CHECKSIGs, but pk1 is discarded via DROP and only pk2 gates spend
            const bypassScript = Script.encode([pk1, "CHECKSIG", "DROP", pk2, "CHECKSIG"]);
            const tr = p2tr(
                schnorr.getPublicKey(TEST_PRIVKEYS[2]),
                [{ script: bypassScript, leafVersion: 0xc0 }],
                undefined,
                true,
            );

            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(135), 0, [
                { amount: 100000n, script: tr.script },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: tr.script,
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[2]),
                tapLeafScript: tr.tapLeafScript,
                tapMerkleRoot: tr.tapMerkleRoot,
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
            indexer.virtualTxs.set(vtxoTx.txid, base64.encode(vtxoTx.tx.toPSBT()));

            await expect(
                reconstructAndValidateVtxoDAG({ txid: vtxoTx.txid, vout: 0 }, indexer, onchain),
            ).rejects.toThrow("INVALID_ARK_SCRIPT");
        });

        it("Finding C (Allowlisted Templates): should accept valid BIP 342 collaborative multisig templates", async () => {
            const pk1 = schnorr.getPublicKey(TEST_PRIVKEYS[0]);
            const pk2 = schnorr.getPublicKey(TEST_PRIVKEYS[1]);

            // 1. BIP 342 CHECKSIGVERIFY template: <pk1> CHECKSIGVERIFY <pk2> CHECKSIG
            const verifyTemplate = Script.encode([pk1, "CHECKSIGVERIFY", pk2, "CHECKSIG"]);
            const tr1 = p2tr(
                schnorr.getPublicKey(TEST_PRIVKEYS[2]),
                [{ script: verifyTemplate, leafVersion: 0xc0 }],
                undefined,
                true,
            );

            const commitmentRaw1 = createVirtualTx(fakeCommitmentTxid(136), 0, [
                { amount: 100000n, script: tr1.script },
            ]);
            const commitmentTxid1 = commitmentRaw1.txid;
            onchain.txs.set(commitmentTxid1, hex.encode(commitmentRaw1.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid1);

            const vtxoTx1 = createVirtualTx(commitmentTxid1, 0, [{ amount: 100000n }], {
                parentScript: tr1.script,
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[2]),
                tapLeafScript: tr1.tapLeafScript,
                tapMerkleRoot: tr1.tapMerkleRoot,
            });
            signVirtualTx(vtxoTx1.tx, 0, TEST_PRIVKEYS[2], [
                { script: tr1.script, amount: 100000n },
            ]);

            indexer.chain = [
                {
                    txid: vtxoTx1.txid,
                    expiresAt: "2000000000",
                    type: ChainTxType.ARK,
                    spends: [commitmentTxid1],
                },
                {
                    txid: commitmentTxid1,
                    expiresAt: "2000000000",
                    type: ChainTxType.COMMITMENT,
                    spends: [],
                },
            ];
            indexer.virtualTxs.set(vtxoTx1.txid, base64.encode(vtxoTx1.tx.toPSBT()));

            const res1 = await reconstructAndValidateVtxoDAG(
                { txid: vtxoTx1.txid, vout: 0 },
                indexer,
                onchain,
            );
            expect(res1.valid).toBe(true);

            // 2. BIP 342 CHECKSIGADD template: <pk1> CHECKSIG <pk2> CHECKSIGADD 2 EQUAL
            const addTemplate = Script.encode([pk1, "CHECKSIG", pk2, "CHECKSIGADD", 2, "EQUAL"]);
            const tr2 = p2tr(
                schnorr.getPublicKey(TEST_PRIVKEYS[2]),
                [{ script: addTemplate, leafVersion: 0xc0 }],
                undefined,
                true,
            );

            const commitmentRaw2 = createVirtualTx(fakeCommitmentTxid(137), 0, [
                { amount: 100000n, script: tr2.script },
            ]);
            const commitmentTxid2 = commitmentRaw2.txid;
            onchain.txs.set(commitmentTxid2, hex.encode(commitmentRaw2.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid2);

            const vtxoTx2 = createVirtualTx(commitmentTxid2, 0, [{ amount: 100000n }], {
                parentScript: tr2.script,
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[2]),
                tapLeafScript: tr2.tapLeafScript,
                tapMerkleRoot: tr2.tapMerkleRoot,
            });
            signVirtualTx(vtxoTx2.tx, 0, TEST_PRIVKEYS[2], [
                { script: tr2.script, amount: 100000n },
            ]);

            indexer.chain = [
                {
                    txid: vtxoTx2.txid,
                    expiresAt: "2000000000",
                    type: ChainTxType.ARK,
                    spends: [commitmentTxid2],
                },
                {
                    txid: commitmentTxid2,
                    expiresAt: "2000000000",
                    type: ChainTxType.COMMITMENT,
                    spends: [],
                },
            ];
            indexer.virtualTxs.set(vtxoTx2.txid, base64.encode(vtxoTx2.tx.toPSBT()));

            const res2 = await reconstructAndValidateVtxoDAG(
                { txid: vtxoTx2.txid, vout: 0 },
                indexer,
                onchain,
            );
            expect(res2.valid).toBe(true);
        });

        it("Finding E: isTxIndexEnabled handles unsupported RPC method without caching errors on network failure", async () => {
            const provider = new BitcoinRpcProvider("http://localhost:18443", "user", "pass");

            // Case 1: RPC returns method not found (-32601) -> should return false and cache false
            const callMock = vi.spyOn(provider as any, "call");
            callMock.mockRejectedValueOnce(new BitcoinRpcError("Method not found", -32601));

            const res1 = await provider.isTxIndexEnabled();
            expect(res1).toBe(false);

            // Calling again should return cached false without calling RPC again
            const res2 = await provider.isTxIndexEnabled();
            expect(res2).toBe(false);
            expect(callMock).toHaveBeenCalledTimes(1);

            // Case 2: New provider instance encounters transient network error -> should rethrow and NOT cache
            const freshProvider = new BitcoinRpcProvider("http://localhost:18443", "user", "pass");
            const freshCallMock = vi.spyOn(freshProvider as any, "call");
            freshCallMock.mockRejectedValueOnce(
                new BitcoinRpcError("HTTP Error: 500 Internal Server Error", 500),
            );

            await expect(freshProvider.isTxIndexEnabled()).rejects.toThrow("HTTP Error: 500");

            // Next successful call can still evaluate correctly
            freshCallMock.mockResolvedValueOnce({ txindex: { synced: true } });
            const res3 = await freshProvider.isTxIndexEnabled();
            expect(res3).toBe(true);
        });

        it("prefers batch-scoped getBatchVtxos over getVtxoChain and fetches the sorted union of all batch virtual txs", async () => {
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(41), 0, [
                { amount: 100000n, script: makeP2TRScript(0) },
                { amount: 200000n, script: makeP2TRScript(1) },
            ]);
            const commitmentTxid = commitmentRaw.txid;
            onchain.txs.set(commitmentTxid, hex.encode(commitmentRaw.tx.toBytes()));
            onchain.confirmedTxids.add(commitmentTxid);

            const targetVtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: makeP2TRScript(0),
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[0]),
            });
            signVirtualTx(targetVtxoTx.tx, 0, TEST_PRIVKEYS[0], [
                { script: makeP2TRScript(0), amount: 100000n },
            ]);

            const siblingVtxoTx = createVirtualTx(commitmentTxid, 1, [{ amount: 200000n }], {
                parentScript: makeP2TRScript(1),
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[1]),
            });
            signVirtualTx(siblingVtxoTx.tx, 0, TEST_PRIVKEYS[1], [
                { script: makeP2TRScript(1), amount: 200000n },
            ]);

            const targetChain: ChainTx[] = [
                {
                    txid: targetVtxoTx.txid,
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
            const siblingChain: ChainTx[] = [
                {
                    txid: siblingVtxoTx.txid,
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

            const psbtByTxid = new Map<string, string>([
                [targetVtxoTx.txid, base64.encode(targetVtxoTx.tx.toPSBT())],
                [siblingVtxoTx.txid, base64.encode(siblingVtxoTx.tx.toPSBT())],
            ]);

            const getVtxoChain = vi.fn().mockResolvedValue({ chain: targetChain });
            const getBatchVtxos = vi
                .fn()
                .mockResolvedValue([{ chain: siblingChain }, { chain: targetChain }]);
            const getVirtualTxs = vi.fn().mockImplementation(async (txids: string[]) => ({
                txs: txids.map((id) => psbtByTxid.get(id) ?? ""),
            }));

            const dualIndexer: VerificationIndexerProvider = {
                getVtxoChain,
                getBatchVtxos,
                getVirtualTxs,
            };

            const res = await reconstructAndValidateVtxoDAG(
                { txid: targetVtxoTx.txid, vout: 0 },
                dualIndexer,
                onchain,
                undefined,
                commitmentTxid,
            );
            expect(res.valid).toBe(true);
            expect(getBatchVtxos).toHaveBeenCalledWith(commitmentTxid);
            expect(getVtxoChain).not.toHaveBeenCalled();

            // Must request the deterministically sorted union of ALL batch virtual txids,
            // never singling out targetVtxoTx.txid alone.
            const expectedSortedUnion = [targetVtxoTx.txid, siblingVtxoTx.txid].sort();
            expect(getVirtualTxs).toHaveBeenCalledWith(expectedSortedUnion);
        });

        it("fails closed with INVALID_PROVIDER when commitmentTxid is passed to a direct-only indexer lacking getBatchVtxos", async () => {
            const getVtxoChain = vi.fn();
            const directOnlyIndexer: VerificationIndexerProvider = {
                getVtxoChain,
                getVirtualTxs: vi.fn(),
            };

            await expect(
                reconstructAndValidateVtxoDAG(
                    { txid: fakeCommitmentTxid(60), vout: 0 },
                    directOnlyIndexer,
                    onchain,
                    undefined,
                    fakeCommitmentTxid(61),
                ),
            ).rejects.toThrow("INVALID_PROVIDER");

            expect(getVtxoChain).not.toHaveBeenCalled();
        });

        it("reports timelocksSatisfied=false and broadcastable=false when getBlockchainInfo is omitted", async () => {
            const commitmentRaw = createVirtualTx(fakeCommitmentTxid(42), 0, [
                { amount: 100000n, script: makeP2TRScript(0) },
            ]);
            const commitmentTxid = commitmentRaw.txid;

            const vtxoTx = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
                parentScript: makeP2TRScript(0),
                tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[0]),
            });
            signVirtualTx(vtxoTx.tx, 0, TEST_PRIVKEYS[0], [
                { script: makeP2TRScript(0), amount: 100000n },
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

            const noChainInfoOnchain: VerificationOnchainProvider = {
                getRawTransaction: async () => hex.encode(commitmentRaw.tx.toBytes()),
                getTxStatus: async () => ({ confirmed: true as const, confirmations: 1 }),
            };

            const res = await verifyVtxoComplete(
                { txid: vtxoTx.txid, vout: 0 },
                indexer,
                noChainInfoOnchain,
                1,
            );
            expect(res.valid).toBe(true);
            expect(res.timelocksSatisfied).toBe(false);
            expect(res.broadcastable).toBe(false);
        });

        it("scopes script-path signature completeness strictly per leafHash", () => {
            const priv1 = TEST_PRIVKEYS[0];
            const priv2 = TEST_PRIVKEYS[1];
            const pub1 = schnorr.getPublicKey(priv1);
            const pub2 = schnorr.getPublicKey(priv2);

            const leafA = Script.encode([pub1, "CHECKSIG"]);
            const leafB = Script.encode([pub1, "CHECKSIGVERIFY", pub2, "CHECKSIG"]);
            const leafHashA = tapLeafHash(leafA, 0xc0);
            const leafHashB = tapLeafHash(leafB, 0xc0);

            const msgA = new Uint8Array(32).fill(0x11);
            const msgB = new Uint8Array(32).fill(0x22);
            const sig1OnA = schnorr.sign(msgA, priv1);
            const sig2OnB = schnorr.sign(msgB, priv2);

            // pub1 signed leafA and pub2 signed leafB — leafB is still missing pub1's signature on leafB!
            const crossLeafNode: any = {
                tx: {
                    getInput: () => ({
                        tapKeySig: undefined,
                        tapScriptSig: [
                            [{ pubKey: pub1, leafHash: leafHashA }, sig1OnA],
                            [{ pubKey: pub2, leafHash: leafHashB }, sig2OnB],
                        ],
                        tapLeafScript: [
                            [new Uint8Array(33).fill(0xc0), new Uint8Array([...leafA, 0xc0])],
                            [new Uint8Array(33).fill(0xc0), new Uint8Array([...leafB, 0xc0])],
                        ],
                    }),
                    preimageWitnessV1: (
                        _idx: number,
                        _scripts: Uint8Array[],
                        _sighash: number,
                        _amounts: bigint[],
                        _codeSep: unknown,
                        script: Uint8Array,
                    ) => (hex.encode(script) === hex.encode(leafA) ? msgA : msgB),
                },
                txid: fakeCommitmentTxid(43),
                ancestor: null,
                prevOutContext: { script: makeP2TRScript(0), amount: 100000n },
                children: new Map(),
            };

            expect(() => verifyNodeSignature(crossLeafNode)).toThrow(/INCOMPLETE_SIGNATURES/);
        });

        it("ignores future CLTV on unexecuted alternate tapleaves during script-path timelock validation", () => {
            const claimKey = schnorr.getPublicKey(TEST_PRIVKEYS[1]);
            const refundKey = schnorr.getPublicKey(TEST_PRIVKEYS[2]);
            const preimageHash = ripemd160(sha256(new Uint8Array(32).fill(0x77)));

            const claimLeaf = Script.encode([
                "HASH160",
                preimageHash,
                "EQUALVERIFY",
                claimKey,
                "CHECKSIG",
            ]);
            const refundLeaf = Script.encode([
                refundKey,
                "CHECKSIGVERIFY",
                999_999,
                "CHECKLOCKTIMEVERIFY",
            ]);
            const claimLeafHash = tapLeafHash(claimLeaf, 0xc0);

            const node: any = {
                txid: fakeCommitmentTxid(44),
                tx: {
                    lockTime: 0,
                    getInput: () => ({
                        sequence: 0xffffffff,
                        tapKeySig: undefined,
                        tapScriptSig: [
                            [{ pubKey: claimKey, leafHash: claimLeafHash }, new Uint8Array(64)],
                        ],
                        tapLeafScript: [
                            [new Uint8Array(33).fill(0xc0), new Uint8Array([...claimLeaf, 0xc0])],
                            [new Uint8Array(33).fill(0xc0), new Uint8Array([...refundLeaf, 0xc0])],
                        ],
                    }),
                },
                children: new Map(),
            };

            const constraints = extractTimelockConstraints(node);
            expect(constraints.cltvValues).toEqual([]);
            expect(verifyNodeTimelocks(node, { currentHeight: 100, currentTime: 1700000000 })).toBe(
                true,
            );
        });

        it("rejects non-finite and non-positive-integer limits in ConcurrencyLimiter", () => {
            expect(() => new ConcurrencyLimiter(Number.NaN)).toThrow();
            expect(() => new ConcurrencyLimiter(Number.POSITIVE_INFINITY)).toThrow();
            expect(() => new ConcurrencyLimiter(0)).toThrow();
            expect(() => new ConcurrencyLimiter(-2)).toThrow();
            expect(() => new ConcurrencyLimiter(1.5)).toThrow();
            expect(() => new ConcurrencyLimiter(10)).not.toThrow();
        });
    });
});
