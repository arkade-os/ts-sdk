import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    ContractManager,
    IndexerProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
} from "../../src";
import {
    createDefaultContractParams,
    createDelegateContractParams,
    createMockContractVtxo,
    createMockIndexerProvider,
    TEST_DEFAULT_SCRIPT,
    TEST_DELEGATE_SCRIPT,
} from "./helpers";

vi.useFakeTimers();

describe("Delegator Lifecycle", () => {
    let contractRepository: InMemoryContractRepository;
    let walletRepository: InMemoryWalletRepository;
    let mockIndexer: IndexerProvider;

    beforeEach(() => {
        contractRepository = new InMemoryContractRepository();
        walletRepository = new InMemoryWalletRepository();
        mockIndexer = createMockIndexerProvider();
    });

    it("should add delegator — persisted contracts survive re-creation", async () => {
        // Phase 1 — No delegator: only default contract
        const manager1 = await ContractManager.create({
            indexerProvider: mockIndexer,
            contractRepository,
            walletRepository,
            getDefaultAddress: async () => "default-address",
            watcherConfig: {
                failsafePollIntervalMs: 1000,
                reconnectDelayMs: 500,
            },
        });

        await manager1.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "default-address",
        });

        expect(await manager1.getContracts()).toHaveLength(1);

        // Mock indexer returns a VTXO for the default script
        const defaultVtxo = createMockContractVtxo(TEST_DEFAULT_SCRIPT, {
            value: 50_000,
        });
        (mockIndexer.getVtxos as any).mockResolvedValue({
            vtxos: [defaultVtxo],
        });

        const contractsWithVtxos1 = await manager1.getContractsWithVtxos();
        expect(contractsWithVtxos1).toHaveLength(1);
        expect(contractsWithVtxos1[0].vtxos).toHaveLength(1);
        expect(contractsWithVtxos1[0].vtxos[0].value).toBe(50_000);

        // Verify spending paths for default: forfeit + exit (2 paths)
        const defaultPaths = await manager1.getAllSpendingPaths({
            contractScript: TEST_DEFAULT_SCRIPT,
        });
        expect(defaultPaths).toHaveLength(2);

        manager1.dispose();

        // Phase 2 — Add delegator: re-create manager with same repos, register delegate
        const manager2 = await ContractManager.create({
            indexerProvider: mockIndexer,
            contractRepository,
            walletRepository,
            getDefaultAddress: async () => "delegate-address",
            watcherConfig: {
                failsafePollIntervalMs: 1000,
                reconnectDelayMs: 500,
            },
        });

        // Default contract already persisted from phase 1; register delegate
        await manager2.createContract({
            type: "delegate",
            params: createDelegateContractParams(),
            script: TEST_DELEGATE_SCRIPT,
            address: "delegate-address",
        });

        expect(await manager2.getContracts()).toHaveLength(2);

        // Mock indexer returns VTXOs for both scripts
        const delegateVtxo = createMockContractVtxo(TEST_DELEGATE_SCRIPT, {
            txid: "aa".repeat(32),
            value: 30_000,
        });
        (mockIndexer.getVtxos as any).mockImplementation(
            ({ scripts }: { scripts: string[] }) => {
                const vtxos = scripts.flatMap((s: string) => {
                    if (s === TEST_DEFAULT_SCRIPT) return [defaultVtxo];
                    if (s === TEST_DELEGATE_SCRIPT) return [delegateVtxo];
                    return [];
                });
                return Promise.resolve({ vtxos });
            }
        );

        const contractsWithVtxos2 = await manager2.getContractsWithVtxos();
        expect(contractsWithVtxos2).toHaveLength(2);
        for (const cwv of contractsWithVtxos2) {
            expect(cwv.vtxos).toHaveLength(1);
        }

        // Verify spending paths for delegate: forfeit + exit + delegate (3 paths)
        const delegatePaths = await manager2.getAllSpendingPaths({
            contractScript: TEST_DELEGATE_SCRIPT,
        });
        expect(delegatePaths).toHaveLength(3);

        // Default paths still work
        const defaultPaths2 = await manager2.getAllSpendingPaths({
            contractScript: TEST_DEFAULT_SCRIPT,
        });
        expect(defaultPaths2).toHaveLength(2);

        manager2.dispose();
    });

    it("should remove delegator — persisted delegate contracts remain accessible", async () => {
        // Setup: create both contracts
        const setupManager = await ContractManager.create({
            indexerProvider: mockIndexer,
            contractRepository,
            walletRepository,
            getDefaultAddress: async () => "default-address",
            watcherConfig: {
                failsafePollIntervalMs: 1000,
                reconnectDelayMs: 500,
            },
        });

        await setupManager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "default-address",
        });
        await setupManager.createContract({
            type: "delegate",
            params: createDelegateContractParams(),
            script: TEST_DELEGATE_SCRIPT,
            address: "delegate-address",
        });

        expect(await setupManager.getContracts()).toHaveLength(2);
        setupManager.dispose();

        // Phase 3 — Remove delegator: re-create manager, only register default
        const manager3 = await ContractManager.create({
            indexerProvider: mockIndexer,
            contractRepository,
            walletRepository,
            getDefaultAddress: async () => "default-address",
            watcherConfig: {
                failsafePollIntervalMs: 1000,
                reconnectDelayMs: 500,
            },
        });

        // Only register default — it already exists, createContract returns existing
        const existingDefault = await manager3.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "default-address",
        });
        expect(existingDefault.type).toBe("default");

        // Both contracts still persisted from setup
        const allContracts = await manager3.getContracts();
        expect(allContracts).toHaveLength(2);

        const types = allContracts.map((c) => c.type).sort();
        expect(types).toEqual(["default", "delegate"]);

        // Mock indexer returns VTXOs for both scripts
        const defaultVtxo = createMockContractVtxo(TEST_DEFAULT_SCRIPT, {
            value: 40_000,
        });
        const delegateVtxo = createMockContractVtxo(TEST_DELEGATE_SCRIPT, {
            txid: "bb".repeat(32),
            value: 25_000,
        });
        (mockIndexer.getVtxos as any).mockImplementation(
            ({ scripts }: { scripts: string[] }) => {
                const vtxos = scripts.flatMap((s: string) => {
                    if (s === TEST_DEFAULT_SCRIPT) return [defaultVtxo];
                    if (s === TEST_DELEGATE_SCRIPT) return [delegateVtxo];
                    return [];
                });
                return Promise.resolve({ vtxos });
            }
        );

        const contractsWithVtxos = await manager3.getContractsWithVtxos();
        expect(contractsWithVtxos).toHaveLength(2);
        for (const cwv of contractsWithVtxos) {
            expect(cwv.vtxos).toHaveLength(1);
        }

        // Both spending paths still work even without delegator service
        const defaultPaths = await manager3.getAllSpendingPaths({
            contractScript: TEST_DEFAULT_SCRIPT,
        });
        expect(defaultPaths).toHaveLength(2);

        const delegatePaths = await manager3.getAllSpendingPaths({
            contractScript: TEST_DELEGATE_SCRIPT,
        });
        expect(delegatePaths).toHaveLength(3);

        manager3.dispose();
    });
});
