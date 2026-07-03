import { BIP21 } from "../utils/bip21";

/** Throw unless `amt` is a positive integer number of satoshis. */
export function assertSendableAmount(railId: string, amt: number): void {
    if (!Number.isInteger(amt) || amt <= 0) {
        throw new Error(`${railId}: invalid amount ${amt} sats (expected a positive integer)`);
    }
}

/**
 * Resolve a rail's send amount from an explicit value or the BIP21 `amount=`
 * param, validated as a positive integer number of satoshis. Rejecting here
 * keeps the router from surfacing a `{ amount: 0 }` quote that only fails later
 * in wallet/swap code.
 */
export function resolveSendAmount(railId: string, raw: string, amount?: number): number {
    const amt = amount ?? BIP21.amountSats(raw);
    if (amt === undefined) {
        throw new Error(
            `${railId}: an amount is required (none provided or encoded in the request)`,
        );
    }
    assertSendableAmount(railId, amt);
    return amt;
}
