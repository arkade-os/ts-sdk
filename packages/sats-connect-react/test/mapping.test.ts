import { TxType, type ArkTransaction, type WalletBalance } from "@arkade-os/sdk";
import type { SwapClient, SwapUpdate } from "@arkade-os/swap";
import { describe, expect, it, vi } from "vitest";

import { outcomeUntil, refreshAfter, toBalance, toTransaction } from "../src/ArkadeWalletProvider";

const balance = (overrides: Partial<WalletBalance>): WalletBalance =>
    ({
        boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
        settled: 0,
        preconfirmed: 0,
        available: 0,
        contractLocked: 0,
        pendingSettlement: 0,
        reserved: 0,
        recoverable: 0,
        deprecatedSignerLocked: 0,
        unrolled: 0,
        total: 0,
        ...overrides,
    }) as WalletBalance;

describe("toBalance", () => {
    it("counts boarding funds once, from the same SDK reading", () => {
        const shown = toBalance(
            balance({
                boarding: { confirmed: 10_000, unconfirmed: 0, total: 10_000 },
                total: 10_000,
            }),
            [],
        );
        expect(shown.total).toBe(10_000);
        expect(shown.onchain).toBe(10_000);
    });

    it("keeps the SDK's buckets", () => {
        const shown = toBalance(
            balance({
                settled: 1_000,
                preconfirmed: 4_000,
                available: 3_000,
                recoverable: 700,
                total: 5_700,
            }),
            [],
        );
        expect(shown).toMatchObject({
            settled: 1_000,
            preconfirmed: 4_000,
            offchain: 3_000,
            recoverable: 700,
        });
    });
});

describe("toTransaction", () => {
    const tx = (overrides: Partial<ArkTransaction>): ArkTransaction => ({
        key: { arkTxid: "ab", boardingTxid: "", commitmentTxid: "" },
        type: TxType.TxReceived,
        amount: 1_000,
        settled: true,
        createdAt: 1_795_000_000_000,
        tag: "offchain",
        ...overrides,
    });

    it("shows an outgoing transaction as a send", () => {
        expect(toTransaction(tx({ type: TxType.TxSent })).type).toBe("send");
        expect(toTransaction(tx({ type: TxType.TxReceived })).type).toBe("receive");
    });

    it("keeps the SDK's millisecond timestamp", () => {
        expect(toTransaction(tx({})).timestamp).toBe(1_795_000_000_000);
    });

    it("puts boarding and exit rows onchain by their tag", () => {
        expect(toTransaction(tx({ tag: "boarding" })).layer).toBe("onchain");
        expect(toTransaction(tx({ tag: "exit" })).layer).toBe("onchain");
        expect(toTransaction(tx({ tag: "offchain" })).layer).toBe("offchain");
    });
});

describe("refreshAfter", () => {
    it("reports a failed refresh instead of throwing", async () => {
        const report = vi.fn();
        await refreshAfter(async () => {
            throw new Error("indexer down");
        }, report);
        expect(report).toHaveBeenCalledWith(expect.stringContaining("indexer down"));
    });
});

describe("outcomeUntil", () => {
    const silentClient = { onUpdate: () => () => {} } as unknown as SwapClient;

    it("stops waiting once the session closes", async () => {
        await expect(
            outcomeUntil(silentClient, "rfq:1", ["paid"], Promise.resolve()),
        ).resolves.toBe(undefined);
    });

    it("answers with the outcome when it comes first", async () => {
        const client = {
            onUpdate: (fn: (update: SwapUpdate) => void) => {
                fn({ swap: { id: "rfq:1" }, outcome: "paid" } as unknown as SwapUpdate);
                return () => {};
            },
        } as unknown as SwapClient;
        await expect(outcomeUntil(client, "rfq:1", ["paid"], new Promise(() => {}))).resolves.toBe(
            "paid",
        );
    });
});
