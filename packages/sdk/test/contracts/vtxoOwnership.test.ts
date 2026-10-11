import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
    filterVtxosForScript,
    hasVtxosForContract,
    isVtxoForScript,
    validateVtxosForScript,
    vtxoOutpoint,
    warnAndFilterVtxosForScript,
} from "../../src/contracts/vtxoOwnership";
import type { WalletRepository } from "../../src/repositories/walletRepository";

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

    describe("hasVtxosForContract", () => {
        const contract = { script: "a", address: "address-a" };

        it("reads one bounded page rather than the contract's history", async () => {
            const getVtxosForScriptPage = vi
                .fn()
                .mockResolvedValue({ items: [{ address: "address-a", vtxo: row("a") }] });
            const repo = { getVtxosForScriptPage } as unknown as WalletRepository;
            await expect(hasVtxosForContract(repo, contract)).resolves.toBe(true);
            expect(getVtxosForScriptPage).toHaveBeenCalledTimes(1);
            expect(getVtxosForScriptPage).toHaveBeenCalledWith("a", { limit: 1 });
        });

        it("is false on an empty script page", async () => {
            const repo = {
                getVtxosForScriptPage: vi.fn().mockResolvedValue({ items: [] }),
            } as unknown as WalletRepository;
            await expect(hasVtxosForContract(repo, contract)).resolves.toBe(false);
        });

        it("falls back to the address read and ignores wrong-script rows", async () => {
            const getVtxosPage = vi.fn().mockResolvedValue({ items: [row("b")] });
            const repo = { getVtxosPage } as unknown as WalletRepository;
            await expect(hasVtxosForContract(repo, contract)).resolves.toBe(false);
            expect(getVtxosPage).toHaveBeenCalledWith("address-a", expect.objectContaining({}));

            const withMatch = {
                getVtxosPage: vi.fn().mockResolvedValue({ items: [row("a")] }),
            } as unknown as WalletRepository;
            await expect(hasVtxosForContract(withMatch, contract)).resolves.toBe(true);
        });
    });

    describe("filterVtxosForScript", () => {
        it("keeps only matching-script rows", () => {
            const out = filterVtxosForScript([row("a"), row("b"), row("a")], "a");
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
            const out = warnAndFilterVtxosForScript([good, bad], "a", "test-context");
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
            expect(() => validateVtxosForScript([good, bad], "a", "Wallet.ctx")).toThrowError(
                /Wallet\.ctx/,
            );
            expect(() => validateVtxosForScript([good, bad], "a", "Wallet.ctx")).toThrowError(
                new RegExp(vtxoOutpoint(bad)),
            );
        });

        it("returns silently when every row matches", () => {
            expect(() => validateVtxosForScript([row("a"), row("a")], "a", "ctx")).not.toThrow();
        });
    });
});
