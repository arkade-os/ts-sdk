/**
 * What a quote is: the order, fully resolved, plus the provenance that says who priced it and
 * where that card came from. Types only — the quote path assembles these, `accept()` consumes
 * them.
 *
 * A `Quote` is binding terms plus the evidence for them: every field is something the caller must
 * act on or be able to audit. Nothing internal rides along (no covenant, secret or transport).
 */
import type { AssetId } from "./assetId";
import type { AmountOn } from "./rfqAmount";
import type { Corridor, CorridorId } from "./corridor";
import type { Hex, Pubkey } from "./primitives";
import type { Artifact, Instrument, Route } from "./route";

/**
 * A quote's identity, minted by the client at quote time on every backend: feed-priced quotes
 * have no solver id, and `accept()` is idempotent by quote id *only* (§3.2).
 */
export type QuoteId = string;

/**
 * A caller's spelling of an asset: a public id, or a ticker the alias layer canonicalizes against
 * the registry. `(string & {})` rather than `string` keeps editor completion of the id form.
 */
export type AssetRef = AssetId | (string & {});

/**
 * Everything a caller supplies: two asset ids or one destination string, one amount, which side
 * it pins, and — on receives, where no instrument exists yet — a corridor.
 */
export interface QuoteInput {
    /** Omitted when the route determines it: the give leg is the wallet's. */
    give?: AssetRef;
    /** Omitted when `to` determines it — a corridor that carries BTC only does. */
    take?: AssetRef;
    /** A self-describing instrument: bolt11, an Arkade address, or `bc1…`. */
    to?: string;
    /** Receive flows only: names the corridor when no instrument can exist yet. */
    via?: CorridorId;
    /** Atomic units. Exactly one amount may be pinned — see `amountOn`. */
    amount?: bigint;
    /** Which leg `amount` pins. Required with `amount`, and refused with an
     * invoice, which pins one already. */
    amountOn?: AmountOn;
}

/** Which backend priced a quote. The card decides it; no client switch does. */
export type MarketBackend = "rfq" | "feed";

/** Where a snapshot came from, and how fresh it is. */
export interface SnapshotRef {
    /** Unix ms the markets were read from their sources. */
    readonly fetchedAt: number;
    /**
     * The registry answered in this read (cards are not replayed from local storage).
     *
     * `false` is marked, not refused: a stale snapshot still prices a feed-priced quote. It cannot
     * supply the key an addressed RFQ's responder is checked against, because cached cards are
     * only partly revalidated (`isMarketShaped`).
     */
    readonly live: boolean;
    /** How the markets were obtained. */
    readonly source: "live" | "cache" | "injected";
    /** The registry URL behind it, or `undefined` for an injected snapshot. */
    readonly registry?: string;
}

/**
 * Which card priced a quote, and from which registry. A union because an auction-closed quote
 * (§10) has a market key and no card, and a restored record has neither.
 */
export type MarketRef = CardMarketRef | AuctionMarketRef | RestoredMarketRef;

export interface CardMarketRef {
    readonly kind: "card";
    /**
     * The canonical market key, `<corridor>:<id>/<corridor>:<id>`, under rfq-protocol.md §2's leg
     * order — arkade first when exactly one leg is arkade, lexicographic otherwise — never the
     * card's own base/quote order (see `marketKeyOf`).
     */
    readonly key: string;
    readonly backend: MarketBackend;
    /** The registry URL, or the label a locally pinned card was loaded under. */
    readonly source: string;
    readonly sourceType: "registry" | "local";
    /** The solver's name, as the card publishes it. Display, never identity. */
    readonly solver: string;
    /** The card's signing key. Absent on spot cards, which need no rendezvous. */
    readonly discoveryPubkey?: Pubkey;
    /** The card's display label, e.g. `BTC/lightning:BTC`. Display only. */
    readonly pair: string;
    readonly snapshot: SnapshotRef;
}

/** §10, reserved: a quote closed out of a published auction has no card. */
export interface AuctionMarketRef {
    readonly kind: "auction";
    readonly key: string;
    readonly backend: "rfq";
}

/** A record rebuilt from the funding tx after a restore: no card stands behind it. */
export interface RestoredMarketRef {
    readonly kind: "restored";
    readonly backend: "feed";
}

