import { base64 } from "@scure/base";
import { ChainTxType } from "../../providers/indexer";
import { Transaction } from "../../utils/transaction";

/**
 * Decode and finalize a virtual transaction PSBT fetched from the indexer.
 *
 * TREE transactions carry a musig2 `tapKeySig` produced during the batch
 * signing ceremony — finalization lifts it into the witness. Arkade and
 * checkpoint transactions are finalized with the generic finalizer.
 */
export function finalizeVirtualTx(type: ChainTxType, psbtBase64: string): Transaction {
    const tx = Transaction.fromPSBT(base64.decode(psbtBase64));

    if (type === ChainTxType.TREE) {
        const input = tx.getInput(0);
        if (!input) {
            throw new Error("Input not found");
        }
        const tapKeySig = input.tapKeySig;
        if (!tapKeySig) {
            throw new Error("Tap key sig not found");
        }
        tx.updateInput(0, {
            finalScriptWitness: [tapKeySig],
        });
        return tx;
    }

    tx.finalize();
    return tx;
}
