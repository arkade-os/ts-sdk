import { Transaction as BtcSignerTransaction } from "@scure/btc-signer";
import { TxOpts } from "@scure/btc-signer/transaction";
import { Bytes } from "@scure/btc-signer/utils";

/**
 * Transaction is a wrapper around the @scure/btc-signer Transaction class.
 * It adds the Ark protocol specific options to the transaction.
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

    static fromRaw(raw: Bytes, opts?: TxOpts): BtcSignerTransaction {
        return BtcSignerTransaction.fromRaw(raw, withArkOpts(opts));
    }
}

function withArkOpts(opts?: TxOpts): TxOpts {
    return { ...Transaction.ARK_TX_OPTS, ...opts };
}
