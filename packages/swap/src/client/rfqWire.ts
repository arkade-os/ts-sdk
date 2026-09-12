/**
 * The RFQ wire adapter: the pair string, the amount encoding, and the parse
 * that turns a solver's reply into values the rest of the client can compare.
 *
 * **The pair string is wire, and it is owned here.** Two different fields are
 * called `pair`. The registry's is a display label (`BTC/lightning:BTC`); the
 * wire's is `<from-leg>-><to-leg>` over legs of `<corridor>:<asset>`, where the
 * asset is a registered ticker or, on arkade only, the 68-hex asset id. Solvers
 * compare it byte for byte and cap it at 158 characters, so a CAIP-19 id cannot
 * go on it — it would fail the comparison and overrun the cap. The public alias
 * layer therefore stops one level above this, at a corridor and a discovery
 * asset id, and the string is built here, one layer below anything public.
 *
 * **Amounts go out as canonical decimal strings, unconditionally.** The solver
 * accepts them on all four corridor request schemas today, and emitting a string
 * is never a narrowing — where a JSON number past 2^53 has already lost the
 * amount before anyone can check it. The receipt side takes either form through
 * M1's adapter, a number only while it is a non-negative safe integer, which is
 * why `AmountEncodingUnsupported` is a receipt-side error here: it fires on the
 * way in, before verification, never on the way out.
 */
import {
    ARKADE_BTC,
    LIGHTNING_BTC,
    ONCHAIN_BTC,
    assertPairLength,
    rfqPair,
    type RfqQuote,
} from "../rfq";
import { BTC_ASSET_ID } from "../store";
import type { DiscoveryLeg } from "./aliases";
import type { Corridor } from "./corridor";
import type { Pubkey } from "./primitives";
import { decodeRfqAmount, encodeRfqAmount } from "./rfqAmount";

/** The BTC leg constant for each corridor, so the spellings live in one file. */
const BTC_LEG = {
    arkade: ARKADE_BTC,
    lightning: LIGHTNING_BTC,
    onchain: ONCHAIN_BTC,
} as const satisfies Record<Corridor, string>;

/**
 * One leg, as the wire spells it.
 *
 * The BTC legs come from `rfq.ts`'s own constants rather than being rebuilt out
 * of the corridor name and a ticker: the solver compares these byte for byte,
 * and a second construction of `arkade:BTC` is a second thing that can drift.
 * An arkade-issued asset is the id verbatim, lowercase — which is what makes the
 * discovery leg the right input, since the alias layer already lowercased it.
 */
export const rfqLeg = (leg: DiscoveryLeg): string =>
    leg.assetId === BTC_ASSET_ID ? BTC_LEG[leg.corridor] : `${leg.corridor}:${leg.assetId}`;

/**
 * The directional pair for a route, checked against the wire's length cap.
 *
 * Direction is give-to-take and never the card's base/quote order: the card
 * describes a market, the pair describes this trade.
 */
export const rfqPairFor = (give: DiscoveryLeg, take: DiscoveryLeg): string => {
    const pair = rfqPair(rfqLeg(give), rfqLeg(take));
    assertPairLength(pair);
    return pair;
};

/**
 * A request payload with its amount in the wire's canonical string encoding.
 *
 * The payload itself is built by `rfq.ts`'s own request builders — they are the
 * schema, and a second copy of the profile field names is a second thing to keep
 * in step with a `.strict()` remote schema. What this adds is the one field
 * whose encoding M3 decided: `amount`, out as a decimal string on every corridor
 * that carries one.
 */
export const withCanonicalAmount = (
    payload: Record<string, unknown>,
    amount: bigint,
): Record<string, unknown> => ({
    ...payload,
    amount: encodeRfqAmount(amount, "amount"),
});

/**
 * A solver's quote, with the fields the client compares against pulled out and
 * decoded once.
 *
 * The amounts are the point: `RfqQuote` declares them `number`, the migration
 * has them arriving as either, and every check downstream is a comparison. One
 * decode at the boundary is what keeps a string amount from failing a `!==`
 * against a bigint three layers down and reading as a solver mismatch.
 */
export interface ParsedRfqQuote {
    /** The reply verbatim, for the record and for anything not decoded here. */
    readonly raw: RfqQuote;
    readonly rfqId: string;
    readonly pair: string;
    /** `from_amount`: what the trader gives, atomic units of the give leg. */
    readonly give: bigint;
    /** `to_amount`: what the trader takes. */
    readonly take: bigint;
    /** The covenant role key the quote commits to. */
    readonly solver: Pubkey;
    readonly validUntil: number;
    /** Optional on the wire; every corridor route refuses a quote without it. */
    readonly refundLocktime?: number;
    readonly profile: Record<string, unknown>;
}

/** Read a solver's quote, decoding both amounts. */
export const parseRfqQuote = (quote: RfqQuote): ParsedRfqQuote => ({
    raw: quote,
    rfqId: quote.rfq_id,
    pair: quote.pair,
    give: decodeRfqAmount(quote.from_amount, "from_amount"),
    take: decodeRfqAmount(quote.to_amount, "to_amount"),
    solver: quote.solver_pubkey,
    validUntil: quote.valid_until,
    ...(quote.refund_locktime === undefined ? {} : { refundLocktime: quote.refund_locktime }),
    profile: quote.profile ?? {},
});
