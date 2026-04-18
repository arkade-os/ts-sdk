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

    it("should clear stale subscription ID and create a fresh subscription on reconnect", async () => {
        vi.useFakeTimers();

        try {
            const contract: Contract = {
                type: "default",
                params: createDefaultContractParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address",
                state: "active",
                createdAt: Date.now(),
            };
            await watcher.addContract(contract);

            // getSubscription returns an async iterator that immediately
            // rejects, simulating the SSE stream dying after the server
            // drops the subscription due to inactivity
            (mockIndexer.getSubscription as any).mockImplementation(() => ({
                [Symbol.asyncIterator]: () => ({
                    next: () => Promise.reject(new Error("stream died")),
                }),
            }));

            const callback = vi.fn();
            await watcher.startWatching(callback);
            // connect() succeeded: subscriptionId = "mock-subscription-id"
            // listenLoop() started in background (will fail immediately)

            // Reset subscribe mock to track only reconnection calls.
            // Reject when called with the stale ID (server cleaned it up),
            // succeed when called without an ID (fresh subscription).
            const subscribeMock = mockIndexer.subscribeForScripts as ReturnType<
                typeof vi.fn
            >;
            subscribeMock.mockReset();
            subscribeMock.mockImplementation(
                (scripts: string[], existingId?: string) => {
                    if (existingId) {
                        return Promise.reject(
                            new Error(`subscription ${existingId} not found`)
                        );
                    }
                    return Promise.resolve("fresh-subscription-id");
                }
            );

            // After successful reconnection, make getSubscription hang
            // so we don't trigger another reconnect cycle
            (mockIndexer.getSubscription as any).mockImplementation(() => ({
                [Symbol.asyncIterator]: () => ({
                    next: () => new Promise(() => {}),
                }),
            }));

            // Flush microtasks: listenLoop rejects → scheduleReconnect()
            await vi.advanceTimersByTimeAsync(0);

            // Advance past the reconnect delay (1s default)
            await vi.advanceTimersByTimeAsync(1000);
            // Flush microtasks so connect() resolves
            await vi.advanceTimersByTimeAsync(0);

            // subscribeForScripts should have been called twice:
            // 1st: with the stale ID → server rejects "not found"
            // 2nd: without ID → fresh subscription created
            //
            // Without the fix the 2nd call never happens — the error
            // propagates, connect() catches it, and it retries forever
            // with the same stale ID.
            expect(subscribeMock).toHaveBeenCalledTimes(2);
            expect(subscribeMock).toHaveBeenNthCalledWith(
                1,
                [contract.script],
                "mock-subscription-id"
            );
            expect(subscribeMock).toHaveBeenNthCalledWith(2, [contract.script]);

            // Watcher recovered — not stuck in a reconnect loop
            expect(watcher.getConnectionState()).toBe("connected");

            await watcher.stopWatching();
        } finally {
            vi.useRealTimers();
        }
    });
});
