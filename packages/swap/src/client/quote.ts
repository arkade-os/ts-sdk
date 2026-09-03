/**
 * What a quote is: the order, fully resolved, plus the provenance that says who
 * priced it and where that card came from.
 *
 * M1 named these shapes and left them to whichever milestone decided their
 * semantics; this is that milestone, so `QuoteId`, `QuoteInput`, `Quote`,
 * `MarketRef` and `AuctionProvenance` are declared here rather than beside the
 * types they are built out of. Nothing in this module has behaviour — the quote
 * path assembles these, `accept()` (M4) consumes them.
 *
 * The one rule worth restating at the top: a `Quote` is binding terms plus the
 * evidence for them. Every field is either something the caller must act on
 * (the two obligations, the artifact, the deadline) or something they must be
 * able to audit afterwards (the market, the solver, the checks that passed).
 * Nothing internal rides along — no covenant, no secret, no transport.
 */
import type { AssetId } from "./assetId";
import type { AmountOn } from "./rfqAmount";
import type { Corridor, CorridorId } from "./corridor";
import type { Hex, Pubkey } from "./primitives";
import type { Artifact, Instrument, Route } from "./route";

/**
 * A quote's identity, minted by the client at quote time.
 *
 * Client-minted everywhere, not just where the wire offers no id: a feed-priced
 * offer quote has no solver-minted id at all, and `accept()` is idempotent by
 * quote id *and only* by quote id (§3.2), so an identity that exists on one
 * backend and not the other could not carry that rule. An alias rather than a
 * brand, matching `Hex` and `Pubkey` beside it.
 */
export type QuoteId = string;

/**
 * A caller's spelling of an asset: a public id, or a ticker the alias layer
 * canonicalizes against the registry.
 *
 * `AssetId | (string & {})` rather than `string`, so an editor still completes
 * the id form and a mistyped id still shows up as one — `AssetId | string`
 * collapses to `string` and takes both with it.
 */
export type AssetRef = AssetId | (string & {});

/**
 * Everything a caller supplies. §4's bottom line: two asset ids or one
 * destination string, one amount, which side it pins, and — on receives, where
 * no instrument exists yet — a corridor.
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
     * The registry answered in this read, so the cards are registry-served
     * rather than replayed out of local storage.
     *
     * `false` is not an error: a stale snapshot still resolves and still prices
     * a feed-priced quote — it is marked, not refused. What it cannot do is
     * supply the key an addressed RFQ's responder is checked against, because
     * that field is unvalidated cache content (`isMarketShaped` revalidates
     * four fields and trusts the rest).
     */
    readonly live: boolean;
    /** How the markets were obtained. */
    readonly source: "live" | "cache" | "injected";
    /** The registry URL behind it, or `undefined` for an injected snapshot. */
    readonly registry?: string;
}

/**
 * Which card priced a quote, and from which registry.
 *
 * A union rather than a bag of optionals, because §10's published RFQ is the
 * one place the sentence "the market picks the backend" stops: a quote closed
 * out of an open auction has a market *key* and no card behind it, so every
 * card-derived field is absent at once rather than one at a time. Sizing that
 * arm now costs a discriminant and keeps the addressed arm total.
 */
export type MarketRef = CardMarketRef | AuctionMarketRef;

export interface CardMarketRef {
    readonly kind: "card";
    /**
     * The canonical market key, `<corridor>:<id>/<corridor>:<id>`, derived under
     * rfq-protocol.md §2's leg order — arkade first when exactly one leg is
     * arkade, lexicographic otherwise — and never read off the card's own
     * base/quote order. The two agree for every card the registry's reducer
     * validated, and a card published outside it is exactly where the silent
     * miss lives.
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

/**
 * One bid seen in a published auction (§10, Q9).
 *
 * Typed against ts-sdk #777's shipped draft rather than invented: a bid is a
 * counter-amount on the leg the client did not fix, attributed to the event key
 * that signed it — which is NOT the covenant's `solver_pubkey`, a role key the
 * quote fills from a different field.
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
 * The auction a published-RFQ quote was closed out of (§10, Q9).
 *
 * Reserved and inert: `quote()` never populates it, and Q9 froze the name so
 * the shape it will take cannot be occupied by something else in the meantime.
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
 * The order, fully resolved.
 *
 * Both amounts are exact obligations with the fee already inside them, which is
 * what `fee` restates rather than adds: it is the spread, precomputed, so a
 * verb (M7) can compare it to a ceiling without re-deriving it from a price.
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
     * Corridor routes: when the trader's value comes back if the swap does not
     * complete.
     *
     * Optional on the type because an asset swap has no refund clock at all —
     * an offer covenant never expires — and non-optional in practice on every
     * corridor route, where the wire's own field is optional and the client
     * refuses a quote without it.
     */
    readonly refundLocktime?: number;
    /** The one thing a counterparty must see, when this route has one. */
    readonly artifact?: Artifact;
    /** The spread, denominated on the leg where it is exact. */
    readonly fee: { readonly amount: bigint; readonly asset: AssetId };
}

/**
 * An endpoint as `resolve()` can answer for it, before any disclosure.
 *
 * Not an `Endpoint`: that type's instrument is non-optional, deliberately, and a
 * receive leg has none until the quote returns — the instrument IS the artifact
 * the solver mints. Absence here means exactly that one thing, because the
 * wallet case is spelled `{ kind: "wallet" }` rather than left out.
 */
export interface ResolvedEndpoint {
    readonly corridor: Corridor;
    readonly asset: AssetId;
    /** Absent only while the leg's instrument does not exist yet. */
    readonly instrument?: Instrument;
}

/** The amount a caller (or an invoice) pinned, and which leg it pins. */
export interface PinnedAmount {
    readonly value: bigint;
    readonly on: AmountOn;
    /** What pinned it, for the diagnostic an `AmountMismatch` carries. */
    readonly source: "caller" | "invoice";
}

/**
 * What `resolve()` answers: the route's shape, the market that would price it,
 * and what the active snapshot actually serves.
 *
 * `eligible` is reported alongside rather than folded into an error because
 * zero is not a failure of resolution: the destination parsed, the corridor pair
 * is implemented, and nothing about the route is wrong — there is simply no
 * market for it on this snapshot. `quote()` is where that becomes
 * `UnsupportedRoute`, since a quote cannot proceed past market selection.
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
