import { describe, it, expect } from "vitest";
import * as root from "../src";
import * as sqlite from "../src/repositories/sqlite";
import * as realm from "../src/repositories/realm";

// ChainedTxType is part of the public VirtualTx contract (VirtualTx.type), so it
// must be importable as a runtime value — not just a type — from every
// entrypoint that exposes a VirtualTx repository. Guards against it silently
// dropping out of the barrels again.
describe("ChainedTxType is exported as a runtime value", () => {
    it("from the root entrypoint", () => {
        expect(root.ChainedTxType.Unspecified).toBe(0);
        expect(root.ChainedTxType.Checkpoint).toBe(4);
    });

    it("from the sqlite and realm repository subpaths", () => {
        expect(sqlite.ChainedTxType.Checkpoint).toBe(4);
        expect(realm.ChainedTxType.Checkpoint).toBe(4);
    });
});
