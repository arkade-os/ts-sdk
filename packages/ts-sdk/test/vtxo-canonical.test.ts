import { describe, expect, it, vi } from "vitest";
import {
    EXPIRY_MIN_PLAUSIBLE_MS,
    canRecoverOnchain,
    canSpendOffchain,
    convertVtxo,
    getNormalizedVtxos,
    hasTerminalSpend,
    isExpired,
    isPastExpiry,
    isRecoverable,
    isSpendable,
    isVirtualCoin,
    normalizeVtxo,
    parseLegacyExpiry,
    parseWireExpiry,
    resolveTimeHeight,
    toBatchExpiry,
    toVirtualStatus,
} from "../src/wallet/vtxo";
import type { VirtualCoin, VirtualStatus } from "../src/wallet";
import type { Vtxo } from "../src/providers/indexer";

const SCRIPT = "51".repeat(17);
const NOW = new Date("2026-06-01T00:00:00.000Z");
const FUTURE = new Date("2027-01-01T00:00:00.000Z");
const PAST = new Date("2026-01-01T00:00:00.000Z");

/** A canonical-shaped coin. Overrides land on top so each test states only what it varies. */
function coin(over: Partial<VirtualCoin> = {}): VirtualCoin {
    const facts = {
        isSpent: false,
        isSwept: false,
        isPreconfirmed: false,
        commitmentTxIds: ["22".repeat(32)],
        expiresAt: FUTURE,
        ...over,
    };
    return {
        txid: "11".repeat(32),
        vout: 0,
        value: 50_000,
        status: { confirmed: true, isLeaf: true },
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        isUnrolled: false,
        script: SCRIPT,
        spentBy: "",
        ...facts,
        virtualStatus: toVirtualStatus(facts),
        ...over,
    };
}

/**
 * A coin as a pre-canonical SDK (or a consumer-implemented provider/repository) hands it over:
 * `virtualStatus` and nothing else.
 */
function legacyCoin(state: VirtualStatus["state"], over: Partial<VirtualCoin> = {}): VirtualCoin {
    return {
        txid: "11".repeat(32),
        vout: 0,
        value: 50_000,
        status: { confirmed: true, isLeaf: true },
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        isUnrolled: false,
        script: SCRIPT,
        virtualStatus: {
            state,
            commitmentTxIds: ["22".repeat(32)],
            batchExpiry: FUTURE.getTime(),
        },
        ...over,
    } as VirtualCoin;
}

