import { describe, it, expect } from "vitest";
import { excludeLockedOutpoints } from "../src/wallet/wallet";

describe("excludeLockedOutpoints", () => {
    it("drops vtxos locked by non-terminal intents", () => {
        const vtxos = [
            { txid: "a", vout: 0, value: 100 },
            { txid: "b", vout: 1, value: 200 },
        ];
        const kept = excludeLockedOutpoints(vtxos, [{ txid: "a", vout: 0 }]);
        expect(kept.map((v) => v.txid)).toEqual(["b"]);
    });

    it("returns the input array unchanged when nothing is locked", () => {
        const vtxos = [{ txid: "a", vout: 0 }];
        expect(excludeLockedOutpoints(vtxos, [])).toBe(vtxos);
    });

    it("matches on both txid and vout", () => {
        const vtxos = [
            { txid: "a", vout: 0 },
            { txid: "a", vout: 1 },
        ];
        const kept = excludeLockedOutpoints(vtxos, [{ txid: "a", vout: 1 }]);
        expect(kept).toEqual([{ txid: "a", vout: 0 }]);
    });
});
