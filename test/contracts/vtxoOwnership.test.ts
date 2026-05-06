import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
    filterVtxosForScript,
    isVtxoForScript,
    validateVtxosForScript,
    vtxoOutpoint,
    warnAndFilterVtxosForScript,
} from "../../src/contracts/vtxoOwnership";

const row = (script: string, txid = "aa".repeat(32), vout = 0) => ({
    txid,
    vout,
    script,
});

describe("vtxoOwnership", () => {
    describe("isVtxoForScript", () => {
        it("matches when scripts are equal", () => {
            expect(isVtxoForScript({ script: "abc" }, "abc")).toBe(true);
        });
        it("rejects when scripts differ", () => {
            expect(isVtxoForScript({ script: "abc" }, "xyz")).toBe(false);
        });
        it("rejects empty script", () => {
            expect(isVtxoForScript({ script: "" }, "")).toBe(false);
        });
    });

    describe("filterVtxosForScript", () => {
        it("keeps only matching-script rows", () => {
            const out = filterVtxosForScript(
                [row("a"), row("b"), row("a")],
                "a"
            );
            expect(out).toHaveLength(2);
            expect(out.every((v) => v.script === "a")).toBe(true);
        });
    });

    describe("warnAndFilterVtxosForScript", () => {
        let warnSpy: ReturnType<typeof vi.spyOn>;
        beforeEach(() => {
            warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        });
        afterEach(() => {
            warnSpy.mockRestore();
        });

        it("returns matches and warns about rejected outpoints", () => {
            const good = row("a", "aa".repeat(32), 0);
            const bad = row("b", "bb".repeat(32), 1);
            const out = warnAndFilterVtxosForScript(
                [good, bad],
                "a",
                "test-context"
            );
            expect(out).toEqual([good]);
            expect(warnSpy).toHaveBeenCalledOnce();
            const msg = warnSpy.mock.calls[0][0] as string;
            expect(msg).toContain("test-context");
            expect(msg).toContain(vtxoOutpoint(bad));
        });

        it("does not warn when all rows match", () => {
            const out = warnAndFilterVtxosForScript([row("a")], "a", "ctx");
            expect(out).toHaveLength(1);
            expect(warnSpy).not.toHaveBeenCalled();
        });
    });

    describe("validateVtxosForScript", () => {
        it("throws on a wrong-script row, naming the outpoint and context", () => {
            const good = row("a");
            const bad = row("b", "bb".repeat(32), 1);
            expect(() =>
                validateVtxosForScript([good, bad], "a", "Wallet.ctx")
            ).toThrowError(/Wallet\.ctx/);
            expect(() =>
                validateVtxosForScript([good, bad], "a", "Wallet.ctx")
            ).toThrowError(new RegExp(vtxoOutpoint(bad)));
        });

        it("returns silently when every row matches", () => {
            expect(() =>
                validateVtxosForScript([row("a"), row("a")], "a", "ctx")
            ).not.toThrow();
        });
    });
});
