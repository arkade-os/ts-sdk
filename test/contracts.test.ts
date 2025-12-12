import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    ContractManager,
    ContractWatcher,
    ContractSweeper,
    contractHandlers,
} from "../src/contracts";
import type { Contract, ContractVtxo, ContractState } from "../src/contracts";
import { InMemoryStorageAdapter } from "../src/storage/inMemory";
import { ContractRepositoryImpl } from "../src/repositories/contractRepository";
import type { IndexerProvider } from "../src/providers/indexer";
import type { VirtualCoin, ExtendedVirtualCoin } from "../src/wallet";

// Mock IndexerProvider
const createMockIndexerProvider = (): IndexerProvider => ({
    getVtxoTree: vi.fn(),
    getVtxoTreeLeaves: vi.fn(),
    getBatchSweepTransactions: vi.fn(),
    getCommitmentTx: vi.fn(),
    getCommitmentTxConnectors: vi.fn(),
    getCommitmentTxForfeitTxs: vi.fn(),
    getSubscription: vi.fn(),
    getVirtualTxs: vi.fn(),
    getVtxoChain: vi.fn(),
    getVtxos: vi.fn().mockResolvedValue({ vtxos: [] }),
    subscribeForScripts: vi.fn().mockResolvedValue("mock-subscription-id"),
    unsubscribeForScripts: vi.fn().mockResolvedValue(undefined),
});

// Helper to create a mock VTXO
const createMockVtxo = (overrides: Partial<VirtualCoin> = {}): VirtualCoin => ({
    txid: hex.encode(new Uint8Array(32).fill(1)),
    vout: 0,
    value: 100000,
    status: { confirmed: true },
    virtualStatus: { state: "settled" },
    createdAt: new Date(),
    isUnrolled: false,
    isSpent: false,
    ...overrides,
});

// Helper to create a mock ExtendedVirtualCoin
const createMockExtendedVtxo = (
    overrides: Partial<ExtendedVirtualCoin> = {}
): ExtendedVirtualCoin => ({
    ...createMockVtxo(),
    forfeitTapLeafScript: [new Uint8Array(32), new Uint8Array(33)],
    intentTapLeafScript: [new Uint8Array(32), new Uint8Array(34)],
    tapTree: new Uint8Array(64),
    ...overrides,
});

// Helper to create a mock ContractVtxo
const createMockContractVtxo = (
    contractId: string,
    overrides: Partial<ContractVtxo> = {}
): ContractVtxo => ({
    ...createMockExtendedVtxo(),
    contractId,
    ...overrides,
});

