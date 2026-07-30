import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
    makeStaticWalletForTest,
    installRestoreHarness,
    teardownRestoreHarness,
} from "../helpers/restoreWallet";
import { FetchError } from "../../src/utils/fetch";

/**
 * `Wallet.getTransactionHistory()` must ask the indexer for missing `createdAt`
 * timestamps in BATCHES, not one request per transaction.
 *
 * It previously did one request per txid, and because `buildTransactionHistory`
 * awaits `getTxCreatedAt` inside its per-VTXO loop those ran strictly
 * sequentially — and repeated for every VTXO sharing an `arkTxId`. MEASURED in a
 * browser HAR against mutinynet: 348 single-outpoint requests covering only 123
 * distinct txids, 92% of the page's total traffic, median 181ms each, 23.9s in
 * one burst. Cost grew linearly with wallet history, so a large wallet could
 * exceed a caller's timeout and fail the read outright.
 *
 * The service-worker path (`WalletMessageHandler.getTransactionHistory`) has
 * always batched this; these tests pin the same behaviour on the plain `Wallet`.
 */

/** A spent virtual output whose arkTxId is NOT among the wallet's own vtxos, so
 *  its createdAt has to be fetched — exactly the case that hit the indexer. */
function spentVtxo(txid: string, arkTxId: string, createdAtMs = 1_700_000_000_000) {
    return {
        txid,
        vout: 0,
        value: 1000,
        createdAt: new Date(createdAtMs),
        isSpent: true,
        arkTxId,
        virtualStatus: { state: "settled", commitmentTxIds: ["c".repeat(64)] },
        status: { isLeaf: false, confirmed: true },
        settledBy: undefined,
    };
}

const hex64 = (n: number, fill = "a") => String(n).padStart(64, fill);

describe("Wallet.getTransactionHistory batches createdAt lookups", () => {
    beforeEach(() => installRestoreHarness());
    afterEach(() => teardownRestoreHarness());

    /** Point the wallet at a fixed vtxo set and neutralise boarding. */
    async function walletOver(vtxos: unknown[]) {
        const handle = await makeStaticWalletForTest();
        const w = handle.wallet as unknown as Record<string, unknown>;
        vi.spyOn(w as never, "getContractManager" as never).mockResolvedValue({
            getContractsWithVtxos: async () => [{ vtxos }],
        } as never);
        vi.spyOn(w as never, "getBoardingTxs" as never).mockResolvedValue({
            boardingTxs: [],
            commitmentsToIgnore: new Set<string>(),
        } as never);
        return handle;
    }

    it("issues ONE indexer request for many distinct txids, not one each", async () => {
        // 30 vtxos, 30 distinct arkTxIds needing a timestamp.
        const vtxos = Array.from({ length: 30 }, (_v, i) =>
            spentVtxo(hex64(i, "a"), hex64(i, "b")),
        );
        const { wallet, indexer } = await walletOver(vtxos);
        const spy = vi.spyOn(indexer, "getVtxos");
        spy.mockClear();

        await wallet.getTransactionHistory();

        const outpointCalls = spy.mock.calls.filter(([opts]) =>
            Array.isArray((opts as { outpoints?: unknown[] })?.outpoints),
        );
        // Pre-fix: 30 separate requests. Now: one, carrying all 30.
        expect(outpointCalls).toHaveLength(1);
        expect((outpointCalls[0][0] as { outpoints: unknown[] }).outpoints).toHaveLength(30);
    });

    it("does not re-request a txid shared by several vtxos", async () => {
        // Five vtxos, ONE shared arkTxId — the source of the ~2.8x duplication.
        const shared = hex64(0, "b");
        const vtxos = Array.from({ length: 5 }, (_v, i) => spentVtxo(hex64(i, "a"), shared));
        const { wallet, indexer } = await walletOver(vtxos);
        const spy = vi.spyOn(indexer, "getVtxos");
        spy.mockClear();

        await wallet.getTransactionHistory();

        const outpointCalls = spy.mock.calls.filter(([opts]) =>
            Array.isArray((opts as { outpoints?: unknown[] })?.outpoints),
        );
        expect(outpointCalls).toHaveLength(1);
        expect((outpointCalls[0][0] as { outpoints: unknown[] }).outpoints).toHaveLength(1);
    });

    it("chunks beyond the batch size instead of sending one giant query", async () => {
        // 205 distinct txids at BATCH_SIZE 100 -> 100 / 100 / 5.
        const vtxos = Array.from({ length: 205 }, (_v, i) =>
            spentVtxo(hex64(i, "a"), hex64(i, "b")),
        );
        const { wallet, indexer } = await walletOver(vtxos);
        const spy = vi.spyOn(indexer, "getVtxos");
        spy.mockClear();

        await wallet.getTransactionHistory();

        const sizes = spy.mock.calls
            .map(([opts]) => (opts as { outpoints?: unknown[] })?.outpoints)
            .filter(Array.isArray)
            .map((o) => o.length);
        expect(sizes).toEqual([100, 100, 5]);
    });

    it("asks for nothing when every timestamp is already known locally", async () => {
        // arkTxId matches a vtxo the wallet already holds, so no fetch is needed.
        const a = hex64(1, "a");
        const vtxos = [spentVtxo(a, a)];
        const { wallet, indexer } = await walletOver(vtxos);
        const spy = vi.spyOn(indexer, "getVtxos");
        spy.mockClear();

        await wallet.getTransactionHistory();

        const outpointCalls = spy.mock.calls.filter(([opts]) =>
            Array.isArray((opts as { outpoints?: unknown[] })?.outpoints),
        );
        expect(outpointCalls).toHaveLength(0);
    });

    it("still builds history when the indexer batch fails retryably", async () => {
        const vtxos = [spentVtxo(hex64(1, "a"), hex64(1, "b"))];
        const { wallet, indexer } = await walletOver(vtxos);
        // A genuine FetchError, which isRetryableProviderError recognises — an
        // ad-hoc Error with the same `name` does NOT, so the fixture has to be
        // the real type or this test proves nothing.
        vi.spyOn(indexer, "getVtxos").mockRejectedValue(
            new FetchError("fetch failed", { url: "http://localhost:7070" }),
        );

        // Best-effort enrichment: an unavailable indexer must not fail the read.
        await expect(wallet.getTransactionHistory()).resolves.toBeInstanceOf(Array);
    });
});
