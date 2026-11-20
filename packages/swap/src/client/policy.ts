/**
 * Application policy: the vetoes and floors a client applies before it discloses anything.
 *
 * Every active member runs BEFORE the RFQ round trip that discloses an invoice or an amount; a
 * policy that could only reject a quote after it arrived would be a preference.
 */
import type { MarketCandidate } from "./market";
import type { FeeCeiling } from "./verbs";
import type { SolverRoutingPolicy } from "./solverRouting";

/**
 * A published-RFQ auction's parameters (§10, Q9).
 *
 * Defaults for explicit openRfq calls. Ordinary quote() remains addressed.
 */
export interface RfqAuctionPolicy {
    /** How long to hold the bid window open, in ms. */
    readonly windowMs: number;
    /** Default relays for explicit openRfq calls; absent means the current cards or public defaults. */
    readonly relays?: readonly string[];
}

/**
 * How much the client drives on its own, so a consumer can inspect its swaps without being made to
 * move money.
 */
export type DriveMode =
    /**
     * Default. Construction's restore-read arms the drive when it finds live
     * work, and the first `accept()` arms it when it does not.
     */
    | "auto"
    /** Restores, then waits: no timer and no stream until `start()`. */
    | "manual"
    /**
     * Restores and reports, and never actuates: no pass runs, so no claim, refund or recovery
     * round, and nothing new is discovered.
     */
    | "readonly";

/** Default {@link SwapPolicy.maxRefundWindowSeconds}: 30 days. */
export const DEFAULT_MAX_REFUND_WINDOW_SECONDS = 30 * 24 * 3600;

export interface SwapPolicy {
    /** Opt in to direction-specific ordering and quote-only failover. Explicit selectMarket stays pinned. */
    readonly solverRouting?: SolverRoutingPolicy;

    /** How much the client drives on its own. Default `"auto"`. */
    readonly drive?: DriveMode;

    /**
     * The most a swap may cost, as a standing instruction.
     *
     * The verbs take the **minimum** of this and their own `maxFee`, so a call can only tighten it.
     * Enforced between `quote` and `accept`, before funding. Denominated because the fee sits on
     * the give leg on corridor routes and the take leg on asset swaps; a ceiling in a different
     * asset than the quoted fee is refused, not converted.
     */
    readonly maxFee?: FeeCeiling;

    /** Choose from eligible candidates in discovery order, before routing preferences; `undefined` vetoes all.
     * The answer must be one of those candidates, which passed pair, corridor and addressability
     * checks. An explicit selection disables quote failover; routing pauses can still veto it. */
    readonly selectMarket?: (candidates: readonly MarketCandidate[]) => MarketCandidate | undefined;

    /**
     * The registries whose cards may price a swap, matched exactly against
     * `DiscoveredMarket.source`.
     *
     * On `source`, never `discovery_pubkey`: the cache does not revalidate that field on read, so
     * filtering on it would reopen the hole the allowlist closes. Exact URLs, not hostnames; a
     * locally pinned card carries its discovery label (a path). Absent means every source.
     */
    readonly allowedRegistries?: readonly string[];

    /**
     * The least validity a quote may arrive with, in seconds. Below it `quote()` throws
     * `QuoteExpired`, rather than handing back terms that would fail at `accept()`.
     */
    readonly quoteTtlFloorSeconds?: number;

    /**
     * The longest a send's funds may stay locked before the trader can refund, in seconds.
     * Caps `refund_locktime` and the solo-refund delay; above it `quote()` throws
     * `QuoteVerificationFailed("refund_window")`. Default {@link DEFAULT_MAX_REFUND_WINDOW_SECONDS}.
     */
    readonly maxRefundWindowSeconds?: number;

    /**
     * Defaults for explicit openRfq calls; never makes quote() public.
     */
    readonly rfq?: RfqAuctionPolicy;
}