describe("Contracts", () => {
    describe("ContractHandlers", () => {
        it("should have default handler registered", () => {
            expect(contractHandlers.has("default")).toBe(true);
            const handler = contractHandlers.get("default");
            expect(handler).toBeDefined();
            expect(handler?.type).toBe("default");
        });

        it("should have VHTLC handler registered", () => {
            expect(contractHandlers.has("vhtlc")).toBe(true);
            const handler = contractHandlers.get("vhtlc");
            expect(handler).toBeDefined();
            expect(handler?.type).toBe("vhtlc");
        });

        it("should return undefined for unregistered handler", () => {
            expect(contractHandlers.get("custom")).toBeUndefined();
        });
    });

    describe("ContractRepository", () => {
        let storage: InMemoryStorageAdapter;
        let repository: ContractRepositoryImpl;

        beforeEach(() => {
            storage = new InMemoryStorageAdapter();
            repository = new ContractRepositoryImpl(storage);
        });

        it("should save and retrieve contract", async () => {
            const contract: Contract = {
                id: "test-1",
                type: "default",
                params: {},
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            await repository.saveContract(contract);
            const contracts = await repository.getContracts({ id: "test-1" });

            expect(contracts).toHaveLength(1);
            expect(contracts[0]).toEqual(contract);
        });

        it("should get contracts by state", async () => {
            const activeContract: Contract = {
                id: "active-1",
                type: "default",
                params: {},
                script: "script-1",
                address: "address-1",
                state: "active",
                createdAt: Date.now(),
            };

            const inactiveContract: Contract = {
                id: "inactive-1",
                type: "default",
                params: {},
                script: "script-2",
                address: "address-2",
                state: "inactive",
                createdAt: Date.now(),
            };

            await repository.saveContract(activeContract);
            await repository.saveContract(inactiveContract);

            const activeContracts = await repository.getContracts({
                state: "active",
            });
            const inactiveContracts = await repository.getContracts({
                state: "inactive",
            });

            expect(activeContracts).toHaveLength(1);
            expect(activeContracts[0].id).toBe("active-1");
            expect(inactiveContracts).toHaveLength(1);
            expect(inactiveContracts[0].id).toBe("inactive-1");
        });

        it("should update contract state via save", async () => {
            const contract: Contract = {
                id: "test-1",
                type: "default",
                params: {},
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            await repository.saveContract(contract);

            // Update state by saving modified contract
            await repository.saveContract({ ...contract, state: "inactive" });

            const contracts = await repository.getContracts({ id: "test-1" });
            expect(contracts[0]?.state).toBe("inactive");
        });

        it("should update contract data via save", async () => {
            const contract: Contract = {
                id: "test-1",
                type: "vhtlc",
                params: { hash: "abc" },
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
                data: { hashlock: "abc" },
            };

            await repository.saveContract(contract);

            // Update data by saving with merged data
            await repository.saveContract({
                ...contract,
                data: { ...contract.data, preimage: "secret" },
            });

            const contracts = await repository.getContracts({ id: "test-1" });
            expect(contracts[0]?.data).toEqual({
                hashlock: "abc",
                preimage: "secret",
            });
        });

        it("should delete contract", async () => {
            const contract: Contract = {
                id: "test-1",
                type: "default",
                params: {},
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            await repository.saveContract(contract);
            await repository.deleteContract("test-1");

            const contracts = await repository.getContracts({ id: "test-1" });
            expect(contracts).toHaveLength(0);
        });

        it("should get contract by script", async () => {
            const contract: Contract = {
                id: "test-1",
                type: "default",
                params: {},
                script: "unique-script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            await repository.saveContract(contract);
            const contracts = await repository.getContracts({
                script: "unique-script-hex",
            });

            expect(contracts).toHaveLength(1);
            expect(contracts[0].id).toBe("test-1");
        });
    });

    describe("ContractWatcher", () => {
        let watcher: ContractWatcher;
        let mockIndexer: IndexerProvider;

        beforeEach(() => {
            mockIndexer = createMockIndexerProvider();
            watcher = new ContractWatcher({
                indexerProvider: mockIndexer,
            });
        });

        afterEach(async () => {
            if (watcher.isCurrentlyWatching()) {
                await watcher.stopWatching();
            }
        });

        it("should add and retrieve contracts", async () => {
            const contract: Contract = {
                id: "test-1",
                type: "default",
                params: {},
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            await watcher.addContract(contract);

            expect(watcher.getContract("test-1")).toEqual(contract);
            expect(watcher.getAllContracts()).toHaveLength(1);
            expect(watcher.getActiveContracts()).toHaveLength(1);
        });

        it("should track active/inactive contracts separately", async () => {
            const activeContract: Contract = {
                id: "active-1",
                type: "default",
                params: {},
                script: "script-1",
                address: "address-1",
                state: "active",
                createdAt: Date.now(),
            };

            const inactiveContract: Contract = {
                id: "inactive-1",
                type: "default",
                params: {},
                script: "script-2",
                address: "address-2",
                state: "inactive",
                createdAt: Date.now(),
            };

            await watcher.addContract(activeContract);
            await watcher.addContract(inactiveContract);

            expect(watcher.getAllContracts()).toHaveLength(2);
            expect(watcher.getActiveContracts()).toHaveLength(1);
            expect(watcher.getActiveScripts()).toEqual(["script-1"]);
        });

        it("should toggle contract active state", async () => {
            const contract: Contract = {
                id: "test-1",
                type: "default",
                params: {},
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            await watcher.addContract(contract);
            expect(watcher.getActiveContracts()).toHaveLength(1);

            await watcher.setContractActive("test-1", false);
            expect(watcher.getActiveContracts()).toHaveLength(0);

            await watcher.setContractActive("test-1", true);
            expect(watcher.getActiveContracts()).toHaveLength(1);
        });

        it("should remove contracts", async () => {
            const contract: Contract = {
                id: "test-1",
                type: "default",
                params: {},
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            await watcher.addContract(contract);
            expect(watcher.getAllContracts()).toHaveLength(1);

            await watcher.removeContract("test-1");
            expect(watcher.getAllContracts()).toHaveLength(0);
        });
    });

    describe("ContractManager", () => {
        let manager: ContractManager;
        let mockIndexer: IndexerProvider;
        let storage: InMemoryStorageAdapter;
        let repository: ContractRepositoryImpl;

        beforeEach(async () => {
            mockIndexer = createMockIndexerProvider();
            storage = new InMemoryStorageAdapter();
            repository = new ContractRepositoryImpl(storage);

            manager = new ContractManager({
                indexerProvider: mockIndexer,
                contractRepository: repository,
                extendVtxo: (vtxo) => createMockExtendedVtxo(vtxo),
                getDefaultAddress: async () => "default-address",
            });

            await manager.initialize();
        });

        it("should create and retrieve contracts", async () => {
            const contract = await manager.createContract({
                type: "default",
                params: {},
                script: "script-hex",
                address: "address",
            });

            expect(contract.id).toBeDefined();
            expect(contract.createdAt).toBeDefined();
            expect(contract.state).toBe("active");

            const retrieved = await manager.getContract(contract.id);
            expect(retrieved).toEqual(contract);
        });

        it("should list all contracts", async () => {
            await manager.createContract({
                type: "default",
                params: {},
                script: "script-1",
                address: "address-1",
            });

            await manager.createContract({
                type: "vhtlc",
                params: { hash: "abc" },
                script: "script-2",
                address: "address-2",
            });

            expect(manager.getAllContracts()).toHaveLength(2);
        });

        it("should activate and deactivate contracts", async () => {
            const contract = await manager.createContract({
                type: "default",
                params: {},
                script: "script-hex",
                address: "address",
            });

            expect(manager.getActiveContracts()).toHaveLength(1);

            await manager.deactivateContract(contract.id);
            expect(manager.getActiveContracts()).toHaveLength(0);

            await manager.activateContract(contract.id);
            expect(manager.getActiveContracts()).toHaveLength(1);
        });

        it("should update contract data", async () => {
            const contract = await manager.createContract({
                type: "vhtlc",
                params: { hash: "abc" },
                script: "script-hex",
                address: "address",
                data: { hashlock: "abc" },
            });

            await manager.updateContractData(contract.id, {
                preimage: "secret",
            });

            const updated = await manager.getContract(contract.id);
            expect(updated?.data).toEqual({
                hashlock: "abc",
                preimage: "secret",
            });
        });

        it("should persist contracts across initialization", async () => {
            await manager.createContract({
                type: "default",
                params: {},
                script: "script-hex",
                address: "address",
            });

            // Create new manager with same storage
            const newManager = new ContractManager({
                indexerProvider: mockIndexer,
                contractRepository: repository,
                extendVtxo: (vtxo) => createMockExtendedVtxo(vtxo),
                getDefaultAddress: async () => "default-address",
            });

            await newManager.initialize();

            expect(newManager.getAllContracts()).toHaveLength(1);
        });
    });

    describe("ContractSweeper", () => {
        let sweeper: ContractSweeper;
        let watcher: ContractWatcher;
        let mockIndexer: IndexerProvider;
        let executeSweepMock: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            mockIndexer = createMockIndexerProvider();
            watcher = new ContractWatcher({
                indexerProvider: mockIndexer,
            });
            executeSweepMock = vi.fn().mockResolvedValue("mock-txid");

            sweeper = new ContractSweeper(
                {
                    contractWatcher: watcher,
                    getDefaultAddress: async () => "default-address",
                    executeSweep: executeSweepMock,
                    extendVtxo: (vtxo) => createMockExtendedVtxo(vtxo),
                },
                {
                    enabled: false,
                    minSweepValue: 1000,
                    maxVtxosPerSweep: 50,
                    batchSweeps: true,
                    pollIntervalMs: 60000,
                }
            );
        });

        afterEach(() => {
            sweeper.stop();
        });

        it("should start and stop without errors", () => {
            expect(sweeper.isActive()).toBe(false);

            sweeper.start();
            expect(sweeper.isActive()).toBe(false); // enabled: false

            sweeper.updateConfig({ enabled: true });
            // Would need to restart to take effect in this test
        });

        it("should return empty results when no contracts", async () => {
            const results = await sweeper.checkAndSweep();
            expect(results).toEqual([]);
        });

        it("should get config", () => {
            const config = sweeper.getConfig();
            expect(config.enabled).toBe(false);
            expect(config.minSweepValue).toBe(1000);
        });
    });
});
