/**
 * Application policy: the vetoes and floors a client applies before it discloses anything.
 *
 * Every active member runs BEFORE the RFQ round trip that discloses an invoice or an amount; a
 * policy that could only reject a quote after it arrived would be a preference.
 */
import type { MarketCandidate } from "./market";
import type { RankedBid } from "./quote";
import type { FeeCeiling } from "./verbs";

/**
 * A published-RFQ auction's parameters (§10, Q9).
 *
 * Reserved and inert: nothing reads it. Shaped after ts-sdk #777's draft so the name isn't taken
 * by something narrower meanwhile.
 */
export interface RfqAuctionPolicy {
    /** How long to hold the bid window open, in ms. */
    readonly windowMs: number;
    /** Relays to publish the open request on. Unioned across the pair's cards. */
    readonly relays?: readonly string[];
    /** §4.6's SHOULD: a fresh transport key per open, so bids are unlinkable. */
    readonly freshTransportKey?: boolean;
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

export interface SwapPolicy {
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

    /**
     * The last word on which market prices a swap.
     *
     * Called with every eligible candidate, best-ranked first; `undefined` vetoes them all
     * (surfacing as `UnsupportedRoute`). The answer must be one of the candidates: a card from
     * elsewhere has not passed the pair, corridor and addressability checks.
     */
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
     * §10, reserved and inert: the published-RFQ auction's parameters.
     */
    readonly rfq?: RfqAuctionPolicy;

    /**
     * §10, reserved and inert: which bid to close a published auction with.
     */
    readonly selectBid?: (bids: readonly RankedBid[]) => RankedBid | undefined;
}
