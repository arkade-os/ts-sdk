import { describe, expect, it, vi } from "vitest";
import {
    EXPIRY_MIN_PLAUSIBLE_MS,
    canRecoverOnchain,
    canSpendOffchain,
    canSweepOnchain,
    convertVtxo,
    getNormalizedVtxos,
    hasTerminalSpend,
    isPastExpiry,
    isVirtualCoin,
    normalizeVtxo,
    parseWireExpiry,
    resolveTimeHeight,
} from "../src/wallet/vtxo";
import type { VirtualCoin } from "../src/wallet";
import type { Vtxo } from "../src/providers/indexer";

const SCRIPT = "51".repeat(17);
const NOW = new Date("2026-06-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");

function coin(over: Partial<VirtualCoin> = {}): VirtualCoin {
    return {
        txid: "11".repeat(32),
        vout: 0,
        value: 50_000,
        status: { confirmed: true, isLeaf: true },
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        isUnrolled: false,
        script: SCRIPT,
        isSpent: false,
        isSwept: false,
        isPreconfirmed: false,
        commitmentTxIds: ["22".repeat(32)],
        expiresAt: FUTURE,
        spentBy: "",
        ...over,
    };
}

function minimalCoin(over: Partial<VirtualCoin> = {}): VirtualCoin {
    return {
        txid: "11".repeat(32),
        vout: 0,
        value: 50_000,
        status: { confirmed: true, isLeaf: true },
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        isUnrolled: false,
        script: SCRIPT,
        ...over,
    };
}

describe("expiry parsing", () => {
    it("disambiguates a wire timestamp from a wire block height", () => {
        const seconds = Math.floor(FUTURE.getTime() / 1000);
        expect(parseWireExpiry(String(seconds))).toEqual({ expiresAt: FUTURE });
        expect(parseWireExpiry("500000")).toEqual({ expiresAtHeight: 500_000 });
    });

    it("treats null, blank, zero and invalid values as no expiry", () => {
        for (const raw of [null, undefined, "", "0", "-1", "NaN", "Infinity", "abc"]) {
            expect(parseWireExpiry(raw)).toEqual({});
        }
    });

    it("uses a UTC threshold, so classification does not move with timezone", () => {
        expect(EXPIRY_MIN_PLAUSIBLE_MS).toBe(Date.UTC(2025, 0, 1));
        expect(parseWireExpiry(String(EXPIRY_MIN_PLAUSIBLE_MS / 1000))).toEqual({
            expiresAt: new Date(EXPIRY_MIN_PLAUSIBLE_MS),
        });
        expect(parseWireExpiry(String(EXPIRY_MIN_PLAUSIBLE_MS / 1000 - 1))).toEqual({
            expiresAtHeight: EXPIRY_MIN_PLAUSIBLE_MS / 1000 - 1,
        });
    });

    it("no expiry never reads as permanently expired", () => {
        const v = coin({ expiresAt: undefined, expiresAtHeight: undefined });
        expect(isPastExpiry(v, { timestamp: NOW, height: 800_000 })).toBe(false);
    });
});

