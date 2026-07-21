import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    Contract,
    ContractEvent,
    ContractManager,
    ContractWatcher,
    DefaultContractHandler,
    DefaultVtxo,
    type IndexerProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
} from "../../src";
import type { SubscriptionResponse } from "../../src/providers/indexer";
import { hex } from "@scure/base";
import {
    createDefaultContractParams,
    createDelegateContractParams,
    createMockIndexerProvider,
    createMockVtxo,
    TEST_DEFAULT_SCRIPT,
    TEST_DELEGATE_SCRIPT,
    testDefaultScript,
    testDelegateScript,
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
        expect(mockIndexer.subscribeForScripts).toHaveBeenCalledWith([contract.script], undefined);
    });

    it("should subscribe inactive contracts without VTXOs", async () => {
        // A rotated-past receive address can still be paid.
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
        expect(mockIndexer.subscribeForScripts).toHaveBeenCalledWith([contract.script], undefined);
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
        expect(mockIndexer.unsubscribeForScripts).toHaveBeenCalledExactlyOnceWith(
            "mock-subscription-id",
        );
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

    it.each([
        { label: "old format", message: (id: string) => `subscription ${id} not found` },
        { label: "new format", message: (id: string) => `subscription not found: ${id}` },
    ])(
        "should clear stale subscription ID and create a fresh subscription on reconnect ($label)",
        async ({ message }) => {
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
                const subscribeMock = mockIndexer.subscribeForScripts as ReturnType<typeof vi.fn>;
                subscribeMock.mockReset();
                subscribeMock.mockImplementation((scripts: string[], existingId?: string) => {
                    if (existingId) {
                        return Promise.reject(new Error(message(existingId)));
                    }
                    return Promise.resolve("fresh-subscription-id");
                });

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
                    "mock-subscription-id",
                );
                expect(subscribeMock).toHaveBeenNthCalledWith(2, [contract.script]);

                // Watcher recovered — not stuck in a reconnect loop
                expect(watcher.getConnectionState()).toBe("connected");

                await watcher.stopWatching();
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it("opens listenLoop immediately when the first contract is added after a zero-script startWatching", async () => {
        // Without the cold-start kick, the listener parks behind the
        // reconnect timer and `getSubscription` is delayed by ≥1s.
        await watcher.startWatching(() => {});

        expect(mockIndexer.getSubscription).not.toHaveBeenCalled();
        expect(watcher.getConnectionState()).not.toBe("connected");

        const contract: Contract = {
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
            state: "active",
            createdAt: Date.now(),
        };
        await watcher.addContract(contract);

        // Yield so the cold-start kick reaches `getSubscription`.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mockIndexer.getSubscription).toHaveBeenCalledTimes(1);
        expect(mockIndexer.getSubscription).toHaveBeenCalledWith(
            "mock-subscription-id",
            expect.anything(),
        );
        expect(watcher.getConnectionState()).toBe("connected");

        await watcher.stopWatching();
    });

    describe("vtxo enrichment via subscription updates", () => {
        // Wire the indexer mock so the next listenLoop iteration receives
        // a single subscription update and then hangs (no reconnect churn).
        const yieldOnce = (update: SubscriptionResponse): void => {
            let yielded = false;
            (mockIndexer.getSubscription as any).mockImplementation(() => ({
                [Symbol.asyncIterator]: () => ({
                    next: () => {
                        if (!yielded) {
                            yielded = true;
                            return Promise.resolve({
                                value: update,
                                done: false,
                            });
                        }
                        return new Promise(() => {});
                    },
                }),
            }));
        };

        const waitForReceived = (events: ContractEvent[]) =>
            vi.waitFor(() => {
                const event = events.find((e) => e.type === "vtxo_received");
                if (!event) throw new Error("vtxo_received not yet emitted");
                return event;
            });

        it("annotates emitted vtxos with the contract-specific tapscript, not the default", async () => {
            // A delegate contract — distinct tapscript from the default
            // handler — so we can assert the watcher resolves the right
            // handler instead of accidentally falling back to defaults.
            const delegateContract: Contract = {
                type: "delegate",
                params: createDelegateContractParams(),
                script: TEST_DELEGATE_SCRIPT,
                address: "delegate-address",
                state: "active",
                createdAt: Date.now(),
            };

            yieldOnce({
                scripts: [TEST_DELEGATE_SCRIPT],
                newVtxos: [
                    createMockVtxo({
                        script: TEST_DELEGATE_SCRIPT,
                        txid: "aa",
                        vout: 1,
                    }),
                ],
                spentVtxos: [],
                sweptVtxos: [],
            });

            const events: ContractEvent[] = [];
            await watcher.addContract(delegateContract);
            await watcher.startWatching((e) => events.push(e));

            try {
                const event = await waitForReceived(events);
                if (event.type !== "vtxo_received") {
                    throw new Error("unreachable");
                }

                expect(event.contractScript).toBe(TEST_DELEGATE_SCRIPT);
                expect(event.vtxos).toHaveLength(1);
                const vtxo = event.vtxos[0];
                expect(vtxo.contractScript).toBe(TEST_DELEGATE_SCRIPT);
                // The exact tapscript bytes must come from the delegate
                // handler. A regression that fell back to the default
                // tapscript would produce different bytes here.
                expect(vtxo.tapTree).toEqual(testDelegateScript.encode());
                expect(vtxo.tapTree).not.toEqual(testDefaultScript.encode());
            } finally {
                await watcher.stopWatching();
            }
        });

        it("emits the raw vtxo with contractScript and warns when no handler can extend", async () => {
            // A contract type with no registered handler exercises the
            // catch-fallback path: emit the raw vtxo (no taproot fields)
            // and surface a warn so the failure is observable.
            const fakeScript = "deadbeef";
            const contract: Contract = {
                type: "nonexistent-handler-type",
                params: {},
                script: fakeScript,
                address: "fake-address",
                state: "active",
                createdAt: Date.now(),
            };

            yieldOnce({
                scripts: [fakeScript],
                newVtxos: [
                    createMockVtxo({
                        script: fakeScript,
                        txid: "aabb",
                        vout: 7,
                    }),
                ],
                spentVtxos: [],
                sweptVtxos: [],
            });

            const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
            const events: ContractEvent[] = [];
            try {
                await watcher.addContract(contract);
                await watcher.startWatching((e) => events.push(e));

                const event = await waitForReceived(events);
                if (event.type !== "vtxo_received") {
                    throw new Error("unreachable");
                }
                expect(event.vtxos).toHaveLength(1);
                const vtxo = event.vtxos[0];
                expect(vtxo.contractScript).toBe(fakeScript);
                expect(vtxo.forfeitTapLeafScript).toBeUndefined();
                expect(vtxo.intentTapLeafScript).toBeUndefined();
                expect(vtxo.tapTree).toBeUndefined();

                const fallbackWarn = warnSpy.mock.calls.find(
                    (call) => typeof call[0] === "string" && call[0].includes("aabb:7"),
                );
                expect(fallbackWarn).toBeDefined();
            } finally {
                warnSpy.mockRestore();
                await watcher.stopWatching();
            }
        });
    });
});
