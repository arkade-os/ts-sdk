import { describe, expect, it } from "vitest";
import {
    openRfqPayload,
    parseOpenRfqBid,
    rankOpenRfqBids,
    type OpenRfqRequest,
} from "../src/openRfq";

const request: OpenRfqRequest = {
    openId: "a".repeat(64),
    pair: "arkade:bitcoin/slip44:0->arkade:bitcoin/asset:abcd",
    amountSide: "from",
    amount: 10_000n,
    bidsUntil: 1_000,
};
const payload = (changes: Record<string, unknown> = {}) => ({
    v: 1,
    type: "rfq_bid",
    open_id: request.openId,
    pair: request.pair,
    amount_side: "from",
    from_amount: "10000",
    to_amount: "123000000000000000001",
    valid_until: 1_020,
    card: { signed: true },
    ...changes,
});

describe("open RFQ prices", () => {
    it("publishes exactly the public pair and atomic size", () => {
        expect(openRfqPayload(request)).toEqual({
            v: 1,
            type: "rfq_open",
            open_id: "a".repeat(64),
            pair: request.pair,
            amount_side: "from",
            amount: "10000",
            bids_until: 1_000,
        });
    });

    it("preserves cross-asset amounts above the safe-number range", () => {
        const bid = parseOpenRfqBid(payload(), "a".repeat(64), "b".repeat(64));
        expect(bid?.fromAmount).toBe(10_000n);
        expect(bid?.toAmount).toBe(123000000000000000001n);
        expect(bid?.solverPubkey).toBe("a".repeat(64));
    });

    it("rejects other open RFQ wire versions", () => {
        expect(parseOpenRfqBid(payload({ v: 2 }), "a".repeat(64), "b".repeat(64))).toBeNull();
    });

    it("rejects the unshipped fee-only bid shape", () => {
        expect(
            parseOpenRfqBid(
                {
                    v: 1,
                    type: "rfq_bid",
                    open_id: request.openId,
                    pair: request.pair,
                    fee_bps: 30,
                    fee_flat: 10,
                    min: 500,
                    max: 50_000,
                    valid_until: 1_020,
                },
                "a".repeat(64),
                "b".repeat(64),
            ),
        ).toBeNull();
    });

    it.each(["01", "0", "-1", "1e18", " 42", "1.5", "9".repeat(129), 10_000])(
        "drops non-canonical positive amount %s",
        (amount) => {
            expect(
                parseOpenRfqBid(payload({ to_amount: amount }), "a".repeat(64), "b".repeat(64)),
            ).toBeNull();
        },
    );

    it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        "drops invalid expiry %s",
        (validUntil) => {
            expect(
                parseOpenRfqBid(
                    payload({ valid_until: validUntil }),
                    "a".repeat(64),
                    "b".repeat(64),
                ),
            ).toBeNull();
        },
    );

    it("ranks exact-in by output and exact-out by input with stable key ties", () => {
        const first = parseOpenRfqBid(payload(), "b".repeat(64), "1".repeat(64))!;
        const better = parseOpenRfqBid(
            payload({ to_amount: "123000000000000000002" }),
            "c".repeat(64),
            "2".repeat(64),
        )!;
        const tied = { ...first, solverPubkey: "a".repeat(64) };
        expect(
            rankOpenRfqBids([first, better, tied], "from").map((bid) => bid.solverPubkey[0]),
        ).toEqual(["c", "a", "b"]);
        expect(
            rankOpenRfqBids(
                [
                    { ...first, fromAmount: 12n },
                    { ...better, fromAmount: 10n },
                ],
                "to",
            ).map((bid) => bid.fromAmount),
        ).toEqual([10n, 12n]);
    });

    it("rejects invalid requests before serialization", () => {
        expect(() => openRfqPayload({ ...request, amount: 0n })).toThrow();
        expect(() => openRfqPayload({ ...request, pair: "same->same->other" })).toThrow();
        expect(() =>
            openRfqPayload({ ...request, pair: request.pair.replace("->", "~") }),
        ).toThrow();
        expect(() => openRfqPayload({ ...request, bidsUntil: 1.5 })).toThrow();
    });

    it("rejects numeric amounts and the unshipped bucket-sized request shape", () => {
        expect(() => openRfqPayload({ ...request, amount: 10_000 as unknown as bigint })).toThrow();
        expect(() =>
            openRfqPayload({
                ...request,
                amount: undefined,
                size: { sizeBucket: { min: 500n, max: 50_000n } },
            } as unknown as OpenRfqRequest),
        ).toThrow();
    });
});
