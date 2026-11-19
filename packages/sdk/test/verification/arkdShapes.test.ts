import { describe, it, expect, vi } from "vitest";
import { hex, base64 } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { Script, SigHash } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { equalBytes } from "@scure/btc-signer/utils.js";
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
    ChainTxType,
    computeTxid,
    reconstructAndValidateVtxoDAG,
    verifyVtxoComplete,
    type VerificationIndexerProvider,
    type VerificationStorageProvider,
} from "../../src/tree/vtxoDAGVerification.js";
import { validateTimelockSatisfiability } from "../../src/tree/timelockVerification.js";
import {
    extractExitSequence,
    executeSovereignUnroll,
    getBroadcastSequence,
    onReceiveVtxo,
} from "../../src/storage/sovereignStorage.js";
import { p2tr } from "@scure/btc-signer/payment.js";
import type { ExitFeeWallet } from "../../src/wallet/exit/executor.js";
import { VHTLC } from "../../src/script/vhtlc.js";
import {
    ConditionWitness,
    CosignerPublicKey,
    setArkPsbtField,
} from "../../src/utils/unknownFields.js";

class MemStorage implements VerificationStorageProvider {
    private m = new Map<string, string>();
    async setItem(k: string, v: string) {
        this.m.set(k, v);
    }
    async getItem(k: string) {
        return this.m.get(k) ?? null;
    }
    async removeItem(k: string) {
        this.m.delete(k);
    }
}

const feeWallet: ExitFeeWallet = {
    bumpAnchor: vi.fn(async (parentHex: string): Promise<[string, string]> => [parentHex, "child"]),
};

/** A TREE node shaped like arkd v0.9.25 builder.go getTx + musig2.go: v3, final sequence,
 * no internal key / merkle root / witnessUtxo, cosigner field, key-path tapKeySig only. */
function arkdTreeTx(parentTxid: string, prevScript: Uint8Array, privKey: Uint8Array) {
    const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
    tx.addInput({
        txid: parentTxid,
        index: 0,
        sequence: 0xffffffff,
        sighashType: SigHash.DEFAULT,
    });
    tx.addOutput({ amount: 100000n, script: makeP2TRScript(1) });
    setArkPsbtField(tx, 0, CosignerPublicKey, {
        index: 0,
        key: new Uint8Array([0x02, ...schnorr.getPublicKey(privKey)]),
    });
    signVirtualTx(tx, 0, privKey, [{ script: prevScript, amount: 100000n }]);
    const roundTripped = Transaction.fromPSBT(tx.toPSBT());
    return { tx: roundTripped, txid: computeTxid(roundTripped) };
}

function setupCommitment(onchain: MockOnchainProvider, seed: number) {
    const commitment = createVirtualTx(fakeCommitmentTxid(seed), 0, [
        { amount: 100000n, script: makeP2TRScript(0) },
    ]);
    onchain.txs.set(commitment.txid, hex.encode(commitment.tx.toBytes()));
    onchain.confirmedTxids.add(commitment.txid);
    return commitment.txid;
}

