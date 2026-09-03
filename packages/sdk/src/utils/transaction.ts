import { SigHash, Transaction as BtcSignerTransaction } from "@scure/btc-signer";
import { TxOpts } from "@scure/btc-signer/transaction.js";
import { Bytes } from "@scure/btc-signer/utils.js";

/**
 * Transaction is a wrapper around the @scure/btc-signer Transaction class.
 * It adds the Arkade protocol specific options to the transaction.
 */
export class Transaction extends BtcSignerTransaction {
    static ARK_TX_OPTS: TxOpts = {
        allowUnknown: true,
        allowUnknownOutputs: true,
        allowUnknownInputs: true,
    };

    constructor(opts?: TxOpts) {
        super(withArkOpts(opts));
    }

    static fromPSBT(psbt_: Bytes, opts?: TxOpts): Transaction {
        return BtcSignerTransaction.fromPSBT(psbt_, withArkOpts(opts));
    }

    static fromRaw(raw: Bytes, opts?: TxOpts): Transaction {
        return BtcSignerTransaction.fromRaw(raw, withArkOpts(opts));
    }
}

function withArkOpts(opts?: TxOpts): TxOpts {
    return { ...Transaction.ARK_TX_OPTS, ...opts };
}

/** Formats a sighash type as a hex string (e.g., 0x01) */
export function formatSighash(type: number): string {
    return `0x${type.toString(16).padStart(2, "0")}`;
}

/**
 * Reject a PSBT that declares a sighash type outside `allowedSighashTypes` on
 * any input, before it reaches a signer. An input carrying no explicit type is
 * left alone: the signer treats a taproot input as {@link SigHash.DEFAULT}.
 */
export function assertAllowedSighashTypes(
    tx: BtcSignerTransaction,
    allowedSighashTypes: number[] = [SigHash.DEFAULT],
): void {
    for (let i = 0; i < tx.inputsLength; i++) {
        const declared = tx.getInput(i).sighashType;
        if (declared === undefined) continue;
        if (!allowedSighashTypes.includes(declared)) {
            throw new Error(`Unallowed sighash type ${formatSighash(declared)} for input ${i}.`);
        }
    }
}
