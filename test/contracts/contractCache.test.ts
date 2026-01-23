import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
    IndexerContractVtxoCache,
    InMemoryWalletRepository,
    type IndexerProvider,
} from "../../src";
import {
    createDefaultContractParams,
    createMockExtendedVtxo,
    createMockIndexerProvider,
    TEST_DEFAULT_SCRIPT,
} from "./helpers";
import type { Contract } from "../../src/contracts/types";
const createContract = (
    id: string,
    address: string,
    state: "active" | "inactive" = "active"
): Contract => ({
    id,
    type: "default",
    params: createDefaultContractParams(),
    script: TEST_DEFAULT_SCRIPT,
    address,
    state,
    createdAt: Date.now(),
});

describe("IndexerContractVtxoCache", () => {
    let mockIndexer: IndexerProvider;
    let walletRepository: InMemoryWalletRepository;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
        mockIndexer = createMockIndexerProvider();
        walletRepository = new InMemoryWalletRepository();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("uses cached VTXOs when refresh is false and cache is fresh", async () => {
        const cache = new IndexerContractVtxoCache(
            mockIndexer,
            walletRepository
        );
        const contract = createContract("contract-1", "address-1");
        const fetched = createMockExtendedVtxo({ txid: "fetched" });

        (mockIndexer.getVtxos as any).mockResolvedValueOnce({
            vtxos: [fetched],
            page: { current: 0, next: 0, total: 1 },
        });

        // first run, will hit indexer and cache
        await cache.getContractVtxos([contract]);

        // second run, will hit cache only
        const result = await cache.getContractVtxos([contract]);

        expect(mockIndexer.getVtxos).toHaveBeenCalledTimes(1);

        const vtxos = result.get(contract.id) || [];
        expect(vtxos).toHaveLength(1);
        expect(vtxos[0].txid).toBe("fetched");
        expect(vtxos[0].contractId).toBe(contract.id);
    });

    it("bypasses cache when refresh is true", async () => {
        const cache = new IndexerContractVtxoCache(
            mockIndexer,
            walletRepository
        );
        const contract = createContract("contract-1", "address-1");
        const cached = createMockExtendedVtxo({ txid: "cached" });
        const fetched = createMockExtendedVtxo({ txid: "fetched" });

        await walletRepository.saveVtxos(contract.address, [cached]);

        (mockIndexer.getVtxos as any).mockResolvedValueOnce({
            vtxos: [fetched],
            page: { current: 0, next: 0, total: 1 },
        });

        const result = await cache.getContractVtxos([contract], {
            refresh: true,
        });

        expect(mockIndexer.getVtxos).toHaveBeenCalled();
        const vtxos = result.get(contract.id) || [];
        expect(vtxos).toHaveLength(1);
        expect(vtxos[0].txid).toBe("fetched");
        expect(vtxos[0].contractId).toBe(contract.id);
    });

    it("invalidates cache via invalidateCache()", async () => {
        const cache = new IndexerContractVtxoCache(
            mockIndexer,
            walletRepository
        );
        const contract = createContract("contract-1", "address-1");
        const first = createMockExtendedVtxo({ txid: "first" });
        const second = createMockExtendedVtxo({ txid: "second" });

        (mockIndexer.getVtxos as any)
            .mockResolvedValueOnce({
                vtxos: [first],
                page: { current: 0, next: 0, total: 1 },
            })
            .mockResolvedValueOnce({
                vtxos: [second],
                page: { current: 0, next: 0, total: 1 },
            });

        await cache.getContractVtxos([contract]);
        cache.invalidateCache();
        const result = await cache.getContractVtxos([contract]);

        expect(mockIndexer.getVtxos).toHaveBeenCalledTimes(2);
        const vtxos = result.get(contract.id) || [];
        expect(vtxos[0].txid).toBe("second");
    });

    it("refreshes when cache TTL expires", async () => {
        const cache = new IndexerContractVtxoCache(
            mockIndexer,
            walletRepository,
            1000
        );
        const contract = createContract("contract-1", "address-1");
        const first = createMockExtendedVtxo({ txid: "first" });
        const second = createMockExtendedVtxo({ txid: "second" });

        (mockIndexer.getVtxos as any)
            .mockResolvedValueOnce({
                vtxos: [first],
                page: { current: 0, next: 0, total: 1 },
            })
            .mockResolvedValueOnce({
                vtxos: [second],
                page: { current: 0, next: 0, total: 1 },
            });

        await cache.getContractVtxos([contract]);

        vi.setSystemTime(new Date("2024-01-01T00:00:02.000Z"));
        const result = await cache.getContractVtxos([contract]);

        expect(mockIndexer.getVtxos).toHaveBeenCalledTimes(2);
        const vtxos = result.get(contract.id) || [];
        expect(vtxos[0].txid).toBe("second");
    });

    it("filters spent VTXOs when includeSpent is false", async () => {
        const cache = new IndexerContractVtxoCache(
            mockIndexer,
            walletRepository
        );
        const contract = createContract("contract-1", "address-1");
        const spendable = createMockExtendedVtxo({
            txid: "spendable",
            isSpent: false,
        });
        const spent = createMockExtendedVtxo({
            txid: "spent",
            isSpent: true,
        });

        await walletRepository.saveVtxos(contract.address, [spendable, spent]);

        // warm up cache
        await cache.getContractVtxos([contract], {
            includeSpent: false,
        });

        const result = await cache.getContractVtxos([contract], {
            includeSpent: false,
        });
        const vtxos = result.get(contract.id) || [];

        expect(vtxos).toHaveLength(1);
        expect(vtxos[0].txid).toBe("spendable");
    });

    it("uses spendableOnly filtering when includeSpent is false and refresh is true", async () => {
        const cache = new IndexerContractVtxoCache(
            mockIndexer,
            walletRepository
        );
        const contract = createContract("contract-1", "address-1");

        (mockIndexer.getVtxos as any).mockResolvedValueOnce({
            vtxos: [],
            page: { current: 0, next: 0, total: 1 },
        });

        await cache.getContractVtxos([contract], {
            includeSpent: false,
            refresh: true,
        });

        expect(mockIndexer.getVtxos).toHaveBeenCalledWith(
            expect.objectContaining({
                scripts: [contract.script],
                spendableOnly: true,
                pageIndex: 0,
                pageSize: 100,
            })
        );
    });
});
