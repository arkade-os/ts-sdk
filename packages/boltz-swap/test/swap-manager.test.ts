import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SwapManager, SwapManagerClient, SwapManagerConfig } from "../src/swap-manager";
import { BoltzSwapProvider } from "../src/boltz-swap-provider";
import { BoltzChainSwap, BoltzReverseSwap, BoltzSubmarineSwap } from "../src/types";
import { SwapError } from "../src/errors";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SwapManager", () => {
    let swapProvider: BoltzSwapProvider;
    let mockWebSocket: any;
    let swapManager: SwapManager;

    const swapManagerConfig: SwapManagerConfig = {
        enableAutoActions: true,
    };

    const mockReverseSwap: BoltzReverseSwap = {
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

    const mockSubmarineSwap: BoltzSubmarineSwap = {
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

    const mockChainSwap: BoltzChainSwap = {
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
            preimageHash: "0".repeat(64),
            feeSatsPerByte: 1,
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

    afterEach(async () => {
        // Stop the manager to clean up any pending timers (e.g. the
        // delayed initial poll) and prevent leaking into subsequent tests.
        await swapManager?.stop();
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

            expect(consoleWarnSpy).toHaveBeenCalledWith("SwapManager is already running");
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
                } as Response),
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
                }),
            );

            expect(mockWebSocket.send).toHaveBeenCalledWith(
                JSON.stringify({
                    op: "subscribe",
                    channel: "swap.update",
                    args: ["submarine-swap-1"],
                }),
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
                stats1.currentReconnectDelay,
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
                } as Response),
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
                }),
            );
        });

        it("should filter out final status swaps on start", async () => {
            const completedSwap: BoltzReverseSwap = {
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

            // Reset mock swap statuses — tests may mutate them via
            // handleSwapStatusUpdate (which sets swap.status in place).
            mockReverseSwap.status = "swap.created";
            mockSubmarineSwap.status = "swap.created";

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
                }),
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
                } as Response),
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
                "claim",
            );
        });

        it("should auto-refund submarine swap when refundable", async () => {
            const refundableSwap: BoltzSubmarineSwap = {
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
                "refund",
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
                }),
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
                } as Response),
            );
        });

        it("should poll all swaps after WebSocket connects", async () => {
            await swapManager.start([mockReverseSwap]);

            // Trigger WebSocket open callback
            if (mockWebSocket.onopen) {
                mockWebSocket.onopen();
            }

            // Initial poll is delayed 2s after WebSocket connect to avoid
            // hitting Boltz rate limits during startup bursts.
            await sleep(2100);

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
                }),
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
                updateCallback,
            );

            // Trigger a status update
            await swapManager["handleSwapStatusUpdate"](freshSwap, "transaction.mempool");

            expect(updateCallback).toHaveBeenCalledWith(
                expect.objectContaining({ id: "submarine-swap-1" }),
                "invoice.set",
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
                callback1,
            );
            const unsubscribe2 = await swapManager.subscribeToSwapUpdates(
                "submarine-swap-1",
                callback2,
            );

            // Trigger a status update
            await swapManager["handleSwapStatusUpdate"](freshSwap, "transaction.mempool");

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
                }),
            );

            const claimableSwap = {
                ...mockReverseSwap,
                status: "transaction.confirmed" as const,
            };
            await swapManager.start([claimableSwap]);

            // Check swap is not being processed initially
            expect(await swapManager.isProcessing("reverse-swap-1")).toBe(false);

            // Trigger first autonomous action (will start processing)
            const promise1 = swapManager["executeAutonomousAction"](claimableSwap);

            // Check swap is now being processed
            expect(await swapManager.isProcessing("reverse-swap-1")).toBe(true);

            // Trigger second autonomous action (should be skipped)
            const promise2 = swapManager["executeAutonomousAction"](claimableSwap);

            await Promise.all([promise1, promise2]);

            // Claim should only be called once (no race condition)
            expect(claimCallback).toHaveBeenCalledTimes(1);

            // Check swap is no longer being processed
            expect(await swapManager.isProcessing("reverse-swap-1")).toBe(false);

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
            const waitPromise = swapManager.waitForSwapCompletion("reverse-swap-1");

            // Simulate status update to final status
            setTimeout(async () => {
                await swapManager["handleSwapStatusUpdate"](confirmedSwap, "invoice.settled");
            }, 10);

            // Should resolve when swap reaches final status
            const result = await waitPromise;
            expect(result.txid).toBe(mockTxId);
            expect(swapProvider.getReverseSwapTxId).toHaveBeenCalledWith("reverse-swap-1");

            await swapManager.stop();
        });

        it("should reject if swap not found", async () => {
            await swapManager.start([]);

            await expect(swapManager.waitForSwapCompletion("non-existent-swap")).rejects.toThrow(
                "Swap non-existent-swap not found in manager",
            );

            await swapManager.stop();
        });

        it("should resolve immediately if swap already completed", async () => {
            const completedSwap = {
                ...mockReverseSwap,
                status: "invoice.settled" as const,
            };
            await swapManager.start([completedSwap]);

            // Should resolve immediately since swap is already in final status
            const result = await swapManager.waitForSwapCompletion("reverse-swap-1");
            expect(result.txid).toBe(mockTxId);
            expect(swapProvider.getReverseSwapTxId).toHaveBeenCalledWith("reverse-swap-1");

            await swapManager.stop();
        });

        it("should reject if getReverseSwapTxId fails", async () => {
            vi.spyOn(swapProvider, "getReverseSwapTxId").mockRejectedValue(
                new Error("Failed to fetch txid"),
            );

            const completedSwap = {
                ...mockReverseSwap,
                status: "invoice.settled" as const,
            };
            await swapManager.start([completedSwap]);

            await expect(swapManager.waitForSwapCompletion("reverse-swap-1")).rejects.toThrow(
                "Failed to fetch txid",
            );

            await swapManager.stop();
        });

        it("should resolve submarine swap completion with the on-chain txid", async () => {
            vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValue({
                status: "transaction.claimed",
                transaction: { id: mockTxId },
            });
            const pendingSwap = { ...mockSubmarineSwap };
            await swapManager.start([pendingSwap]);

            const waitPromise = swapManager.waitForSwapCompletion("submarine-swap-1");

            // 2nd arg is the *new* status; swap starts at invoice.set.
            setTimeout(async () => {
                await swapManager["handleSwapStatusUpdate"](pendingSwap, "transaction.claimed");
            }, 10);

            const result = await waitPromise;
            expect(result.txid).toBe(mockTxId);
            expect(swapProvider.getSwapStatus).toHaveBeenCalledWith("submarine-swap-1");
            // Regression guard for #509: must not resolve the Boltz swap id.
            expect(result.txid).not.toBe("submarine-swap-1");

            await swapManager.stop();
        });

        it("should resolve chain swap completion with the on-chain txid", async () => {
            vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValue({
                status: "transaction.claimed",
                transaction: { id: mockTxId },
            });
            const pendingSwap = { ...mockChainSwap };
            await swapManager.start([pendingSwap]);

            const waitPromise = swapManager.waitForSwapCompletion("chain-swap-1");

            // 2nd arg is the *new* status; swap starts at swap.created.
            setTimeout(async () => {
                await swapManager["handleSwapStatusUpdate"](pendingSwap, "transaction.claimed");
            }, 10);

            const result = await waitPromise;
            expect(result.txid).toBe(mockTxId);
            expect(swapProvider.getSwapStatus).toHaveBeenCalledWith("chain-swap-1");
            // Regression guard for #509: must not resolve the Boltz swap id.
            expect(result.txid).not.toBe("chain-swap-1");

            await swapManager.stop();
        });

        it("should prefer the claim txid captured from the chain claim callback", async () => {
            // For chain swaps the manager performs the claim itself, so the
            // claim txid is the on-chain completion — it must win over
            // getSwapStatus, which does not surface it at transaction.claimed.
            const claimTxId = "claim-tx-id-deadbeef";
            const getSwapStatus = vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValue({
                status: "transaction.claimed",
                transaction: { id: "status-tx-id-should-not-be-used" },
            });
            // mockChainSwap is ARK→BTC, so the BTC claim runs at the
            // server-confirmed (claimable) status.
            const claimBtc = vi.fn().mockResolvedValue({ txid: claimTxId });
            swapManager.setCallbacks(makeCallbacks({ claimBtc }));

            const pendingSwap = { ...mockChainSwap };
            await swapManager.start([pendingSwap]);

            const waitPromise = swapManager.waitForSwapCompletion("chain-swap-1");

            setTimeout(async () => {
                // Claimable status → manager claims and captures the txid.
                await swapManager["handleSwapStatusUpdate"](
                    pendingSwap,
                    "transaction.server.confirmed",
                );
                // Final status → completion resolves from the captured txid.
                await swapManager["handleSwapStatusUpdate"](pendingSwap, "transaction.claimed");
            }, 10);

            const result = await waitPromise;
            expect(claimBtc).toHaveBeenCalledOnce();
            expect(result.txid).toBe(claimTxId);
            // The captured claim txid wins; the provider status id is ignored.
            expect(getSwapStatus).not.toHaveBeenCalled();

            await swapManager.stop();
        });

        it("should resolve the claim txid when transaction.claimed races an in-flight claim", async () => {
            // Regression: transaction.claimed can arrive while the chain claim
            // is still in-flight (Boltz learns the preimage at the cooperative
            // claim step, before our broadcast returns). Completion must await
            // the claim we started and resolve its txid — not fall back to
            // getSwapStatus, which does not surface the chain claim txid and
            // would reject.
            const claimTxId = "claim-tx-id-racewinner";
            const getSwapStatus = vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValue({
                // No transaction.id: a fallback here would reject.
                status: "transaction.claimed",
            });

            let releaseClaim!: () => void;
            let claimEntered!: () => void;
            const claimStarted = new Promise<void>((resolve) => {
                claimEntered = resolve;
            });
            // The claim blocks until releaseClaim(), modelling a broadcast that
            // has not yet returned its txid when transaction.claimed arrives.
            const claimBtc = vi.fn().mockImplementation(
                () =>
                    new Promise<{ txid: string }>((resolve) => {
                        releaseClaim = () => resolve({ txid: claimTxId });
                        claimEntered();
                    }),
            );
            swapManager.setCallbacks(makeCallbacks({ claimBtc }));

            const pendingSwap = { ...mockChainSwap };
            await swapManager.start([pendingSwap]);

            const waitPromise = swapManager.waitForSwapCompletion("chain-swap-1");

            // Claimable status starts the BTC claim; it blocks (still in-flight).
            const claimableUpdate = swapManager["handleSwapStatusUpdate"](
                pendingSwap,
                "transaction.server.confirmed",
            );
            await claimStarted; // claim started and its promise was captured

            // transaction.claimed arrives mid-claim and drives completion.
            const claimedUpdate = swapManager["handleSwapStatusUpdate"](
                pendingSwap,
                "transaction.claimed",
            );

            releaseClaim(); // claim broadcast returns its txid
            await Promise.all([claimableUpdate, claimedUpdate]);

            const result = await waitPromise;
            expect(claimBtc).toHaveBeenCalledOnce();
            expect(result.txid).toBe(claimTxId);
            // Completion awaited the in-flight claim, not the provider status.
            expect(getSwapStatus).not.toHaveBeenCalled();

            await swapManager.stop();
        });

        it("should reject if a claimed swap has no transaction id", async () => {
            vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValue({
                status: "transaction.claimed",
            });
            const pendingSwap = { ...mockSubmarineSwap };
            await swapManager.start([pendingSwap]);

            const waitPromise = swapManager.waitForSwapCompletion("submarine-swap-1");

            setTimeout(async () => {
                await swapManager["handleSwapStatusUpdate"](pendingSwap, "transaction.claimed");
            }, 10);

            await expect(waitPromise).rejects.toThrow(
                "Transaction ID not available for completed swap submarine-swap-1",
            );

            await swapManager.stop();
        });

        it("should reject when a swap reaches a failed final status", async () => {
            const pendingSwap = { ...mockSubmarineSwap };
            await swapManager.start([pendingSwap]);

            const waitPromise = swapManager.waitForSwapCompletion("submarine-swap-1");

            setTimeout(async () => {
                await swapManager["handleSwapStatusUpdate"](pendingSwap, "swap.expired");
            }, 10);

            await expect(waitPromise).rejects.toThrow("Swap failed with status: swap.expired");

            await swapManager.stop();
        });

        it("should return the txid for an already-claimed submarine swap", async () => {
            vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValue({
                status: "transaction.claimed",
                transaction: { id: mockTxId },
            });
            const completedSwap = {
                ...mockSubmarineSwap,
                status: "transaction.claimed" as const,
            };
            await swapManager.start([completedSwap]);

            const result = await swapManager.waitForSwapCompletion("submarine-swap-1");
            expect(result.txid).toBe(mockTxId);
            expect(swapProvider.getSwapStatus).toHaveBeenCalledWith("submarine-swap-1");
            expect(result.txid).not.toBe("submarine-swap-1");

            await swapManager.stop();
        });

        it("should return the txid for an already-claimed chain swap", async () => {
            vi.spyOn(swapProvider, "getSwapStatus").mockResolvedValue({
                status: "transaction.claimed",
                transaction: { id: mockTxId },
            });
            const completedSwap = {
                ...mockChainSwap,
                status: "transaction.claimed" as const,
            };
            await swapManager.start([completedSwap]);

            const result = await swapManager.waitForSwapCompletion("chain-swap-1");
            expect(result.txid).toBe(mockTxId);
            expect(swapProvider.getSwapStatus).toHaveBeenCalledWith("chain-swap-1");
            expect(result.txid).not.toBe("chain-swap-1");

            await swapManager.stop();
        });

        it("should throw for an already-final swap that did not claim", async () => {
            const expiredSwap = {
                ...mockSubmarineSwap,
                status: "swap.expired" as const,
            };
            await swapManager.start([expiredSwap]);

            await expect(swapManager.waitForSwapCompletion("submarine-swap-1")).rejects.toThrow(
                "already in final status: swap.expired",
            );

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
                }),
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
                } as Response),
            );
        });

        it("should skip claim for restored reverse swap without preimage", async () => {
            const restoredReverseSwap: BoltzReverseSwap = {
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
            const restoredSubmarineSwap: BoltzSubmarineSwap = {
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
            const validReverseSwap: BoltzReverseSwap = {
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
            const validSubmarineSwap: BoltzSubmarineSwap = {
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
                }),
            );

            const restoredReverseSwap: BoltzReverseSwap = {
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
                } as Response),
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

    /**
     * Safety net for swaps that have become unknown to the configured Boltz
     * instance — typically because the operator switched the API URL to a
     * different Boltz instance. Without it, the polling loop would 404 on
     * every interval forever, generating server load and log noise. After
     * 10 consecutive `getSwapStatus` 404s the swap is transitioned to
     * `swap.expired` (terminal) and dropped from monitoring.
     */
    describe("Unknown to Boltz (404 safety net)", () => {
        const NOT_FOUND_THRESHOLD = 10;

        function stubSwapNotFound() {
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: false,
                    status: 404,
                    text: () =>
                        Promise.resolve(
                            JSON.stringify({
                                error: "could not find swap with id: any",
                            }),
                        ),
                    headers: { get: () => null },
                } as unknown as Response),
            );
        }

        function stubSwapStatusOk(status = "swap.created") {
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ status }),
                    headers: new Headers({ "content-length": "100" }),
                } as Response),
            );
        }

        beforeEach(() => {
            swapManager = new SwapManager(swapProvider, {
                ...swapManagerConfig,
                enableAutoActions: false, // we don't want auto refund/claim noise here
            });
            swapManager.setCallbacks(makeCallbacks());
        });

        it("trips after threshold, persists swap.expired, removes from monitoring, fires onSwapFailed", async () => {
            const onSwapFailed = vi.fn();
            const saveSwap = vi.fn().mockResolvedValue(undefined);
            swapManager.setCallbacks(makeCallbacks({ saveSwap }));
            await swapManager.onSwapFailed(onSwapFailed);

            const swap = {
                ...mockReverseSwap,
                status: "swap.created" as const,
            };
            await swapManager.start([swap]);

            stubSwapNotFound();

            // Drive `pollAllSwaps` exactly THRESHOLD times. Each call should
            // increment the counter; the THRESHOLD-th call trips the safety
            // net and removes the swap.
            for (let i = 0; i < NOT_FOUND_THRESHOLD; i++) {
                await (swapManager as any).pollAllSwaps();
            }

            const stats = await swapManager.getStats();
            expect(stats.monitoredSwaps).toBe(0);

            expect(saveSwap).toHaveBeenCalled();
            const persisted = saveSwap.mock.calls.at(-1)![0];
            expect(persisted.id).toBe(swap.id);
            expect(persisted.status).toBe("swap.expired");

            expect(onSwapFailed).toHaveBeenCalledTimes(1);
            const [failedSwap, failedError] = onSwapFailed.mock.calls[0];
            expect(failedSwap.id).toBe(swap.id);
            expect(failedError.name).toBe("SwapNotFoundError");
            expect(failedError.swapId).toBe(swap.id);
        });

        it("does not trip below threshold", async () => {
            const onSwapFailed = vi.fn();
            const saveSwap = vi.fn().mockResolvedValue(undefined);
            swapManager.setCallbacks(makeCallbacks({ saveSwap }));
            await swapManager.onSwapFailed(onSwapFailed);

            const swap = {
                ...mockReverseSwap,
                status: "swap.created" as const,
            };
            await swapManager.start([swap]);

            stubSwapNotFound();

            for (let i = 0; i < NOT_FOUND_THRESHOLD - 1; i++) {
                await (swapManager as any).pollAllSwaps();
            }

            const stats = await swapManager.getStats();
            expect(stats.monitoredSwaps).toBe(1);
            expect(saveSwap).not.toHaveBeenCalled();
            expect(onSwapFailed).not.toHaveBeenCalled();
        });

        it("settles waitForSwapCompletion when the safety net trips", async () => {
            // Regression: markSwapAsUnknownToProvider used to delete the
            // per-swap subscriber set before emitting anything. Awaiters
            // registered via subscribeToSwapUpdates (waitForSwapCompletion,
            // waitAndClaim*, etc.) would hang forever after the trip.
            const saveSwap = vi.fn().mockResolvedValue(undefined);
            swapManager.setCallbacks(makeCallbacks({ saveSwap }));

            const swap = {
                ...mockSubmarineSwap,
                status: "invoice.set" as const,
            };
            await swapManager.start([swap]);

            const completion = swapManager.waitForSwapCompletion(swap.id);

            stubSwapNotFound();
            for (let i = 0; i < NOT_FOUND_THRESHOLD; i++) {
                await (swapManager as any).pollAllSwaps();
            }

            await expect(completion).rejects.toThrow(/swap\.expired/);
        });

        it("notifies per-swap subscribers with the terminal status", async () => {
            const saveSwap = vi.fn().mockResolvedValue(undefined);
            swapManager.setCallbacks(makeCallbacks({ saveSwap }));

            const swap = {
                ...mockReverseSwap,
                status: "swap.created" as const,
            };
            await swapManager.start([swap]);

            const subscriber = vi.fn();
            await swapManager.subscribeToSwapUpdates(swap.id, subscriber);

            stubSwapNotFound();
            for (let i = 0; i < NOT_FOUND_THRESHOLD; i++) {
                await (swapManager as any).pollAllSwaps();
            }

            expect(subscriber).toHaveBeenCalledTimes(1);
            const [updatedSwap, oldStatus] = subscriber.mock.calls[0];
            expect(updatedSwap.id).toBe(swap.id);
            expect(updatedSwap.status).toBe("swap.expired");
            expect(oldStatus).toBe("swap.created");
        });

        it("resets counter on a successful poll", async () => {
            const onSwapFailed = vi.fn();
            const saveSwap = vi.fn().mockResolvedValue(undefined);
            swapManager.setCallbacks(makeCallbacks({ saveSwap }));
            await swapManager.onSwapFailed(onSwapFailed);

            const swap = {
                ...mockReverseSwap,
                status: "swap.created" as const,
            };
            await swapManager.start([swap]);

            // 9 consecutive 404s.
            stubSwapNotFound();
            for (let i = 0; i < NOT_FOUND_THRESHOLD - 1; i++) {
                await (swapManager as any).pollAllSwaps();
            }

            // One successful poll should clear the counter — no status change
            // here so the swap is not promoted, but the counter resets.
            stubSwapStatusOk("swap.created");
            await (swapManager as any).pollAllSwaps();

            // Now back to 404. With the counter reset, a single 404 must NOT
            // trip the safety net.
            stubSwapNotFound();
            await (swapManager as any).pollAllSwaps();

            const stats = await swapManager.getStats();
            expect(stats.monitoredSwaps).toBe(1);
            expect(saveSwap).not.toHaveBeenCalled();
            expect(onSwapFailed).not.toHaveBeenCalled();
        });
    });

    describe("Chain refund partial-outcome retry", () => {
        const refundableChainSwap: BoltzChainSwap = {
            ...mockChainSwap,
            status: "swap.expired",
        };

        const triggerSwapExpired = async () => {
            const message = {
                event: "update",
                args: [
                    {
                        id: refundableChainSwap.id,
                        status: "swap.expired",
                    },
                ],
            };
            await mockWebSocket.onmessage({
                data: JSON.stringify(message),
            });
        };

        beforeEach(() => {
            // The WebSocket `onopen` handler schedules an initial poll that
            // calls `global.fetch` via `getSwapStatus`. Stub it here so the
            // suite never depends on a fetch mock leaked from another block
            // (or hits the real network), keeping these tests order-
            // independent. The swaps are `swap.expired` once monitored, so
            // returning that status makes every poll a no-op.
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ status: "swap.expired" }),
                    headers: new Headers({ "content-length": "100" }),
                } as Response),
            );
        });

        afterEach(() => {
            delete (global as { fetch?: unknown }).fetch;
        });

        it("keeps the swap monitored and schedules a retry when refundArk reports skipped > 0", async () => {
            vi.useFakeTimers();
            try {
                const refundArk = vi.fn().mockResolvedValueOnce({ swept: 0, skipped: 2 });
                const onSwapCompleted = vi.fn();
                swapManager = new SwapManager(swapProvider, {
                    ...swapManagerConfig,
                    events: { onSwapCompleted },
                });
                swapManager.setCallbacks(
                    makeCallbacks({
                        refundArk,
                        saveSwap: vi.fn(),
                    }),
                );

                await swapManager.start([{ ...refundableChainSwap, status: "swap.created" }]);
                mockWebSocket.onopen();
                await triggerSwapExpired();

                expect(refundArk).toHaveBeenCalledTimes(1);
                const stats = await swapManager.getStats();
                expect(stats.monitoredSwaps).toBe(1);
                expect(onSwapCompleted).not.toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        });

        it("re-invokes refundArk after the retry delay until it sweeps the remaining VTXOs", async () => {
            vi.useFakeTimers();
            try {
                const refundArk = vi
                    .fn()
                    .mockResolvedValueOnce({ swept: 0, skipped: 1 })
                    .mockResolvedValueOnce({ swept: 1, skipped: 0 });
                const onSwapCompleted = vi.fn();
                swapManager = new SwapManager(swapProvider, {
                    ...swapManagerConfig,
                    events: { onSwapCompleted },
                });
                swapManager.setCallbacks(
                    makeCallbacks({
                        refundArk,
                        saveSwap: vi.fn(),
                    }),
                );

                await swapManager.start([{ ...refundableChainSwap, status: "swap.created" }]);
                mockWebSocket.onopen();
                await triggerSwapExpired();

                // Advance just past the retry delay (60s). The retry callback
                // then awaits refundArk and finalizes monitoring cleanup.
                await vi.advanceTimersByTimeAsync(60_001);

                expect(refundArk).toHaveBeenCalledTimes(2);
                const stats = await swapManager.getStats();
                expect(stats.monitoredSwaps).toBe(0);
                expect(onSwapCompleted).toHaveBeenCalledTimes(1);
            } finally {
                vi.useRealTimers();
            }
        });

        it("removes the swap immediately and emits completed when refundArk reports no skipped VTXOs", async () => {
            const refundArk = vi.fn().mockResolvedValue({
                swept: 1,
                skipped: 0,
            });
            const onSwapCompleted = vi.fn();
            swapManager = new SwapManager(swapProvider, {
                ...swapManagerConfig,
                events: { onSwapCompleted },
            });
            swapManager.setCallbacks(
                makeCallbacks({
                    refundArk,
                    saveSwap: vi.fn(),
                }),
            );

            await swapManager.start([{ ...refundableChainSwap, status: "swap.created" }]);
            mockWebSocket.onopen();
            await triggerSwapExpired();

            expect(refundArk).toHaveBeenCalledTimes(1);
            const stats = await swapManager.getStats();
            expect(stats.monitoredSwaps).toBe(0);
            expect(onSwapCompleted).toHaveBeenCalledTimes(1);
        });

        it("clears the pending retry on stop()", async () => {
            vi.useFakeTimers();
            try {
                const refundArk = vi.fn().mockResolvedValueOnce({ swept: 0, skipped: 1 });
                swapManager = new SwapManager(swapProvider, swapManagerConfig);
                swapManager.setCallbacks(
                    makeCallbacks({
                        refundArk,
                        saveSwap: vi.fn(),
                    }),
                );

                await swapManager.start([{ ...refundableChainSwap, status: "swap.created" }]);
                mockWebSocket.onopen();
                await triggerSwapExpired();

                expect(refundArk).toHaveBeenCalledTimes(1);

                await swapManager.stop();
                // Past the retry deadline, no further refundArk calls land.
                await vi.advanceTimersByTimeAsync(120_000);
                expect(refundArk).toHaveBeenCalledTimes(1);
            } finally {
                vi.useRealTimers();
            }
        });

        it("clears the pending retry on removeSwap()", async () => {
            vi.useFakeTimers();
            try {
                const refundArk = vi.fn().mockResolvedValueOnce({ swept: 0, skipped: 1 });
                swapManager = new SwapManager(swapProvider, swapManagerConfig);
                swapManager.setCallbacks(
                    makeCallbacks({
                        refundArk,
                        saveSwap: vi.fn(),
                    }),
                );

                await swapManager.start([{ ...refundableChainSwap, status: "swap.created" }]);
                mockWebSocket.onopen();
                await triggerSwapExpired();

                expect(refundArk).toHaveBeenCalledTimes(1);
                await swapManager.removeSwap(refundableChainSwap.id);

                await vi.advanceTimersByTimeAsync(120_000);
                // Timer was cancelled — no second call.
                expect(refundArk).toHaveBeenCalledTimes(1);
            } finally {
                vi.useRealTimers();
            }
        });

        it("keeps the swap monitored and schedules a retry when refundArk throws", async () => {
            vi.useFakeTimers();
            try {
                const refundArk = vi
                    .fn()
                    .mockRejectedValueOnce(new Error("transient refund error"))
                    .mockResolvedValueOnce({ swept: 1, skipped: 0 });
                const onSwapCompleted = vi.fn();
                const onSwapFailed = vi.fn();
                swapManager = new SwapManager(swapProvider, {
                    ...swapManagerConfig,
                    events: { onSwapCompleted, onSwapFailed },
                });
                swapManager.setCallbacks(
                    makeCallbacks({
                        refundArk,
                        saveSwap: vi.fn(),
                    }),
                );

                await swapManager.start([{ ...refundableChainSwap, status: "swap.created" }]);
                mockWebSocket.onopen();
                await triggerSwapExpired();

                // Throw on the initial attempt: emit swapFailed but keep
                // the swap monitored — a transient refund failure must
                // not drop funds.
                expect(refundArk).toHaveBeenCalledTimes(1);
                expect(onSwapFailed).toHaveBeenCalledTimes(1);
                const statsAfterThrow = await swapManager.getStats();
                expect(statsAfterThrow.monitoredSwaps).toBe(1);
                expect(onSwapCompleted).not.toHaveBeenCalled();

                await vi.advanceTimersByTimeAsync(60_001);

                expect(refundArk).toHaveBeenCalledTimes(2);
                const stats = await swapManager.getStats();
                expect(stats.monitoredSwaps).toBe(0);
                expect(onSwapCompleted).toHaveBeenCalledTimes(1);
            } finally {
                vi.useRealTimers();
            }
        });

        it("re-schedules indefinitely while refundArk keeps throwing", async () => {
            vi.useFakeTimers();
            try {
                const refundArk = vi
                    .fn()
                    .mockRejectedValueOnce(new Error("transient 1"))
                    .mockRejectedValueOnce(new Error("transient 2"))
                    .mockResolvedValueOnce({ swept: 1, skipped: 0 });
                const onSwapCompleted = vi.fn();
                swapManager = new SwapManager(swapProvider, {
                    ...swapManagerConfig,
                    events: { onSwapCompleted },
                });
                swapManager.setCallbacks(
                    makeCallbacks({
                        refundArk,
                        saveSwap: vi.fn(),
                    }),
                );

                await swapManager.start([{ ...refundableChainSwap, status: "swap.created" }]);
                mockWebSocket.onopen();
                await triggerSwapExpired();

                // First throw → swap monitored, retry scheduled.
                expect(refundArk).toHaveBeenCalledTimes(1);

                // Second throw after the first retry delay → still monitored.
                await vi.advanceTimersByTimeAsync(60_001);
                expect(refundArk).toHaveBeenCalledTimes(2);
                const statsAfterSecond = await swapManager.getStats();
                expect(statsAfterSecond.monitoredSwaps).toBe(1);

                // Third call succeeds → swap dropped + completion emitted.
                await vi.advanceTimersByTimeAsync(60_001);
                expect(refundArk).toHaveBeenCalledTimes(3);
                const stats = await swapManager.getStats();
                expect(stats.monitoredSwaps).toBe(0);
                expect(onSwapCompleted).toHaveBeenCalledTimes(1);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe("Action Log", () => {
        beforeEach(() => {
            // Mock fetch for polling (needed once the WebSocket connects).
            global.fetch = vi.fn(() =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ status: "swap.created" }),
                    headers: new Headers({ "content-length": "100" }),
                } as Response),
            );
        });

        it("records the swapId in claimed after a successful reverse claim", async () => {
            const claimCallback = vi.fn();
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(makeCallbacks({ claim: claimCallback }));

            await swapManager.start([{ ...mockReverseSwap, status: "swap.created" }]);
            mockWebSocket.onopen();

            await mockWebSocket.onmessage({
                data: JSON.stringify({
                    event: "update",
                    args: [{ id: "reverse-swap-1", status: "transaction.confirmed" }],
                }),
            });

            expect(claimCallback).toHaveBeenCalled();
            const log = swapManager.getActionLog();
            expect(log.claimed.has("reverse-swap-1")).toBe(true);
            expect(log.refunded.has("reverse-swap-1")).toBe(false);
        });

        it("records the swapId in refunded after a successful submarine refund", async () => {
            const refundCallback = vi.fn();
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(makeCallbacks({ refund: refundCallback }));

            const refundableSwap: BoltzSubmarineSwap = {
                ...mockSubmarineSwap,
                status: "invoice.set",
            };
            await swapManager.start([refundableSwap]);
            mockWebSocket.onopen();

            await mockWebSocket.onmessage({
                data: JSON.stringify({
                    event: "update",
                    args: [{ id: "submarine-swap-1", status: "invoice.failedToPay" }],
                }),
            });

            expect(refundCallback).toHaveBeenCalled();
            const log = swapManager.getActionLog();
            expect(log.refunded.has("submarine-swap-1")).toBe(true);
            expect(log.claimed.has("submarine-swap-1")).toBe(false);
        });

        it("records the swapId in claimed after a successful chain ARK claim (BTC->ARK)", async () => {
            const claimArk = vi.fn();
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(makeCallbacks({ claimArk }));

            const btcToArkSwap: BoltzChainSwap = {
                ...mockChainSwap,
                status: "swap.created",
                request: { ...mockChainSwap.request, from: "BTC", to: "ARK" },
            };
            await swapManager.start([btcToArkSwap]);
            mockWebSocket.onopen();

            await mockWebSocket.onmessage({
                data: JSON.stringify({
                    event: "update",
                    args: [{ id: btcToArkSwap.id, status: "transaction.server.mempool" }],
                }),
            });

            expect(claimArk).toHaveBeenCalled();
            expect(swapManager.getActionLog().claimed.has(btcToArkSwap.id)).toBe(true);
        });

        it("records the swapId in claimed after a successful chain BTC claim (ARK->BTC)", async () => {
            const claimBtc = vi.fn();
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(makeCallbacks({ claimBtc }));

            // mockChainSwap.request is already {from: "ARK", to: "BTC"}.
            const arkToBtcSwap: BoltzChainSwap = { ...mockChainSwap, status: "swap.created" };
            await swapManager.start([arkToBtcSwap]);
            mockWebSocket.onopen();

            await mockWebSocket.onmessage({
                data: JSON.stringify({
                    event: "update",
                    args: [{ id: arkToBtcSwap.id, status: "transaction.server.mempool" }],
                }),
            });

            expect(claimBtc).toHaveBeenCalled();
            expect(swapManager.getActionLog().claimed.has(arkToBtcSwap.id)).toBe(true);
        });

        it("records the swapId in refunded when refundArk fully sweeps (skipped: 0)", async () => {
            const refundArk = vi.fn().mockResolvedValue({ swept: 1, skipped: 0 });
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(makeCallbacks({ refundArk, saveSwap: vi.fn() }));

            const arkToBtcSwap: BoltzChainSwap = { ...mockChainSwap, status: "swap.created" };
            await swapManager.start([arkToBtcSwap]);
            mockWebSocket.onopen();

            await mockWebSocket.onmessage({
                data: JSON.stringify({
                    event: "update",
                    args: [{ id: arkToBtcSwap.id, status: "swap.expired" }],
                }),
            });

            expect(refundArk).toHaveBeenCalled();
            expect(swapManager.getActionLog().refunded.has(arkToBtcSwap.id)).toBe(true);
        });

        it("does NOT record when refundArk reports a partial sweep (skipped > 0)", async () => {
            const refundArk = vi.fn().mockResolvedValue({ swept: 0, skipped: 2 });
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(makeCallbacks({ refundArk, saveSwap: vi.fn() }));

            const arkToBtcSwap: BoltzChainSwap = { ...mockChainSwap, status: "swap.created" };
            await swapManager.start([arkToBtcSwap]);
            mockWebSocket.onopen();

            await mockWebSocket.onmessage({
                data: JSON.stringify({
                    event: "update",
                    args: [{ id: arkToBtcSwap.id, status: "swap.expired" }],
                }),
            });

            expect(refundArk).toHaveBeenCalled();
            expect(swapManager.getActionLog().refunded.has(arkToBtcSwap.id)).toBe(false);
        });

        it("does not record when the claim callback is not set (skipped)", async () => {
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            // setCallbacks() intentionally never called — claimCallback stays null.

            await swapManager.start([{ ...mockReverseSwap, status: "swap.created" }]);
            mockWebSocket.onopen();

            await mockWebSocket.onmessage({
                data: JSON.stringify({
                    event: "update",
                    args: [{ id: "reverse-swap-1", status: "transaction.confirmed" }],
                }),
            });

            expect(swapManager.getActionLog().claimed.has("reverse-swap-1")).toBe(false);
        });

        it("does not record when the claim callback throws", async () => {
            const claimCallback = vi.fn().mockRejectedValue(new Error("claim failed"));
            const onSwapFailed = vi.fn();
            swapManager = new SwapManager(swapProvider, {
                ...swapManagerConfig,
                events: { onSwapFailed },
            });
            swapManager.setCallbacks(makeCallbacks({ claim: claimCallback }));

            await swapManager.start([{ ...mockReverseSwap, status: "swap.created" }]);
            mockWebSocket.onopen();

            await mockWebSocket.onmessage({
                data: JSON.stringify({
                    event: "update",
                    args: [{ id: "reverse-swap-1", status: "transaction.confirmed" }],
                }),
            });

            expect(claimCallback).toHaveBeenCalled();
            expect(onSwapFailed).toHaveBeenCalled();
            expect(swapManager.getActionLog().claimed.has("reverse-swap-1")).toBe(false);
        });
    });

    /**
     * `resolveSwapFromVtxo` is the SwapManager-side hook a `SwapStatusReconciler`
     * calls (as `onSwapResolved`) once a VTXO event derives a swap's terminal
     * `SwapState` — see swap-status-reconciler.ts. Unlike the Boltz-status-driven
     * finalize path, it never touches `swap.status`.
     */
    describe("resolveSwapFromVtxo (VTXO-driven finalize)", () => {
        beforeEach(() => {
            swapManager = new SwapManager(swapProvider, swapManagerConfig);
            swapManager.setCallbacks(makeCallbacks());
        });

        it("exposes getActionLog on the SwapManagerClient interface (M2)", () => {
            const client: SwapManagerClient = swapManager;
            const log = client.getActionLog();
            expect(log.claimed).toBeInstanceOf(Set);
            expect(log.refunded).toBeInstanceOf(Set);
        });

        it("finalizes on Settled: removes from monitoring and fires onSwapCompleted", async () => {
            const onSwapCompleted = vi.fn();
            await swapManager.onSwapCompleted(onSwapCompleted);

            const swap = { ...mockReverseSwap, status: "swap.created" as const };
            await swapManager.start([swap]);
            expect(await swapManager.hasSwap(swap.id)).toBe(true);

            swapManager.resolveSwapFromVtxo(swap, "Settled");

            expect(await swapManager.hasSwap(swap.id)).toBe(false);
            expect(onSwapCompleted).toHaveBeenCalledWith(swap);
        });

        it("finalizes on Refunded: removes from monitoring and fires onSwapCompleted", async () => {
            const onSwapCompleted = vi.fn();
            await swapManager.onSwapCompleted(onSwapCompleted);

            const swap = { ...mockSubmarineSwap, status: "invoice.set" as const };
            await swapManager.start([swap]);

            swapManager.resolveSwapFromVtxo(swap, "Refunded");

            expect(await swapManager.hasSwap(swap.id)).toBe(false);
            expect(onSwapCompleted).toHaveBeenCalledWith(swap);
        });

        it("finalizes on Failed: removes from monitoring and fires onSwapFailed with a SwapError", async () => {
            const onSwapFailed = vi.fn();
            await swapManager.onSwapFailed(onSwapFailed);

            const swap = { ...mockReverseSwap, status: "swap.created" as const };
            await swapManager.start([swap]);

            swapManager.resolveSwapFromVtxo(swap, "Failed");

            expect(await swapManager.hasSwap(swap.id)).toBe(false);
            expect(onSwapFailed).toHaveBeenCalledTimes(1);
            const [failedSwap, error] = onSwapFailed.mock.calls[0];
            expect(failedSwap).toBe(swap);
            expect(error).toBeInstanceOf(SwapError);
            expect((error as Error).message).toContain(swap.id);
        });

        it("is idempotent: a second call after finalization is a no-op", async () => {
            const onSwapCompleted = vi.fn();
            await swapManager.onSwapCompleted(onSwapCompleted);

            const swap = { ...mockReverseSwap, status: "swap.created" as const };
            await swapManager.start([swap]);

            swapManager.resolveSwapFromVtxo(swap, "Settled");
            swapManager.resolveSwapFromVtxo(swap, "Settled");

            expect(onSwapCompleted).toHaveBeenCalledTimes(1);
        });

        it("does not act on a swap the manager never monitored", async () => {
            const onSwapCompleted = vi.fn();
            const onSwapFailed = vi.fn();
            await swapManager.onSwapCompleted(onSwapCompleted);
            await swapManager.onSwapFailed(onSwapFailed);

            // Note: swap is never passed to start(), so it's not in monitoredSwaps.
            const swap = { ...mockReverseSwap, status: "swap.created" as const };

            swapManager.resolveSwapFromVtxo(swap, "Settled");

            expect(onSwapCompleted).not.toHaveBeenCalled();
            expect(onSwapFailed).not.toHaveBeenCalled();
        });

        it("does not finalize while executeAutonomousAction is mid-flight (swapsInProgress guard)", async () => {
            const onSwapCompleted = vi.fn();
            await swapManager.onSwapCompleted(onSwapCompleted);

            const swap = { ...mockReverseSwap, status: "swap.created" as const };
            await swapManager.start([swap]);

            // Simulate an in-progress autonomous action without actually running one.
            (swapManager as any).swapsInProgress.add(swap.id);

            swapManager.resolveSwapFromVtxo(swap, "Settled");

            expect(await swapManager.hasSwap(swap.id)).toBe(true);
            expect(onSwapCompleted).not.toHaveBeenCalled();
        });

        it("ignores a non-terminal derived state", async () => {
            const onSwapCompleted = vi.fn();
            const onSwapFailed = vi.fn();
            await swapManager.onSwapCompleted(onSwapCompleted);
            await swapManager.onSwapFailed(onSwapFailed);

            const swap = { ...mockReverseSwap, status: "swap.created" as const };
            await swapManager.start([swap]);

            swapManager.resolveSwapFromVtxo(swap, "Pending");

            expect(await swapManager.hasSwap(swap.id)).toBe(true);
            expect(onSwapCompleted).not.toHaveBeenCalled();
            expect(onSwapFailed).not.toHaveBeenCalled();
        });
    });
});
