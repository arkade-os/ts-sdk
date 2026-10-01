import { describe, expect, it } from "vitest";
import { topoSortByDeps } from "../src/wallet/exit/chain";

const idOf = (t: { id: string }) => t.id;
const depsOf = (t: { id: string; deps: string[] }) => t.deps;

describe("topoSortByDeps", () => {
    it("reorders a scrambled chain so each input precedes its spender", () => {
        // Physical chain root -> a -> b -> c, but handed to us out of order
        // (as buildExitDag's logical order can be for a deep offchain chain).
        const items = [
            { id: "c", deps: ["b"] },
            { id: "a", deps: ["root"] }, // root is onchain, not produced here
            { id: "b", deps: ["a"] },
        ];
        expect(topoSortByDeps(items, idOf, depsOf).map((i) => i.id)).toEqual(["a", "b", "c"]);
    });

    it("treats deps not produced by any item as already-satisfied roots", () => {
        const items = [{ id: "x", deps: ["onchain-commitment"] }];
        expect(topoSortByDeps(items, idOf, depsOf).map((i) => i.id)).toEqual(["x"]);
    });

    it("keeps independent items in their incoming order (deterministic)", () => {
        const items = [
            { id: "p", deps: [] },
            { id: "q", deps: [] },
        ];
        expect(topoSortByDeps(items, idOf, depsOf).map((i) => i.id)).toEqual(["p", "q"]);
    });

    it("orders a branch that converges (two roots feeding one spender)", () => {
        const items = [
            { id: "merge", deps: ["l", "r"] },
            { id: "r", deps: ["commitment"] },
            { id: "l", deps: ["commitment"] },
        ];
        const order = topoSortByDeps(items, idOf, depsOf).map((i) => i.id);
        expect(order.indexOf("merge")).toBeGreaterThan(order.indexOf("l"));
        expect(order.indexOf("merge")).toBeGreaterThan(order.indexOf("r"));
    });

    it("throws on a cycle", () => {
        const items = [
            { id: "a", deps: ["b"] },
            { id: "b", deps: ["a"] },
        ];
        expect(() => topoSortByDeps(items, idOf, depsOf)).toThrow(/cycle|unsatisfiable/i);
    });
});
