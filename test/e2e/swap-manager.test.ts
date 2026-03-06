import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { ArkadeSwaps } from "../../src/arkade-swaps";
import {
    RestIndexerProvider,
    RestArkProvider,
    Identity,
    Wallet,
    SingleKey,
    EsploraProvider,
} from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { pubECDSA } from "@scure/btc-signer/utils.js";
import { BoltzSwapProvider } from "../../src";

describe("SwapManager", () => {
    let swapManagerInstance: ArkadeSwaps;
    let indexerProvider: RestIndexerProvider;
    let swapProvider: BoltzSwapProvider;
    let arkProvider: RestArkProvider;
    let swaps: ArkadeSwaps;
    let identity: Identity;
    let wallet: Wallet;

    let aliceSecKey: Uint8Array;
    let aliceCompressedPubKey: string;

    beforeEach(async () => {
        const arkUrl = "http://localhost:7070";

        // Create identity
        aliceSecKey = schnorr.utils.randomSecretKey();
        aliceCompressedPubKey = hex.encode(pubECDSA(aliceSecKey, true));
        identity = SingleKey.fromPrivateKey(aliceSecKey);

        // Create providers
        arkProvider = new RestArkProvider(arkUrl);
        indexerProvider = new RestIndexerProvider(arkUrl);
        swapProvider = new BoltzSwapProvider({ network: "regtest" });

        // Create wallet
        wallet = await Wallet.create({
            identity,
            arkServerUrl: arkUrl,
            onchainProvider: new EsploraProvider("http://localhost:3000", {
                forcePolling: true,
                pollingInterval: 2000,
            }),
        });

        // Create ArkadeSwaps instance
        swaps = new ArkadeSwaps({
            wallet,
            swapProvider,
            arkProvider,
            indexerProvider,
        });

        // Mock console.error to avoid polluting test output
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(async () => {
        // Clean up swap manager after each test
        if (swapManagerInstance) {
            await swapManagerInstance.stopSwapManager();
        }
    });

    describe("Initialization with SwapManager", () => {
        it("should instantiate with swapManager enabled (boolean true)", () => {
            // act
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: true,
            });

            // assert
            expect(swapManagerInstance.getSwapManager()).not.toBeNull();
        });

        it("should instantiate with swapManager config object", () => {
            // act
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: {
                    enableAutoActions: false,
                    pollInterval: 60000,
                },
            });

            // assert
            expect(swapManagerInstance.getSwapManager()).not.toBeNull();
        });

        it("should have null swapManager when disabled", () => {
            // act
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: false,
            });

            // assert
            expect(swapManagerInstance.getSwapManager()).toBeNull();
        });

        it("should have null swapManager when not configured", () => {
            // assert - using the default instance without swapManager
            expect(swaps.getSwapManager()).toBeNull();
        });

        it("should have SwapManager interface methods", () => {
            // arrange
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: true,
            });

            // act
            const manager = swapManagerInstance.getSwapManager();

            // assert
            expect(manager).not.toBeNull();
            expect(manager!.start).toBeInstanceOf(Function);
            expect(manager!.stop).toBeInstanceOf(Function);
            expect(manager!.addSwap).toBeInstanceOf(Function);
            expect(manager!.removeSwap).toBeInstanceOf(Function);
            expect(manager!.getPendingSwaps).toBeInstanceOf(Function);
            expect(manager!.hasSwap).toBeInstanceOf(Function);
            expect(manager!.isProcessing).toBeInstanceOf(Function);
            expect(manager!.getStats).toBeInstanceOf(Function);
            expect(manager!.subscribeToSwapUpdates).toBeInstanceOf(Function);
            expect(manager!.waitForSwapCompletion).toBeInstanceOf(Function);
            expect(manager!.onSwapUpdate).toBeInstanceOf(Function);
            expect(manager!.onSwapCompleted).toBeInstanceOf(Function);
            expect(manager!.onSwapFailed).toBeInstanceOf(Function);
            expect(manager!.onActionExecuted).toBeInstanceOf(Function);
            expect(manager!.onWebSocketConnected).toBeInstanceOf(Function);
            expect(manager!.onWebSocketDisconnected).toBeInstanceOf(Function);
        });
    });

    describe("SwapManager Lifecycle", () => {
        it("should start and stop swap manager manually", async () => {
            // arrange - create with autoStart disabled
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: {
                    autoStart: false,
                },
            });

            const manager = swapManagerInstance.getSwapManager()!;

            // assert initial state
            expect((await manager.getStats()).isRunning).toBe(false);

            // act - start
            await swapManagerInstance.startSwapManager();

            // assert - running
            expect((await manager.getStats()).isRunning).toBe(true);

            // act - stop
            await swapManagerInstance.stopSwapManager();

            // assert - stopped
            expect((await manager.getStats()).isRunning).toBe(false);
        });

        it("should throw when starting swap manager without config", async () => {
            // assert
            await expect(swaps.startSwapManager()).rejects.toThrow(
                "SwapManager is not enabled"
            );
        });

        it("should not throw when stopping disabled swap manager", async () => {
            // act & assert
            await expect(swaps.stopSwapManager()).resolves.toBeUndefined();
        });
    });

    describe("SwapManager Stats", () => {
        it("should return correct stats when not running", async () => {
            // arrange
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: {
                    autoStart: false,
                },
            });

            const manager = swapManagerInstance.getSwapManager()!;

            // act
            const stats = await manager.getStats();

            // assert
            expect(stats.isRunning).toBe(false);
            expect(stats.monitoredSwaps).toBe(0);
            expect(stats.websocketConnected).toBe(false);
            expect(stats.usePollingFallback).toBe(false);
            expect(typeof stats.currentReconnectDelay).toBe("number");
            expect(typeof stats.currentPollRetryDelay).toBe("number");
        });

        it("should return correct stats when running", async () => {
            // arrange
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: {
                    autoStart: false,
                },
            });

            const manager = swapManagerInstance.getSwapManager()!;

            // act
            await swapManagerInstance.startSwapManager();
            const stats = await manager.getStats();

            // assert
            expect(stats.isRunning).toBe(true);
            expect(stats.monitoredSwaps).toBe(0);
        });
    });

    describe("SwapManager Event Listeners", () => {
        it("should add and remove swap update listener", async () => {
            // arrange
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: {
                    autoStart: false,
                },
            });

            const manager = swapManagerInstance.getSwapManager()!;
            const listener = vi.fn();

            // act - add listener
            const unsubscribe = await manager.onSwapUpdate(listener);

            // assert - unsubscribe is a function
            expect(typeof unsubscribe).toBe("function");

            // act - remove listener
            unsubscribe();
        });

        it("should add and remove swap completed listener", async () => {
            // arrange
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: {
                    autoStart: false,
                },
            });

            const manager = swapManagerInstance.getSwapManager()!;
            const listener = vi.fn();

            // act - add listener
            const unsubscribe = await manager.onSwapCompleted(listener);

            // assert
            expect(typeof unsubscribe).toBe("function");

            // act - remove listener using off method
            manager.offSwapCompleted(listener);
        });

        it("should add and remove swap failed listener", async () => {
            // arrange
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: {
                    autoStart: false,
                },
            });

            const manager = swapManagerInstance.getSwapManager()!;
            const listener = vi.fn();

            // act & assert
            const unsubscribe = await manager.onSwapFailed(listener);
            expect(typeof unsubscribe).toBe("function");
            manager.offSwapFailed(listener);
        });

        it("should add and remove action executed listener", async () => {
            // arrange
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: {
                    autoStart: false,
                },
            });

            const manager = swapManagerInstance.getSwapManager()!;
            const listener = vi.fn();

            // act & assert
            const unsubscribe = await manager.onActionExecuted(listener);
            expect(typeof unsubscribe).toBe("function");
            manager.offActionExecuted(listener);
        });

        it("should add and remove WebSocket connected listener", async () => {
            // arrange
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: {
                    autoStart: false,
                },
            });

            const manager = swapManagerInstance.getSwapManager()!;
            const listener = vi.fn();

            // act & assert
            const unsubscribe = await manager.onWebSocketConnected(listener);
            expect(typeof unsubscribe).toBe("function");
            manager.offWebSocketConnected(listener);
        });

        it("should add and remove WebSocket disconnected listener", async () => {
            // arrange
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: {
                    autoStart: false,
                },
            });

            const manager = swapManagerInstance.getSwapManager()!;
            const listener = vi.fn();

            // act & assert
            const unsubscribe = await manager.onWebSocketDisconnected(listener);
            expect(typeof unsubscribe).toBe("function");
            manager.offWebSocketDisconnected(listener);
        });
    });

    describe("SwapManager Configuration", () => {
        it("should use default config values", async () => {
            // arrange
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: true,
            });

            const manager = swapManagerInstance.getSwapManager()!;
            const stats = await manager.getStats();

            // assert - check default reconnect delay (1000ms)
            expect(stats.currentReconnectDelay).toBe(1000);
            // Default poll retry delay (5000ms)
            expect(stats.currentPollRetryDelay).toBe(5000);
        });

        it("should use custom reconnect delay", async () => {
            // arrange
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: {
                    reconnectDelayMs: 2000,
                },
            });

            const manager = swapManagerInstance.getSwapManager()!;
            const stats = await manager.getStats();

            // assert
            expect(stats.currentReconnectDelay).toBe(2000);
        });

        it("should use custom poll retry delay", async () => {
            // arrange
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: {
                    pollRetryDelayMs: 10000,
                },
            });

            const manager = swapManagerInstance.getSwapManager()!;
            const stats = await manager.getStats();

            // assert
            expect(stats.currentPollRetryDelay).toBe(10000);
        });

        it("should accept event callbacks in config", () => {
            // arrange
            const onSwapUpdate = vi.fn();
            const onSwapCompleted = vi.fn();
            const onSwapFailed = vi.fn();

            // act
            swapManagerInstance = new ArkadeSwaps({
                wallet,
                arkProvider,
                swapProvider,
                indexerProvider,
                swapManager: {
                    events: {
                        onSwapUpdate,
                        onSwapCompleted,
                        onSwapFailed,
                    },
                },
            });

            // assert - should not throw
            expect(swapManagerInstance.getSwapManager()).not.toBeNull();
        });
    });
});
