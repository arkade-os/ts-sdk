import type { Asset, Recipient, Wallet } from "../index";

export type PaymentStatus = "pending" | "sent" | "settled" | "failed";

export interface RouteResult {
    railId: string;
    txid?: string;
    preimage?: string;
    swapId?: string;
}

/** An in-flight payment. Observe it — its outcome may also arrive out-of-band
 *  (swap monitor / webhook) and surface as a tx in the wallet's history. */
export interface PaymentHandle {
    readonly id: string;
    readonly status: PaymentStatus;
    /** Progress stream; returns an unsubscribe fn. Replays the latest update.
     *  A terminal `"failed"` update carries the rejection in `error` (for swap rails
     *  a `SwapError` whose `isRefundable`/`pendingSwap` drive recovery). */
    subscribe(
        fn: (u: { status: PaymentStatus; result?: RouteResult; error?: unknown }) => void,
    ): () => void;
    /** OPTIONAL await — resolves on a terminal result, rejects on the timeout.
     *  Fire-and-forget rails may never resolve it; that is allowed. */
    settled(opts?: { timeoutMs?: number }): Promise<RouteResult>;
}

/**
 * A priced route. The three amounts are **receiver-exact** and mean the same
 * thing on every rail, so `options()` can be ranked on cost and a rail swapped
 * without changing what the recipient gets:
 *
 * - `amount` — sats delivered **to the recipient**.
 * - `fee` — sats charged **on top**, by the rail and its counterparty.
 * - `total` — `amount + fee`; the sats that leave the wallet.
 *
 * Rails whose underlying primitive *deducts* its fee (the collaborative exit)
 * gross the amount up to honour this; rails that add it on top pass it through.
 * A rail that does not perform the deducting spend cannot gross up to a fee it
 * never chooses, and flags that instead: see `claimFeeDeductedFromPayout`.
 *
 * `fee` is a pre-send estimate wherever the true cost is only fixed later: the
 * swap rails quote from Boltz's advertised pricing and are superseded by the
 * amount Boltz returns at swap creation, and the collaborative exit does not
 * include the per-input intent fees, which depend on the VTXO selection made at
 * settlement. Treat it as a display and ranking figure, not a guarantee.
 */
export interface RouteQuote {
    railId: string;
    /** Sats delivered to the recipient. */
    amount: number;
    /** Sats charged on top of {@link amount}; an estimate on the swap rails. */
    fee: number;
    /** `amount + fee` — what leaves the wallet. */
    total: number;
    /**
     * @experimental The asset shape is provisional. The v2 swap client models
     * assets as `give`/`take`/`amountOn` over `AssetRef`, and the two
     * vocabularies are expected to converge on v0.5; do not treat this field as
     * stable 0.4.x API.
     *
     * The asset view; absent means BTC only. The sats fields keep their
     * meaning — an asset rides a sats-carrying output, so `amount` is the
     * carrier, not zero.
     *
     * A pair, not a triple: on a cross-asset route these name DIFFERENT
     * assets, so `total = amount + fee` cannot hold across the two units —
     * which forces the purchase price into `fee`. Prefer `assets.spent` for a
     * cost display.
     */
    assets?: {
        delivered: Asset;
        spent: Asset;
    };
    /** Execute. Returns an observable handle, never a bare result. */
    send(): Promise<PaymentHandle>;
    meta?: Record<string, unknown>;
}

export interface RouterPreferences {
    /** Ordered rail ids; first matching+available wins. Default ships in the factory. */
    priority?: string[];
    disabled?: string[];
    caps?: Record<string, unknown>;
    /** route() behaviour when >1 option survives ranking. Default "first". */
    tieBreak?: "first" | "require-choice";
}

export interface RouterContext {
    wallet: Wallet;
    /** Loosely typed in core to avoid a dependency on boltz-swap; swap rails cast it. */
    swaps?: unknown;
    prefs: RouterPreferences;
}

/** Mirrors {@link Recipient}: an Arkade address is the same string for BTC and
 *  for an asset, so the AMOUNT names the asset, never the target. */
export interface PaymentRequest {
    /** Raw target: bare address/invoice, or a BIP21 URI. */
    raw: string;
    /** Explicit sats; supplements/overrides any amount encoded in `raw`. */
    amount?: number;
    /** @experimental — provisional, see {@link RouteQuote.assets}.
     *
     *  Additive: an asset transfer also moves sats, so a 500 USDX request
     *  legitimately has both. A rail that cannot deliver assets must REFUSE. */
    assets?: Asset[];
}

/** A payment rail — registered by id, mirrors the ActivityRegistry resolver shape. */
export interface PaymentRail {
    id: string;
    /** Classification only — amount-blind; takes the request for uniformity. */
    match(req: PaymentRequest, ctx: RouterContext): boolean;
    /** Availability gate — where a rail drops itself for an out-of-limits amount. */
    available?(req: PaymentRequest, ctx: RouterContext): boolean | Promise<boolean>;
    quote(req: PaymentRequest, ctx: RouterContext): Promise<RouteQuote>;
}

export interface PaymentOption {
    railId: string;
    /** Lazy — resolves fee/amount + prepares execution only when called. The
     *  amount is fixed by the request, so this is no-arg. */
    quote(): Promise<RouteQuote>;
}
