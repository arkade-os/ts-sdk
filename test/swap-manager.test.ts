import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SwapManager, SwapManagerConfig } from "../src/swap-manager";
import { BoltzSwapProvider } from "../src/boltz-swap-provider";
import {
    PendingChainSwap,
    PendingReverseSwap,
    PendingSubmarineSwap,
} from "../src/types";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SwapManager", () => {
    let swapProvider: BoltzSwapProvider;
    let mockWebSocket: any;
    let swapManager: SwapManager;

    const swapManagerConfig: SwapManagerConfig = {
        enableAutoActions: true,
    };

    const mockReverseSwap: PendingReverseSwap = {
        id: "reverse-swap-1",
        type: "reverse",
        createdAt: Date.now() / 1000,
        preimage: "0".repeat(64),
        status: "swap.created",
        request: {
            claimPublicKey: "0".repeat(66),
            invoiceAmount: 10000,
            preimageHash: "0".repeat(64),
        },
        response: {
            id: "reverse-swap-1",
            invoice: "lnbc100n1p0",
            onchainAmount: 10000,
            lockupAddress: "ark1test",
            refundPublicKey: "0".repeat(66),
            timeoutBlockHeights: {
                refund: 100,
                unilateralClaim: 200,
                unilateralRefund: 300,
                unilateralRefundWithoutReceiver: 400,
            },
        },
    };

    const mockSubmarineSwap: PendingSubmarineSwap = {
        id: "submarine-swap-1",
        type: "submarine",
        createdAt: Date.now() / 1000,
        status: "invoice.set",
        request: {
            invoice: "lnbc100n1p0",
            refundPublicKey: "0".repeat(66),
        },
        response: {
            id: "submarine-swap-1",
            address: "ark1test",
            expectedAmount: 10000,
            claimPublicKey: "0".repeat(66),
            acceptZeroConf: false,
            timeoutBlockHeights: {
                refund: 100,
                unilateralClaim: 200,
                unilateralRefund: 300,
                unilateralRefundWithoutReceiver: 400,
            },
        },
    };

    const mockChainSwap: PendingChainSwap = {
        id: "chain-swap-1",
        type: "chain",
        createdAt: Math.floor(Date.now() / 1000),
        status: "swap.created",
        preimage: "0".repeat(64),
        ephemeralKey: "0".repeat(64),
        feeSatsPerByte: 1,
        amount: 100000,
        request: {
            from: "ARK",
            to: "BTC",
            userLockAmount: 100000,
            claimPublicKey: "0".repeat(66),
            refundPublicKey: "0".repeat(66),
        },
        response: {
            id: "chain-swap-1",
            claimDetails: {
                amount: 95000,
                lockupAddress: "bc1qtest",
                serverPublicKey: "0".repeat(66),
                timeoutBlockHeight: 500,
                swapTree: {
                    claimLeaf: { version: 192, output: "0".repeat(64) },
                    refundLeaf: { version: 192, output: "0".repeat(64) },
                },
            },
            lockupDetails: {
                amount: 100000,
                lockupAddress: "ark1test",
                serverPublicKey: "0".repeat(66),
                timeoutBlockHeight: 600,
                swapTree: {
                    claimLeaf: { version: 192, output: "0".repeat(64) },
                    refundLeaf: { version: 192, output: "0".repeat(64) },
                },
            },
        },
    };

    /** Create a full SwapManagerCallbacks object with vi.fn() for each callback */
    function makeCallbacks(overrides: Record<string, any> = {}) {
        return {
            claim: vi.fn(),
            refund: vi.fn(),
            claimArk: vi.fn(),
            claimBtc: vi.fn(),
            refundArk: vi.fn(),
            saveSwap: vi.fn(),
            ...overrides,
        };
    }

    beforeEach(() => {
        // Mock WebSocket
        mockWebSocket = {
            send: vi.fn(),
            close: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            readyState: 1, // OPEN
            onerror: null,
            onopen: null,
            onclose: null,
            onmessage: null,
        };

        // Mock WebSocket constructor with static constants
        const MockWebSocketConstructor = vi.fn(() => mockWebSocket) as any;
        MockWebSocketConstructor.CONNECTING = 0;
        MockWebSocketConstructor.OPEN = 1;
        MockWebSocketConstructor.CLOSING = 2;
        MockWebSocketConstructor.CLOSED = 3;
        global.WebSocket = MockWebSocketConstructor;

        swapProvider = new BoltzSwapProvider({
            network: "regtest",
            apiUrl: "http://localhost:9069",
        });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe("Initialization", () => {
        it("should create SwapManager with default config", async () => {
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            expect(swapManager).toBeDefined();
            const stats = await swapManager.getStats();
            expect(stats.isRunning).toBe(false);
        });

        it("should create SwapManager with custom config", () => {
            swapManager = new SwapManager(swapProvider, {
                ...swapManagerConfig,
                enableAutoActions: false,
                pollInterval: 60000,
                reconnectDelayMs: 2000,
            });
            expect(swapManager).toBeDefined();
        });

        it("should accept event callbacks", () => {
            const onSwapUpdate = vi.fn();
            const onSwapCompleted = vi.fn();

            swapManager = new SwapManager(swapProvider, {
                ...swapManagerConfig,
                events: {
                    onSwapUpdate,
                    onSwapCompleted,
                },
            });

            expect(swapManager).toBeDefined();
        });
    });

    describe("Lifecycle", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(makeCallbacks());
        });

        it("should start with empty pending swaps", async () => {
            await swapManager.start([]);

            const stats = await swapManager.getStats();
            expect(stats.isRunning).toBe(true);
            expect(stats.monitoredSwaps).toBe(0);
        });

        it("should start with pending swaps", async () => {
            await swapManager.start([mockReverseSwap, mockSubmarineSwap]);

            const stats = await swapManager.getStats();
            expect(stats.isRunning).toBe(true);
            expect(stats.monitoredSwaps).toBe(2);
        });

        it("should not start if already running", async () => {
            await swapManager.start([]);

            const consoleWarnSpy = vi.spyOn(console, "warn");
            await swapManager.start([]);

            expect(consoleWarnSpy).toHaveBeenCalledWith(
                "SwapManager is already running"
            );
        });

        it("should stop manager", async () => {
            await swapManager.start([mockReverseSwap]);
            await swapManager.stop();

            const stats = await swapManager.getStats();
            expect(stats.isRunning).toBe(false);
        });

        it("should close WebSocket on stop", async () => {
            await swapManager.start([]);
            await swapManager.stop();

            expect(mockWebSocket.close).toHaveBeenCalled();
        });
    });

    describe("WebSocket", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(makeCallbacks());

            // Mock fetch for polling (needed when WebSocket connects)
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            status: "swap.created",
                        }),
                    headers: new Headers({
                        "content-length": "100",
                    }),
                } as Response)
            );
        });

        it("should connect to WebSocket on start", async () => {
            await swapManager.start([]);

            // Trigger onopen callback (it was assigned by SwapManager)
            if (mockWebSocket.onopen) {
                mockWebSocket.onopen();
            }

            // Give async operations time to complete
            await sleep(10);

            const stats = await swapManager.getStats();
            expect(stats.websocketConnected).toBe(true);
        });

        it("should subscribe to all swap IDs", async () => {
            await swapManager.start([mockReverseSwap, mockSubmarineSwap]);

            // Trigger onopen callback (it was assigned by SwapManager)
            if (mockWebSocket.onopen) {
                mockWebSocket.onopen();
            }

            // Give async operations time to complete
            await sleep(10);

            expect(mockWebSocket.send).toHaveBeenCalledWith(
                JSON.stringify({
                    op: "subscribe",
                    channel: "swap.update",
                    args: ["reverse-swap-1"],
                })
            );

            expect(mockWebSocket.send).toHaveBeenCalledWith(
                JSON.stringify({
                    op: "subscribe",
                    channel: "swap.update",
                    args: ["submarine-swap-1"],
                })
            );
        });

        it("should handle WebSocket connection timeout", async () => {
            vi.useFakeTimers();

            await swapManager.start([]);

            // Advance time past connection timeout
            vi.advanceTimersByTime(15000);

            expect(mockWebSocket.close).toHaveBeenCalled();

            vi.useRealTimers();
        });

        it("should fall back to polling on WebSocket error", async () => {
            const onWebSocketDisconnected = vi.fn();
            swapManager = new SwapManager(swapProvider, {
                ...swapManagerConfig,
                events: { onWebSocketDisconnected },
            });
            swapManager.setCallbacks(makeCallbacks());

            await swapManager.start([]);

            // Trigger error
            mockWebSocket.onerror(new Error("Connection failed"));

            const stats = await swapManager.getStats();
            expect(stats.usePollingFallback).toBe(true);
            expect(onWebSocketDisconnected).toHaveBeenCalled();
        });

        it("should reconnect with exponential backoff", async () => {
            vi.useFakeTimers();

            await swapManager.start([]);

            // Trigger onopen then close
            mockWebSocket.onopen();
            mockWebSocket.onclose();

            const stats1 = await swapManager.getStats();
            expect(stats1.currentReconnectDelay).toBeGreaterThan(0);

            // Advance time to trigger reconnect
            vi.advanceTimersByTime(stats1.currentReconnectDelay);

            const stats2 = await swapManager.getStats();
            expect(stats2.currentReconnectDelay).toBeGreaterThanOrEqual(
                stats1.currentReconnectDelay
            );

            vi.useRealTimers();
        });
    });

    describe("Swap Monitoring", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(makeCallbacks());

            // Mock fetch for polling (needed when WebSocket connects)
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            status: "swap.created",
                        }),
                    headers: new Headers({
                        "content-length": "100",
                    }),
                } as Response)
            );
        });

        it("should add swap to monitoring", async () => {
            await swapManager.start([]);

            await swapManager.addSwap(mockReverseSwap);

            const stats = await swapManager.getStats();
            expect(stats.monitoredSwaps).toBe(1);

            const pending = await swapManager.getPendingSwaps();
            expect(pending).toHaveLength(1);
            expect(pending[0].id).toBe("reverse-swap-1");
        });

        it("should remove swap from monitoring", async () => {
            await swapManager.start([mockReverseSwap]);

            await swapManager.removeSwap("reverse-swap-1");

            const stats = await swapManager.getStats();
            expect(stats.monitoredSwaps).toBe(0);
        });

        it("should subscribe to new swap if WebSocket is open", async () => {
            await swapManager.start([]);

            // Trigger onopen callback (it was assigned by SwapManager)
            if (mockWebSocket.onopen) {
                mockWebSocket.onopen();
            }

            // Give async operations time to complete
            await sleep(10);

            await swapManager.addSwap(mockReverseSwap);

            expect(mockWebSocket.send).toHaveBeenCalledWith(
                JSON.stringify({
                    op: "subscribe",
                    channel: "swap.update",
                    args: ["reverse-swap-1"],
                })
            );
        });

        it("should filter out final status swaps on start", async () => {
            const completedSwap: PendingReverseSwap = {
                ...mockReverseSwap,
                status: "invoice.settled",
            };

            await swapManager.start([mockReverseSwap, completedSwap]);

            const stats = await swapManager.getStats();
            // Only mockReverseSwap should be monitored (swap.created)
            expect(stats.monitoredSwaps).toBe(1);
        });
    });

    describe("Status Updates", () => {
        let claimCallback: any;
        let refundCallback: any;
        let saveSwapCallback: any;
        let onSwapUpdate: any;
        let onSwapCompleted: any;
        let onActionExecuted: any;

        beforeEach(() => {
            claimCallback = vi.fn();
            refundCallback = vi.fn();
            saveSwapCallback = vi.fn();
            onSwapUpdate = vi.fn();
            onSwapCompleted = vi.fn();
            onActionExecuted = vi.fn();

            swapManager = new SwapManager(swapProvider, {
                ...swapManagerConfig,
                events: {
                    onSwapUpdate,
                    onSwapCompleted,
                    onActionExecuted,
                },
            });

            swapManager.setCallbacks(
                makeCallbacks({
                    claim: claimCallback,
                    refund: refundCallback,
                    saveSwap: saveSwapCallback,
                })
            );

            // Mock fetch for polling (needed when WebSocket connects)
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            status: "swap.created",
                        }),
                    headers: new Headers({
                        "content-length": "100",
                    }),
                } as Response)
            );
        });

        it("should handle reverse swap status update", async () => {
            await swapManager.start([mockReverseSwap]);
            mockWebSocket.onopen();

            // Simulate WebSocket message
            const message = {
                event: "update",
                args: [
                    {
                        id: "reverse-swap-1",
                        status: "transaction.confirmed",
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            expect(onSwapUpdate).toHaveBeenCalled();
            expect(saveSwapCallback).toHaveBeenCalled();
        });

        it("should auto-claim reverse swap when claimable", async () => {
            await swapManager.start([mockReverseSwap]);
            mockWebSocket.onopen();

            // Simulate status update to claimable
            const message = {
                event: "update",
                args: [
                    {
                        id: "reverse-swap-1",
                        status: "transaction.confirmed",
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            expect(claimCallback).toHaveBeenCalled();
            expect(onActionExecuted).toHaveBeenCalledWith(
                expect.objectContaining({ id: "reverse-swap-1" }),
                "claim"
            );
        });

        it("should auto-refund submarine swap when refundable", async () => {
            const refundableSwap: PendingSubmarineSwap = {
                ...mockSubmarineSwap,
                status: "invoice.set",
            };

            await swapManager.start([refundableSwap]);
            mockWebSocket.onopen();

            // Simulate status update to refundable
            const message = {
                event: "update",
                args: [
                    {
                        id: "submarine-swap-1",
                        status: "invoice.failedToPay",
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            expect(refundCallback).toHaveBeenCalled();
            expect(onActionExecuted).toHaveBeenCalledWith(
                expect.objectContaining({ id: "submarine-swap-1" }),
                "refund"
            );
        });

        it("should remove swap on final status", async () => {
            await swapManager.start([mockReverseSwap]);
            mockWebSocket.onopen();

            // Simulate status update to final
            const message = {
                event: "update",
                args: [
                    {
                        id: "reverse-swap-1",
                        status: "invoice.settled",
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            expect(onSwapCompleted).toHaveBeenCalled();

            const stats = await swapManager.getStats();
            expect(stats.monitoredSwaps).toBe(0);
        });

        it("should not execute action if auto-actions disabled", async () => {
            swapManager = new SwapManager(swapProvider, {
                ...swapManagerConfig,
                enableAutoActions: false,
            });
            swapManager.setCallbacks(
                makeCallbacks({
                    claim: claimCallback,
                    refund: refundCallback,
                    saveSwap: saveSwapCallback,
                })
            );

            await swapManager.start([mockReverseSwap]);
            mockWebSocket.onopen();

            // Simulate status update to claimable
            const message = {
                event: "update",
                args: [
                    {
                        id: "reverse-swap-1",
                        status: "transaction.confirmed",
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            expect(claimCallback).not.toHaveBeenCalled();
        });

        it("should ignore duplicate status updates", async () => {
            await swapManager.start([mockReverseSwap]);
            mockWebSocket.onopen();

            const message = {
                event: "update",
                args: [
                    {
                        id: "reverse-swap-1",
                        status: "swap.created",
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            // Should not emit update for same status
            expect(onSwapUpdate).not.toHaveBeenCalled();
        });

        it("should handle error in WebSocket message", async () => {
            const onSwapFailed = vi.fn();
            swapManager = new SwapManager(swapProvider, {
                ...swapManagerConfig,
                events: { onSwapFailed },
            });
            swapManager.setCallbacks(makeCallbacks());

            await swapManager.start([mockReverseSwap]);

            // Trigger onopen callback
            if (mockWebSocket.onopen) {
                mockWebSocket.onopen();
            }

            // Give async operations time to complete
            await sleep(10);

            const message = {
                event: "update",
                args: [
                    {
                        id: "reverse-swap-1",
                        error: "Swap failed",
                    },
                ],
            };

            // Trigger onmessage callback
            if (mockWebSocket.onmessage) {
                mockWebSocket.onmessage({
                    data: JSON.stringify(message),
                });
            }

            // Give error handler time to execute
            await sleep(10);

            expect(onSwapFailed).toHaveBeenCalled();
        });
    });

    describe("Polling", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(makeCallbacks());

            // Mock fetch for polling
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            status: "swap.created",
                        }),
                    headers: new Headers({
                        "content-length": "100",
                    }),
                } as Response)
            );
        });

        it("should poll all swaps after WebSocket connects", async () => {
            await swapManager.start([mockReverseSwap]);

            // Trigger WebSocket open callback
            if (mockWebSocket.onopen) {
                mockWebSocket.onopen();
            }

            // Give async operations time to complete (including initial poll)
            await sleep(100);

            expect(global.fetch).toHaveBeenCalled();
        });

        it("should use exponential backoff for polling fallback", async () => {
            vi.useFakeTimers();

            swapManager = new SwapManager(swapProvider, {
                ...swapManagerConfig,
                pollRetryDelayMs: 1000,
            });
            swapManager.setCallbacks(makeCallbacks());

            await swapManager.start([mockReverseSwap]);

            // Trigger WebSocket error to enable fallback
            mockWebSocket.onerror(new Error("Connection failed"));

            const stats1 = await swapManager.getStats();
            expect(stats1.usePollingFallback).toBe(true);

            // Advance by initial delay
            await vi.advanceTimersByTimeAsync(1000);

            const stats2 = await swapManager.getStats();
            expect(stats2.currentPollRetryDelay).toBeGreaterThan(1000);

            vi.useRealTimers();
        });
    });

    describe("Per-Swap Subscriptions", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(
                makeCallbacks({
                    claim: vi.fn().mockResolvedValue(undefined),
                    refund: vi.fn().mockResolvedValue(undefined),
                    saveSwap: vi.fn().mockResolvedValue(undefined),
                })
            );
        });

        it("should subscribe to swap updates", async () => {
            // Create a fresh copy to avoid mutations from other tests
            const freshSwap = {
                ...mockSubmarineSwap,
                status: "invoice.set" as const,
            };
            await swapManager.start([freshSwap]);

            // Subscribe to swap updates
            const updateCallback = vi.fn();
            const unsubscribe = await swapManager.subscribeToSwapUpdates(
                "submarine-swap-1",
                updateCallback
            );

            // Trigger a status update
            await swapManager["handleSwapStatusUpdate"](
                freshSwap,
                "transaction.mempool"
            );

            expect(updateCallback).toHaveBeenCalledWith(
                expect.objectContaining({ id: "submarine-swap-1" }),
                "invoice.set"
            );

            unsubscribe();
            await swapManager.stop();
        });

        it("should support multiple subscribers for same swap", async () => {
            // Create a fresh copy to avoid mutations from other tests
            const freshSwap = {
                ...mockSubmarineSwap,
                status: "invoice.set" as const,
            };
            await swapManager.start([freshSwap]);

            // Subscribe two callbacks to the same swap
            const callback1 = vi.fn();
            const callback2 = vi.fn();
            const unsubscribe1 = await swapManager.subscribeToSwapUpdates(
                "submarine-swap-1",
                callback1
            );
            const unsubscribe2 = await swapManager.subscribeToSwapUpdates(
                "submarine-swap-1",
                callback2
            );

            // Trigger a status update
            await swapManager["handleSwapStatusUpdate"](
                freshSwap,
                "transaction.mempool"
            );

            expect(callback1).toHaveBeenCalled();
            expect(callback2).toHaveBeenCalled();

            unsubscribe1();
            unsubscribe2();
            await swapManager.stop();
        });
    });

    describe("Race Condition Prevention", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
        });

        it("should prevent concurrent processing of same swap", async () => {
            const claimCallback = vi.fn().mockImplementation(async () => {
                // Simulate slow claim operation
                await sleep(50);
            });

            // Disable auto actions so we can manually test the locking mechanism
            swapManager = new SwapManager(swapProvider, {
                ...swapManagerConfig,
                enableAutoActions: false,
            });

            swapManager.setCallbacks(
                makeCallbacks({
                    claim: claimCallback,
                    refund: vi.fn().mockResolvedValue(undefined),
                    saveSwap: vi.fn().mockResolvedValue(undefined),
                })
            );

            const claimableSwap = {
                ...mockReverseSwap,
                status: "transaction.confirmed" as const,
            };
            await swapManager.start([claimableSwap]);

            // Check swap is not being processed initially
            expect(await swapManager.isProcessing("reverse-swap-1")).toBe(
                false
            );

            // Trigger first autonomous action (will start processing)
            const promise1 =
                swapManager["executeAutonomousAction"](claimableSwap);

            // Check swap is now being processed
            expect(await swapManager.isProcessing("reverse-swap-1")).toBe(true);

            // Trigger second autonomous action (should be skipped)
            const promise2 =
                swapManager["executeAutonomousAction"](claimableSwap);

            await Promise.all([promise1, promise2]);

            // Claim should only be called once (no race condition)
            expect(claimCallback).toHaveBeenCalledTimes(1);

            // Check swap is no longer being processed
            expect(await swapManager.isProcessing("reverse-swap-1")).toBe(
                false
            );

            await swapManager.stop();
        });

        it("should check if manager has swap", async () => {
            swapManager.setCallbacks(makeCallbacks());

            // Create a fresh copy to avoid mutations from other tests
            const freshSwap = {
                ...mockReverseSwap,
                status: "swap.created" as const,
            };
            await swapManager.start([freshSwap]);

            expect(await swapManager.hasSwap("reverse-swap-1")).toBe(true);
            expect(await swapManager.hasSwap("non-existent-swap")).toBe(false);

            await swapManager.stop();
        });
    });

    describe("Wait for Completion", () => {
        const mockTxId = "abc123def456";

        beforeEach(() => {
            // Mock getReverseSwapTxId to return a mock txid
            vi.spyOn(swapProvider, "getReverseSwapTxId").mockResolvedValue({
                id: mockTxId,
                hex: "0200000001...",
                timeoutBlockHeight: 10,
            });

            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(makeCallbacks());
        });

        it("should wait for reverse swap completion", async () => {
            const confirmedSwap = {
                ...mockReverseSwap,
                status: "transaction.confirmed" as const,
            };
            await swapManager.start([confirmedSwap]);

            // Start waiting for completion
            const waitPromise =
                swapManager.waitForSwapCompletion("reverse-swap-1");

            // Simulate status update to final status
            setTimeout(async () => {
                await swapManager["handleSwapStatusUpdate"](
                    confirmedSwap,
                    "invoice.settled"
                );
            }, 10);

            // Should resolve when swap reaches final status
            const result = await waitPromise;
            expect(result.txid).toBe(mockTxId);
            expect(swapProvider.getReverseSwapTxId).toHaveBeenCalledWith(
                "reverse-swap-1"
            );

            await swapManager.stop();
        });

        it("should reject if swap not found", async () => {
            await swapManager.start([]);

            await expect(
                swapManager.waitForSwapCompletion("non-existent-swap")
            ).rejects.toThrow("Swap non-existent-swap not found in manager");

            await swapManager.stop();
        });

        it("should resolve immediately if swap already completed", async () => {
            const completedSwap = {
                ...mockReverseSwap,
                status: "invoice.settled" as const,
            };
            await swapManager.start([completedSwap]);

            // Should resolve immediately since swap is already in final status
            const result =
                await swapManager.waitForSwapCompletion("reverse-swap-1");
            expect(result.txid).toBe(mockTxId);
            expect(swapProvider.getReverseSwapTxId).toHaveBeenCalledWith(
                "reverse-swap-1"
            );

            await swapManager.stop();
        });

        it("should reject if getReverseSwapTxId fails", async () => {
            vi.spyOn(swapProvider, "getReverseSwapTxId").mockRejectedValue(
                new Error("Failed to fetch txid")
            );

            const completedSwap = {
                ...mockReverseSwap,
                status: "invoice.settled" as const,
            };
            await swapManager.start([completedSwap]);

            await expect(
                swapManager.waitForSwapCompletion("reverse-swap-1")
            ).rejects.toThrow("Failed to fetch txid");

            await swapManager.stop();
        });
    });

    describe("Restored Swaps Validation", () => {
        let claimCallback: ReturnType<typeof vi.fn>;
        let refundCallback: ReturnType<typeof vi.fn>;
        let saveSwapCallback: ReturnType<typeof vi.fn>;

        beforeEach(() => {
            claimCallback = vi.fn();
            refundCallback = vi.fn();
            saveSwapCallback = vi.fn();

            swapManager = new SwapManager(swapProvider, {
                ...swapManagerConfig,
                enableAutoActions: true,
            });
            swapManager.setCallbacks(
                makeCallbacks({
                    claim: claimCallback,
                    refund: refundCallback,
                    saveSwap: saveSwapCallback,
                })
            );

            // Mock fetch for polling
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            status: "swap.created",
                        }),
                    headers: new Headers({
                        "content-length": "100",
                    }),
                } as Response)
            );
        });

        it("should skip claim for restored reverse swap without preimage", async () => {
            const restoredReverseSwap: PendingReverseSwap = {
                ...mockReverseSwap,
                preimage: "", // Empty preimage indicates restored swap
                status: "transaction.confirmed", // Claimable status
            };

            await swapManager.start([restoredReverseSwap]);
            mockWebSocket.onopen();

            // Give async operations time to complete
            await sleep(10);

            // Claim should NOT be called for restored swap without preimage
            expect(claimCallback).not.toHaveBeenCalled();

            await swapManager.stop();
        });

        it("should skip refund for restored submarine swap without invoice", async () => {
            const restoredSubmarineSwap: PendingSubmarineSwap = {
                ...mockSubmarineSwap,
                request: {
                    ...mockSubmarineSwap.request,
                    invoice: "", // Empty invoice indicates restored swap
                },
                status: "invoice.failedToPay", // Refundable status
            };

            await swapManager.start([restoredSubmarineSwap]);
            mockWebSocket.onopen();

            // Give async operations time to complete
            await sleep(10);

            // Refund should NOT be called for restored swap without invoice
            expect(refundCallback).not.toHaveBeenCalled();

            await swapManager.stop();
        });

        it("should claim reverse swap with valid preimage", async () => {
            const validReverseSwap: PendingReverseSwap = {
                ...mockReverseSwap,
                preimage: "0".repeat(64), // Valid preimage
                status: "transaction.confirmed", // Claimable status
            };

            await swapManager.start([validReverseSwap]);
            mockWebSocket.onopen();

            // Give async operations time to complete
            await sleep(10);

            // Claim SHOULD be called for swap with valid preimage
            expect(claimCallback).toHaveBeenCalled();

            await swapManager.stop();
        });

        it("should refund submarine swap with valid invoice", async () => {
            const validSubmarineSwap: PendingSubmarineSwap = {
                ...mockSubmarineSwap,
                request: {
                    ...mockSubmarineSwap.request,
                    invoice: "lnbc100n1p0", // Valid invoice
                },
                status: "invoice.set", // Non-final status initially
            };

            await swapManager.start([validSubmarineSwap]);
            mockWebSocket.onopen();

            // Simulate status update to refundable
            const message = {
                event: "update",
                args: [
                    {
                        id: "submarine-swap-1",
                        status: "invoice.failedToPay", // Refundable status
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            // Give async operations time to complete
            await sleep(10);

            // Refund SHOULD be called for swap with valid invoice
            expect(refundCallback).toHaveBeenCalled();

            await swapManager.stop();
        });

        it("should still monitor restored swaps for status updates", async () => {
            const onSwapUpdate = vi.fn();
            swapManager = new SwapManager(swapProvider, {
                ...swapManagerConfig,
                events: { onSwapUpdate },
            });
            swapManager.setCallbacks(
                makeCallbacks({
                    claim: claimCallback,
                    refund: refundCallback,
                    saveSwap: saveSwapCallback,
                })
            );

            const restoredReverseSwap: PendingReverseSwap = {
                ...mockReverseSwap,
                preimage: "", // Restored swap
                status: "swap.created",
            };

            await swapManager.start([restoredReverseSwap]);
            mockWebSocket.onopen();

            // Simulate status update
            const message = {
                event: "update",
                args: [
                    {
                        id: "reverse-swap-1",
                        status: "transaction.mempool",
                    },
                ],
            };

            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });

            // Status update should still be emitted for monitoring purposes
            expect(onSwapUpdate).toHaveBeenCalled();

            await swapManager.stop();
        });
    });

    describe("Statistics", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(makeCallbacks());

            // Mock fetch for polling (needed when WebSocket connects)
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () =>
                        Promise.resolve({
                            status: "swap.created",
                        }),
                    headers: new Headers({
                        "content-length": "100",
                    }),
                } as Response)
            );
        });

        it("should return correct stats", async () => {
            const stats1 = await swapManager.getStats();
            expect(stats1.isRunning).toBe(false);
            expect(stats1.monitoredSwaps).toBe(0);
            expect(stats1.websocketConnected).toBe(false);

            // Create fresh copies to avoid mutations from other tests
            const freshReverseSwap = {
                ...mockReverseSwap,
                status: "swap.created" as const,
            };
            const freshSubmarineSwap = {
                ...mockSubmarineSwap,
                status: "invoice.set" as const,
            };
            await swapManager.start([freshReverseSwap, freshSubmarineSwap]);

            // Trigger onopen callback
            if (mockWebSocket.onopen) {
                mockWebSocket.onopen();
            }

            // Give async operations time to complete
            await sleep(10);

            const stats2 = await swapManager.getStats();
            expect(stats2.isRunning).toBe(true);
            expect(stats2.monitoredSwaps).toBe(2);
            expect(stats2.websocketConnected).toBe(true);
        });
    });
});
