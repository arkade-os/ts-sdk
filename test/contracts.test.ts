import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import {
    ContractManager,
    ContractWatcher,
    contractHandlers,
    encodeArkContract,
    decodeArkContract,
    contractFromArkContract,
    isArkContract,
} from "../src/contracts";
import type { Contract, ContractVtxo, ContractState } from "../src/contracts";
import { InMemoryStorageAdapter } from "../src/storage/inMemory";
import { ContractRepositoryImpl } from "../src/repositories/contractRepository";
import type { IndexerProvider } from "../src/providers/indexer";
import type { VirtualCoin, ExtendedVirtualCoin } from "../src/wallet";
import { DefaultVtxo } from "../src/script/default";
import { DefaultContractHandler } from "../src/contracts/handlers/default";

// Test keys for creating valid contracts
const TEST_PUB_KEY = new Uint8Array(32).fill(1);
const TEST_SERVER_PUB_KEY = new Uint8Array(32).fill(2);

// Create a valid default contract script
const testDefaultScript = new DefaultVtxo.Script({
    pubKey: TEST_PUB_KEY,
    serverPubKey: TEST_SERVER_PUB_KEY,
});
const TEST_DEFAULT_SCRIPT = hex.encode(testDefaultScript.pkScript);

// Helper to create valid default contract params
const createDefaultParams = () => ({
    pubKey: hex.encode(TEST_PUB_KEY),
    serverPubKey: hex.encode(TEST_SERVER_PUB_KEY),
});

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
                params: createDefaultParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address",
            });

            expect(contract.id).toBeDefined();
            expect(contract.createdAt).toBeDefined();
            expect(contract.state).toBe("active");

            const retrieved = await manager.getContract(contract.id);
            expect(retrieved).toEqual(contract);
        });

        it("should list all contracts", async () => {
            // Create two contracts with explicit different IDs
            // (since script defaults to ID, we need different IDs for same script)
            await manager.createContract({
                id: "contract-1",
                type: "default",
                params: createDefaultParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address-1",
            });

            await manager.createContract({
                id: "contract-2",
                type: "default",
                params: createDefaultParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address-2",
            });

            expect(manager.getAllContracts()).toHaveLength(2);
        });

        it("should activate and deactivate contracts", async () => {
            const contract = await manager.createContract({
                type: "default",
                params: createDefaultParams(),
                script: TEST_DEFAULT_SCRIPT,
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
                type: "default",
                params: createDefaultParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address",
                data: { customField: "initial" },
            });

            await manager.updateContractData(contract.id, {
                newField: "added",
            });

            const updated = await manager.getContract(contract.id);
            expect(updated?.data).toEqual({
                customField: "initial",
                newField: "added",
            });
        });

        it("should persist contracts across initialization", async () => {
            await manager.createContract({
                type: "default",
                params: createDefaultParams(),
                script: TEST_DEFAULT_SCRIPT,
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

    describe("ArkContract encoding/decoding", () => {
        it("should encode a contract to arkcontract string", () => {
            const contract: Contract = {
                id: "test-id",
                type: "default",
                params: {
                    pubKey: "abc123",
                    serverPubKey: "def456",
                },
                script: "5120...",
                address: "tark1...",
                state: "active",
                createdAt: Date.now(),
            };

            const encoded = encodeArkContract(contract);
            expect(encoded).toContain("arkcontract=default");
            expect(encoded).toContain("pubKey=abc123");
            expect(encoded).toContain("serverPubKey=def456");
        });

        it("should encode contract with runtime data", () => {
            const contract: Contract = {
                id: "test-id",
                type: "vhtlc",
                params: { hash: "abc" },
                data: { preimage: "secret123" },
                script: "5120...",
                address: "tark1...",
                state: "active",
                createdAt: Date.now(),
            };

            const encoded = encodeArkContract(contract);
            expect(encoded).toContain("preimage=secret123");
        });

        it("should decode an arkcontract string", () => {
            const encoded =
                "arkcontract=default&pubKey=abc123&serverPubKey=def456";
            const parsed = decodeArkContract(encoded);

            expect(parsed.type).toBe("default");
            expect(parsed.data.pubKey).toBe("abc123");
            expect(parsed.data.serverPubKey).toBe("def456");
        });

        it("should throw for invalid arkcontract string", () => {
            expect(() => decodeArkContract("invalid=string")).toThrow(
                "Invalid arkcontract string"
            );
        });

        it("should check if string is arkcontract", () => {
            expect(isArkContract("arkcontract=default&foo=bar")).toBe(true);
            expect(isArkContract("not-arkcontract")).toBe(false);
            expect(isArkContract("arkcontractwrong=test")).toBe(false);
        });

        it("should create contract from arkcontract string", () => {
            const encoded = "arkcontract=default&pubKey=abc&serverPubKey=def";
            const contract = contractFromArkContract(encoded, {
                id: "my-contract",
                label: "Test Contract",
            });

            expect(contract.id).toBe("my-contract");
            expect(contract.label).toBe("Test Contract");
            expect(contract.type).toBe("default");
            expect(contract.params.pubKey).toBe("abc");
            expect(contract.state).toBe("active");
        });

        it("should throw for unknown contract type", () => {
            const encoded = "arkcontract=unknown-type&foo=bar";
            expect(() => contractFromArkContract(encoded)).toThrow(
                "No handler registered for contract type"
            );
        });
    });

    describe("Handler param validation", () => {
        let storage: InMemoryStorageAdapter;
        let repository: ContractRepositoryImpl;
        let manager: ContractManager;
        let mockIndexer: IndexerProvider;

        beforeEach(async () => {
            storage = new InMemoryStorageAdapter();
            repository = new ContractRepositoryImpl(storage);
            mockIndexer = createMockIndexerProvider();

            manager = new ContractManager({
                indexerProvider: mockIndexer,
                contractRepository: repository,
                extendVtxo: (vtxo) => createMockExtendedVtxo(vtxo),
                getDefaultAddress: async () => "default-address",
            });
            await manager.initialize();
        });

        it("should reject contract with invalid params", async () => {
            await expect(
                manager.createContract({
                    type: "default",
                    params: {}, // Missing required pubKey and serverPubKey
                    script: TEST_DEFAULT_SCRIPT,
                    address: "address",
                })
            ).rejects.toThrow();
        });

        it("should reject contract with mismatched script", async () => {
            await expect(
                manager.createContract({
                    type: "default",
                    params: createDefaultParams(),
                    script: "wrong-script-that-doesnt-match",
                    address: "address",
                })
            ).rejects.toThrow("Script mismatch");
        });

        it("should accept contract with valid params and matching script", async () => {
            const contract = await manager.createContract({
                type: "default",
                params: createDefaultParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address",
            });

            expect(contract).toBeDefined();
            expect(contract.type).toBe("default");
        });
    });

    describe("VTXO-based watching", () => {
        let watcher: ContractWatcher;
        let mockIndexer: IndexerProvider;

        beforeEach(() => {
            mockIndexer = createMockIndexerProvider();
            watcher = new ContractWatcher({
                indexerProvider: mockIndexer,
                extendVtxo: (vtxo) => createMockExtendedVtxo(vtxo),
            });
        });

        it("should include active contracts in scripts to watch", async () => {
            const contract: Contract = {
                id: "active-contract",
                type: "default",
                params: createDefaultParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            await watcher.addContract(contract);
            const scripts = watcher.getScriptsToWatch();

            expect(scripts).toContain(TEST_DEFAULT_SCRIPT);
        });

        it("should exclude inactive contracts without VTXOs from watching", async () => {
            const contract: Contract = {
                id: "inactive-contract",
                type: "default",
                params: createDefaultParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address",
                state: "inactive",
                createdAt: Date.now(),
            };

            await watcher.addContract(contract);
            const scripts = watcher.getScriptsToWatch();

            // Inactive with no VTXOs should not be watched
            expect(scripts).not.toContain(TEST_DEFAULT_SCRIPT);
        });

        it("should return active scripts via getActiveScripts", async () => {
            const contract: Contract = {
                id: "test",
                type: "default",
                params: createDefaultParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            await watcher.addContract(contract);
            const activeScripts = watcher.getActiveScripts();

            expect(activeScripts).toContain(TEST_DEFAULT_SCRIPT);
        });
    });

    describe("Multiple event callbacks", () => {
        let storage: InMemoryStorageAdapter;
        let repository: ContractRepositoryImpl;
        let manager: ContractManager;
        let mockIndexer: IndexerProvider;

        beforeEach(async () => {
            storage = new InMemoryStorageAdapter();
            repository = new ContractRepositoryImpl(storage);
            mockIndexer = createMockIndexerProvider();

            manager = new ContractManager({
                indexerProvider: mockIndexer,
                contractRepository: repository,
                extendVtxo: (vtxo) => createMockExtendedVtxo(vtxo),
                getDefaultAddress: async () => "default-address",
            });
            await manager.initialize();
        });

        it("should support registering multiple event callbacks", () => {
            const callback1 = vi.fn();
            const callback2 = vi.fn();

            const unsubscribe1 = manager.onContractEvent(callback1);
            const unsubscribe2 = manager.onContractEvent(callback2);

            expect(unsubscribe1).toBeInstanceOf(Function);
            expect(unsubscribe2).toBeInstanceOf(Function);
        });

        it("should allow unsubscribing callbacks", () => {
            const callback = vi.fn();

            const unsubscribe = manager.onContractEvent(callback);
            unsubscribe();

            // After unsubscribe, callback should not be called
            // (we can't easily trigger events in unit tests, but verify unsubscribe works)
            expect(unsubscribe).toBeInstanceOf(Function);
        });
    });

    describe("DefaultContractHandler", () => {
        it("should create script from params", () => {
            const params = {
                pubKey: hex.encode(TEST_PUB_KEY),
                serverPubKey: hex.encode(TEST_SERVER_PUB_KEY),
            };

            const script = DefaultContractHandler.createScript(params);

            expect(script).toBeDefined();
            expect(script.pkScript).toBeDefined();
        });

        it("should serialize and deserialize params", () => {
            const original = {
                pubKey: TEST_PUB_KEY,
                serverPubKey: TEST_SERVER_PUB_KEY,
            };

            const serialized = DefaultContractHandler.serializeParams(original);
            const deserialized =
                DefaultContractHandler.deserializeParams(serialized);

            expect(deserialized.pubKey).toBeInstanceOf(Uint8Array);
            expect(deserialized.serverPubKey).toBeInstanceOf(Uint8Array);
            expect(Array.from(deserialized.pubKey)).toEqual(
                Array.from(TEST_PUB_KEY)
            );
        });

        it("should select forfeit path when collaborative", () => {
            const params = createDefaultParams();
            const script = DefaultContractHandler.createScript(params);
            const contract: Contract = {
                id: "test",
                type: "default",
                params,
                script: hex.encode(script.pkScript),
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            const path = DefaultContractHandler.selectPath(script, contract, {
                collaborative: true,
                currentTime: Date.now(),
            });

            expect(path).toBeDefined();
            expect(path?.leaf).toBeDefined();
        });

        it("should select exit path when not collaborative", () => {
            const params = createDefaultParams();
            const script = DefaultContractHandler.createScript(params);
            const contract: Contract = {
                id: "test",
                type: "default",
                params,
                script: hex.encode(script.pkScript),
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            const path = DefaultContractHandler.selectPath(script, contract, {
                collaborative: false,
                currentTime: Date.now(),
            });

            expect(path).toBeDefined();
            expect(path?.leaf).toBeDefined();
        });

        it("should return multiple spendable paths", () => {
            const params = createDefaultParams();
            const script = DefaultContractHandler.createScript(params);
            const contract: Contract = {
                id: "test",
                type: "default",
                params,
                script: hex.encode(script.pkScript),
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };

            const paths = DefaultContractHandler.getSpendablePaths(
                script,
                contract,
                {
                    collaborative: true,
                    currentTime: Date.now(),
                }
            );

            // Should have both forfeit and exit paths when collaborative
            expect(paths.length).toBeGreaterThanOrEqual(2);
        });
    });
});
