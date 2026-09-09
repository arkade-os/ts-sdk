import { describe, expect, it } from "vitest";
import { isRfqMarket, marketCorridor, marketPairLabel } from "../src/marketShape";

const legacy = {
    pair: "BTC/lightning:BTC",
    base_asset: { id: "btc", ticker: "BTC" },
    quote_asset: { id: "btc", ticker: "BTC" },
    quote_corridor: "lightning",
};

const card = {
    base_asset: { id: "arkade:mutinynet/slip44:1", ticker: "BTC" },
    quote_asset: { id: "bolt11:mutinynet/slip44:1", ticker: "BTC" },
};

describe("market shape compatibility", () => {
    it("classifies legacy and CAIP-19 Lightning markets identically", () => {
        for (const market of [legacy, card]) {
            expect(marketCorridor(market, "base")).toBe("arkade");
            expect(marketCorridor(market, "quote")).toBe("bolt11");
            expect(isRfqMarket(market)).toBe(true);
            expect(marketPairLabel(market)).toBe("BTC/bolt11:BTC");
        }
    });

    it("reads the canonical id retained beside a down-projected index id", () => {
        const index = {
            ...legacy,
            base_asset: { ...legacy.base_asset, caip19_id: "arkade:mutinynet/slip44:1" },
            quote_asset: { ...legacy.quote_asset, caip19_id: "bolt11:mutinynet/slip44:1" },
        };
        expect(marketCorridor(index, "quote")).toBe("bolt11");
    });

    it("prefers a CAIP-19 identity over a disagreeing legacy corridor", () => {
        expect(
            marketCorridor(
                { quote_asset: { id: "bolt11:bitcoin/slip44:0" }, quote_corridor: "onchain" },
                "quote",
            ),
        ).toBe("bolt11");
    });

    it("recognizes Bitcoin and EIP-155 without treating either as spot", () => {
        for (const [id, corridor] of [
            ["bitcoin:bitcoin/slip44:0", "bitcoin"],
            [`eip155:1/erc20:0x${"a".repeat(40)}`, "eip155"],
        ] as const) {
            const market = { quote_asset: { id, ticker: "X" } };
            expect(marketCorridor(market, "quote")).toBe(corridor);
            expect(isRfqMarket(market)).toBe(true);
        }
    });

    it("defaults malformed and unknown namespaces to Arkade", () => {
        expect(marketCorridor({}, "quote")).toBe("arkade");
        expect(marketCorridor({ quote_asset: { id: "ripple:mainnet/slip44:144" } }, "quote")).toBe(
            "arkade",
        );
    });

    it("uses a question mark when display metadata is absent", () => {
        expect(marketPairLabel({ base_asset: {}, quote_asset: {} })).toBe("?/?");
    });
});