describe("truth table", () => {
    const now = { timestamp: NOW };

    it("preconfirmed, unspent is spendable", () => {
        const v = coin({ isPreconfirmed: true, status: { confirmed: false, isLeaf: false } });
        expect(hasTerminalSpend(v)).toBe(false);
        expect(canSpendOffchain(v, now)).toBe(true);
        expect(canRecoverOnchain(v, now)).toBe(false);
    });

    it("settled, unspent is spendable", () => {
        const v = coin();
        expect(canSpendOffchain(v, now)).toBe(true);
        expect(canRecoverOnchain(v, now)).toBe(false);
    });

    it("swept is recoverable and not spendable", () => {
        const v = coin({ isSwept: true });
        expect(canSpendOffchain(v, now)).toBe(false);
        expect(canRecoverOnchain(v, now)).toBe(true);
    });

    it("expired but unswept is recoverable and not spendable", () => {
        const v = coin({ expiresAt: PAST });
        expect(hasTerminalSpend(v)).toBe(false);
        expect(canSpendOffchain(v, now)).toBe(false);
        expect(canRecoverOnchain(v, now)).toBe(true);
    });

    it("spent with spentBy is terminal", () => {
        const v = coin({ isSpent: true, spentBy: "33".repeat(32) });
        expect(hasTerminalSpend(v)).toBe(true);
        expect(canSpendOffchain(v, now)).toBe(false);
        expect(canRecoverOnchain(v, now)).toBe(false);
    });

    it("settledBy makes a VTXO terminal even when isSpent is false", () => {
        const v = coin({ isSpent: false, spentBy: "", settledBy: "44".repeat(32) });
        expect(hasTerminalSpend(v)).toBe(true);
        expect(canSpendOffchain(v, now)).toBe(false);
        expect(canRecoverOnchain(v, now)).toBe(false);
    });

    it("isSpent true with an empty spentBy is terminal", () => {
        const v = coin({ isSpent: true, spentBy: "" });
        expect(hasTerminalSpend(v)).toBe(true);
        expect(canSpendOffchain(v, now)).toBe(false);
        expect(canRecoverOnchain(v, now)).toBe(false);
    });

    it("row 9: unrolled without isSpent → onchain, not terminal", () => {
        // The location axis. `hasTerminalSpend` mirrors NArk's `IsSpent()` and
        // says nothing about where the output lives, so it stays false — but no
        // batch and no offchain spend can reach the coin, so both capability
        // predicates refuse it and `canSweepOnchain` claims it instead.
        const v = coin({ isUnrolled: true, isSpent: false, spentBy: "" });
        expect(hasTerminalSpend(v)).toBe(false);
        expect(canSpendOffchain(v, now)).toBe(false);
        expect(canRecoverOnchain(v, now)).toBe(false);
        expect(canSweepOnchain(v)).toBe(true);
    });

    it("row 10: unrolled AND swept → still only sweepable, never recoverable", () => {
        // Without the `!isUnrolled` clause in `canRecoverOnchain` this coin
        // would be offered to a recovery batch, which cannot lift an output
        // that already lives onchain.
        const v = coin({ isUnrolled: true, isSwept: true });
        expect(canRecoverOnchain(v, now)).toBe(false);
        expect(canSpendOffchain(v, now)).toBe(false);
        expect(canSweepOnchain(v)).toBe(true);
    });

    it("row 11: unrolled and then spent → no capability at all", () => {
        // The exit output was swept away by `completeUnroll`; nothing is left.
        for (const over of [
            { isSpent: true, spentBy: "" },
            { spentBy: "33".repeat(32) },
            { settledBy: "44".repeat(32) },
        ]) {
            const v = coin({ isUnrolled: true, ...over });
            expect(hasTerminalSpend(v)).toBe(true);
            expect(canSweepOnchain(v)).toBe(false);
            expect(canSpendOffchain(v, now)).toBe(false);
            expect(canRecoverOnchain(v, now)).toBe(false);
        }
    });

    it("the three capabilities partition the unspent set", () => {
        for (const v of [
            coin(),
            coin({ isSwept: true }),
            coin({ expiresAt: PAST }),
            coin({ isUnrolled: true }),
            coin({ isUnrolled: true, isSwept: true }),
        ]) {
            const claims = [
                canSpendOffchain(v, now),
                canRecoverOnchain(v, now),
                canSweepOnchain(v),
            ].filter(Boolean);
            expect(claims).toHaveLength(1);
        }
    });
});

describe("normalization", () => {
    it("fills absent optional facts with canonical defaults", () => {
        const n = normalizeVtxo(minimalCoin());
        expect(n.isSwept).toBe(false);
        expect(n.isSpent).toBe(false);
        expect(n.isPreconfirmed).toBe(false);
        expect(n.spentBy).toBe("");
        expect(n.commitmentTxIds).toEqual([]);
        expect(n.expiresAt).toBeUndefined();
        expect(n.expiresAtHeight).toBeUndefined();
    });

    it("keeps a coin own authoritative facts", () => {
        const n = normalizeVtxo(minimalCoin({ isSwept: true, commitmentTxIds: ["22".repeat(32)] }));
        expect(n.isSwept).toBe(true);
        expect(n.commitmentTxIds).toEqual(["22".repeat(32)]);
    });

    it("is idempotent", () => {
        const once = normalizeVtxo(coin({ isPreconfirmed: true }));
        expect(normalizeVtxo(once)).toEqual(once);
    });

    it("rehydrates an expiresAt that a JSON round-trip turned into a string", () => {
        const wire = coin();
        const viaJson = JSON.parse(JSON.stringify(wire));
        const n = normalizeVtxo({ ...wire, expiresAt: viaJson.expiresAt });
        expect(n.expiresAt).toBeInstanceOf(Date);
        expect(n.expiresAt!.getTime()).toBe(FUTURE.getTime());
    });

    it("minimal and normalized coins yield the same predicate verdicts", () => {
        const now = { timestamp: NOW };
        const minimal = minimalCoin({ isSwept: true });
        const normalized = normalizeVtxo(minimal);
        expect(hasTerminalSpend(minimal)).toBe(hasTerminalSpend(normalized));
        expect(isPastExpiry(minimal, now)).toBe(isPastExpiry(normalized, now));
        expect(canSpendOffchain(minimal, now)).toBe(canSpendOffchain(normalized, now));
        expect(canRecoverOnchain(minimal, now)).toBe(canRecoverOnchain(normalized, now));
    });
});