describe("expiry round-trip", () => {
    it("D1 disambiguates a wire timestamp from a wire block height", () => {
        const seconds = Math.floor(FUTURE.getTime() / 1000);
        expect(parseWireExpiry(String(seconds))).toEqual({ expiresAt: FUTURE });
        expect(parseWireExpiry("500000")).toEqual({ expiresAtHeight: 500_000 });
    });

    it("I1: D2(D1(raw)) reproduces the legacy batchExpiry for positive finite inputs", () => {
        for (const raw of ["1767225600", "500000", "1", "1900000000"]) {
            expect(toBatchExpiry(parseWireExpiry(raw))).toBe(Number(raw) * 1000);
        }
    });

    it("I1 outside its domain: null and empty string map to undefined, as they do today", () => {
        for (const raw of [null, undefined, ""]) {
            expect(toBatchExpiry(parseWireExpiry(raw))).toBeUndefined();
        }
    });

    it('the "0" delta: batchExpiry becomes undefined where today it was 0', () => {
        // Today's converter tests `vtxo.expiresAt ?` — "0" is a truthy string, so it yielded 0.
        // Accepted: every consumer tests batchExpiry falsily, so 0 and undefined behave alike, and
        // an epoch-1970 batch expiry is meaningless anyway.
        expect(parseWireExpiry("0")).toEqual({});
        expect(toBatchExpiry(parseWireExpiry("0"))).toBeUndefined();
    });

    it("invalid-input deltas: negative and non-finite wire values map to undefined", () => {
        for (const raw of ["-1", "NaN", "Infinity", "abc"]) {
            expect(parseWireExpiry(raw)).toEqual({});
        }
    });

    it("keeps the zero guard NArk lacks: no expiry never reads as permanently expired", () => {
        const v = coin({ expiresAt: undefined, expiresAtHeight: undefined });
        expect(isPastExpiry(v, { timestamp: NOW, height: 800_000 })).toBe(false);
    });

    it("I2: D2(D3(b)) === b for undefined and positive multiples of 1000", () => {
        expect(toBatchExpiry(parseLegacyExpiry(undefined))).toBeUndefined();
        for (const b of [FUTURE.getTime(), 500_000 * 1000, 1000]) {
            expect(toBatchExpiry(parseLegacyExpiry(b))).toBe(b);
        }
    });

    it("I3: D3(D2(c)) === c on its domain", () => {
        expect(parseLegacyExpiry(toBatchExpiry({}))).toEqual({});
        expect(parseLegacyExpiry(toBatchExpiry({ expiresAt: FUTURE }))).toEqual({
            expiresAt: FUTURE,
        });
        expect(parseLegacyExpiry(toBatchExpiry({ expiresAtHeight: 500_000 }))).toEqual({
            expiresAtHeight: 500_000,
        });
    });

    it("I3's escape: a pre-2025 wall-clock expiry degrades to a height, but behaves the same", () => {
        const old = new Date("2024-06-01T00:00:00.000Z");
        const round = parseLegacyExpiry(toBatchExpiry({ expiresAt: old }));
        expect(round.expiresAt).toBeUndefined();
        expect(round.expiresAtHeight).toBe(old.getTime() / 1000);
        // Cosmetically wrong, behaviorally identical: no real chain tip is anywhere near 1.7e9,
        // so it reads as not expired — exactly what today's year<2025 bail-out does.
        const v = coin({ expiresAt: undefined, ...round });
        expect(isPastExpiry(v, { timestamp: NOW, height: 900_000 })).toBe(false);
    });

    it("uses a UTC threshold, so classification does not move with the runtime timezone", () => {
        expect(EXPIRY_MIN_PLAUSIBLE_MS).toBe(Date.UTC(2025, 0, 1));
        expect(parseLegacyExpiry(EXPIRY_MIN_PLAUSIBLE_MS)).toEqual({
            expiresAt: new Date(EXPIRY_MIN_PLAUSIBLE_MS),
        });
        expect(parseLegacyExpiry(EXPIRY_MIN_PLAUSIBLE_MS - 1)).toEqual({
            expiresAtHeight: (EXPIRY_MIN_PLAUSIBLE_MS - 1) / 1000,
        });
    });
});

