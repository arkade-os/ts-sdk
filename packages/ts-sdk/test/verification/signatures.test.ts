import { hex } from "@scure/base";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { SigHash } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { describe, expect, it } from "vitest";
import { ChainTxType } from "../../src/providers/indexer";
import { SingleKey } from "../../src/identity/singleKey";
import { VtxoScript } from "../../src/script/base";
import { CSVMultisigTapscript, MultisigTapscript } from "../../src/script/tapscript";
import { aggregateKeys } from "../../src/musig2";
import { Transaction } from "../../src/utils/transaction";
import { CosignerPublicKey, setArkPsbtField, VtxoTreeExpiry } from "../../src/utils/unknownFields";
import {
    ParsedVtxoProof,
    verifyProofSignatures,
    verifyTreeCosignerKeys,
    VtxoVerificationServerInfo,
} from "../../src/verification";

const COMMITMENT_TXID = "11".repeat(32);
const SECRET_KEY = new Uint8Array(32).fill(7);
const OUTPUT_KEY = schnorr.getPublicKey(SECRET_KEY);
const SCRIPT = Uint8Array.from([0x51, 0x20, ...OUTPUT_KEY]);

function cosignerBoundTree() {
    const cosignerSecret = new Uint8Array(32).fill(10);
    const cosignerKey = secp256k1.getPublicKey(cosignerSecret);
    const serverInfo: VtxoVerificationServerInfo = {
        forfeitPubkey: schnorr.getPublicKey(new Uint8Array(32).fill(11)),
    };
    const sweepInterval = { type: "blocks" as const, value: 144n };
    const sweepScript = CSVMultisigTapscript.encode({
        timelock: sweepInterval,
        pubkeys: [serverInfo.forfeitPubkey],
    }).script;
    const { finalKey } = aggregateKeys([cosignerKey], true, {
        taprootTweak: tapLeafHash(sweepScript),
    });
    const prevoutScript = Uint8Array.from([0x51, 0x20, ...finalKey.subarray(1)]);
    const tx = new Transaction({ allowLegacyWitnessUtxo: true });
    tx.addInput({
        txid: hex.decode(COMMITMENT_TXID),
        index: 0,
        witnessUtxo: { amount: 10_000n, script: prevoutScript },
    });
    setArkPsbtField(tx, 0, CosignerPublicKey, { index: 0, key: cosignerKey });
    setArkPsbtField(tx, 0, VtxoTreeExpiry, sweepInterval);
    tx.addOutput({ amount: 10_000n, script: SCRIPT });
    const proof: ParsedVtxoProof = {
        entries: new Map([
            [
                tx.id,
                {
                    txid: tx.id,
                    expiresAt: "0",
                    type: ChainTxType.TREE,
                    spends: [COMMITMENT_TXID],
                },
            ],
        ]),
        transactions: new Map([[tx.id, tx]]),
        commitmentTxids: [COMMITMENT_TXID],
    };
    return { proof, serverInfo };
}

function signedTree(inputScript = SCRIPT): { proof: ParsedVtxoProof; tx: Transaction } {
    const tx = new Transaction({ allowLegacyWitnessUtxo: true, allowUnknownOutputs: true });
    tx.addInput({
        txid: hex.decode(COMMITMENT_TXID),
        index: 0,
        witnessUtxo: { amount: 10_000n, script: inputScript },
    });
    tx.addOutput({ amount: 10_000n, script: SCRIPT });
    const message = tx.preimageWitnessV1(0, [inputScript], SigHash.DEFAULT, [10_000n]);
    tx.updateInput(0, { tapKeySig: schnorr.sign(message, SECRET_KEY) });

    return {
        tx,
        proof: {
            entries: new Map([
                [
                    COMMITMENT_TXID,
                    {
                        txid: COMMITMENT_TXID,
                        expiresAt: "0",
                        type: ChainTxType.COMMITMENT,
                        spends: [],
                    },
                ],
                [
                    tx.id,
                    {
                        txid: tx.id,
                        expiresAt: "0",
                        type: ChainTxType.TREE,
                        spends: [COMMITMENT_TXID],
                    },
                ],
            ]),
            transactions: new Map([[tx.id, tx]]),
            commitmentTxids: [COMMITMENT_TXID],
        },
    };
}

describe("verifyProofSignatures TREE key path", () => {
    it("accepts a valid BIP-341 tapKeySig", () => {
        const { proof } = signedTree();
        expect(verifyProofSignatures(proof)).toEqual([]);
    });

    it("rejects a forged tapKeySig", () => {
        const { proof, tx } = signedTree();
        const forged = Uint8Array.from(tx.getInput(0).tapKeySig!);
        forged[0] ^= 0xff;
        tx.updateInput(0, { tapKeySig: forged });

        expect(verifyProofSignatures(proof)[0].code).toBe("signature_invalid_tap_key");
    });

    it("rejects a missing tapKeySig", () => {
        const { proof, tx } = signedTree();
        tx.updateInput(0, { tapKeySig: undefined });

        expect(verifyProofSignatures(proof)[0].code).toBe("signature_missing_tap_key");
    });

    it("rejects a TREE prevout that is not P2TR", () => {
        const { proof } = signedTree(Uint8Array.from([0x51]));

        expect(verifyProofSignatures(proof)[0].code).toBe("signature_prevout_not_p2tr");
    });
});