describe("height-based expiry", () => {
    it("is evaluated when a height is supplied", () => {
        const v = coin({ expiresAt: undefined, expiresAtHeight: 500_000 });
        expect(isPastExpiry(v, { timestamp: NOW, height: 500_001 })).toBe(true);
        expect(canSpendOffchain(v, { timestamp: NOW, height: 500_001 })).toBe(false);
        expect(canRecoverOnchain(v, { timestamp: NOW, height: 500_001 })).toBe(true);
    });

    it("reads as not expired when no height is supplied", () => {
        const v = coin({ expiresAt: undefined, expiresAtHeight: 500_000 });
        expect(isPastExpiry(v, { timestamp: NOW })).toBe(false);
        expect(canSpendOffchain(v, { timestamp: NOW })).toBe(true);
    });
});

describe("isVirtualCoin", () => {
    it("classifies every input kind in one mixed array, with no TypeError", () => {
        const boarding = { txid: "aa".repeat(32), vout: 1, value: 1, status: { confirmed: true } };
        const canonical = coin();
        const minimal = minimalCoin();
        const arknote = "arknote1qqqq";
        const mixed = [boarding, canonical, minimal, arknote, null, undefined];

        expect(mixed.map(isVirtualCoin)).toEqual([false, true, true, false, false, false]);
    });
});

describe("convertVtxo", () => {
    const wire: Vtxo = {
        outpoint: { txid: "11".repeat(32), vout: 0 },
        createdAt: "1767225600",
        expiresAt: String(Math.floor(FUTURE.getTime() / 1000)),
        amount: "50000",
        script: SCRIPT,
        isPreconfirmed: false,
        isSwept: false,
        isUnrolled: false,
        isSpent: false,
        spentBy: null,
        commitmentTxids: ["22".repeat(32)],
    };

    it("maps the wire shape to canonical facts", () => {
        const v = convertVtxo(wire);
        expect(v.isSwept).toBe(false);
        expect(v.isPreconfirmed).toBe(false);
        expect(v.isSpent).toBe(false);
        expect(v.expiresAt).toEqual(FUTURE);
        expect(v.commitmentTxIds).toEqual(["22".repeat(32)]);
        expect(v.spentBy).toBe("");
    });

    it("maps a spent wire vtxo to terminal state", () => {
        const v = convertVtxo({ ...wire, isSpent: true, spentBy: "33".repeat(32) });
        expect(v.isSpent).toBe(true);
        expect(v.spentBy).toBe("33".repeat(32));
        expect(hasTerminalSpend(v)).toBe(true);
    });

    it("routes a height-encoded wire expiry to expiresAtHeight", () => {
        const v = convertVtxo({ ...wire, expiresAt: "500000" });
        expect(v.expiresAt).toBeUndefined();
        expect(v.expiresAtHeight).toBe(500_000);
    });
});

describe("getNormalizedVtxos", () => {
    it("normalizes a consumer-implemented provider and preserves page", async () => {
        const page = { current: 0, next: 1, total: 2 };
        const provider = {
            getVtxos: async () => ({ vtxos: [minimalCoin({ isSwept: true })], page }),
        };

        const res = await getNormalizedVtxos(provider as never);

        expect(res.page).toBe(page);
        expect(res.vtxos[0].isSwept).toBe(true);
        expect(res.vtxos[0].commitmentTxIds).toEqual([]);
        expect(canRecoverOnchain(res.vtxos[0], { timestamp: NOW })).toBe(true);
    });
});

describe("resolveTimeHeight", () => {
    it("returns the tip height when the provider answers", async () => {
        const provider = { getChainTip: vi.fn().mockResolvedValue({ height: 812_345 }) };

        const now = await resolveTimeHeight(provider);

        expect(now.height).toBe(812_345);
        expect(now.timestamp).toBeInstanceOf(Date);
    });

    it("degrades to timestamp-only when the tip fetch rejects", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const provider = { getChainTip: vi.fn().mockRejectedValue(new Error("esplora down")) };

        const now = await resolveTimeHeight(provider);

        expect(now.height).toBeUndefined();
        expect(now.timestamp).toBeInstanceOf(Date);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it("omits height when no provider is supplied", async () => {
        const now = await resolveTimeHeight(undefined);

        expect(now.height).toBeUndefined();
        expect(now.timestamp).toBeInstanceOf(Date);
    });

    it("reads a height-encoded expiry as not expired once height is unavailable", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const v = normalizeVtxo(minimalCoin({ expiresAtHeight: 100 }));

        const withTip = await resolveTimeHeight({
            getChainTip: vi.fn().mockResolvedValue({ height: 500 }),
        });
        const degraded = await resolveTimeHeight({
            getChainTip: vi.fn().mockRejectedValue(new Error("esplora down")),
        });

        expect(isPastExpiry(v, withTip)).toBe(true);
        expect(isPastExpiry(v, degraded)).toBe(false);
        warn.mockRestore();
    });
});