describe("truth table", () => {
    const now = { timestamp: NOW };

    it("row 1: preconfirmed, unspent → spendable", () => {
        const v = coin({ isPreconfirmed: true });
        expect(hasTerminalSpend(v)).toBe(false);
        expect(canSpendOffchain(v, now)).toBe(true);
        expect(canRecoverOnchain(v, now)).toBe(false);
        expect(v.virtualStatus.state).toBe("preconfirmed");
    });

    it("row 2: settled, unspent → spendable", () => {
        const v = coin();
        expect(canSpendOffchain(v, now)).toBe(true);
        expect(canRecoverOnchain(v, now)).toBe(false);
        expect(v.virtualStatus.state).toBe("settled");
    });

    it("row 3: swept → recoverable, not spendable", () => {
        const v = coin({ isSwept: true });
        expect(canSpendOffchain(v, now)).toBe(false);
        expect(canRecoverOnchain(v, now)).toBe(true);
        expect(v.virtualStatus.state).toBe("swept");
    });

    it("row 4: expired but NOT swept → recoverable, not spendable", () => {
        // The live bug this pass fixes: the legacy `state` falls back to "settled", so getBalance
        // counted it as available while the send path refused to spend it.
        const v = coin({ expiresAt: PAST });
        expect(v.virtualStatus.state).toBe("settled");
        expect(hasTerminalSpend(v)).toBe(false);
        expect(canSpendOffchain(v, now)).toBe(false);
        expect(canRecoverOnchain(v, now)).toBe(true);
    });

    it("row 5: spent with a spentBy → terminal", () => {
        const v = coin({ isSpent: true, spentBy: "33".repeat(32) });
        expect(hasTerminalSpend(v)).toBe(true);
        expect(canSpendOffchain(v, now)).toBe(false);
        expect(canRecoverOnchain(v, now)).toBe(false);
    });

    it("row 6: settledBy set but wire isSpent unset → still terminal", () => {
        // Unreachable from arkd v0.9.14 (settlement writes spent=true and settled_by in the same
        // statement), but reachable from a consumer-implemented provider. Defense in depth.
        const v = coin({ isSpent: false, spentBy: "", settledBy: "44".repeat(32) });
        expect(hasTerminalSpend(v)).toBe(true);
        expect(canSpendOffchain(v, now)).toBe(false);
        expect(canRecoverOnchain(v, now)).toBe(false);
    });

    it("row 7: spent outranks swept in the legacy projection", () => {
        const v = coin({ isSpent: true, isSwept: true, spentBy: "33".repeat(32) });
        expect(v.virtualStatus.state).toBe("spent");
        expect(hasTerminalSpend(v)).toBe(true);
        expect(canRecoverOnchain(v, now)).toBe(false);
    });

    it("row 8: isSpent true with an EMPTY spentBy → terminal", () => {
        // The row that kills `hasTerminalSpend = !!spentBy || !!settledBy`: public spentBy is "",
        // so that definition would call a spent VTXO spendable. arkd settles no-forfeit inputs
        // (swept/expired/notes/unrolled) with exactly this empty spentBy.
        const v = coin({ isSpent: true, spentBy: "" });
        expect(hasTerminalSpend(v)).toBe(true);
        expect(canSpendOffchain(v, now)).toBe(false);
        expect(canRecoverOnchain(v, now)).toBe(false);
    });
});

