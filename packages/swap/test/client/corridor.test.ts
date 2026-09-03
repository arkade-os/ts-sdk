import { CORRIDORS as DISCOVERY_CORRIDORS } from "@arkade-os/solver-discovery";
import { describe, expect, it } from "vitest";
import { BITCOIN_RAILS, railOf } from "../../src/client/assetId";
import { CORRIDORS, corridorOfRail, railOfCorridor } from "../../src/client/corridor";

describe("the corridor axis and its rails", () => {
    it("re-exports discovery's corridor list by identity", () => {
        expect(CORRIDORS).toBe(DISCOVERY_CORRIDORS);
    });

    it("is a bijection with the bitcoin-family rails", () => {
        for (const corridor of DISCOVERY_CORRIDORS) {
            expect(corridorOfRail(railOfCorridor(corridor))).toBe(corridor);
        }
        for (const rail of BITCOIN_RAILS) {
            const corridor = corridorOfRail(rail);
            expect(corridor).toBeDefined();
            expect(railOfCorridor(corridor!)).toBe(rail);
        }
    });

    it("disagrees with discovery on exactly one member, and names it bolt11", () => {
        expect(railOfCorridor("arkade")).toBe("arkade");
        expect(railOfCorridor("onchain")).toBe("bitcoin");
        expect(railOfCorridor("lightning")).toBe("bolt11");
    });

    it("puts every EVM chain on the eip155 rail", () => {
        expect(railOfCorridor("eip155:8453")).toBe("eip155");
        // ...and cannot invert it: the corridor id carries a chain reference
        // this side has no way to invent.
        expect(corridorOfRail("eip155")).toBe(undefined);
    });

    it("agrees with the rail an asset id spells", () => {
        expect(railOf("bolt11:bitcoin/slip44:0")).toBe(railOfCorridor("lightning"));
        expect(railOf("bitcoin:bitcoin/slip44:0")).toBe(railOfCorridor("onchain"));
        expect(railOf("arkade:bitcoin/slip44:0")).toBe(railOfCorridor("arkade"));
    });
});
