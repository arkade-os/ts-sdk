import { describe, expect, it } from "vitest";
import type { DiscoveredMarket } from "@arkade-os/solver-discovery";
import { aliasTableFrom } from "../../src/client/aliasTable";
import { lightningCard } from "./fixtures";

describe("the alias table across card schemas", () => {
    it("reads both canonical card ids and legacy index ids", () => {
        const canonical = {
            ...lightningCard,
            pair: undefined,
            base_corridor: undefined,
            quote_corridor: undefined,
            base_asset: {
                ...lightningCard.base_asset,
                id: "arkade:regtest/slip44:0",
            },
            quote_asset: {
                ...lightningCard.quote_asset,
                id: "bolt11:regtest/slip44:0",
            },
        } as DiscoveredMarket;

        expect(aliasTableFrom([canonical], "regtest").assets).toEqual([
            { id: "arkade:regtest/slip44:0", ticker: "BTC" },
            { id: "bolt11:regtest/slip44:0", ticker: "BTC" },
        ]);
        expect(aliasTableFrom([lightningCard], "regtest").assets).toEqual([
            { id: "arkade:regtest/slip44:0", ticker: "BTC" },
            { id: "bolt11:regtest/slip44:0", ticker: "BTC" },
        ]);
    });
});
