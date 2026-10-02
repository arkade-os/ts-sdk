import { base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { ChainTxType } from "../src/providers/indexer";
import { Transaction } from "../src/utils/transaction";
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
});