describe("verifyTreeCosignerKeys", () => {
    it("binds TREE cosigners and the server sweep leaf to the spent output", () => {
        const { proof, serverInfo } = cosignerBoundTree();
        expect(verifyTreeCosignerKeys(proof, serverInfo)).toEqual([]);
    });

    it("rejects a different server sweep key", () => {
        const { proof, serverInfo } = cosignerBoundTree();
        const issues = verifyTreeCosignerKeys(proof, {
            ...serverInfo,
            forfeitPubkey: schnorr.getPublicKey(new Uint8Array(32).fill(12)),
        });

        expect(issues[0].code).toBe("signature_cosigner_key_mismatch");
    });

    it("rejects missing cosigner metadata", () => {
        const { proof, serverInfo } = cosignerBoundTree();
        proof.transactions.values().next().value!.updateInput(0, { unknown: [] });

        expect(verifyTreeCosignerKeys(proof, serverInfo)[0].code).toBe(
            "signature_cosigner_missing",
        );
    });

    it("rejects missing sweep-expiry metadata", () => {
        const { proof, serverInfo } = cosignerBoundTree();
        const tx = proof.transactions.values().next().value!;
        tx.updateInput(0, {
            unknown: tx
                .getInput(0)
                .unknown!.filter((field) => VtxoTreeExpiry.decode(field) === null),
        });

        expect(verifyTreeCosignerKeys(proof, serverInfo)[0].code).toBe(
            "signature_sweep_expiry_missing",
        );
    });
});

describe("verifyProofSignatures script path", () => {
    async function signedArk(requiredSecrets: Uint8Array[], signedSecrets: Uint8Array[]) {
        const requiredKeys = await Promise.all(
            requiredSecrets.map((secret) => SingleKey.fromPrivateKey(secret).xOnlyPublicKey()),
        );
        const script = MultisigTapscript.encode({
            pubkeys: requiredKeys,
            type: MultisigTapscript.MultisigType.CHECKSIG,
        });
        const vtxoScript = new VtxoScript([script.script]);
        const tx = new Transaction();
        tx.addInput({
            txid: hex.decode(COMMITMENT_TXID),
            index: 0,
            witnessUtxo: { amount: 10_000n, script: vtxoScript.pkScript },
            tapLeafScript: [vtxoScript.leaves[0]],
        });
        tx.addOutput({ amount: 10_000n, script: SCRIPT });
        for (const secret of signedSecrets) {
            tx.signIdx(SingleKey.fromPrivateKey(secret)["key"], 0, [SigHash.DEFAULT]);
        }
        const proof: ParsedVtxoProof = {
            entries: new Map([
                [
                    tx.id,
                    {
                        txid: tx.id,
                        expiresAt: "0",
                        type: ChainTxType.ARK,
                        spends: [COMMITMENT_TXID],
                    },
                ],
            ]),
            transactions: new Map([[tx.id, tx]]),
            commitmentTxids: [COMMITMENT_TXID],
        };
        return proof;
    }

    it("accepts signatures required by the tapscript", async () => {
        const secret = new Uint8Array(32).fill(8);
        expect(verifyProofSignatures(await signedArk([secret], [secret]))).toEqual([]);
    });

    it("rejects a missing signer required by the tapscript", async () => {
        const first = new Uint8Array(32).fill(8);
        const second = new Uint8Array(32).fill(9);
        const issues = verifyProofSignatures(await signedArk([first, second], [first]));

        expect(issues[0].code).toBe("signature_invalid_script_path");
    });

    it("rejects an ARK input with no script-path proof", async () => {
        const tx = new Transaction({ allowLegacyWitnessUtxo: true });
        tx.addInput({
            txid: hex.decode(COMMITMENT_TXID),
            index: 0,
            witnessUtxo: { amount: 10_000n, script: SCRIPT },
        });
        tx.addOutput({ amount: 10_000n, script: SCRIPT });
        const proof: ParsedVtxoProof = {
            entries: new Map([
                [
                    tx.id,
                    {
                        txid: tx.id,
                        expiresAt: "0",
                        type: ChainTxType.ARK,
                        spends: [COMMITMENT_TXID],
                    },
                ],
            ]),
            transactions: new Map([[tx.id, tx]]),
            commitmentTxids: [COMMITMENT_TXID],
        };

        expect(verifyProofSignatures(proof)[0].code).toBe("signature_script_path_missing");
    });

    it("rejects a signed tapscript whose control block is not bound to the prevout", async () => {
        const secret = new Uint8Array(32).fill(8);
        const proof = await signedArk([secret], [secret]);
        const tx = proof.transactions.values().next().value!;
        const [controlBlock, script] = tx.getInput(0).tapLeafScript![0];
        tx.updateInput(0, {
            tapLeafScript: [
                [
                    {
                        ...controlBlock,
                        merklePath: [new Uint8Array(32).fill(1)],
                    },
                    script,
                ],
            ],
        });

        expect(verifyProofSignatures(proof)[0].code).toBe("signature_tapleaf_unbound");
    });
});
