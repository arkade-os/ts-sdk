import { schnorr } from "@noble/curves/secp256k1.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64 } from "@scure/base";
import { Script, SigHash } from "@scure/btc-signer";
import { p2tr, tapLeafHash } from "@scure/btc-signer/payment.js";
import { describe, expect, it } from "vitest";
import { ChainTxType } from "../src/providers/indexer";
import { Transaction } from "../src/utils/transaction";
import { ConditionWitness, setArkPsbtField } from "../src/utils/unknownFields";
import { finalizeVirtualTx } from "../src/wallet/exit/finalizeVirtualTx";

// Build a minimal PSBT resembling an indexer TREE tx: one taproot input
// carrying a tapKeySig, one output.
function makeTreePsbt(withSig: boolean): string {
    const tx = new Transaction({ allowLegacyWitnessUtxo: true });
    tx.addInput({
        txid: new Uint8Array(32).fill(1),
        index: 0,
        witnessUtxo: { script: new Uint8Array([0x51, 0x02, 0x4e, 0x73]), amount: 1000n },
    });
    tx.addOutput({ script: new Uint8Array([0x51, 0x02, 0x4e, 0x73]), amount: 1000n });
    if (withSig) {
        tx.updateInput(0, { tapKeySig: new Uint8Array(64).fill(7) });
    }
    return base64.encode(tx.toPSBT());
}

describe("finalizeVirtualTx", () => {
    it("finalizes a TREE tx by lifting tapKeySig into the witness", () => {
        const tx = finalizeVirtualTx(ChainTxType.TREE, makeTreePsbt(true));
        const input = tx.getInput(0);
        expect(input.finalScriptWitness).toBeDefined();
        expect(input.finalScriptWitness![0]).toEqual(new Uint8Array(64).fill(7));
        // finalized txs expose hex without throwing
        expect(tx.hex.length).toBeGreaterThan(0);
    });

    it("throws when a TREE tx is missing tapKeySig", () => {
        expect(() => finalizeVirtualTx(ChainTxType.TREE, makeTreePsbt(false))).toThrow(
            /tap key sig not found/i,
        );
    });

    it("finalizes a two-leaf PSBT spending an unconditional leaf without appending an unrelated ConditionWitness", () => {
        const priv1 = new Uint8Array(32).fill(0x11);
        const priv2 = new Uint8Array(32).fill(0x22);
        const internalPub = schnorr.getPublicKey(new Uint8Array(32).fill(0x33));
        const pk1 = schnorr.getPublicKey(priv1);
        const pk2 = schnorr.getPublicKey(priv2);
        const preimage = new Uint8Array(32).fill(0x42);

        const unconditionalLeaf = Script.encode([pk1, "CHECKSIGVERIFY", pk2, "CHECKSIG"]);
        const conditionalLeaf = Script.encode([
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
            internalPub,
            [{ script: unconditionalLeaf }, { script: conditionalLeaf }],
            undefined,
            true,
        );
        const destScript = p2tr(internalPub).script;

        const tx = new Transaction({ version: 3, allowUnknownOutputs: true });
        tx.addInput({
            txid: new Uint8Array(32).fill(4),
            index: 0,
            witnessUtxo: { amount: 50000n, script: tr.script },
            tapLeafScript: tr.tapLeafScript,
        });
        tx.addOutput({ amount: 50000n, script: destScript });

        const uncondHash = tapLeafHash(unconditionalLeaf, 0xc0);
        const sighash = tx.preimageWitnessV1(
            0,
            [tr.script],
            SigHash.DEFAULT,
            [50000n],
            undefined,
            unconditionalLeaf,
            0xc0,
        );
        const sig1 = schnorr.sign(sighash, priv1);
        const sig2 = schnorr.sign(sighash, priv2);
        tx.updateInput(0, {
            tapScriptSig: [
                [{ pubKey: pk1, leafHash: uncondHash }, sig1],
                [{ pubKey: pk2, leafHash: uncondHash }, sig2],
            ],
        });
        // An unrelated ConditionWitness field on the PSBT must NOT be appended onto the unconditional leaf
        setArkPsbtField(tx, 0, ConditionWitness, [preimage]);

        const finalized = finalizeVirtualTx(ChainTxType.ARK, base64.encode(tx.toPSBT()));
        const witness = finalized.getInput(0).finalScriptWitness!;
        expect(witness).toHaveLength(4); // [sig2, sig1, unconditionalLeaf, controlBlock]
        expect(witness[0]).toEqual(sig2);
        expect(witness[1]).toEqual(sig1);
        expect(witness[2]).toEqual(unconditionalLeaf);
    });
});
