import type { Wallet } from "../index";

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

export interface RouteQuote {
    railId: string;
    amount: number;
    fee: number;
    total: number;
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

/** A payment request: the raw target plus an optional explicit amount. Rails
 *  self-extract their target from `raw` (bare address/invoice or a BIP21 URI);
 *  `amount` supplements or overrides any amount encoded in `raw`. */
export interface PaymentRequest {
    /** Raw target: bare address/invoice, or a BIP21 URI. */
    raw: string;
    /** Explicit sats; supplements/overrides any amount encoded in `raw`. */
    amount?: number;
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