describe("arkd v0.9.25 TREE shape (key-path, no internal key)", () => {
    it("verifies, then finalizes with the key signature as the witness", async () => {
        const indexer = new MockIndexerProvider();
        const onchain = new MockOnchainProvider();
        const commitmentTxid = setupCommitment(onchain, 71);
        const tree = arkdTreeTx(commitmentTxid, makeP2TRScript(0), TEST_PRIVKEYS[0]);
        expect(tree.tx.getInput(0).tapInternalKey).toBeUndefined();
        expect(tree.tx.getInput(0).tapMerkleRoot).toBeUndefined();
        expect(tree.tx.getInput(0).tapKeySig).toBeDefined();

        indexer.chain = [
            {
                txid: tree.txid,
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
        indexer.virtualTxs.set(tree.txid, base64.encode(tree.tx.toPSBT()));

        const res = await verifyVtxoComplete({ txid: tree.txid, vout: 0 }, indexer, onchain);
        expect(res.valid).toBe(true);
        expect(res.timelocksSatisfied).toBe(true);

        const [raw] = extractExitSequence(res.anchoringLeaf, tree.txid);
        const finalized = Transaction.fromRaw(hex.decode(raw), { allowUnknownOutputs: true });
        expect(finalized.getInput(0).finalScriptWitness).toEqual([tree.tx.getInput(0).tapKeySig]);
    });

    it("rejects a key-path signature that does not verify against the prevout output key", async () => {
        const indexer = new MockIndexerProvider();
        const onchain = new MockOnchainProvider();
        const commitmentTxid = setupCommitment(onchain, 72);
        // signed by key 3 but the commitment output commits to key 0
        const tree = arkdTreeTx(commitmentTxid, makeP2TRScript(0), TEST_PRIVKEYS[3]);
        indexer.chain = [
            {
                txid: tree.txid,
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
        indexer.virtualTxs.set(tree.txid, base64.encode(tree.tx.toPSBT()));
        await expect(
            reconstructAndValidateVtxoDAG({ txid: tree.txid, vout: 0 }, indexer, onchain),
        ).rejects.toThrow(/INVALID_SIGNATURE/);
    });
});

/** Minimal tapscript evaluator for `SIZE 32 EQUALVERIFY HASH160 <h> EQUAL VERIFY <pk> CHECKSIGVERIFY <pk> CHECKSIG`. */
function evalTapscript(
    witness: Uint8Array[],
    sighash: (script: Uint8Array) => Uint8Array,
): boolean {
    const script = witness[witness.length - 2];
    const stack: Uint8Array[] = witness.slice(0, -2).map((w) => w);
    const ops = Script.decode(script);
    const num = (n: number) => (n === 0 ? new Uint8Array() : new Uint8Array([n]));
    const pop = () => {
        const v = stack.pop();
        if (!v) throw new Error("stack underflow");
        return v;
    };
    const truthy = (v: Uint8Array) => v.some((b) => b !== 0);
    for (const op of ops) {
        if (op instanceof Uint8Array) stack.push(op);
        else if (typeof op === "number") stack.push(num(op));
        else if (op === "SIZE") stack.push(num(stack[stack.length - 1].length));
        else if (op === "HASH160") stack.push(ripemd160(sha256(pop())));
        else if (op === "EQUAL" || op === "EQUALVERIFY") {
            const eq = equalBytes(pop(), pop());
            if (op === "EQUALVERIFY") {
                if (!eq) return false;
            } else stack.push(eq ? new Uint8Array([1]) : new Uint8Array());
        } else if (op === "VERIFY") {
            if (!truthy(pop())) return false;
        } else if (op === "CHECKSIG" || op === "CHECKSIGVERIFY") {
            const pk = pop();
            const sig = pop();
            const ok = schnorr.verify(sig, sighash(script), pk);
            if (op === "CHECKSIGVERIFY") {
                if (!ok) return false;
            } else stack.push(ok ? new Uint8Array([1]) : new Uint8Array());
        } else throw new Error(`unsupported op ${String(op)}`);
    }
    return stack.length === 1 && truthy(stack[0]);
}

describe("VHTLC claim keeps the Ark ConditionWitness through sovereign finalization", () => {
    const receiver = TEST_PRIVKEYS[4];
    const server = TEST_PRIVKEYS[5];
    const sender = TEST_PRIVKEYS[6];
    const preimage = new Uint8Array(32).fill(0x42);
    const vhtlc = new VHTLC.ScriptV2({
        sender: schnorr.getPublicKey(sender),
        receiver: schnorr.getPublicKey(receiver),
        server: schnorr.getPublicKey(server),
        preimageHash: ripemd160(sha256(preimage)),
        refundLocktime: 1000n,
        unilateralClaimDelay: { type: "blocks", value: 100n },
        unilateralRefundDelay: { type: "blocks", value: 50n },
        unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 60n },
    });

    it("fails closed in sovereign extractExitSequence on wrong preimage, unconditional two-leaf spend, or ambiguous multi-leaf tapScriptSig", () => {
        const pk1 = schnorr.getPublicKey(receiver);
        const pk2 = schnorr.getPublicKey(server);
        const uncondScript = Script.encode([pk1, "CHECKSIGVERIFY", pk2, "CHECKSIG"]);
        const condScript = Script.encode([
            "HASH160",
            ripemd160(sha256(preimage)),
            "EQUAL",
            "VERIFY",
            pk1,
            "CHECKSIGVERIFY",
            pk2,
            "CHECKSIG",
        ]);
        const tr = p2tr(
            schnorr.getPublicKey(sender),
            [{ script: uncondScript }, { script: condScript }],
            undefined,
            true,
        );

        const makeNode = (tx: Transaction) => {
            const txid = computeTxid(tx);
            return {
                txid,
                tx,
                chainTx: { txid, expiresAt: "2000000000", type: ChainTxType.ARK, spends: [] },
                rawPsbt: base64.encode(tx.toPSBT()),
                children: new Map(),
                ancestor: null,
                ancestorOutputIndex: 0,
                descendant: null,
            };
        };

        // 1. Two-leaf PSBT spending unconditional leaf + unrelated ConditionWitness -> sovereign fails closed
        {
            const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
            tx.addInput({
                txid: "11".repeat(32),
                index: 0,
                witnessUtxo: { amount: 50000n, script: tr.script },
                tapLeafScript: tr.tapLeafScript,
            });
            tx.addOutput({ amount: 50000n, script: makeP2TRScript(2) });
            const sh = tx.preimageWitnessV1(
                0,
                [tr.script],
                SigHash.DEFAULT,
                [50000n],
                undefined,
                uncondScript,
                0xc0,
            );
            const lh = tapLeafHash(uncondScript, 0xc0);
            tx.updateInput(0, {
                tapScriptSig: [receiver, server].map(
                    (k) =>
                        [
                            { pubKey: schnorr.getPublicKey(k), leafHash: lh },
                            schnorr.sign(sh, k),
                        ] as [{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array],
                ),
            });
            setArkPsbtField(tx, 0, ConditionWitness, [preimage]);
            const node = makeNode(tx);
            expect(() => extractExitSequence(node, node.txid)).toThrow(/INVALID_CONDITION_WITNESS/);
        }

        // 2. Two-leaf PSBT with tapScriptSig spanning BOTH leaves + ConditionWitness -> sovereign fails closed (no multi-leaf guessing)
        {
            const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
            tx.addInput({
                txid: "12".repeat(32),
                index: 0,
                witnessUtxo: { amount: 50000n, script: tr.script },
                tapLeafScript: tr.tapLeafScript,
            });
            tx.addOutput({ amount: 50000n, script: makeP2TRScript(2) });
            const shUncond = tx.preimageWitnessV1(
                0,
                [tr.script],
                SigHash.DEFAULT,
                [50000n],
                undefined,
                uncondScript,
                0xc0,
            );
            const shCond = tx.preimageWitnessV1(
                0,
                [tr.script],
                SigHash.DEFAULT,
                [50000n],
                undefined,
                condScript,
                0xc0,
            );
            const lhUncond = tapLeafHash(uncondScript, 0xc0);
            const lhCond = tapLeafHash(condScript, 0xc0);
            tx.updateInput(0, {
                tapScriptSig: [
                    [{ pubKey: pk1, leafHash: lhUncond }, schnorr.sign(shUncond, receiver)],
                    [{ pubKey: pk1, leafHash: lhCond }, schnorr.sign(shCond, receiver)],
                    [{ pubKey: pk2, leafHash: lhCond }, schnorr.sign(shCond, server)],
                ],
            });
            setArkPsbtField(tx, 0, ConditionWitness, [preimage]);
            const node = makeNode(tx);
            expect(() => extractExitSequence(node, node.txid)).toThrow(/INVALID_CONDITION_WITNESS/);
        }

        // 3. Wrong preimage in VHTLC.ScriptV2 claim -> sovereign extractExitSequence fails closed
        {
            const leaf = vhtlc.claim();
            const script = leaf[1].slice(0, -1);
            const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
            tx.addInput({
                txid: "13".repeat(32),
                index: 0,
                witnessUtxo: { amount: 50000n, script: vhtlc.pkScript },
                tapLeafScript: [leaf],
            });
            tx.addOutput({ amount: 50000n, script: makeP2TRScript(2) });
            const sh = tx.preimageWitnessV1(
                0,
                [vhtlc.pkScript],
                SigHash.DEFAULT,
                [50000n],
                undefined,
                script,
                0xc0,
            );
            const lh = tapLeafHash(script, 0xc0);
            tx.updateInput(0, {
                tapScriptSig: [receiver, server].map(
                    (k) =>
                        [
                            { pubKey: schnorr.getPublicKey(k), leafHash: lh },
                            schnorr.sign(sh, k),
                        ] as [{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array],
                ),
            });
            setArkPsbtField(tx, 0, ConditionWitness, [new Uint8Array(32).fill(0x43)]);
            const node = makeNode(tx);
            expect(() => extractExitSequence(node, node.txid)).toThrow(/INVALID_HASH_PREIMAGE/);
        }
    });

    it("extractExitSequence preserves ConditionWitness on a verified VHTLC claim DAG", async () => {
        const indexer = new MockIndexerProvider();
        const onchain = new MockOnchainProvider();
        const commitment = createVirtualTx(fakeCommitmentTxid(78), 0, [
            { amount: 50000n, script: vhtlc.pkScript },
        ]);
        onchain.txs.set(commitment.txid, hex.encode(commitment.tx.toBytes()));
        onchain.confirmedTxids.add(commitment.txid);

        const leaf = vhtlc.claim();
        const script = leaf[1].slice(0, -1);
        const claimTx = new Transaction({ version: 3, allowUnknownOutputs: true });
        claimTx.addInput({
            txid: commitment.txid,
            index: 0,
            witnessUtxo: { amount: 50000n, script: vhtlc.pkScript },
            tapLeafScript: [leaf],
        });
        claimTx.addOutput({ amount: 50000n, script: makeP2TRScript(2) });
        const sighash = claimTx.preimageWitnessV1(
            0,
            [vhtlc.pkScript],
            SigHash.DEFAULT,
            [50000n],
            undefined,
            script,
            0xc0,
        );
        const leafHash = tapLeafHash(script, 0xc0);
        claimTx.updateInput(0, {
            tapScriptSig: [receiver, server].map(
                (k) =>
                    [{ pubKey: schnorr.getPublicKey(k), leafHash }, schnorr.sign(sighash, k)] as [
                        { pubKey: Uint8Array; leafHash: Uint8Array },
                        Uint8Array,
                    ],
            ),
        });
        setArkPsbtField(claimTx, 0, ConditionWitness, [preimage]);
        const claimTxid = computeTxid(claimTx);

        indexer.chain = [
            {
                txid: claimTxid,
                expiresAt: "2000000000",
                type: ChainTxType.ARK,
                spends: [commitment.txid],
            },
            {
                txid: commitment.txid,
                expiresAt: "2000000000",
                type: ChainTxType.COMMITMENT,
                spends: [],
            },
        ];
        indexer.virtualTxs.set(claimTxid, base64.encode(claimTx.toPSBT()));

        const preimages = new Map([[hex.encode(ripemd160(sha256(preimage))), preimage]]);
        const verified = await verifyVtxoComplete(
            { txid: claimTxid, vout: 0 },
            indexer,
            onchain,
            1,
            preimages,
        );
        expect(verified.valid).toBe(true);

        const [rawHex] = extractExitSequence(verified.anchoringLeaf, claimTxid);
        const parsed = Transaction.fromRaw(hex.decode(rawHex), { allowUnknownOutputs: true });
        const witness = parsed.getInput(0).finalScriptWitness!;
        expect(witness).toHaveLength(5);
        expect(witness[2]).toEqual(preimage);
        expect(evalTapscript(witness, () => sighash)).toBe(true);

        // Genuine case through onReceiveVtxo persists encrypted finalized witness cleanly (even without external map)
        const storage = new MemStorage();
        const storageKey = new Uint8Array(32).fill(0x5c);
        const recv = await onReceiveVtxo(
            { txid: claimTxid, vout: 0 },
            indexer,
            onchain,
            storage,
            storageKey,
        );
        expect(recv.success).toBe(true);
        expect(recv.broadcastable).toBe(true);
        const [storedHex] = await getBroadcastSequence(claimTxid, storage, storageKey);
        const storedWitness = Transaction.fromRaw(hex.decode(storedHex), {
            allowUnknownOutputs: true,
        }).getInput(0).finalScriptWitness!;
        expect(storedWitness).toHaveLength(5);
        expect(storedWitness[2]).toEqual(preimage);
        expect(evalTapscript(storedWitness, () => sighash)).toBe(true);
    });

    it("rejects wrong or missing ConditionWitness in verifyVtxoComplete and onReceiveVtxo with zero storage writes even when a good external preimage map is supplied", async () => {
        const goodPreimages = new Map([[hex.encode(ripemd160(sha256(preimage))), preimage]]);
        const storageKey = new Uint8Array(32).fill(0x5d);

        async function runCase(
            seed: number,
            conditionField: Uint8Array[] | "omit",
            expectedCode: RegExp,
        ) {
            const indexer = new MockIndexerProvider();
            const onchain = new MockOnchainProvider();
            const commitment = createVirtualTx(fakeCommitmentTxid(seed), 0, [
                { amount: 50000n, script: vhtlc.pkScript },
            ]);
            onchain.txs.set(commitment.txid, hex.encode(commitment.tx.toBytes()));
            onchain.confirmedTxids.add(commitment.txid);

            const leaf = vhtlc.claim();
            const script = leaf[1].slice(0, -1);
            const claimTx = new Transaction({ version: 3, allowUnknownOutputs: true });
            claimTx.addInput({
                txid: commitment.txid,
                index: 0,
                witnessUtxo: { amount: 50000n, script: vhtlc.pkScript },
                tapLeafScript: [leaf],
            });
            claimTx.addOutput({ amount: 50000n, script: makeP2TRScript(2) });
            const sighash = claimTx.preimageWitnessV1(
                0,
                [vhtlc.pkScript],
                SigHash.DEFAULT,
                [50000n],
                undefined,
                script,
                0xc0,
            );
            const leafHash = tapLeafHash(script, 0xc0);
            claimTx.updateInput(0, {
                tapScriptSig: [receiver, server].map(
                    (k) =>
                        [
                            { pubKey: schnorr.getPublicKey(k), leafHash },
                            schnorr.sign(sighash, k),
                        ] as [{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array],
                ),
            });
            if (conditionField !== "omit") {
                setArkPsbtField(claimTx, 0, ConditionWitness, conditionField);
            }
            const claimTxid = computeTxid(claimTx);

            indexer.chain = [
                {
                    txid: claimTxid,
                    expiresAt: "2000000000",
                    type: ChainTxType.ARK,
                    spends: [commitment.txid],
                },
                {
                    txid: commitment.txid,
                    expiresAt: "2000000000",
                    type: ChainTxType.COMMITMENT,
                    spends: [],
                },
            ];
            indexer.virtualTxs.set(claimTxid, base64.encode(claimTx.toPSBT()));

            // 1. verifyVtxoComplete MUST fail even with a good external preimage map
            await expect(
                verifyVtxoComplete(
                    { txid: claimTxid, vout: 0 },
                    indexer,
                    onchain,
                    1,
                    goodPreimages,
                ),
            ).rejects.toThrow(expectedCode);

            // 2. onReceiveVtxo MUST fail with ZERO writes to storage (both with and without external map)
            const storage = new MemStorage();
            const setSpy = vi.spyOn(storage, "setItem");
            const recvWithMap = await onReceiveVtxo(
                { txid: claimTxid, vout: 0 },
                indexer,
                onchain,
                storage,
                storageKey,
                1,
                goodPreimages,
            );
            expect(recvWithMap.success).toBe(false);
            expect(recvWithMap.error).toMatch(expectedCode);
            expect(setSpy).not.toHaveBeenCalled();

            const recvNoMap = await onReceiveVtxo(
                { txid: claimTxid, vout: 0 },
                indexer,
                onchain,
                storage,
                storageKey,
            );
            expect(recvNoMap.success).toBe(false);
            expect(recvNoMap.error).toMatch(expectedCode);
            expect(setSpy).not.toHaveBeenCalled();
            expect(await storage.getItem(`arkade_exit_data_${claimTxid}`)).toBeNull();
        }

        // Wrong preimage in PSBT ConditionWitness
        await runCase(79, [new Uint8Array(32).fill(0x99)], /INVALID_HASH_PREIMAGE/);
        // Missing ConditionWitness in PSBT
        await runCase(80, "omit", /MISSING_CONDITION_WITNESS/);
        // Empty ConditionWitness in PSBT
        await runCase(81, [], /MISSING_CONDITION_WITNESS/);
        // Extra witness item in ConditionWitness (would break CLEANSTACK / sig alignment)
        await runCase(82, [preimage, new Uint8Array([1])], /INVALID_CONDITION_WITNESS/);
    });

    it("enforces OP_SIZE on VHTLC v2 preimage and fails closed on unsupported or unexpected conditions with zero writes", async () => {
        const storageKey = new Uint8Array(32).fill(0x5e);

        // 1. Short 31-byte preimage whose HASH160 matches the script's hash but fails SIZE 32 EQUALVERIFY
        const shortPreimage = new Uint8Array(31).fill(0x77);
        const shortVhtlc = new VHTLC.ScriptV2({
            sender: schnorr.getPublicKey(sender),
            receiver: schnorr.getPublicKey(receiver),
            server: schnorr.getPublicKey(server),
            preimageHash: ripemd160(sha256(shortPreimage)),
            refundLocktime: 1000n,
            unilateralClaimDelay: { type: "blocks", value: 100n },
            unilateralRefundDelay: { type: "blocks", value: 50n },
            unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 60n },
        });
        {
            const indexer = new MockIndexerProvider();
            const onchain = new MockOnchainProvider();
            const commitment = createVirtualTx(fakeCommitmentTxid(83), 0, [
                { amount: 50000n, script: shortVhtlc.pkScript },
            ]);
            onchain.txs.set(commitment.txid, hex.encode(commitment.tx.toBytes()));
            onchain.confirmedTxids.add(commitment.txid);

            const leaf = shortVhtlc.claim();
            const script = leaf[1].slice(0, -1);
            const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
            tx.addInput({
                txid: commitment.txid,
                index: 0,
                witnessUtxo: { amount: 50000n, script: shortVhtlc.pkScript },
                tapLeafScript: [leaf],
            });
            tx.addOutput({ amount: 50000n, script: makeP2TRScript(2) });
            const sighash = tx.preimageWitnessV1(
                0,
                [shortVhtlc.pkScript],
                SigHash.DEFAULT,
                [50000n],
                undefined,
                script,
                0xc0,
            );
            const leafHash = tapLeafHash(script, 0xc0);
            tx.updateInput(0, {
                tapScriptSig: [receiver, server].map(
                    (k) =>
                        [
                            { pubKey: schnorr.getPublicKey(k), leafHash },
                            schnorr.sign(sighash, k),
                        ] as [{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array],
                ),
            });
            setArkPsbtField(tx, 0, ConditionWitness, [shortPreimage]);
            const txid = computeTxid(tx);

            indexer.chain = [
                { txid, expiresAt: "2000000000", type: ChainTxType.ARK, spends: [commitment.txid] },
                {
                    txid: commitment.txid,
                    expiresAt: "2000000000",
                    type: ChainTxType.COMMITMENT,
                    spends: [],
                },
            ];
            indexer.virtualTxs.set(txid, base64.encode(tx.toPSBT()));

            const storage = new MemStorage();
            const setSpy = vi.spyOn(storage, "setItem");
            const res = await onReceiveVtxo(
                { txid, vout: 0 },
                indexer,
                onchain,
                storage,
                storageKey,
            );
            expect(res.success).toBe(false);
            expect(res.error).toMatch(/INVALID_HASH_PREIMAGE/);
            expect(setSpy).not.toHaveBeenCalled();
        }

        // 2. Unsupported condition script before VERIFY (OP_0 VERIFY <pk1> CHECKSIGVERIFY <pk2> CHECKSIG)
        {
            const pk1 = schnorr.getPublicKey(receiver);
            const pk2 = schnorr.getPublicKey(server);
            const unsupportedScript = Script.encode([
                0,
                "VERIFY",
                pk1,
                "CHECKSIGVERIFY",
                pk2,
                "CHECKSIG",
            ]);
            const tr = p2tr(
                schnorr.getPublicKey(sender),
                { script: unsupportedScript },
                undefined,
                true,
            );
            const indexer = new MockIndexerProvider();
            const onchain = new MockOnchainProvider();
            const commitment = createVirtualTx(fakeCommitmentTxid(84), 0, [
                { amount: 50000n, script: tr.script },
            ]);
            onchain.txs.set(commitment.txid, hex.encode(commitment.tx.toBytes()));
            onchain.confirmedTxids.add(commitment.txid);

            const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
            tx.addInput({
                txid: commitment.txid,
                index: 0,
                witnessUtxo: { amount: 50000n, script: tr.script },
                tapLeafScript: tr.tapLeafScript,
            });
            tx.addOutput({ amount: 50000n, script: makeP2TRScript(2) });
            const sighash = tx.preimageWitnessV1(
                0,
                [tr.script],
                SigHash.DEFAULT,
                [50000n],
                undefined,
                unsupportedScript,
                0xc0,
            );
            const leafHash = tapLeafHash(unsupportedScript, 0xc0);
            tx.updateInput(0, {
                tapScriptSig: [receiver, server].map(
                    (k) =>
                        [
                            { pubKey: schnorr.getPublicKey(k), leafHash },
                            schnorr.sign(sighash, k),
                        ] as [{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array],
                ),
            });
            setArkPsbtField(tx, 0, ConditionWitness, [new Uint8Array([1])]);
            const txid = computeTxid(tx);

            indexer.chain = [
                { txid, expiresAt: "2000000000", type: ChainTxType.ARK, spends: [commitment.txid] },
                {
                    txid: commitment.txid,
                    expiresAt: "2000000000",
                    type: ChainTxType.COMMITMENT,
                    spends: [],
                },
            ];
            indexer.virtualTxs.set(txid, base64.encode(tx.toPSBT()));

            const storage = new MemStorage();
            const setSpy = vi.spyOn(storage, "setItem");
            const res = await onReceiveVtxo(
                { txid, vout: 0 },
                indexer,
                onchain,
                storage,
                storageKey,
            );
            expect(res.success).toBe(false);
            expect(res.error).toMatch(/UNSUPPORTED_CONDITION_SCRIPT/);
            expect(setSpy).not.toHaveBeenCalled();
        }

        // 3. Unexpected ConditionWitness on an unconditional collaborative multisig leaf
        {
            const pk1 = schnorr.getPublicKey(receiver);
            const pk2 = schnorr.getPublicKey(server);
            const plainMultisig = Script.encode([pk1, "CHECKSIGVERIFY", pk2, "CHECKSIG"]);
            const tr = p2tr(
                schnorr.getPublicKey(sender),
                { script: plainMultisig },
                undefined,
                true,
            );
            const indexer = new MockIndexerProvider();
            const onchain = new MockOnchainProvider();
            const commitment = createVirtualTx(fakeCommitmentTxid(85), 0, [
                { amount: 50000n, script: tr.script },
            ]);
            onchain.txs.set(commitment.txid, hex.encode(commitment.tx.toBytes()));
            onchain.confirmedTxids.add(commitment.txid);

            const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
            tx.addInput({
                txid: commitment.txid,
                index: 0,
                witnessUtxo: { amount: 50000n, script: tr.script },
                tapLeafScript: tr.tapLeafScript,
            });
            tx.addOutput({ amount: 50000n, script: makeP2TRScript(2) });
            const sighash = tx.preimageWitnessV1(
                0,
                [tr.script],
                SigHash.DEFAULT,
                [50000n],
                undefined,
                plainMultisig,
                0xc0,
            );
            const leafHash = tapLeafHash(plainMultisig, 0xc0);
            tx.updateInput(0, {
                tapScriptSig: [receiver, server].map(
                    (k) =>
                        [
                            { pubKey: schnorr.getPublicKey(k), leafHash },
                            schnorr.sign(sighash, k),
                        ] as [{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array],
                ),
            });
            setArkPsbtField(tx, 0, ConditionWitness, [preimage]);
            const txid = computeTxid(tx);

            indexer.chain = [
                { txid, expiresAt: "2000000000", type: ChainTxType.ARK, spends: [commitment.txid] },
                {
                    txid: commitment.txid,
                    expiresAt: "2000000000",
                    type: ChainTxType.COMMITMENT,
                    spends: [],
                },
            ];
            indexer.virtualTxs.set(txid, base64.encode(tx.toPSBT()));

            const storage = new MemStorage();
            const setSpy = vi.spyOn(storage, "setItem");
            const res = await onReceiveVtxo(
                { txid, vout: 0 },
                indexer,
                onchain,
                storage,
                storageKey,
            );
            expect(res.success).toBe(false);
            expect(res.error).toMatch(/INVALID_CONDITION_WITNESS/);
            expect(setSpy).not.toHaveBeenCalled();
        }

        // 4. Pre-populated poisoned finalScriptWitness alongside valid tapScriptSig + valid ConditionWitness
        {
            const indexer = new MockIndexerProvider();
            const onchain = new MockOnchainProvider();
            const commitment = createVirtualTx(fakeCommitmentTxid(86), 0, [
                { amount: 50000n, script: vhtlc.pkScript },
            ]);
            onchain.txs.set(commitment.txid, hex.encode(commitment.tx.toBytes()));
            onchain.confirmedTxids.add(commitment.txid);

            const leaf = vhtlc.claim();
            const script = leaf[1].slice(0, -1);
            const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
            tx.addInput({
                txid: commitment.txid,
                index: 0,
                witnessUtxo: { amount: 50000n, script: vhtlc.pkScript },
                tapLeafScript: [leaf],
            });
            tx.addOutput({ amount: 50000n, script: makeP2TRScript(2) });
            const sighash = tx.preimageWitnessV1(
                0,
                [vhtlc.pkScript],
                SigHash.DEFAULT,
                [50000n],
                undefined,
                script,
                0xc0,
            );
            const leafHash = tapLeafHash(script, 0xc0);
            tx.updateInput(0, {
                tapScriptSig: [receiver, server].map(
                    (k) =>
                        [
                            { pubKey: schnorr.getPublicKey(k), leafHash },
                            schnorr.sign(sighash, k),
                        ] as [{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array],
                ),
                finalScriptWitness: [new Uint8Array(32).fill(0x99)],
            });
            setArkPsbtField(tx, 0, ConditionWitness, [preimage]);
            const txid = computeTxid(tx);

            indexer.chain = [
                { txid, expiresAt: "2000000000", type: ChainTxType.ARK, spends: [commitment.txid] },
                {
                    txid: commitment.txid,
                    expiresAt: "2000000000",
                    type: ChainTxType.COMMITMENT,
                    spends: [],
                },
            ];
            indexer.virtualTxs.set(txid, base64.encode(tx.toPSBT()));

            const storage = new MemStorage();
            const setSpy = vi.spyOn(storage, "setItem");
            const res = await onReceiveVtxo(
                { txid, vout: 0 },
                indexer,
                onchain,
                storage,
                storageKey,
            );
            expect(res.success).toBe(false);
            expect(res.error).toMatch(/INVALID_CONDITION_WITNESS/);
            expect(setSpy).not.toHaveBeenCalled();
        }
    });

    it("enforces tapscript relay-policy (80B) and consensus (520B) preimage limits on legacy VHTLC.Script with zero writes while accepting valid legacy v1 claims", async () => {
        const storageKey = new Uint8Array(32).fill(0x5f);

        function buildLegacyV1Claim(seed: number, claimPreimage: Uint8Array) {
            const hash = ripemd160(sha256(claimPreimage));
            const legacyVhtlc = new VHTLC.Script({
                sender: schnorr.getPublicKey(sender),
                receiver: schnorr.getPublicKey(receiver),
                server: schnorr.getPublicKey(server),
                preimageHash: hash,
                refundLocktime: 1000n,
                unilateralClaimDelay: { type: "blocks", value: 100n },
                unilateralRefundDelay: { type: "blocks", value: 50n },
                unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 60n },
            });
            const indexer = new MockIndexerProvider();
            const onchain = new MockOnchainProvider();
            const commitment = createVirtualTx(fakeCommitmentTxid(seed), 0, [
                { amount: 50000n, script: legacyVhtlc.pkScript },
            ]);
            onchain.txs.set(commitment.txid, hex.encode(commitment.tx.toBytes()));
            onchain.confirmedTxids.add(commitment.txid);

            const leaf = legacyVhtlc.claim();
            const script = leaf[1].slice(0, -1);
            const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
            tx.addInput({
                txid: commitment.txid,
                index: 0,
                witnessUtxo: { amount: 50000n, script: legacyVhtlc.pkScript },
                tapLeafScript: [leaf],
            });
            tx.addOutput({ amount: 50000n, script: makeP2TRScript(2) });
            const sighash = tx.preimageWitnessV1(
                0,
                [legacyVhtlc.pkScript],
                SigHash.DEFAULT,
                [50000n],
                undefined,
                script,
                0xc0,
            );
            const leafHash = tapLeafHash(script, 0xc0);
            tx.updateInput(0, {
                tapScriptSig: [receiver, server].map(
                    (k) =>
                        [
                            { pubKey: schnorr.getPublicKey(k), leafHash },
                            schnorr.sign(sighash, k),
                        ] as [{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array],
                ),
            });
            setArkPsbtField(tx, 0, ConditionWitness, [claimPreimage]);
            const txid = computeTxid(tx);

            indexer.chain = [
                { txid, expiresAt: "2000000000", type: ChainTxType.ARK, spends: [commitment.txid] },
                {
                    txid: commitment.txid,
                    expiresAt: "2000000000",
                    type: ChainTxType.COMMITMENT,
                    spends: [],
                },
            ];
            indexer.virtualTxs.set(txid, base64.encode(tx.toPSBT()));
            return {
                txid,
                indexer,
                onchain,
                sighash,
                preimageMap: new Map([[hex.encode(hash), claimPreimage]]),
            };
        }

        // 1. Valid 32-byte legacy VHTLC.Script (v1) claim passes verifyVtxoComplete + onReceiveVtxo and evaluates true
        for (const [seed, len] of [
            [87, 32],
            [88, 80], // exact Bitcoin Core MAX_STANDARD_TAPSCRIPT_STACK_ITEM_SIZE relay boundary
        ] as const) {
            const p = new Uint8Array(len).fill(0x41);
            const { txid, indexer, onchain, sighash } = buildLegacyV1Claim(seed, p);
            const storage = new MemStorage();
            const recv = await onReceiveVtxo(
                { txid, vout: 0 },
                indexer,
                onchain,
                storage,
                storageKey,
            );
            expect(recv.success).toBe(true);
            expect(recv.broadcastable).toBe(true);
            const [storedHex] = await getBroadcastSequence(txid, storage, storageKey);
            const witness = Transaction.fromRaw(hex.decode(storedHex), {
                allowUnknownOutputs: true,
            }).getInput(0).finalScriptWitness!;
            expect(witness).toHaveLength(5);
            expect(witness[2]).toEqual(p);
            expect(evalTapscript(witness, () => sighash)).toBe(true);
        }

        // 2. Oversized hash-matching legacy VHTLC.Script claims at relay-policy (+1: 81B) and
        //    consensus (520B / +1: 521B) boundaries fail BEFORE persistence with zero writes
        for (const [seed, len, expectedMsg] of [
            [89, 81, /relay policy limit \(80 bytes\)/],
            [90, 520, /relay policy limit \(80 bytes\)/],
            [91, 521, /consensus stack item limit \(520 bytes\)/],
        ] as const) {
            const oversized = new Uint8Array(len).fill(0x42);
            const { txid, indexer, onchain, preimageMap } = buildLegacyV1Claim(seed, oversized);

            await expect(
                verifyVtxoComplete({ txid, vout: 0 }, indexer, onchain, 1, preimageMap),
            ).rejects.toThrow(/INVALID_CONDITION_WITNESS/);

            const storage = new MemStorage();
            const setSpy = vi.spyOn(storage, "setItem");

            const recvNoMap = await onReceiveVtxo(
                { txid, vout: 0 },
                indexer,
                onchain,
                storage,
                storageKey,
            );
            expect(recvNoMap.success).toBe(false);
            expect(recvNoMap.error).toMatch(/INVALID_CONDITION_WITNESS/);
            expect(recvNoMap.error).toMatch(expectedMsg);
            expect(setSpy).not.toHaveBeenCalled();

            const recvWithMap = await onReceiveVtxo(
                { txid, vout: 0 },
                indexer,
                onchain,
                storage,
                storageKey,
                1,
                preimageMap,
            );
            expect(recvWithMap.success).toBe(false);
            expect(recvWithMap.error).toMatch(/INVALID_CONDITION_WITNESS/);
            expect(recvWithMap.error).toMatch(expectedMsg);
            expect(setSpy).not.toHaveBeenCalled();
            expect(await storage.getItem(`arkade_exit_data_${txid}`)).toBeNull();
        }
    });
});

describe("timelock boundaries and unroll-only behaviour", () => {
    const base = {
        nSequence: 0xfffffffe,
        csvValues: [],
        cltvValues: [],
        sequenceType: "disabled" as const,
        isKeyPathSpend: true,
        txVersion: 2,
    };

    it("treats a timestamp locktime equal to tip MTP as immature (BIP-113)", () => {
        const c = { ...base, nLockTime: 1_700_000_000, lockTimeType: "time" as const };
        expect(
            validateTimelockSatisfiability(
                c,
                { currentHeight: 1, currentTime: 1_700_000_000 },
                "t",
            ),
        ).toBe(false);
        expect(
            validateTimelockSatisfiability(
                c,
                { currentHeight: 1, currentTime: 1_700_000_001 },
                "t",
            ),
        ).toBe(true);
    });

    async function persistedHop(lockTime: number) {
        const indexer = new MockIndexerProvider();
        const onchain = new MockOnchainProvider();
        onchain.autoConfirmBroadcast = true;
        const storage = new MemStorage();
        const key = new Uint8Array(32).fill(7);
        const commitmentTxid = setupCommitment(onchain, 73);
        const vtxo = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
            parentScript: makeP2TRScript(0),
            tapInternalKey: schnorr.getPublicKey(TEST_PRIVKEYS[0]),
            lockTime,
        });
        signVirtualTx(vtxo.tx, 0, TEST_PRIVKEYS[0], [
            { script: makeP2TRScript(0), amount: 100000n },
        ]);
        indexer.chain = [
            {
                txid: vtxo.txid,
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
        indexer.virtualTxs.set(vtxo.txid, base64.encode(vtxo.tx.toPSBT()));
        const res = await onReceiveVtxo(
            { txid: vtxo.txid, vout: 0 },
            indexer,
            onchain,
            storage,
            key,
        );
        expect(res.success).toBe(true);
        expect(res.broadcastable).toBe(false);
        return { onchain, storage, key, txid: vtxo.txid };
    }

    const opts = { network: "regtest" as const, feeRate: 2, feeWallet, pollIntervalMs: 1 };

    it("reports an immature hop as pending without calling bumpAnchor or broadcasting when waiting is off", async () => {
        const { onchain, storage, key, txid } = await persistedHop(150);
        onchain.chainHeight = 100;
        const bumpSpy = vi.fn(
            async (parentHex: string): Promise<[string, string]> => [parentHex, "child"],
        );
        const r = await executeSovereignUnroll(txid, storage, onchain, key, {
            ...opts,
            feeWallet: { bumpAnchor: bumpSpy },
            waitForMaturity: false,
        });
        expect(r.success).toBe(false);
        expect(r.swept).toBe(false);
        expect(r.error).toMatch(/not yet broadcastable.*nLockTime 150/);
        expect(r.pending).toHaveLength(1);
        expect(bumpSpy).not.toHaveBeenCalled();
        expect(onchain.broadcastedPackages).toHaveLength(0);
    });

    it("waits for a timestamp locktime to fall strictly below tip MTP, then unrolls only", async () => {
        const { onchain, storage, key, txid } = await persistedHop(1_700_000_000);
        onchain.chainMedianTime = 1_700_000_000; // equal: still immature
        const r = await executeSovereignUnroll(txid, storage, onchain, key, {
            ...opts,
            onPending: () => {
                onchain.chainMedianTime = 1_700_000_001;
            },
        });
        expect(r.success).toBe(true);
        expect(r.pending).toHaveLength(1);
        expect(r.swept).toBe(false);
        // only the 1P1C unroll package was broadcast: no sweep transaction
        expect(onchain.broadcastedPackages).toHaveLength(1);
        expect(onchain.broadcastedPackages[0]).toHaveLength(2);
    });
});

describe("batch mode does batch-wide work before target-dependent checks", () => {
    it("fetches the whole batch union even when the target is absent, then fails", async () => {
        const onchain = new MockOnchainProvider();
        const commitmentTxid = setupCommitment(onchain, 74);
        const sibling = createVirtualTx(commitmentTxid, 0, [{ amount: 100000n }], {
            parentScript: makeP2TRScript(0),
        });
        const getVirtualTxs = vi.fn(async (txids: string[]) => ({
            txs: txids.map(() => base64.encode(sibling.tx.toPSBT())),
        }));
        const indexer: VerificationIndexerProvider = {
            getBatchVtxos: async () => [
                {
                    chain: [
                        {
                            txid: sibling.txid,
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
            ],
            getVirtualTxs,
        };
        await expect(
            reconstructAndValidateVtxoDAG(
                { txid: "ab".repeat(32), vout: 0 },
                indexer,
                onchain,
                undefined,
                commitmentTxid,
            ),
        ).rejects.toThrow(/EMPTY_CHAIN/);
        expect(getVirtualTxs).toHaveBeenCalledWith([sibling.txid]);
    });
});
