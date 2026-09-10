import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IWallet } from "@arkade-os/sdk";
import { InMemoryAssetSwapRepository } from "../src/repository";
import { restoreAssetSwapRepository } from "../src/restoreRepository";
import type { RestoreIndexer, Tx } from "../src/restore";
import type { AssetSwap } from "../src/store";

const mocks = vi.hoisted(() => ({
    restoreAssetSwaps: vi.fn(),
    restoreOfferCoverage: vi.fn(),
}));

vi.mock("../src/restore", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/restore")>()),
    restoreAssetSwaps: mocks.restoreAssetSwaps,
}));

vi.mock("../src/offer", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/offer")>()),
    restoreOfferCoverage: mocks.restoreOfferCoverage,
}));

const pending = (id: string, overrides: Partial<AssetSwap> = {}): AssetSwap => ({
    id,
    fromAsset: "btc",
    toAsset: "aa".repeat(34),
    fromAmount: "10000",
    toAmount: "500",
    swapAddress: "tark1qstored",
    swapPkScript: `5120${"ab".repeat(32)}`,
    offerHex: "0100",
    fundingTxid: id,
    status: "pending",
    createdAt: 1,
    ...overrides,
});

const wallet = { identity: {} } as IWallet;
const indexer = {} as RestoreIndexer;
const txs = [{ type: "sent", redeemTxid: "new" }] as Tx[];
const serverPubkey = new Uint8Array(32);

const run = (repository: InMemoryAssetSwapRepository, overrides = {}) =>
    restoreAssetSwapRepository({
        wallet,
        arkServerUrl: "https://ark.test",
        indexer,
        repository,
        txs,
        serverPubkey,
        ...overrides,
    });

beforeEach(() => {
    mocks.restoreAssetSwaps.mockReset();
    mocks.restoreOfferCoverage.mockReset().mockResolvedValue(undefined);
});

