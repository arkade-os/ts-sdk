/**
 * The wire adapter: the pair string M3 owns, and the amount encoding it decided.
 *
 * Both halves exist because the wire is byte-compared. A pair one character off
 * is not an error either side can report — it is a market nobody serves — and an
 * amount that crossed as a JSON number past 2^53 is not an amount anyone can
 * check afterwards.
 */
import { describe, expect, it } from "vitest";
import { AmountEncodingUnsupported } from "../../src/client/errors";
import { parseRfqQuote, rfqLeg, rfqPairFor, withCanonicalAmount } from "../../src/client/rfqWire";
import {
    ARKADE_BTC,
    LIGHTNING_RECEIVE_PAIR,
    LIGHTNING_SEND_PAIR,
    ONCHAIN_SEND_PAIR,
    MAX_PAIR_LENGTH,
    type RfqQuote,
} from "../../src/rfq";
import { USD_ASSET_ID } from "./fixtures";

const arkade = { corridor: "arkade", assetId: "btc" } as const;
const lightning = { corridor: "lightning", assetId: "btc" } as const;
const onchain = { corridor: "onchain", assetId: "btc" } as const;
const usd = { corridor: "arkade", assetId: USD_ASSET_ID } as const;

describe("the pair string", () => {
    it("spells BTC as the wire's own constants do", () => {
        expect(rfqLeg(arkade)).toBe(ARKADE_BTC);
        expect(rfqPairFor(arkade, lightning)).toBe(LIGHTNING_SEND_PAIR);
        expect(rfqPairFor(lightning, arkade)).toBe(LIGHTNING_RECEIVE_PAIR);
        expect(rfqPairFor(arkade, onchain)).toBe(ONCHAIN_SEND_PAIR);
    });

    it("carries an arkade asset as the identity form, verbatim", () => {
        expect(rfqLeg(usd)).toBe(`arkade:${USD_ASSET_ID}`);
        expect(rfqPairFor(arkade, usd)).toBe(`arkade:BTC->arkade:${USD_ASSET_ID}`);
    });

    it("is directional: the trade's direction, never the card's leg order", () => {
        expect(rfqPairFor(usd, arkade)).toBe(`arkade:${USD_ASSET_ID}->arkade:BTC`);
    });

    it("stays inside the wire's length cap", () => {
        expect(rfqPairFor(usd, usd).length).toBeLessThanOrEqual(MAX_PAIR_LENGTH);
    });
});

describe("amounts out", () => {
    it("emits the canonical decimal string on every corridor", () => {
        expect(withCanonicalAmount({ amount: 0, pair: "x" }, 5_000n)).toEqual({
            amount: "5000",
            pair: "x",
        });
    });

    it("emits a string a JSON number could not have carried", () => {
        const big = 2n ** 60n;
        expect(withCanonicalAmount({}, big)).toEqual({ amount: `${big}` });
    });
});

const quote = (over: Partial<RfqQuote>): RfqQuote => ({
    v: 1,
    type: "rfq_quote",
    rfq_id: "ab".repeat(32),
    pair: LIGHTNING_SEND_PAIR,
    from_amount: 5_050,
    to_amount: 5_000,
    solver_pubkey: "cd".repeat(32),
    valid_until: 1_700_003_600,
    refund_locktime: 1_700_007_200,
    profile: {},
    ...over,
});

describe("amounts in", () => {
    it("reads the number form the migration still emits", () => {
        const parsed = parseRfqQuote(quote({}));
        expect(parsed.give).toBe(5_050n);
        expect(parsed.take).toBe(5_000n);
        expect(parsed.refundLocktime).toBe(1_700_007_200);
    });

    it("reads the canonical string form the solver already accepts", () => {
        const parsed = parseRfqQuote(
            quote({
                from_amount: "5050" as unknown as number,
                to_amount: "5000" as unknown as number,
            }),
        );
        expect(parsed.give).toBe(5_050n);
        expect(parsed.take).toBe(5_000n);
    });

    it("refuses a number that has already lost the amount", () => {
        expect(() => parseRfqQuote(quote({ from_amount: Number.MAX_SAFE_INTEGER + 2 }))).toThrow(
            AmountEncodingUnsupported,
        );
    });

    it("refuses a non-canonical string rather than reading around it", () => {
        expect(() => parseRfqQuote(quote({ to_amount: "5_000" as unknown as number }))).toThrow(
            AmountEncodingUnsupported,
        );
        expect(() => parseRfqQuote(quote({ to_amount: "0050" as unknown as number }))).toThrow(
            /canonical/,
        );
    });

    it("leaves an absent refund_locktime absent rather than defaulting it", () => {
        expect(parseRfqQuote(quote({ refund_locktime: undefined })).refundLocktime).toBeUndefined();
    });
});
