import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    Contract,
    ContractManager,
    ContractWatcher,
    DefaultContractHandler,
    DefaultVtxo,
    type IndexerProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
} from "../../src";
import { hex } from "@scure/base";
import {
    createDefaultContractParams,
    createMockIndexerProvider,
    TEST_DEFAULT_SCRIPT,
} from "./helpers";

describe("ContractWatcher", () => {
    let watcher: ContractWatcher;
    let mockIndexer: IndexerProvider;

    beforeEach(async () => {
        mockIndexer = createMockIndexerProvider();
        watcher = new ContractWatcher({
            indexerProvider: mockIndexer,
            walletRepository: new InMemoryWalletRepository(),
        });
    });

    it("should subscribe new active scripts added", async () => {
        await watcher.startWatching(() => {});

        const contract: Contract = {
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
            state: "active",
            layer: "offchain",
            createdAt: Date.now(),
        };

        await watcher.addContract(contract);
        expect(mockIndexer.subscribeForScripts).toHaveBeenCalledWith(
            [contract.script],
            undefined
        );
    });

    it("should exclude inactive contracts without VTXOs from watching", async () => {
        await watcher.startWatching(() => {});

        const contract: Contract = {
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
            state: "inactive",
            layer: "offchain",
            createdAt: Date.now(),
        };

        await watcher.addContract(contract);
        expect(mockIndexer.subscribeForScripts).not.toHaveBeenCalled();
    });

    it("should unsubscribe from scripts when stopped", async () => {
        await watcher.startWatching(() => {});

        const contract: Contract = {
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
            state: "active",
            layer: "offchain",
            createdAt: Date.now(),
        };
        await watcher.addContract(contract);
        expect(mockIndexer.unsubscribeForScripts).not.toHaveBeenCalled();
        await watcher.stopWatching();
        expect(
            mockIndexer.unsubscribeForScripts
        ).toHaveBeenCalledExactlyOnceWith("mock-subscription-id");
    });

    it("should emit 'connection_reset` event when the subscription cannot be created", async () => {
        const contract: Contract = {
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
            state: "active",
            layer: "offchain",
            createdAt: Date.now(),
        };
        await watcher.addContract(contract);

        (mockIndexer.subscribeForScripts as any).mockImplementationOnce(() => {
            throw new Error("Connection refused");
        });

        const callback = vi.fn();
        await watcher.startWatching(callback);
        expect(callback).toHaveBeenCalledWith({
            timestamp: expect.any(Number),
            type: "connection_reset",
        });
    });

    it("should emit 'connection_reset` event when the subscription cannot be retrieved", async () => {
        const contract: Contract = {
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
            state: "active",
            layer: "offchain",
            createdAt: Date.now(),
        };
        await watcher.addContract(contract);

        (mockIndexer.getSubscription as any).mockImplementationOnce(() => {
            throw new Error("Connection refused");
        });

        const callback = vi.fn();
        await watcher.startWatching(callback);
        expect(callback).toHaveBeenCalledWith({
            timestamp: expect.any(Number),
            type: "connection_reset",
        });
    });
});
