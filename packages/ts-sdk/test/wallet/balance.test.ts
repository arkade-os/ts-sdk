import { describe, it, expect } from "vitest";
import { computeOffchainBalance, type BalanceCapabilities } from "../../src/wallet/balance";
import type { NormalizedExtendedVirtualCoin } from "../../src/wallet/vtxo";
import type { WalletBalance } from "../../src/wallet";

/**
 * A plainly spendable coin: not spent, not swept, no expiry in the past.
 * `canSpendOffchain` reads exactly those facts, so this lands in
 * settled/preconfirmed and the capability predicates decide the rest.
 */
const vtxo = (txid: string, value: number, script = "aa"): NormalizedExtendedVirtualCoin =>
    ({
        txid,
        vout: 0,
        value,
        script,
        isPreconfirmed: false,
        isSwept: false,
        isSpent: false,
    }) as unknown as NormalizedExtendedVirtualCoin;

const caps = (over: Partial<BalanceCapabilities> = {}): BalanceCapabilities => ({
    now: { timestamp: new Date() },
    isPendingRecovery: () => false,
    isGenericallySpendable: () => true,
    isUnlocked: () => true,
    ...over,
});

describe("computeOffchainBalance escrow bucket", () => {
    it("counts a contract-gated coin as escrow, not available", () => {
        const gated = vtxo("a", 1000, "gated");
        const free = vtxo("b", 500, "free");

        const balance = computeOffchainBalance(
            [gated, free],
            caps({ isGenericallySpendable: (v) => v.script !== "gated" }),
        );

        expect(balance.escrow).toBe(1000);
        expect(balance.available).toBe(500);
    });

    it("leaves owned buckets unchanged — escrow is a view, not a fifth exclusive branch", () => {
        const gated = vtxo("a", 1000, "gated");
        const free = vtxo("b", 500, "free");

        const balance = computeOffchainBalance(
            [gated, free],
            caps({ isGenericallySpendable: (v) => v.script !== "gated" }),
        );

        expect(balance.settled).toBe(1500);
        expect(balance.total).toBe(1500);
    });

    it("attributes an intent-locked but ungated coin to neither available nor escrow", () => {
        const locked = vtxo("a", 1000);

        const balance = computeOffchainBalance([locked], caps({ isUnlocked: () => false }));

        expect(balance.available).toBe(0);
        expect(balance.escrow).toBe(0);
        expect(balance.settled).toBe(1000);
    });

    it("counts a coin that is both gated and intent-locked as escrow only, so buckets stay disjoint", () => {
        const both = vtxo("a", 1000);

        const balance = computeOffchainBalance(
            [both],
            caps({ isGenericallySpendable: () => false, isUnlocked: () => false }),
        );

        expect(balance.escrow).toBe(1000);
        expect(balance.available).toBe(0);
    });

    it("holds the closure invariant: available + escrow + intent-locked === settled + preconfirmed", () => {
        const gated = vtxo("a", 1000, "gated");
        const lockedCoin = vtxo("b", 700);
        const free = vtxo("c", 500);

        const balance = computeOffchainBalance(
            [gated, lockedCoin, free],
            caps({
                isGenericallySpendable: (v) => v.script !== "gated",
                isUnlocked: (v) => v.txid !== "b",
            }),
        );

        const intentLocked =
            balance.settled + balance.preconfirmed - balance.available - balance.escrow;
        expect(intentLocked).toBe(700);
        expect(balance.available + balance.escrow + intentLocked).toBe(
            balance.settled + balance.preconfirmed,
        );
    });

    it("does not count a recoverable coin as escrow even when gated", () => {
        const swept = {
            ...vtxo("a", 1000),
            isSwept: true,
        } as unknown as NormalizedExtendedVirtualCoin;

        const balance = computeOffchainBalance(
            [swept],
            caps({ isGenericallySpendable: () => false }),
        );

        expect(balance.recoverable).toBe(1000);
        expect(balance.escrow).toBe(0);
    });
});

describe("WalletBalance carries escrow through both getBalance paths", () => {
    it("is present on the shape both callers assemble", () => {
        const balance = computeOffchainBalance(
            [vtxo("a", 1000, "gated")],
            caps({ isGenericallySpendable: () => false }),
        );

        // Exactly the object literal both `Wallet.getBalance` and the worker's
        // `handleGetBalance` build. Annotated as `WalletBalance` on purpose: the
        // annotation pins this literal to the real return shape, so a drift
        // between either `getBalance` implementation and the type surfaces
        // here. Note this package's `tsconfig.json` excludes `**/*.test.ts`,
        // so `pnpm typecheck` does not see it — the check only fires in an
        // editor or under a typecheck that does cover test files.
        const assembled: WalletBalance = {
            boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
            settled: balance.settled,
            preconfirmed: balance.preconfirmed,
            available: balance.available,
            escrow: balance.escrow,
            recoverable: balance.recoverable,
            pendingRecovery: balance.pendingRecovery,
            total: 0 + balance.total,
            assets: balance.assets,
            availableAssets: balance.availableAssets,
        };

        expect(assembled.escrow).toBe(1000);
        expect(assembled.total).toBe(1000);
    });
});
