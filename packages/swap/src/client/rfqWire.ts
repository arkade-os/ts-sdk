/**
 * The RFQ wire adapter: the pair string, the amount encoding, and the reply parse.
 *
 * **The pair string is wire, owned here.** Not the registry's display `pair` (`BTC/lightning:BTC`):
 * the wire's is `<from-leg>-><to-leg>` over `<corridor>:<asset>` legs, the asset a registered ticker
 * or, on arkade only, the 68-hex id. Solvers compare it byte for byte and cap it at 158 chars, so a
 * CAIP-19 id cannot go on it; the public alias layer stops one level above.
 *
 * **Amounts go out as canonical decimal strings, unconditionally** — accepted on all four corridor
 * request schemas, and a JSON number past 2^53 would lose the amount. Replies may carry either form
 * (a number only while a non-negative safe integer), so `AmountEncodingUnsupported` fires on receipt.
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
 * One leg, as the wire spells it. BTC legs use `rfq.ts`'s constants, never rebuilt from name and
 * ticker (a second construction can drift from a byte-compared string). An arkade asset is the id
 * verbatim, already lowercased by the alias layer.
 */
export const rfqLeg = (leg: DiscoveryLeg): string =>
    leg.assetId === BTC_ASSET_ID ? BTC_LEG[leg.corridor] : `${leg.corridor}:${leg.assetId}`;

/** The directional pair, length-checked. Give-to-take, never the card's base/quote order: the card
 * describes a market, the pair this trade. */
export const rfqPairFor = (give: DiscoveryLeg, take: DiscoveryLeg): string => {
    const pair = rfqPair(rfqLeg(give), rfqLeg(take));
    assertPairLength(pair);
    return pair;
};

/** A request payload (built by `rfq.ts`'s builders, which are the schema) with `amount` in the
 * wire's canonical string encoding. */
export const withCanonicalAmount = (
    payload: Record<string, unknown>,
    amount: bigint,
): Record<string, unknown> => ({
    ...payload,
    amount: encodeRfqAmount(amount, "amount"),
});

/**
 * A solver's quote, with the compared fields decoded once. `RfqQuote` types amounts as `number` but
 * they arrive as either form; decoding at the boundary keeps a string amount from failing a `!==`
 * against a bigint downstream and reading as a solver mismatch.
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
