import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
    ContractManager,
    ContractVtxoCache,
    IndexerProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    SubscriptionResponse,
} from "../../src";
import { ContractRepository } from "../../src/repositories";
import {
    createDefaultContractParams,
    createMockExtendedVtxo,
    createMockIndexerProvider,
    createMockVtxo,
    TEST_DEFAULT_SCRIPT,
} from "./helpers";

vi.useFakeTimers();

describe("ContractManager", () => {
    let manager: ContractManager;
    let mockIndexer: IndexerProvider;
    let repository: ContractRepository;
    let mockVtxoCache: ContractVtxoCache;

    beforeEach(async () => {
        mockIndexer = createMockIndexerProvider();
        repository = new InMemoryContractRepository();
        mockVtxoCache = {
            getContractVtxos: vi.fn().mockResolvedValue([]),
            invalidateCache: vi.fn(),
        };

        manager = await ContractManager.create({
            indexerProvider: mockIndexer,
            contractRepository: repository,
            extendVtxo: (vtxo) => createMockExtendedVtxo(vtxo),
            getDefaultAddress: async () => "default-address",
            walletRepository: new InMemoryWalletRepository(),
            vtxoCache: mockVtxoCache,
            watcherConfig: {
                failsafePollIntervalMs: 1000,
                reconnectDelayMs: 500,
            },
        });
    });

    it("should create and retrieve contracts", async () => {
        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });

        expect(contract.id).toBeDefined();
        expect(contract.createdAt).toBeDefined();
        expect(contract.state).toBe("active");

        const [retrieved] = await manager.getContracts({ id: contract.id });
        expect(retrieved).toEqual(contract);
    });

    it("should list all contracts", async () => {
        // Create two contracts with explicit different IDs
        // (since script defaults to ID, we need different IDs for same script)
        await manager.createContract({
            id: "contract-1",
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address-1",
        });

        await manager.createContract({
            id: "contract-2",
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address-2",
        });

        expect(await manager.getContracts()).toHaveLength(2);
    });

    it("should activate and deactivate contracts", async () => {
        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });
        expect(await manager.getContracts({ state: "active" })).toHaveLength(1);
        await manager.setContractState(contract.id, "inactive");
        expect(await manager.getContracts({ state: "active" })).toHaveLength(0);
        await manager.setContractState(contract.id, "active");
        expect(await manager.getContracts({ state: "active" })).toHaveLength(1);
    });

    it("should update contract data", async () => {
        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
            data: { customField: "initial" },
        });

        await manager.updateContract(contract.id, {
            data: { newField: "added" },
        });

        const [updated] = await manager.getContracts({ id: contract.id });
        expect(updated?.data).toEqual({
            customField: "initial",
            newField: "added",
        });
    });

    it("should persist contracts across initialization", async () => {
        await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });

        // Create new manager with same storage
        const newManager = await ContractManager.create({
            indexerProvider: mockIndexer,
            contractRepository: repository,
            extendVtxo: (vtxo) => createMockExtendedVtxo(vtxo),
            getDefaultAddress: async () => "default-address",
            walletRepository: new InMemoryWalletRepository(),
        });

        expect(await newManager.getContracts()).toHaveLength(1);
    });

    it("should force VTXOs refresh from indexer when is instantiated", async () => {
        await ContractManager.create({
            indexerProvider: mockIndexer,
            contractRepository: repository,
            extendVtxo: (vtxo) => createMockExtendedVtxo(vtxo),
            getDefaultAddress: async () => "default-address",
            walletRepository: new InMemoryWalletRepository(),
            vtxoCache: mockVtxoCache,
        });

        expect(mockVtxoCache.getContractVtxos).toHaveBeenCalledWith([], {
            refresh: true,
        });
    });

    it("should force VTXOs refresh from indexer when received a `connection_reset` event", async () => {
        (mockIndexer.subscribeForScripts as any).mockImplementationOnce(() => {
            throw new Error("Connection refused");
        });

        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });

        expect(mockVtxoCache.getContractVtxos).toHaveBeenCalledTimes(2); // created, event
        expect(mockVtxoCache.getContractVtxos).toHaveBeenLastCalledWith(
            [contract],
            {
                refresh: true,
            }
        );
    });

    it("should force VTXOs refresh from indexer when received a `vtxo_received` event", async () => {
        (mockIndexer.getSubscription as any).mockImplementationOnce(
            (): AsyncIterableIterator<SubscriptionResponse> => {
                async function* gen(): AsyncIterableIterator<SubscriptionResponse> {
                    yield {
                        scripts: [TEST_DEFAULT_SCRIPT],
                        newVtxos: [createMockVtxo()],
                        spentVtxos: [],
                        sweptVtxos: [],
                    };
                }
                return gen();
            }
        );

        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });

        vi.advanceTimersByTime(3000);

        expect(mockVtxoCache.getContractVtxos).toHaveBeenCalledTimes(2); // created, event
        expect(mockVtxoCache.getContractVtxos).toHaveBeenLastCalledWith(
            [contract],
            {
                refresh: true,
            }
        );
    });
});
