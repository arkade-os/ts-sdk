import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    ContractManager,
    ContractWatcher,
    ContractSweeper,
    SpendingStrategyRegistry,
    DefaultSpendingStrategy,
    HTLCClaimStrategy,
    HTLCRefundStrategy,
    createHTLCContract,
    createDefaultContract,
} from "../src/contracts";
import type {
    Contract,
    ContractVtxo,
    ContractState,
    SpendContext,
    SweeperConfig,
} from "../src/contracts";
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
const createMockVtxo = (
    overrides: Partial<VirtualCoin> = {}
): VirtualCoin => ({
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
    describe("SpendingStrategyRegistry", () => {
        let registry: SpendingStrategyRegistry;

        beforeEach(() => {
            registry = new SpendingStrategyRegistry();
        });

        it("should have default strategy registered", () => {
            expect(registry.has("default")).toBe(true);
            expect(registry.get("default")).toBeInstanceOf(DefaultSpendingStrategy);
        });

        it("should have HTLC strategies registered", () => {
            expect(registry.has("htlc-claim")).toBe(true);
            expect(registry.has("htlc-refund")).toBe(true);
            expect(registry.get("htlc-claim")).toBeInstanceOf(HTLCClaimStrategy);
            expect(registry.get("htlc-refund")).toBeInstanceOf(HTLCRefundStrategy);
        });

        it("should throw when registering duplicate strategy", () => {
            expect(() => {
                registry.register({
                    type: "default",
                    strategy: new DefaultSpendingStrategy(),
                });
            }).toThrow("already registered");
        });

        it("should return undefined for unregistered strategy", () => {
            expect(registry.get("custom")).toBeUndefined();
        });

        it("should throw on getOrThrow for unregistered strategy", () => {
            expect(() => registry.getOrThrow("custom")).toThrow(
                "No spending strategy registered"
            );
        });

        it("should list registered types", () => {
            const types = registry.getRegisteredTypes();
            expect(types).toContain("default");
            expect(types).toContain("htlc-claim");
            expect(types).toContain("htlc-refund");
        });
    });

    describe("DefaultSpendingStrategy", () => {
        const strategy = new DefaultSpendingStrategy();
        const mockContract: Contract = {
            id: "test-contract",
            script: "mock-script",
            address: "mock-address",
            state: "active",
            createdAt: Date.now(),
            spendingStrategy: "default",
        };

        it("should allow spending unspent VTXO", () => {
            const vtxo = createMockContractVtxo("test-contract", {
                isSpent: false,
            });
            const context: SpendContext = {
                currentTime: Date.now(),
                spendingData: {},
            };

            expect(strategy.canSpend(vtxo, mockContract, context)).toBe(true);
        });

        it("should not allow spending spent VTXO", () => {
            const vtxo = createMockContractVtxo("test-contract", {
                isSpent: true,
            });
            const context: SpendContext = {
                currentTime: Date.now(),
                spendingData: {},
            };

            expect(strategy.canSpend(vtxo, mockContract, context)).toBe(false);
        });

        it("should prepare spend with forfeit tap leaf", () => {
            const vtxo = createMockContractVtxo("test-contract");
            const context: SpendContext = {
                currentTime: Date.now(),
                spendingData: {},
            };

            const prepared = strategy.prepareSpend(vtxo, mockContract, context);
            expect(prepared.tapLeafScript).toBe(vtxo.forfeitTapLeafScript);
        });
    });

    describe("HTLCClaimStrategy", () => {
        const strategy = new HTLCClaimStrategy();

        const createHTLCContract = (): Contract => ({
            id: "htlc-contract",
            script: "mock-script",
            address: "mock-address",
            state: "active",
            createdAt: Date.now(),
            spendingStrategy: "htlc-claim",
            spendingData: {
                hashlock: "abc123",
                preimage: "secret",
                timelock: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
            },
        });

        it("should allow claiming when preimage is available and not expired", () => {
            const contract = createHTLCContract();
            const vtxo = createMockContractVtxo("htlc-contract");
            const context: SpendContext = {
                currentTime: Date.now(),
                spendingData: {},
            };

            expect(strategy.canSpend(vtxo, contract, context)).toBe(true);
        });

        it("should not allow claiming without preimage", () => {
            const contract = createHTLCContract();
            contract.spendingData = {
                ...contract.spendingData,
                preimage: undefined,
            };
            const vtxo = createMockContractVtxo("htlc-contract");
            const context: SpendContext = {
                currentTime: Date.now(),
                spendingData: {},
            };

            expect(strategy.canSpend(vtxo, contract, context)).toBe(false);
        });

        it("should not allow claiming after timelock expired", () => {
            const contract = createHTLCContract();
            contract.spendingData = {
                ...contract.spendingData,
                timelock: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
            };
            const vtxo = createMockContractVtxo("htlc-contract");
            const context: SpendContext = {
                currentTime: Date.now(),
                spendingData: {},
            };

            expect(strategy.canSpend(vtxo, contract, context)).toBe(false);
        });
    });

    describe("HTLCRefundStrategy", () => {
        const strategy = new HTLCRefundStrategy();

        const createHTLCContract = (timelockOffset: number): Contract => ({
            id: "htlc-contract",
            script: "mock-script",
            address: "mock-address",
            state: "active",
            createdAt: Date.now(),
            spendingStrategy: "htlc-refund",
            spendingData: {
                hashlock: "abc123",
                timelock: Math.floor(Date.now() / 1000) + timelockOffset,
            },
        });

        it("should allow refund after timelock expired", () => {
            const contract = createHTLCContract(-3600); // 1 hour ago
            const vtxo = createMockContractVtxo("htlc-contract");
            const context: SpendContext = {
                currentTime: Date.now(),
                spendingData: {},
            };

            expect(strategy.canSpend(vtxo, contract, context)).toBe(true);
        });

        it("should not allow refund before timelock", () => {
            const contract = createHTLCContract(3600); // 1 hour from now
            const vtxo = createMockContractVtxo("htlc-contract");
            const context: SpendContext = {
                currentTime: Date.now(),
                spendingData: {},
            };

            expect(strategy.canSpend(vtxo, contract, context)).toBe(false);
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
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
                spendingStrategy: "default",
            };

            await repository.saveContract(contract);
            const retrieved = await repository.getContractById("test-1");

            expect(retrieved).toEqual(contract);
        });

        it("should get contracts by state", async () => {
            const activeContract: Contract = {
                id: "active-1",
                script: "script-1",
                address: "address-1",
                state: "active",
                createdAt: Date.now(),
                spendingStrategy: "default",
            };

            const inactiveContract: Contract = {
                id: "inactive-1",
                script: "script-2",
                address: "address-2",
                state: "inactive",
                createdAt: Date.now(),
                spendingStrategy: "default",
            };

            await repository.saveContract(activeContract);
            await repository.saveContract(inactiveContract);

            const activeContracts = await repository.getContractsByState("active");
            const inactiveContracts = await repository.getContractsByState("inactive");

            expect(activeContracts).toHaveLength(1);
            expect(activeContracts[0].id).toBe("active-1");
            expect(inactiveContracts).toHaveLength(1);
            expect(inactiveContracts[0].id).toBe("inactive-1");
        });

        it("should update contract state", async () => {
            const contract: Contract = {
                id: "test-1",
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
                spendingStrategy: "default",
            };

            await repository.saveContract(contract);
            await repository.updateContractState("test-1", "inactive");

            const retrieved = await repository.getContractById("test-1");
            expect(retrieved?.state).toBe("inactive");
        });

        it("should update spending data", async () => {
            const contract: Contract = {
                id: "test-1",
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
                spendingStrategy: "htlc-claim",
                spendingData: { hashlock: "abc" },
            };

            await repository.saveContract(contract);
            await repository.updateContractSpendingData("test-1", {
                preimage: "secret",
            });

            const retrieved = await repository.getContractById("test-1");
            expect(retrieved?.spendingData).toEqual({
                hashlock: "abc",
                preimage: "secret",
            });
        });

        it("should delete contract", async () => {
            const contract: Contract = {
                id: "test-1",
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
                spendingStrategy: "default",
            };

            await repository.saveContract(contract);
            await repository.deleteContract("test-1");

            const retrieved = await repository.getContractById("test-1");
            expect(retrieved).toBeNull();
        });

        it("should get contract by script", async () => {
            const contract: Contract = {
                id: "test-1",
                script: "unique-script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
                spendingStrategy: "default",
            };

            await repository.saveContract(contract);
            const retrieved = await repository.getContractByScript(
                "unique-script-hex"
            );

            expect(retrieved?.id).toBe("test-1");
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
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
                spendingStrategy: "default",
            };

            await watcher.addContract(contract);

            expect(watcher.getContract("test-1")).toEqual(contract);
            expect(watcher.getAllContracts()).toHaveLength(1);
            expect(watcher.getActiveContracts()).toHaveLength(1);
        });

        it("should track active/inactive contracts separately", async () => {
            const activeContract: Contract = {
                id: "active-1",
                script: "script-1",
                address: "address-1",
                state: "active",
                createdAt: Date.now(),
                spendingStrategy: "default",
            };

            const inactiveContract: Contract = {
                id: "inactive-1",
                script: "script-2",
                address: "address-2",
                state: "inactive",
                createdAt: Date.now(),
                spendingStrategy: "default",
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
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
                spendingStrategy: "default",
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
                script: "script-hex",
                address: "address",
                state: "active",
                createdAt: Date.now(),
                spendingStrategy: "default",
            };

            await watcher.addContract(contract);
            expect(watcher.getAllContracts()).toHaveLength(1);

            await watcher.removeContract("test-1");
            expect(watcher.getAllContracts()).toHaveLength(0);
        });
    });

    describe("Contract helpers", () => {
        it("should create default contract params", () => {
            const params = createDefaultContract("script-hex", "address");

            expect(params.script).toBe("script-hex");
            expect(params.address).toBe("address");
            expect(params.spendingStrategy).toBe("default");
            expect(params.autoSweep).toBe(false);
        });

        it("should create HTLC contract params", () => {
            const params = createHTLCContract({
                script: "htlc-script",
                address: "htlc-address",
                hashlock: "abc123",
                timelock: 1704067200,
                autoSweep: true,
            });

            expect(params.script).toBe("htlc-script");
            expect(params.address).toBe("htlc-address");
            expect(params.spendingStrategy).toBe("htlc-claim");
            expect(params.spendingData?.hashlock).toBe("abc123");
            expect(params.spendingData?.timelock).toBe(1704067200);
            expect(params.autoSweep).toBe(true);
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
                script: "script-hex",
                address: "address",
                spendingStrategy: "default",
            });

            expect(contract.id).toBeDefined();
            expect(contract.createdAt).toBeDefined();
            expect(contract.state).toBe("active");

            const retrieved = await manager.getContract(contract.id);
            expect(retrieved).toEqual(contract);
        });

        it("should list all contracts", async () => {
            await manager.createContract({
                script: "script-1",
                address: "address-1",
                spendingStrategy: "default",
            });

            await manager.createContract({
                script: "script-2",
                address: "address-2",
                spendingStrategy: "htlc-claim",
            });

            expect(manager.getAllContracts()).toHaveLength(2);
        });

        it("should activate and deactivate contracts", async () => {
            const contract = await manager.createContract({
                script: "script-hex",
                address: "address",
                spendingStrategy: "default",
            });

            expect(manager.getActiveContracts()).toHaveLength(1);

            await manager.deactivateContract(contract.id);
            expect(manager.getActiveContracts()).toHaveLength(0);

            await manager.activateContract(contract.id);
            expect(manager.getActiveContracts()).toHaveLength(1);
        });

        it("should update spending data", async () => {
            const contract = await manager.createContract({
                script: "script-hex",
                address: "address",
                spendingStrategy: "htlc-claim",
                spendingData: { hashlock: "abc" },
            });

            await manager.updateSpendingData(contract.id, { preimage: "secret" });

            const updated = await manager.getContract(contract.id);
            expect(updated?.spendingData).toEqual({
                hashlock: "abc",
                preimage: "secret",
            });
        });

        it("should persist contracts across initialization", async () => {
            await manager.createContract({
                script: "script-hex",
                address: "address",
                spendingStrategy: "default",
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