describe("normalization", () => {
    it("derives every fact from a legacy-only coin", () => {
        const n = normalizeVtxo(legacyCoin("swept"));
        expect(n.isSwept).toBe(true);
        expect(n.isSpent).toBe(false);
        expect(n.isPreconfirmed).toBe(false);
        expect(n.spentBy).toBe("");
        expect(n.commitmentTxIds).toEqual(["22".repeat(32)]);
        expect(n.expiresAt).toEqual(FUTURE);
    });

    it("derives isSpent from the legacy state rather than copying a null column", () => {
        // Both column-mapped backends emit `undefined` for a null is_spent column. Copying it
        // would leave `boolean | undefined`, and !!undefined is false — a spent VTXO reading as
        // spendable, on the one fact that decides spendability.
        const n = normalizeVtxo(legacyCoin("spent", { isSpent: undefined }));
        expect(n.isSpent).toBe(true);
        expect(hasTerminalSpend(n)).toBe(true);
    });

    it("reads isSwept/isPreconfirmed as false for a spent legacy coin", () => {
        // The collapse destroyed whether a spent coin was also swept; false matches today's
        // behavior, and it is a decision rather than an accident.
        const n = normalizeVtxo(legacyCoin("spent"));
        expect(n.isSwept).toBe(false);
        expect(n.isPreconfirmed).toBe(false);
    });

    it("keeps a coin's own authoritative facts over the lossy projection", () => {
        const n = normalizeVtxo(legacyCoin("settled", { isSwept: true }));
        expect(n.isSwept).toBe(true);
    });

    it("is idempotent", () => {
        const once = normalizeVtxo(legacyCoin("preconfirmed"));
        expect(normalizeVtxo(once)).toEqual(once);
    });

    it("rehydrates an expiresAt that a JSON round-trip turned into a string", () => {
        // Typechecks as Date but is a string at runtime; .getTime() would return NaN, which
        // compares false against everything and silently reads as "not expired".
        const wire = coin();
        const viaJson = JSON.parse(JSON.stringify({ ...wire, createdAt: wire.createdAt }));
        const n = normalizeVtxo({ ...wire, expiresAt: viaJson.expiresAt });
        expect(n.expiresAt).toBeInstanceOf(Date);
        expect(n.expiresAt!.getTime()).toBe(FUTURE.getTime());
    });

    it("synthesizes virtualStatus for a canonical-only coin, so rule 1 holds on the normalized shape", () => {
        const { virtualStatus: _dropped, ...canonicalOnly } = coin({ isSwept: true });
        const n = normalizeVtxo(canonicalOnly as VirtualCoin);
        expect(n.virtualStatus.state).toBe("swept");
        expect(n.virtualStatus.batchExpiry).toBe(FUTURE.getTime());
    });

    it("egress: a normalized coin is a valid public coin — virtualStatus present, spentBy never undefined", () => {
        const n = normalizeVtxo(legacyCoin("settled"));
        expect(n.virtualStatus).toBeDefined();
        expect(n.spentBy).toBe("");
    });

    it("a legacy-only coin yields the same verdict as its canonical equivalent, per predicate", () => {
        const now = { timestamp: NOW };
        for (const state of ["settled", "swept", "preconfirmed", "spent"] as const) {
            const legacy = legacyCoin(state);
            const canonical = normalizeVtxo(legacy);
            expect(hasTerminalSpend(legacy)).toBe(hasTerminalSpend(canonical));
            expect(isPastExpiry(legacy, now)).toBe(isPastExpiry(canonical, now));
            expect(canSpendOffchain(legacy, now)).toBe(canSpendOffchain(canonical, now));
            expect(canRecoverOnchain(legacy, now)).toBe(canRecoverOnchain(canonical, now));
        }
    });
});

