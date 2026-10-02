/**
 * Open RFQ, client half (rfq-protocol § 4.6).
 *
 * The tests that matter most are the conformance ones. § 4.6 fixes the
 * rounding — ceiling for exact-out, floor for exact-in — precisely so both
 * sides agree on whether a boundary quote conforms. Get the direction wrong
 * and a solver's honest quote reads as a breach, or a breach reads as honest.
 * The spec publishes a worked example at `fee_bps` 25 / `fee_flat` 50; those
 * exact numbers are pinned below, from both directions.
 */
import { describe, expect, it } from "vitest";
import {
    RFQ_BROADCAST_KIND,
    exactInPayout,
    exactOutCost,
    formatWireAmount,
    openRfqPayload,
    parseBid,
    parseWireAmount,
    pickBestBid,
    rankBids,
    type SolverBid,
} from "../src/openRfq";

const bid = (over: Partial<SolverBid> = {}): SolverBid => ({
    solverPubkey: "aa".repeat(32),
    openId: "9f".repeat(32),
    pair: "arkade:BTC->lightning:BTC",
    feeBps: 25,
    feeFlat: 50n,
    min: 1_000n,
    max: 100_000n,
    validUntil: 1_800_000_900,
    ...over,
});

const TERMS = {
    pair: "arkade:BTC->lightning:BTC",
    openId: "9f".repeat(32),
    amountSide: "to" as const,
    amount: 25_000n,
};
const NOW = 1_800_000_000;

describe("the kind", () => {
    it("broadcasts on 24860, leaving 24859 to directed traffic", () => {
        // Bids come back on the DIRECTED kind, not this one — they are sealed
        // to the client, so they are not broadcasts.
        expect(RFQ_BROADCAST_KIND).toBe(24860);
    });
});