/**
 * One bid seen in a published auction (§10, Q9): a counter-amount on the leg the client did not
 * fix, attributed to the event key that signed it — NOT the covenant's `solver_pubkey`.
 */
export interface RankedBid {
    /** The event key that signed the bid. Attribution, not a covenant role. */
    readonly bidder: Pubkey;
    /** The counter-amount, on the leg the client left free. */
    readonly amount: bigint;
    readonly amountOn: AmountOn;
    readonly expiresAt: number;
}

/**
 * The auction a published-RFQ quote was closed out of (§10, Q9). Reserved and inert: `quote()`
 * never populates it.
 */
export interface AuctionProvenance {
    /** The market key the open request was tagged with. */
    readonly marketKey: string;
    /** The bid that was closed with. */
    readonly winner: RankedBid;
    /** Every other bid seen before the window closed. */
    readonly losers: readonly RankedBid[];
    /** Unix seconds the bid window closed. */
    readonly closedAt: number;
}

/** One leg's obligation: an asset, and exactly how much of it. */
export interface QuoteLeg {
    readonly asset: AssetId;
    readonly amount: bigint;
}

/**
 * The order, fully resolved. Both amounts are exact obligations with the fee already inside;
 * `fee` restates the spread rather than adding to it.
 */
export interface Quote {
    readonly id: QuoteId;
    /** Both endpoints resolved, instruments included. */
    readonly route: Route;
    /** What the trader gives, fee included. */
    readonly give: QuoteLeg;
    /** What the trader takes. */
    readonly take: QuoteLeg;
    /** Corridor routes: the hash both covenants commit to. */
    readonly lock?: { readonly hash: Hex };
    /** Which card priced this, from which registry, how fresh. */
    readonly market: MarketRef;
    /** RFQ routes: the committed counterparty, from the quote's covenant role. */
    readonly solver?: Pubkey;
    /** §10 only, and never populated today. */
    readonly auction?: AuctionProvenance;
    /** Unix seconds. Non-optional on both backends — a feed-priced quote has no
     * wire expiry to inherit, so the client mints one from the feed's freshness. */
    readonly expiresAt: number;
    /**
     * Corridor routes: when the trader's value comes back if the swap does not complete. Absent on
     * asset swaps (an offer covenant never expires); corridor quotes without it are refused.
     */
    readonly refundLocktime?: number;
    /**
     * The one thing a counterparty must see, when this route has one.
     *
     * Do not show it until `accept()` has resolved: a Lightning receive's invoice is minted here,
     * but its preimage secrets are persisted only by `accept()`. `receive()` does both.
     */
    readonly artifact?: Artifact;
    /** The spread, plus any deposit carrier the payout does not return, on the leg where it is exact. */
    readonly fee: { readonly amount: bigint; readonly asset: AssetId };
}

/**
 * An endpoint as `resolve()` can answer for it, before any disclosure. Not an `Endpoint`, whose
 * instrument is required: a receive leg has none until the quote returns (the instrument IS the
 * artifact the solver mints).
 */
export interface ResolvedEndpoint {
    readonly corridor: Corridor;
    readonly asset: AssetId;
    /** Absent only while the leg's instrument does not exist yet. */
    readonly instrument?: Instrument;
}

/** The amount a caller or a destination pinned, and which leg it pins. */
export interface PinnedAmount {
    readonly value: bigint;
    readonly on: AmountOn;
    /**
     * What pinned it, for an `AmountMismatch` diagnostic. `"destination"` covers an
     * amount-bearing bolt11 and a BIP21 `amount=`.
     */
    readonly source: "caller" | "destination";
}

/**
 * What `resolve()` answers: the route's shape, the market that would price it, and what the
 * active snapshot serves. `eligible: 0` is not a resolution failure; `quote()` is where it becomes
 * `UnsupportedRoute`.
 */
export interface RouteResolution {
    readonly give: ResolvedEndpoint;
    readonly take: ResolvedEndpoint;
    /** The card that would price it: the first eligible one after policy. */
    readonly market?: MarketRef;
    /** How many markets serve this pair on the active snapshot, after policy. */
    readonly eligible: number;
    /** Where the market data came from, and how fresh it is. */
    readonly snapshot: SnapshotRef;
    /** The amount pinned so far, when the input pinned one. */
    readonly amount?: PinnedAmount;
}
