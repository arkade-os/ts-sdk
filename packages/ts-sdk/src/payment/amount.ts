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

/** The assets a request asks for — `[]` when it names none. */
export function assetsOf(req: PaymentRequest): Asset[] {
    return req.assets ?? [];
}

/** For a BTC-only rail: refusing is what leaves the router free to rank an
 *  asset-capable one, instead of paying the carrier and dropping the asset. */
export function assertNoAssets(railId: string, req: PaymentRequest): void {
    const assets = assetsOf(req);
    if (assets.length > 0) {
        throw new Error(
            `${railId}: cannot deliver ${assets.map((a) => a.assetId).join(", ")} ` +
                `— this rail moves BTC only`,
        );
    }
}

/** Exactly one: `Wallet.send` takes a list because one output can carry
 *  several, but a routed PAYMENT is one thing being paid. */
export function resolveAssetAmount(railId: string, req: PaymentRequest): Asset {
    const assets = assetsOf(req);
    if (assets.length !== 1) {
        throw new Error(`${railId}: expected exactly one asset to pay, got ${assets.length}`);
    }
    const [asset] = assets;
    // Separate from `assertSendableAmount`: the SDK types asset amounts as
    // bigint precisely because Number would truncate them.
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
