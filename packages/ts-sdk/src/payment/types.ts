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
    /** Progress stream; returns an unsubscribe fn. Replays the latest update. */
    subscribe(fn: (u: { status: PaymentStatus; result?: RouteResult }) => void): () => void;
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

/** A payment rail — registered by id, mirrors the ActivityRegistry resolver shape. */
export interface PaymentRail {
    id: string;
    match(raw: string, ctx: RouterContext): boolean;
    available?(ctx: RouterContext): boolean | Promise<boolean>;
    quote(raw: string, amount: number | undefined, ctx: RouterContext): Promise<RouteQuote>;
}

export interface PaymentOption {
    railId: string;
    /** Lazy — resolves fee/amount + prepares execution only when called. */
    quote(amount?: number): Promise<RouteQuote>;
}
