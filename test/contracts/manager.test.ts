import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
    ContractManager,
    DefaultContractHandler,
    DefaultVtxo,
    IndexerProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    SubscriptionResponse,
} from "../../src";
import { ContractRepository } from "../../src/repositories";
import { hex } from "@scure/base";
import {
    createDefaultContractParams,
    createMockExtendedVtxo,
    createMockIndexerProvider,
    createMockVtxo,
    TEST_DEFAULT_SCRIPT,
    TEST_PUB_KEY_HEX,
    TEST_SERVER_PUB_KEY_HEX,
} from "./helpers";

vi.useFakeTimers();

describe("ContractManager", () => {
    let manager: ContractManager;
    let mockIndexer: IndexerProvider;
    let repository: ContractRepository;

    beforeEach(async () => {
        mockIndexer = createMockIndexerProvider();
        repository = new InMemoryContractRepository();

        manager = await ContractManager.create({
            indexerProvider: mockIndexer,
            contractRepository: repository,
            extendVtxo: (vtxo) => createMockExtendedVtxo(vtxo),
            getDefaultAddress: async () => "default-address",
            walletRepository: new InMemoryWalletRepository(),
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

        expect(contract.script).toBeDefined();
        expect(contract.createdAt).toBeDefined();
        expect(contract.state).toBe("active");

        const [retrieved] = await manager.getContracts({
            script: contract.script,
        });
        expect(retrieved).toEqual(contract);
    });

    it("should list all contracts", async () => {
        // Create two contracts with explicit different scripts
        await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address-1",
        });

        const altParams = DefaultContractHandler.serializeParams({
            pubKey: `tr(${TEST_PUB_KEY_HEX})`,
            serverPubKey: `tr(${TEST_SERVER_PUB_KEY_HEX})`,
            csvTimelock: {
                type: "blocks",
                value: DefaultVtxo.Script.DEFAULT_TIMELOCK.value + 1n,
            },
        });
        const altScript = hex.encode(
            DefaultContractHandler.createScript(altParams).pkScript
        );

        await manager.createContract({
            type: "default",
            params: altParams,
            script: altScript,
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
        await manager.setContractState(contract.script, "inactive");
        expect(await manager.getContracts({ state: "active" })).toHaveLength(0);
        await manager.setContractState(contract.script, "active");
        expect(await manager.getContracts({ state: "active" })).toHaveLength(1);
    });

    it("should update contract metadata", async () => {
        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
            metadata: { customField: "initial" },
        });

        await manager.updateContract(contract.script, {
            metadata: { newField: "added" },
        });

        const [updated] = await manager.getContracts({
            script: contract.script,
        });
        expect(updated?.metadata).toEqual({
            newField: "added",
        });
    });

    it("should update contract params preserving the existing values", async () => {
        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });

        await manager.updateContractParams(contract.script, {
            preimage: "newSecret",
        });

        const [updated] = await manager.getContracts({
            script: contract.script,
        });
        expect(updated?.params).toEqual({
            ...contract.params,
            preimage: "newSecret",
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
        });
        // TODO: assert on indexer call
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
    });
});
