import { BIP21 } from "../utils/bip21";
import type { Asset } from "../index";
import type { PaymentRequest } from "./types";

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

/**
 * Non-throwing counterpart of {@link resolveSendAmount}, for availability
 * checks that must not reject the router: returns the positive-integer sats
 * from the explicit `amount` or the BIP21 `amount=` param, or `undefined` when
 * none is present or the value is not a positive integer. The missing-vs-invalid
 * distinction is left to `resolveSendAmount` at quote time.
 */
export function tryResolveSendAmount(raw: string, amount?: number): number | undefined {
    const amt = amount ?? BIP21.amountSats(raw);
    return amt !== undefined && Number.isInteger(amt) && amt > 0 ? amt : undefined;
}

/**
 * The assets a request asks for — `[]` when it names none.
 *
 * Normalizing an absent list to `[]` is what makes "does this request move an
 * asset" one expression on every rail, rather than an `undefined` check each
 * rail writes for itself and one of them forgets.
 */
export function assetsOf(req: PaymentRequest): Asset[] {
    return req.assets ?? [];
}

/**
 * Throw when `req` asks for an asset — for a rail that can only move BTC.
 *
 * The failure this prevents is silent and expensive: a BTC-only rail handed a
 * `{ amount: 330, assets: [500 USDX] }` request would happily pay 330 sats,
 * report success, and deliver none of the asset the user actually asked for.
 * Refusing is what leaves the router free to rank an asset-capable rail
 * instead.
 */
export function assertNoAssets(railId: string, req: PaymentRequest): void {
    const assets = assetsOf(req);
    if (assets.length > 0) {
        throw new Error(
            `${railId}: cannot deliver ${assets.map((a) => a.assetId).join(", ")} ` +
                `— this rail moves BTC only`,
        );
    }
}

/**
 * The single asset a request names, validated.
 *
 * Exactly one: a rail that delivers to one recipient in one corridor has no
 * meaning for two, and quietly paying the first would be worse than refusing.
 * `Wallet.send` takes a list because one output can carry several; a routed
 * PAYMENT is one thing being paid.
 */
export function resolveAssetAmount(railId: string, req: PaymentRequest): Asset {
    const assets = assetsOf(req);
    if (assets.length !== 1) {
        throw new Error(`${railId}: expected exactly one asset to pay, got ${assets.length}`);
    }
    const [asset] = assets;
    // `bigint` is why this is a separate check from `assertSendableAmount`:
    // `Number.isInteger` is meaningless on one, and the whole reason the SDK
    // types asset amounts as bigint is that Number would truncate them.
    if (typeof asset.amount !== "bigint" || asset.amount <= 0n) {
        throw new Error(
            `${railId}: invalid amount ${String(asset.amount)} of ${asset.assetId} ` +
                `(expected a positive bigint of atomic units)`,
        );
    }
    if (typeof asset.assetId !== "string" || asset.assetId.length === 0) {
        throw new Error(`${railId}: an asset amount must name an asset`);
    }
    return asset;
}
