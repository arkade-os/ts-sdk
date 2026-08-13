import { describe, expect, it } from "vitest";
import { compareBookOffers, planBookSweep, type BookOffer } from "../src/orderbook";

const offer = (fundingTxid: string, offerAmount: bigint, wantAmount: bigint): BookOffer => ({
    fundingTxid,
    offerAsset: "RUNE",
    offerAmount,
    wantAsset: "BTC",
    wantAmount,
});

describe("order-book sweep planning", () => {
    it("sorts with exact integer prices and a deterministic txid tie-break", () => {
        const expensive = offer("c", 3n, 2n);
        const cheapB = offer("b", 6n, 3n);
        const cheapA = offer("a", 2n, 1n);

        expect([expensive, cheapB, cheapA].sort(compareBookOffers)).toEqual([
            cheapA,
            cheapB,
            expensive,
        ]);
    });

    it("sweeps whole best-price UTXOs and totals their committed outputs", () => {
        const sweep = planBookSweep(
            [offer("worst", 10n, 20n), offer("best", 4n, 4n), offer("next", 3n, 4n)],
            "RUNE",
            "BTC",
            6n,
        );

        expect(sweep).toEqual({
            fills: [
                { fundingTxid: "best", vout: 0, takeAmount: 4n, payAmount: 4n },
                { fundingTxid: "next", vout: 0, takeAmount: 3n, payAmount: 4n },
            ],
            takeAmount: 7n,
            payAmount: 8n,
        });
    });

    it("filters the requested direction and rejects shallow books", () => {
        const reverse: BookOffer = {
            fundingTxid: "reverse",
            offerAsset: "BTC",
            offerAmount: 100n,
            wantAsset: "RUNE",
            wantAmount: 100n,
        };

        expect(() => planBookSweep([offer("only", 2n, 1n), reverse], "RUNE", "BTC", 3n)).toThrow(
            "insufficient book depth: 2 available, 3 required",
        );
    });

    it("rejects zero amounts before producing a plan", () => {
        expect(() => planBookSweep([offer("bad", 0n, 1n)], "RUNE", "BTC", 1n)).toThrow(
            "offerAmount must be positive",
        );
    });

    it("refuses to plan the same input twice", () => {
        expect(() =>
            planBookSweep([offer("same", 1n, 1n), offer("same", 1n, 1n)], "RUNE", "BTC", 2n),
        ).toThrow("duplicate book outpoint: same:0");
    });
});