describe("wire amounts", () => {
    it("reads the § 2.1 canonical string", () => {
        expect(parseWireAmount("0")).toBe(0n);
        expect(parseWireAmount("25000")).toBe(25_000n);
    });

    it("reads the legacy JSON number, which is what solvers actually send today", () => {
        expect(parseWireAmount(1_000)).toBe(1_000n);
    });

    it("refuses the spellings that misprice by orders of magnitude", () => {
        for (const bad of ["1e18", "1E18", "1e+8", "1.5", " 42", "42 ", "-1", "007", "", "0x10"]) {
            expect(parseWireAmount(bad), bad).toBeNull();
        }
    });

    it("refuses a number JSON.parse already rounded", () => {
        // Past 2^53-1 the value on the wire is not the value the sender wrote,
        // and no validator downstream can recover it.
        expect(parseWireAmount(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
        expect(parseWireAmount(1.5)).toBeNull();
        expect(parseWireAmount(-1)).toBeNull();
    });

    it("survives an amount no double could hold", () => {
        // One whole token of an 18-decimal asset. The reason § 2.1 exists.
        const huge = "1000000000000000000";
        expect(parseWireAmount(huge)).toBe(1_000_000_000_000_000_000n);
        expect(formatWireAmount(parseWireAmount(huge)!)).toBe(huge);
    });
});

describe("§ 4.6 conformance arithmetic", () => {
    // The spec's own worked example, both directions. "an exact-out request for
    // 25 000 permits from_amount up to ceil(25 062.5) + 50 = 25 113, and an
    // exact-in request of 25 113 requires to_amount of at least 25 000 — the
    // same boundary from either side."
    it("prices the spec's worked exact-out example at 25113", () => {
        expect(exactOutCost({ feeBps: 25, feeFlat: 50n }, 25_000n)).toBe(25_113n);
    });

    it("prices the spec's worked exact-in example at 25000, the same boundary", () => {
        expect(exactInPayout({ feeBps: 25, feeFlat: 50n }, 25_113n)).toBe(25_000n);
    });

    it("rounds the exact-out product UP, so a boundary quote conforms", () => {
        // 25 000 · 1.0025 = 25 062.5 exactly. Rounding down here would make the
        // solver's honest 25 113 read as one sat over the cap.
        expect(exactOutCost({ feeBps: 25, feeFlat: 0n }, 25_000n)).toBe(25_063n);
    });

    it("rounds the exact-in quotient DOWN", () => {
        expect(exactInPayout({ feeBps: 25, feeFlat: 0n }, 25_063n)).toBe(25_000n);
    });

    it("treats a zero-fee bid as pass-through", () => {
        expect(exactOutCost({ feeBps: 0, feeFlat: 0n }, 25_000n)).toBe(25_000n);
        expect(exactInPayout({ feeBps: 0, feeFlat: 0n }, 25_000n)).toBe(25_000n);
    });

    it("calls a trade under the flat fee unquotable rather than free", () => {
        // The payout would be zero or negative. § 4.6 has the solver refuse
        // this as `pricing_unavailable`, so the client must not rank it.
        expect(exactInPayout({ feeBps: 25, feeFlat: 50n }, 50n)).toBeNull();
        expect(exactInPayout({ feeBps: 25, feeFlat: 50n }, 49n)).toBeNull();
        expect(exactInPayout({ feeBps: 25, feeFlat: 50n }, 51n)).toBe(0n);
    });

    it("stays exact at a scale that would round as a double", () => {
        const huge = 10n ** 18n;
        // (10^18 · 10025)/10^4 is far past 2^53; a float would lose the tail.
        expect(exactOutCost({ feeBps: 25, feeFlat: 0n }, huge)).toBe(1_002_500_000_000_000_000n);
    });
});

describe("parseBid", () => {
    const payload = {
        v: 1,
        type: "rfq_bid",
        open_id: "9f".repeat(32),
        pair: "arkade:BTC->lightning:BTC",
        fee_bps: 25,
        fee_flat: 50,
        min: 1_000,
        max: 100_000,
        valid_until: 1_800_000_900,
    };

    it("parses the payload today's solver actually publishes — numbers, not strings", () => {
        const parsed = parseBid(payload, "bb".repeat(32));
        expect(parsed?.feeFlat).toBe(50n);
        expect(parsed?.min).toBe(1_000n);
        expect(parsed?.max).toBe(100_000n);
    });

    it("attributes the bid to the EVENT's key, never the payload's claim", () => {
        // The signature is what makes a bid non-repudiable. A self-declared
        // pubkey in the body would let one solver post another's price.
        const parsed = parseBid({ ...payload, solver_pubkey: "cc".repeat(32) }, "bb".repeat(32));
        expect(parsed?.solverPubkey).toBe("bb".repeat(32));
    });

    it("treats an absent fee_flat as zero, so a pre-field bid still reads", () => {
        const { fee_flat: _omitted, ...withoutFlat } = payload;
        expect(parseBid(withoutFlat, "bb".repeat(32))?.feeFlat).toBe(0n);
    });

    it("drops what is not a bid, rather than throwing on a shared bus", () => {
        expect(parseBid(null, "bb".repeat(32))).toBeNull();
        expect(parseBid("nonsense", "bb".repeat(32))).toBeNull();
        expect(parseBid({ ...payload, type: "rfq_quote" }, "bb".repeat(32))).toBeNull();
        expect(parseBid({ ...payload, v: 2 }, "bb".repeat(32))).toBeNull();
    });

    it("refuses a fee_bps that is not a rate", () => {
        // Above 10⁴ it is not a spread; a "bid" of 20 000 bps would otherwise
        // rank as if it were a price.
        for (const feeBps of [-1, 10_001, 1.5, Number.NaN]) {
            expect(
                parseBid({ ...payload, fee_bps: feeBps }, "bb".repeat(32)),
                String(feeBps),
            ).toBeNull();
        }
        expect(parseBid({ ...payload, fee_bps: 10_000 }, "bb".repeat(32))).not.toBeNull();
        expect(parseBid({ ...payload, fee_bps: 0 }, "bb".repeat(32))).not.toBeNull();
    });

    it("refuses inverted or malformed bounds", () => {
        expect(parseBid({ ...payload, min: 100_000, max: 1_000 }, "bb".repeat(32))).toBeNull();
        expect(parseBid({ ...payload, min: "1e5" }, "bb".repeat(32))).toBeNull();
        expect(parseBid({ ...payload, max: undefined }, "bb".repeat(32))).toBeNull();
    });
});

describe("ranking", () => {
    it("picks the cheapest conforming bid for an exact-out request", () => {
        const cheap = bid({ solverPubkey: "01".repeat(32), feeBps: 10 });
        const dear = bid({ solverPubkey: "02".repeat(32), feeBps: 90 });
        expect(pickBestBid([dear, cheap], TERMS, NOW)?.bid.solverPubkey).toBe(cheap.solverPubkey);
    });

    it("picks the biggest payout for an exact-in request", () => {
        // Same bids, opposite direction — the winner must flip with the side.
        const generous = bid({ solverPubkey: "01".repeat(32), feeBps: 10 });
        const stingy = bid({ solverPubkey: "02".repeat(32), feeBps: 90 });
        const terms = { ...TERMS, amountSide: "from" as const, amount: 25_113n };
        expect(pickBestBid([stingy, generous], terms, NOW)?.bid.solverPubkey).toBe(
            generous.solverPubkey,
        );
    });

    it("weighs the flat fee against the spread rather than ranking on bps alone", () => {
        // A tighter spread with a fat flat fee loses at this size. Ranking on
        // fee_bps alone — the obvious shortcut — picks the wrong one.
        const tightSpreadFatFlat = bid({ solverPubkey: "01".repeat(32), feeBps: 1, feeFlat: 500n });
        const widerSpreadNoFlat = bid({ solverPubkey: "02".repeat(32), feeBps: 25, feeFlat: 0n });
        const winner = pickBestBid([tightSpreadFatFlat, widerSpreadNoFlat], TERMS, NOW);
        expect(winner?.bid.solverPubkey).toBe(widerSpreadNoFlat.solverPubkey);
        expect(winner?.counterAmount).toBe(25_063n);
    });

    it("drops a bid that answers a different open RFQ or market", () => {
        expect(pickBestBid([bid({ openId: "ab".repeat(32) })], TERMS, NOW)).toBeNull();
        expect(pickBestBid([bid({ pair: "onchain:BTC->arkade:BTC" })], TERMS, NOW)).toBeNull();
    });

    it("drops a lapsed bid — a price with no validity is not a price", () => {
        expect(pickBestBid([bid({ validUntil: NOW })], TERMS, NOW)).toBeNull();
        expect(pickBestBid([bid({ validUntil: NOW + 1 })], TERMS, NOW)).not.toBeNull();
    });

    it("drops a bid whose bounds exclude the size, on the TO leg", () => {
        expect(pickBestBid([bid({ min: 25_001n })], TERMS, NOW)).toBeNull();
        expect(pickBestBid([bid({ max: 24_999n })], TERMS, NOW)).toBeNull();
        expect(pickBestBid([bid({ min: 25_000n, max: 25_000n })], TERMS, NOW)).not.toBeNull();
    });

    it("checks an exact-in size against the bounds AFTER pricing", () => {
        // § 4.6: conformance is always evaluated on the to leg, which for an
        // exact-in request is the payout the bid implies — not the from amount
        // the client named.
        const terms = { ...TERMS, amountSide: "from" as const, amount: 25_113n };
        expect(pickBestBid([bid({ min: 25_000n, max: 25_000n })], terms, NOW)).not.toBeNull();
        // 25_113 is inside [min,max] but the PAYOUT 25_000 is not.
        expect(pickBestBid([bid({ min: 25_100n, max: 25_200n })], terms, NOW)).toBeNull();
    });

    it("breaks ties deterministically, so relay arrival order cannot decide", () => {
        const a = bid({ solverPubkey: "01".repeat(32) });
        const b = bid({ solverPubkey: "02".repeat(32) });
        expect(pickBestBid([a, b], TERMS, NOW)?.bid.solverPubkey).toBe(a.solverPubkey);
        expect(pickBestBid([b, a], TERMS, NOW)?.bid.solverPubkey).toBe(a.solverPubkey);
    });

    it("returns every conforming bid, best first, for a caller that wants a fallback", () => {
        const ranked = rankBids(
            [
                bid({ solverPubkey: "03".repeat(32), feeBps: 90 }),
                bid({ solverPubkey: "01".repeat(32), feeBps: 10 }),
            ],
            TERMS,
            NOW,
        );
        expect(ranked.map((r) => r.bid.solverPubkey)).toEqual(["01".repeat(32), "03".repeat(32)]);
        expect(ranked[0]!.counterAmount).toBeLessThan(ranked[1]!.counterAmount);
    });

    it("has nothing to pick when every bid is refused", () => {
        expect(pickBestBid([], TERMS, NOW)).toBeNull();
    });
});

describe("openRfqPayload", () => {
    it("publishes amounts in canonical string form, whatever it accepts on read", () => {
        const payload = openRfqPayload({
            openId: "9f".repeat(32),
            pair: "arkade:BTC->lightning:BTC",
            amountSide: "to",
            size: { amount: 50_000n },
            bidsUntil: 1_800_000_030,
        });
        expect(payload).toEqual({
            v: 1,
            type: "rfq_open",
            open_id: "9f".repeat(32),
            pair: "arkade:BTC->lightning:BTC",
            amount_side: "to",
            amount: "50000",
            bids_until: 1_800_000_030,
        });
    });

    it("carries a size bucket instead, for a client hiding its size", () => {
        const payload = openRfqPayload({
            openId: "9f".repeat(32),
            pair: "arkade:BTC->lightning:BTC",
            amountSide: "to",
            size: { sizeBucket: { min: 10_000n, max: 100_000n } },
        });
        expect(payload.size_bucket).toEqual({ min: "10000", max: "100000" });
        // Exactly one of the two, per § 4.6 — the solver's schema refuses both.
        expect(payload.amount).toBeUndefined();
        // Omitted rather than null: the client did not commit to a window.
        expect("bids_until" in payload).toBe(false);
    });

    it("carries no invoice, address or recipient — it is a plaintext broadcast", () => {
        const payload = openRfqPayload({
            openId: "9f".repeat(32),
            pair: "arkade:BTC->lightning:BTC",
            amountSide: "to",
            size: { amount: 50_000n },
        });
        // The reason this cannot be "the directed request minus the p tag":
        // publishing a BOLT11 leaks the destination and invites anyone to pay
        // it, burning the hash outside the swap.
        for (const leak of ["invoice", "payment_hash", "profile", "address", "p"]) {
            expect(leak in payload, leak).toBe(false);
        }
    });
});