describe("restoreAssetSwapRepository", () => {
    it("owns the skip lists and reopens every live stored record", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const open = pending("open");
        const settled = pending("settled", { status: "fulfilled" });
        await repository.saveSwap(open);
        await repository.saveSwap(settled);
        await repository.markTxidsScanned(["open", "settled"]);
        mocks.restoreAssetSwaps.mockResolvedValue({ restored: [], scannedTxids: [] });

        await run(repository);

        expect(mocks.restoreAssetSwaps).toHaveBeenCalledWith(
            indexer,
            txs,
            new Set(["open", "settled"]),
            { serverPubkey, scanned: new Set(["open", "settled"]), reopen: [open] },
        );
    });

    it("persists new and resolved records before advancing the cursor", async () => {
        const events: string[] = [];
        class OrderedRepository extends InMemoryAssetSwapRepository {
            override async saveSwap(swap: AssetSwap): Promise<void> {
                events.push(`save:${swap.id}`);
                await super.saveSwap(swap);
            }
            override async markTxidsScanned(ids: Iterable<string>): Promise<void> {
                events.push(`scan:${[...ids].join(",")}`);
                await super.markTxidsScanned(ids);
            }
        }
        const repository = new OrderedRepository();
        const open = pending("open");
        await repository.saveSwap(open);
        events.length = 0;
        const resolved = { ...open, status: "fulfilled" as const, spentTxid: "fill" };
        const rebuilt = pending("new", { swapAddress: "" });
        mocks.restoreAssetSwaps.mockResolvedValue({
            restored: [resolved, rebuilt],
            scannedTxids: ["open", "new"],
        });

        const result = await run(repository);

        expect(events).toEqual(["save:open", "save:new", "scan:open,new"]);
        expect(result.changes).toEqual([
            { previous: open, current: resolved },
            { current: rebuilt },
        ]);
        expect(result.swaps).toEqual([open, rebuilt].map((s) => (s.id === "open" ? resolved : s)));
    });

    it("lets a consumer decorate only newly rebuilt records before persistence", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const open = pending("open");
        await repository.saveSwap(open);
        const resolved = { ...open, status: "fulfilled" as const };
        const rebuilt = pending("new", { swapAddress: "" });
        mocks.restoreAssetSwaps.mockResolvedValue({
            restored: [resolved, rebuilt],
            scannedTxids: [],
        });
        const prepareNew = vi.fn((swap: AssetSwap) => ({ ...swap, quote: { feeBps: 30 } }));

        const result = await run(repository, { prepareNew });

        expect(prepareNew).toHaveBeenCalledOnce();
        expect(prepareNew).toHaveBeenCalledWith(rebuilt);
        expect(result.changes[1].current).toMatchObject({ id: "new", quote: { feeBps: 30 } });
    });

    it("restores coverage for the final repository even when the scan changed nothing", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const open = pending("open");
        await repository.saveSwap(open);
        mocks.restoreAssetSwaps.mockResolvedValue({ restored: [], scannedTxids: [] });

        const result = await run(repository);

        expect(mocks.restoreOfferCoverage).toHaveBeenCalledWith(wallet, "https://ark.test", [open]);
        expect(result.coverageError).toBeUndefined();
    });

    it("returns a coverage setup failure after preserving restored records", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const rebuilt = pending("new", { swapAddress: "" });
        const unavailable = new Error("server unavailable");
        mocks.restoreAssetSwaps.mockResolvedValue({ restored: [rebuilt], scannedTxids: ["new"] });
        mocks.restoreOfferCoverage.mockRejectedValue(unavailable);

        const result = await run(repository);

        expect(await repository.getAllSwaps()).toEqual([rebuilt]);
        expect(await repository.getScannedTxids()).toEqual(new Set(["new"]));
        expect(result.coverageError).toBe(unavailable);
    });

    it("does not attempt offer coverage for a payment-hash-only record", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const onchain = {
            ...pending("onchain"),
            offerHex: undefined,
            paymentHash: "cc".repeat(32),
        } as unknown as AssetSwap;
        await repository.saveSwap(onchain);
        mocks.restoreAssetSwaps.mockResolvedValue({ restored: [], scannedTxids: [] });
        mocks.restoreOfferCoverage.mockRejectedValue(new Error("Ark server unavailable"));

        const result = await run(repository);

        expect(result.coverageError).toBeUndefined();
        expect(mocks.restoreOfferCoverage).not.toHaveBeenCalled();
    });

    it("still repairs coverage for stored records when the chain scan fails", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const open = pending("open");
        await repository.saveSwap(open);
        const scanError = new Error("indexer unavailable");
        mocks.restoreAssetSwaps.mockRejectedValue(scanError);

        await expect(run(repository)).rejects.toBe(scanError);

        expect(mocks.restoreOfferCoverage).toHaveBeenCalledWith(wallet, "https://ark.test", [open]);
    });

    it("does not mutate the repository after cancellation", async () => {
        const repository = new InMemoryAssetSwapRepository();
        const controller = new AbortController();
        const rebuilt = pending("new", { swapAddress: "" });
        mocks.restoreAssetSwaps.mockImplementation(async () => {
            controller.abort();
            return { restored: [rebuilt], scannedTxids: ["new"] };
        });

        const result = await run(repository, { signal: controller.signal });

        expect(result.aborted).toBe(true);
        expect(await repository.getAllSwaps()).toEqual([]);
        expect(await repository.getScannedTxids()).toEqual(new Set());
        expect(mocks.restoreOfferCoverage).not.toHaveBeenCalled();
    });

    it("reports records durably saved before cancellation without advancing the cursor", async () => {
        const controller = new AbortController();
        class CancellingRepository extends InMemoryAssetSwapRepository {
            override async saveSwap(swap: AssetSwap): Promise<void> {
                await super.saveSwap(swap);
                controller.abort();
            }
        }
        const repository = new CancellingRepository();
        const first = pending("first", { swapAddress: "" });
        const second = pending("second", { swapAddress: "" });
        mocks.restoreAssetSwaps.mockResolvedValue({
            restored: [first, second],
            scannedTxids: ["first", "second"],
        });

        const result = await run(repository, { signal: controller.signal });

        expect(result).toMatchObject({
            swaps: [first],
            changes: [{ current: first }],
            scannedTxids: [],
            aborted: true,
        });
        expect(await repository.getScannedTxids()).toEqual(new Set());
        expect(mocks.restoreOfferCoverage).not.toHaveBeenCalled();
    });
});