describe("height-based expiry", () => {
    it("is evaluated when a height is supplied — the regtest bug", () => {
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

    it("is ignored by the deprecated isExpired, which is synchronous and has no tip", () => {
        const v = coin({ expiresAt: undefined, expiresAtHeight: 500_000 });
        expect(isExpired(v)).toBe(false);
    });
});

describe("deprecated compatibility wrappers", () => {
    it("isRecoverable stays swept-only and is NOT canRecoverOnchain", () => {
        const expiredUnswept = coin({ expiresAt: PAST });
        expect(isRecoverable(expiredUnswept)).toBe(false);
        expect(canRecoverOnchain(expiredUnswept, { timestamp: NOW })).toBe(true);

        const swept = coin({ isSwept: true });
        expect(isRecoverable(swept)).toBe(true);
    });

    it("isSpendable stays true for a swept coin, which is why it is ambiguous", () => {
        expect(isSpendable(coin({ isSwept: true }))).toBe(true);
        expect(canSpendOffchain(coin({ isSwept: true }), { timestamp: NOW })).toBe(false);
    });

    it("isExpired conflates swept with expired, as it always has", () => {
        expect(isExpired(coin({ isSwept: true, expiresAt: FUTURE }))).toBe(true);
        expect(isExpired(coin({ expiresAt: PAST }))).toBe(true);
        expect(isExpired(coin({ expiresAt: FUTURE }))).toBe(false);
    });

    it("rows 6 and 8 narrow isSpendable/isRecoverable — only ever toward 'spent'", () => {
        expect(isSpendable(coin({ isSpent: true, spentBy: "" }))).toBe(false);
        expect(isSpendable(coin({ isSpent: false, settledBy: "44".repeat(32) }))).toBe(false);
        expect(isRecoverable(coin({ isSwept: true, settledBy: "44".repeat(32) }))).toBe(false);
    });
});

describe("isVirtualCoin", () => {
    it("classifies every input kind in one mixed array, with no TypeError", () => {
        // The bug class here is one kind poisoning the scan, so assert on the array rather than
        // each kind alone — a lone-string test passes even when the array path throws.
        const boarding = { txid: "aa".repeat(32), vout: 1, value: 1, status: { confirmed: true } };
        const canonical = coin();
        const legacy = legacyCoin("settled");
        const arknote = "arknote1qqqq";
        const mixed = [boarding, canonical, legacy, arknote, null, undefined];

        expect(mixed.map(isVirtualCoin)).toEqual([false, true, true, false, false, false]);
    });

    it("classifies a legacy-only VTXO as a VTXO", () => {
        // The regression that would catch someone re-keying the guard onto an optional canonical
        // fact: a legacy coin has none of them.
        const legacy = legacyCoin("settled");
        expect(legacy.isSwept).toBeUndefined();
        expect(isVirtualCoin(legacy)).toBe(true);
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

    it("maps the wire shape to canonical facts and the legacy projection", () => {
        const v = convertVtxo(wire);
        expect(v.isSwept).toBe(false);
        expect(v.isPreconfirmed).toBe(false);
        expect(v.expiresAt).toEqual(FUTURE);
        expect(v.commitmentTxIds).toEqual(["22".repeat(32)]);
        expect(v.spentBy).toBe("");
        expect(v.virtualStatus.state).toBe("settled");
        expect(v.virtualStatus.batchExpiry).toBe(FUTURE.getTime());
    });

    it("maps a spent wire vtxo to state 'spent' — REST and Expo share this one path", () => {
        // ExpoIndexerProvider used to omit the spent branch entirely.
        const v = convertVtxo({ ...wire, isSpent: true, spentBy: "33".repeat(32) });
        expect(v.virtualStatus.state).toBe("spent");
        expect(hasTerminalSpend(v)).toBe(true);
    });

    it("routes a height-encoded wire expiry to expiresAtHeight", () => {
        const v = convertVtxo({ ...wire, expiresAt: "500000" });
        expect(v.expiresAt).toBeUndefined();
        expect(v.expiresAtHeight).toBe(500_000);
        // The legacy field still multiplies a block height by 1000, as it always did.
        expect(v.virtualStatus.batchExpiry).toBe(500_000_000);
    });
});

describe("getNormalizedVtxos", () => {
    it("normalizes a legacy-only consumer-implemented provider and preserves page", async () => {
        const page = { current: 0, next: 1, total: 2 };
        const provider = {
            getVtxos: async () => ({ vtxos: [legacyCoin("swept")], page }),
        };

        const res = await getNormalizedVtxos(provider as never);

        expect(res.page).toBe(page);
        expect(res.vtxos[0].isSwept).toBe(true);
        expect(res.vtxos[0].commitmentTxIds).toEqual(["22".repeat(32)]);
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

    it("degrades to timestamp-only when the tip fetch rejects, rather than throwing", async () => {
        // The guarantee that keeps recovery and deprecated-signer migration available while the
        // onchain provider is down. Height-encoded expiry then reads as not expired, which is
        // what the SDK did before heights were evaluated at all.
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
        const coin = normalizeVtxo({
            ...legacyCoin("settled"),
            expiresAtHeight: 100,
        } as VirtualCoin);

        const withTip = await resolveTimeHeight({
            getChainTip: vi.fn().mockResolvedValue({ height: 500 }),
        });
        const degraded = await resolveTimeHeight({
            getChainTip: vi.fn().mockRejectedValue(new Error("esplora down")),
        });

        expect(isPastExpiry(coin, withTip)).toBe(true);
        expect(isPastExpiry(coin, degraded)).toBe(false);
        warn.mockRestore();
    });
});
