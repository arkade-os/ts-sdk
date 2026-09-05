/**
 * Application policy: the vetoes and floors a client applies before it
 * discloses anything, plus the two names §10 reserved.
 *
 * Six members touch the quote path — four active here, two inert — and
 * {@link SwapPolicy.drive} is the lifecycle's. `maxFee` landed with M7, the
 * milestone that can enforce it: a ceiling declared before a layer applies it
 * is a field, not a policy.
 *
 * Every active member has the same shape of purpose: it runs BEFORE the RFQ
 * round trip that discloses an invoice or an amount. A policy that could only
 * reject a quote after it arrived would be a preference, not a policy.
 */
import type { MarketCandidate } from "./market";
import type { RankedBid } from "./quote";
import type { FeeCeiling } from "./verbs";

/**
 * A published-RFQ auction's parameters (§10, Q9).
 *
 * Reserved and inert: nothing reads it, and its shape is sized against ts-sdk
 * #777's draft so the name cannot be occupied by something narrower in the
 * meantime — a bid window, the relay set unioned across the pair's cards, and
 * the fresh per-open transport key rfq-protocol.md §4.6 recommends for
 * unlinkability.
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
 * How much the client drives on its own.
 *
 * The split is the one `RfqSwapManager` already draws between reading its
 * records and driving them: `restoreFromRepository` is documented as NOT part
 * of `start()`, precisely so a consumer can look at its swaps without being
 * made to move money to do it. This promotes that to configuration.
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
     * Restores and reports, and never actuates. It discovers nothing new — no
     * pass runs, so no claim, no refund and no recovery round — which is what
     * keeps `swaps()` and `onUpdate` honest for an inspection-only consumer.
     */
    | "readonly";

export interface SwapPolicy {
    /**
     * How much the client drives on its own. Default `"auto"`.
     *
     * Policy rather than a `SwapClientConfig` field for the same reason the
     * other five members are: it is a caller's decision about behaviour, not a
     * dependency the client needs to work.
     */
    readonly drive?: DriveMode;

    /**
     * The most a swap may cost, as a standing instruction.
     *
     * The verbs take the **minimum** of this and their own `maxFee`, so a call
     * can only tighten it: a policy ceiling a call could raise would be
     * decorative. Enforced between `quote` and `accept` and nowhere else —
     * before funding, which is the only place a ceiling is worth anything.
     *
     * Denominated, like every ceiling on this surface: the fee sits on the give
     * leg on corridor routes and the take leg on asset swaps, so a bare number
     * would name no asset. A ceiling whose asset is not the quoted fee's is
     * refused rather than converted.
     */
    readonly maxFee?: FeeCeiling;

    /**
     * The last word on which market prices a swap.
     *
     * Called with every eligible candidate, best-ranked first, and answering
     * `undefined` vetoes them all — which lands where an empty candidate set
     * lands, as `UnsupportedRoute`, and not as a seventeenth error member. The
     * answer must be one of the candidates: a card from somewhere else has not
     * been through the pair, corridor and addressability checks that produced
     * this list.
     */
    readonly selectMarket?: (candidates: readonly MarketCandidate[]) => MarketCandidate | undefined;

    /**
     * The registries whose cards may price a swap, matched exactly against
     * `DiscoveredMarket.source`.
     *
     * On `source` and never on `discovery_pubkey`, which is the field the cache
     * does not revalidate on read: filtering an allowlist on unvalidated cache
     * content would reintroduce the hole the allowlist exists to close. Exact
     * URLs, not hostnames or origins — and a locally pinned card follows
     * whatever label discovery recorded for it, which is a path, not a URL.
     *
     * Absent means every source. An allowlist that empties the candidate set is
     * the empty-eligible-set case, not a refusal of its own.
     */
    readonly allowedRegistries?: readonly string[];

    /**
     * The least validity a quote may arrive with, in seconds.
     *
     * One layer above the wire's own refusal of a quote already past
     * `valid_until`: a quote with four seconds left is not expired and is not
     * usable either, and the caller is the only one who knows how long their
     * flow takes between seeing terms and accepting them. Under the floor is
     * `QuoteExpired`, thrown from `quote()` rather than handed back to fail at
     * `accept()`.
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
