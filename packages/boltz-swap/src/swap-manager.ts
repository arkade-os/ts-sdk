import {
    BoltzSwapProvider,
    BoltzSwapStatus,
    isPendingReverseSwap,
    isPendingSubmarineSwap,
    isReverseFinalStatus,
    isSubmarineFinalStatus,
    isReverseClaimableStatus,
    isSubmarineRefundableStatus,
    isPendingChainSwap,
    isChainClaimableStatus,
    isChainRefundableStatus,
    isChainSignableStatus,
    isChainFinalStatus,
} from "./boltz-swap-provider";
import {
    BoltzChainSwap,
    BoltzReverseSwap,
    BoltzSubmarineSwap,
    BoltzSwap,
    ChainArkRefundOutcome,
    SubmarineRefundOutcome,
} from "./types";
import { NetworkError, SwapError, SwapNotFoundError } from "./errors";
import { logger } from "./logger";

/**
 * Swap action types emitted by SwapManager.
 *
 * Lightning actions:
 * - `claim`  — claim a reverse swap VHTLC (Lightning → Arkade)
 * - `refund` — refund a submarine swap VHTLC (Arkade → Lightning, failed)
 *
 * Chain swap actions:
 * - `claimArk`  — claim ARK via VHTLC (BTC → ARK swap)
 * - `claimBtc`  — claim BTC via HTLC (ARK → BTC swap)
 * - `refundArk` — refund ARK via VHTLC (ARK → BTC swap, failed)
 *
 * Note: there is no `refundBtc` because BTC lockup refunds are handled
 * on-chain by Boltz after the timelock expires.
 *
 * Cooperative signing:
 * - `signServerClaim` — sign a cooperative claim for the server (BTC → ARK, courtesy)
 */
export type Actions =
    | "claim"
    | "refund"
    | "claimArk"
    | "claimBtc"
    | "refundArk"
    | "signServerClaim";

export interface SwapManagerConfig {
    /** Auto claim/refund swaps (default: true) */
    enableAutoActions?: boolean;
    /** Polling interval in ms (default: 30000) */
    pollInterval?: number;
    /** Initial reconnect delay (default: 1000) */
    reconnectDelayMs?: number;
    /** Max reconnect delay (default: 60000) */
    maxReconnectDelayMs?: number;
    /** Initial poll retry delay (default: 5000) */
    pollRetryDelayMs?: number;
    /** Max poll retry delay (default: 300000) */
    maxPollRetryDelayMs?: number;
    /** Absolute ceiling for any poll interval (default: 300000) */
    maxPollIntervalMs?: number;
    /** Event callbacks for swap lifecycle events (optional, can use on/off methods instead) */
    events?: SwapManagerEvents;
}

/** Event callbacks for swap lifecycle events. Can be provided in config or registered via on/off methods. */
export interface SwapManagerEvents {
    onSwapUpdate?: (swap: BoltzSwap, oldStatus: BoltzSwapStatus) => void;
    onSwapCompleted?: (swap: BoltzSwap) => void;
    onSwapFailed?: (swap: BoltzSwap, error: Error) => void;
    onActionExecuted?: (swap: BoltzSwap, action: Actions) => void;
    onWebSocketConnected?: () => void;
    onWebSocketDisconnected?: (error?: Error) => void;
}

/** Callback for swap status changes. Receives the updated swap and its previous status. */
type SwapUpdateListener = (swap: BoltzSwap, oldStatus: BoltzSwapStatus) => void;
/** Callback for swap completions (final success state reached). */
type SwapCompletedListener = (swap: BoltzSwap) => void;
/** Callback for swap failures. Includes the error that caused the failure. */
type SwapFailedListener = (swap: BoltzSwap, error: Error) => void;
/** Callback after a swap action (claim/refund) has been executed. */
type ActionExecutedListener = (swap: BoltzSwap, action: Actions) => void;
/** Callback when the WebSocket connection is established. */
type WebSocketConnectedListener = () => void;
/** Callback when the WebSocket disconnects. Includes the error if disconnection was not clean. */
type WebSocketDisconnectedListener = (error?: Error) => void;

/** Per-swap update callback used with subscribeToSwapUpdates. */
type SwapUpdateCallback = (swap: BoltzSwap, oldStatus: BoltzSwapStatus) => void;

/** Public interface for SwapManager consumers. Provides swap monitoring, event subscription, and lifecycle control. */
export interface SwapManagerClient {
    /** Starts the manager, loading initial swaps and connecting WebSocket. */
    start(pendingSwaps: BoltzSwap[]): Promise<void>;
    /** Stops the manager, closes WebSocket, and clears all timers. */
    stop(): Promise<void>;
    /** Adds a new swap to be monitored. Immediately subscribes via WebSocket. */
    addSwap(swap: BoltzSwap): Promise<void>;
    /** Removes a swap from monitoring. */
    removeSwap(swapId: string): Promise<void>;
    /** Returns all currently monitored (non-final) swaps. */
    getPendingSwaps(): Promise<BoltzSwap[]>;
    /** Subscribes to status updates for a specific swap. @returns Unsubscribe function. */
    subscribeToSwapUpdates(swapId: string, callback: SwapUpdateCallback): Promise<() => void>;
    /** Returns a promise that resolves with { txid } when the swap completes, or rejects on failure. */
    waitForSwapCompletion(swapId: string): Promise<{ txid: string }>;
    /** Returns true if a claim/refund action is currently executing for this swap. */
    isProcessing(swapId: string): Promise<boolean>;
    /** Returns true if the manager is monitoring this swap. */
    hasSwap(swapId: string): Promise<boolean>;
    /** Returns operational statistics (running state, WebSocket status, monitored count, etc.). */
    getStats(): Promise<{
        isRunning: boolean;
        monitoredSwaps: number;
        websocketConnected: boolean;
        usePollingFallback: boolean;
        currentReconnectDelay: number;
        currentPollRetryDelay: number;
    }>;
    onSwapUpdate(listener: SwapUpdateListener): Promise<() => void>;
    onSwapCompleted(listener: SwapCompletedListener): Promise<() => void>;
    onSwapFailed(listener: SwapFailedListener): Promise<() => void>;
    onActionExecuted(listener: ActionExecutedListener): Promise<() => void>;
    onWebSocketConnected(listener: WebSocketConnectedListener): Promise<() => void>;
    onWebSocketDisconnected(listener: WebSocketDisconnectedListener): Promise<() => void>;
    offSwapUpdate(listener: SwapUpdateListener): void;
    offSwapCompleted(listener: SwapCompletedListener): void;
    offSwapFailed(listener: SwapFailedListener): void;
    offActionExecuted(listener: ActionExecutedListener): void;
    offWebSocketConnected(listener: WebSocketConnectedListener): void;
    offWebSocketDisconnected(listener: WebSocketDisconnectedListener): void;
}

/** Internal callbacks wired by ArkadeSwaps to perform claim/refund/save operations. */
export interface SwapManagerCallbacks {
    claim: (swap: BoltzReverseSwap) => Promise<void>;
    /**
     * Refund a submarine swap's VHTLC.
     *
     * Returns the outcome so the manager can re-arm a deferred refund: every
     * refundable submarine status except `transaction.lockupFailed` is also
     * final, so Boltz sends no further update to re-trigger one.
     */
    refund: (swap: BoltzSubmarineSwap) => Promise<SubmarineRefundOutcome>;
    /**
     * Claim the ARK side of a BTC→ARK chain swap.
     *
     * Returns the on-chain claim txid — the manager surfaces it from
     * {@link SwapManager.waitForSwapCompletion}, since Boltz does not report a
     * usable transaction id for chain swaps at `transaction.claimed`.
     */
    claimArk: (swap: BoltzChainSwap) => Promise<{ txid: string }>;
    /**
     * Claim the BTC side of an ARK→BTC chain swap. Returns the on-chain claim
     * txid; see {@link SwapManagerCallbacks.claimArk}.
     */
    claimBtc: (swap: BoltzChainSwap) => Promise<{ txid: string }>;
    refundArk: (swap: BoltzChainSwap) => Promise<ChainArkRefundOutcome>;
    signServerClaim?: (swap: BoltzChainSwap) => Promise<void>;
    saveSwap: (swap: BoltzSwap) => Promise<void>;
}

/**
 * Background swap monitor with WebSocket + polling fallback.
 *
 * Monitors all pending swaps via a single multiplexed WebSocket connection to Boltz.
 * Automatically claims reverse swaps, refunds failed submarine swaps, and handles
 * chain swap actions (claim/refund on both ARK and BTC sides).
 *
 * Falls back to HTTP polling when WebSocket is unavailable, with exponential backoff
 * for both reconnection and polling intervals.
 */
export class SwapManager implements SwapManagerClient {
    /**
     * Number of consecutive Boltz 404s for a single swap ID before the
     * polling loop gives up and transitions the swap to a terminal state.
     * At the default 30s poll cadence this is roughly a 5-minute grace
     * window — long enough to ride out a transient Boltz blip, short
     * enough that a real "swap unknown to this provider" surfaces quickly.
     */
    private static readonly NOT_FOUND_THRESHOLD = 10;

    /**
     * Floor on the delay between re-attempts of a refund that left VTXOs
     * deferred, and the delay used when the outcome names no retry time. Boltz
     * won't send another status update once the swap is refundable-and-final,
     * so the manager owns the local retry cadence.
     */
    private static readonly REFUND_RETRY_DELAY_MS = 60_000;

    /**
     * Ceiling on that delay. A deferral can be hours out (a pre-CLTV VTXO waits
     * out the whole refund locktime), and `setTimeout` fires *immediately* past
     * its 32-bit millisecond range, so long waits are broken into re-armed
     * hops. Re-attempting costs an indexer lookup and re-defers, which also lets
     * the cadence recover from a suspended device or a clock jump.
     */
    private static readonly MAX_REFUND_RETRY_DELAY_MS = 60 * 60_000;

    private readonly swapProvider: BoltzSwapProvider;
    private readonly config: SwapManagerConfig;

    // Event listeners storage (supports multiple listeners per event)
    private swapUpdateListeners = new Set<SwapUpdateListener>();
    private swapCompletedListeners = new Set<SwapCompletedListener>();
    private swapFailedListeners = new Set<SwapFailedListener>();
    private actionExecutedListeners = new Set<ActionExecutedListener>();
    private wsConnectedListeners = new Set<WebSocketConnectedListener>();
    private wsDisconnectedListeners = new Set<WebSocketDisconnectedListener>();

    // State
    private websocket: WebSocket | null = null;
    private monitoredSwaps = new Map<string, BoltzSwap>();
    private initialSwaps = new Map<string, BoltzSwap>(); // All swaps passed to start(), including completed ones
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private initialPollTimer: ReturnType<typeof setTimeout> | null = null;
    private pollRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // Per-swap retry timers for chain refunds that left work undone
    // (refundArk returned `skipped > 0`). The swap is held in
    // `monitoredSwaps` past its terminal Boltz status until the local
    // refund completes or the manager stops.
    private refundRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // Per-swap counter of consecutive `SwapNotFoundError` responses from
    // `getSwapStatus`. Reset on any successful poll. Once a swap reaches
    // `NOT_FOUND_THRESHOLD` consecutive 404s the safety net trips and the
    // swap is transitioned to `swap.expired` (terminal) and dropped from
    // monitoring — typically the canonical failure mode after a Boltz
    // endpoint switch, where old swap IDs are unknown to the new instance.
    private notFoundCounts = new Map<string, number>();
    private isRunning = false;
    private currentReconnectDelay: number;
    private currentPollRetryDelay: number;
    private usePollingFallback = false;
    private isReconnecting = false;
    private webSocketUnavailable = false;

    // Race condition prevention
    private swapsInProgress = new Set<string>();

    // Per-swap subscriptions for UI hooks
    private swapSubscriptions = new Map<string, Set<SwapUpdateCallback>>();

    // In-flight (or settled) chain-swap claim promises, keyed by swap id. The
    // manager performs chain claims itself, so the claim tx it broadcasts is
    // the swap's on-chain completion; getSwapStatus does not surface that txid
    // at transaction.claimed. resolveClaimedTxid awaits the stored promise so a
    // transaction.claimed update that races an in-flight claim still resolves
    // the real txid instead of falling back to the provider and failing.
    private chainClaimPromises = new Map<string, Promise<{ txid?: string } | void>>();

    // Action callbacks (injected via setCallbacks)
    private claimCallback: ((swap: BoltzReverseSwap) => Promise<void>) | null = null;
    private refundCallback: ((swap: BoltzSubmarineSwap) => Promise<SubmarineRefundOutcome>) | null =
        null;
    private claimArkCallback: ((swap: BoltzChainSwap) => Promise<{ txid: string }>) | null = null;
    private claimBtcCallback: ((swap: BoltzChainSwap) => Promise<{ txid: string }>) | null = null;
    private refundArkCallback: ((swap: BoltzChainSwap) => Promise<ChainArkRefundOutcome>) | null =
        null;
    private signServerClaimCallback: ((swap: BoltzChainSwap) => Promise<void>) | null = null;
    private saveSwapCallback: ((swap: BoltzSwap) => Promise<void>) | null = null;

    constructor(swapProvider: BoltzSwapProvider, config: SwapManagerConfig = {}) {
        this.swapProvider = swapProvider;
        // Note: autostart is not stored - it's only used by ArkadeSwaps
        this.config = {
            enableAutoActions: config.enableAutoActions ?? true,
            pollInterval: config.pollInterval ?? 30000,
            reconnectDelayMs: config.reconnectDelayMs ?? 1000,
            maxReconnectDelayMs: config.maxReconnectDelayMs ?? 60000,
            pollRetryDelayMs: config.pollRetryDelayMs ?? 5000,
            maxPollRetryDelayMs: config.maxPollRetryDelayMs ?? 300000,
            maxPollIntervalMs: config.maxPollIntervalMs ?? 300000,
            events: config.events ?? {},
        };

        // Register initial event listeners from config if provided
        if (config.events?.onSwapUpdate) {
            this.swapUpdateListeners.add(config.events.onSwapUpdate);
        }
        if (config.events?.onSwapCompleted) {
            this.swapCompletedListeners.add(config.events.onSwapCompleted);
        }
        if (config.events?.onSwapFailed) {
            this.swapFailedListeners.add(config.events.onSwapFailed);
        }
        if (config.events?.onActionExecuted) {
            this.actionExecutedListeners.add(config.events.onActionExecuted);
        }
        if (config.events?.onWebSocketConnected) {
            this.wsConnectedListeners.add(config.events.onWebSocketConnected);
        }
        if (config.events?.onWebSocketDisconnected) {
            this.wsDisconnectedListeners.add(config.events.onWebSocketDisconnected);
        }

        this.currentReconnectDelay = this.config.reconnectDelayMs!;
        this.currentPollRetryDelay = this.config.pollRetryDelayMs!;
    }

    /**
     * Set callbacks for claim, refund, and save operations.
     * These are called by the manager when autonomous actions are needed.
     */
    setCallbacks(callbacks: SwapManagerCallbacks): void {
        this.claimCallback = callbacks.claim;
        this.refundCallback = callbacks.refund;
        this.claimArkCallback = callbacks.claimArk;
        this.claimBtcCallback = callbacks.claimBtc;
        this.refundArkCallback = callbacks.refundArk;
        this.signServerClaimCallback = callbacks.signServerClaim ?? null;
        this.saveSwapCallback = callbacks.saveSwap;
    }

    /**
     * Add an event listener for swap updates
     * @returns Unsubscribe function
     */
    async onSwapUpdate(listener: SwapUpdateListener): Promise<() => void> {
        this.swapUpdateListeners.add(listener);
        return () => this.swapUpdateListeners.delete(listener);
    }

    /**
     * Add an event listener for swap completion
     * @returns Unsubscribe function
     */
    async onSwapCompleted(listener: SwapCompletedListener): Promise<() => void> {
        this.swapCompletedListeners.add(listener);
        return () => this.swapCompletedListeners.delete(listener);
    }

    /**
     * Add an event listener for swap failures
     * @returns Unsubscribe function
     */
    async onSwapFailed(listener: SwapFailedListener): Promise<() => void> {
        this.swapFailedListeners.add(listener);
        return () => this.swapFailedListeners.delete(listener);
    }

    /**
     * Add an event listener for executed actions (claim/refund)
     * @returns Unsubscribe function
     */
    async onActionExecuted(listener: ActionExecutedListener): Promise<() => void> {
        this.actionExecutedListeners.add(listener);
        return () => this.actionExecutedListeners.delete(listener);
    }

    /**
     * Add an event listener for WebSocket connection
     * @returns Unsubscribe function
     */
    async onWebSocketConnected(listener: WebSocketConnectedListener): Promise<() => void> {
        this.wsConnectedListeners.add(listener);
        return () => this.wsConnectedListeners.delete(listener);
    }

    /**
     * Add an event listener for WebSocket disconnection
     * @returns Unsubscribe function
     */
    async onWebSocketDisconnected(listener: WebSocketDisconnectedListener): Promise<() => void> {
        this.wsDisconnectedListeners.add(listener);
        return () => this.wsDisconnectedListeners.delete(listener);
    }

    /** Remove a swap update listener */
    offSwapUpdate(listener: SwapUpdateListener): void {
        this.swapUpdateListeners.delete(listener);
    }

    /** Remove a swap completed listener */
    offSwapCompleted(listener: SwapCompletedListener): void {
        this.swapCompletedListeners.delete(listener);
    }

    /** Remove a swap failed listener */
    offSwapFailed(listener: SwapFailedListener): void {
        this.swapFailedListeners.delete(listener);
    }

    /** Remove an action executed listener */
    offActionExecuted(listener: ActionExecutedListener): void {
        this.actionExecutedListeners.delete(listener);
    }

    /** Remove a WebSocket connected listener */
    offWebSocketConnected(listener: WebSocketConnectedListener): void {
        this.wsConnectedListeners.delete(listener);
    }

    /** Remove a WebSocket disconnected listener */
    offWebSocketDisconnected(listener: WebSocketDisconnectedListener): void {
        this.wsDisconnectedListeners.delete(listener);
    }

    /**
     * Start the swap manager
     * This will:
     * 1. Load pending swaps
     * 2. Connect WebSocket (with fallback to polling)
     * 3. Poll all swaps after connection
     * 4. Resume any actionable swaps
     */
    async start(pendingSwaps: BoltzSwap[]): Promise<void> {
        if (this.isRunning) {
            logger.warn("SwapManager is already running");
            return;
        }

        this.isRunning = true;

        // Store all initial swaps (including completed ones) for waitForSwapCompletion
        this.initialSwaps.clear();
        this.chainClaimPromises.clear();
        for (const swap of pendingSwaps) {
            this.initialSwaps.set(swap.id, swap);
        }

        // Load pending swaps into monitoring map (only non-final swaps)
        for (const swap of pendingSwaps) {
            if (!this.isFinalStatus(swap)) {
                this.monitoredSwaps.set(swap.id, swap);
            }
        }

        // Try to connect WebSocket; method handles runtime detection + fallback.
        await this.tryConnectWebSocket();

        // Resume any actionable swaps immediately
        await this.resumeActionableSwaps();
    }

    /**
     * Stop the swap manager
     * Cleanup: close WebSocket, stop all timers
     */
    async stop(): Promise<void> {
        if (!this.isRunning) return;

        this.isRunning = false;

        // Close WebSocket
        if (this.websocket) {
            this.websocket.close();
            this.websocket = null;
        }

        // Clear timers
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.initialPollTimer) {
            clearTimeout(this.initialPollTimer);
            this.initialPollTimer = null;
        }

        for (const timer of this.pollRetryTimers.values()) {
            clearTimeout(timer);
        }
        this.pollRetryTimers.clear();
        for (const timer of this.refundRetryTimers.values()) {
            clearTimeout(timer);
        }
        this.refundRetryTimers.clear();
        this.notFoundCounts.clear();
    }

    /**
     * Set the polling interval (ms).
     * Restarts any running timer so the new interval takes effect immediately.
     */
    setPollInterval(ms: number): void {
        if (ms <= 0) {
            throw new RangeError(`setPollInterval: ms must be a positive number, got ${ms}`);
        }

        const cappedInterval = Math.min(ms, this.config.maxPollIntervalMs!);
        if (cappedInterval !== ms) {
            logger.warn(
                `setPollInterval: requested ${ms}ms exceeds maxPollIntervalMs ${this.config.maxPollIntervalMs}ms, clamping to ${cappedInterval}ms`,
            );
        }
        this.config.pollInterval = cappedInterval;

        // Also reset the fallback retry delay so it doesn't stay inflated
        this.currentPollRetryDelay = Math.min(cappedInterval, this.config.pollRetryDelayMs!);

        // Restart the active timer with the new interval
        if (this.isRunning) {
            if (this.usePollingFallback) {
                this.startPollingFallback();
            } else if (this.pollTimer) {
                this.startPolling();
            }
        }
    }

    /**
     * Add a new swap to monitoring.
     * If fallback polling is active, this triggers an immediate poll and resets
     * fallback delay so newly-added swaps are checked without waiting.
     */
    async addSwap(swap: BoltzSwap): Promise<void> {
        this.monitoredSwaps.set(swap.id, swap);

        // Subscribe to this swap if WebSocket is connected
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            this.subscribeToSwap(swap.id);
        }

        // In polling fallback mode, reset backoff and poll immediately
        // so the new swap gets a status check without waiting
        if (this.usePollingFallback && this.isRunning) {
            this.currentPollRetryDelay = Math.min(
                this.config.pollInterval!,
                this.config.pollRetryDelayMs!,
            );
            this.pollAllSwaps();
            this.startPollingFallback();
        }
    }

    /**
     * Remove a swap from monitoring
     */
    async removeSwap(swapId: string): Promise<void> {
        this.monitoredSwaps.delete(swapId);
        this.swapSubscriptions.delete(swapId);
        this.chainClaimPromises.delete(swapId);
        const retryTimer = this.pollRetryTimers.get(swapId);
        if (retryTimer) {
            clearTimeout(retryTimer);
            this.pollRetryTimers.delete(swapId);
        }
        const refundRetryTimer = this.refundRetryTimers.get(swapId);
        if (refundRetryTimer) {
            clearTimeout(refundRetryTimer);
            this.refundRetryTimers.delete(swapId);
        }
        this.notFoundCounts.delete(swapId);
        logger.log(`Removed swap ${swapId} from monitoring`);
    }

    /**
     * Get all currently monitored swaps
     */
    async getPendingSwaps(): Promise<BoltzSwap[]> {
        return Array.from(this.monitoredSwaps.values());
    }

    /**
     * Subscribe to updates for a specific swap
     * Returns an unsubscribe function
     * Useful for UI components that need to track specific swap progress
     */
    async subscribeToSwapUpdates(
        swapId: string,
        callback: SwapUpdateCallback,
    ): Promise<() => void> {
        if (!this.swapSubscriptions.has(swapId)) {
            this.swapSubscriptions.set(swapId, new Set());
        }

        const subscribers = this.swapSubscriptions.get(swapId)!;
        subscribers.add(callback);

        // Return unsubscribe function
        return () => {
            subscribers.delete(callback);
            if (subscribers.size === 0) {
                this.swapSubscriptions.delete(swapId);
            }
        };
    }

    /**
     * Wait for a specific swap to complete.
     * Blocks until the swap reaches a final status or fails.
     * Useful when you want blocking behavior even with SwapManager enabled.
     *
     * If the swap is already in a final status, resolves immediately with the
     * on-chain txid of the successfully claimed swap (reverse: from
     * getReverseSwapTxId; submarine/chain: from getSwapStatus) and throws for a
     * failed final status.
     *
     * @throws If the swap is already in a failed final status.
     * @throws If the swap is not found in the manager.
     * @throws If a completed swap has no transaction id available yet.
     */
    async waitForSwapCompletion(swapId: string): Promise<{ txid: string }> {
        // Quick checks without async executor
        let swap = this.monitoredSwaps.get(swapId);

        // If not in monitored swaps, check if it was in initial swaps (might be completed)
        if (!swap) {
            swap = this.initialSwaps.get(swapId);
            if (!swap) {
                throw new Error(`Swap ${swapId} not found in manager`);
            }
        }

        // Check if already in final status
        if (this.isFinalStatus(swap)) {
            if (isPendingReverseSwap(swap)) {
                const response = await this.swapProvider.getReverseSwapTxId(swap.id);
                return { txid: response.id };
            }
            if (isPendingSubmarineSwap(swap) || isPendingChainSwap(swap)) {
                if (swap.status === "transaction.claimed") {
                    return this.resolveClaimedTxid(swap.id);
                }
                throw new Error(`Swap ${swap.id} already in final status: ${swap.status}`);
            }
        }

        return new Promise<{ txid: string }>((resolve, reject) => {
            let unsubscribe: (() => void) | null = null;

            const handleUpdate = (updatedSwap: BoltzSwap, _oldStatus: BoltzSwapStatus) => {
                if (!this.isFinalStatus(updatedSwap)) return;

                unsubscribe?.();

                if (isPendingReverseSwap(updatedSwap)) {
                    if (updatedSwap.status === "invoice.settled") {
                        this.swapProvider
                            .getReverseSwapTxId(updatedSwap.id)
                            .then((response) => resolve({ txid: response.id }))
                            .catch((error) => reject(error));
                    } else {
                        reject(new Error(`Swap failed with status: ${updatedSwap.status}`));
                    }
                } else if (isPendingSubmarineSwap(updatedSwap)) {
                    if (updatedSwap.status === "transaction.claimed") {
                        this.resolveClaimedTxid(updatedSwap.id).then(resolve).catch(reject);
                    } else {
                        reject(new Error(`Swap failed with status: ${updatedSwap.status}`));
                    }
                } else if (isPendingChainSwap(updatedSwap)) {
                    if (updatedSwap.status === "transaction.claimed") {
                        this.resolveClaimedTxid(updatedSwap.id).then(resolve).catch(reject);
                    } else {
                        reject(new Error(`Swap failed with status: ${updatedSwap.status}`));
                    }
                }
            };

            this.subscribeToSwapUpdates(swapId, handleUpdate)
                .then((unsub) => {
                    unsubscribe = unsub;
                })
                .catch(reject);
        });
    }

    /**
     * Resolve the on-chain txid for a claimed submarine/chain swap.
     *
     * Chain swaps are claimed by the manager itself, so the claim txid captured
     * from the claimArk/claimBtc callback is the swap's on-chain completion and
     * is preferred — Boltz does not surface it via getSwapStatus at
     * transaction.claimed. Submarine swaps (claimed by Boltz) and chain swaps
     * we never claimed in this session (e.g. restored already-claimed) fall
     * back to the provider status. Rejects when no transaction id is available,
     * so callers never receive the Boltz swap id in place of a real txid.
     */
    private async resolveClaimedTxid(swapId: string): Promise<{ txid: string }> {
        // Await the claim we started — it may still be in-flight when a racing
        // transaction.claimed update fires — and prefer its txid; getSwapStatus
        // does not surface it at transaction.claimed for chain swaps. Swallow
        // the claim's rejection (executeAutonomousAction surfaces it) and fall
        // through to the provider status for swaps we never claimed this
        // session (e.g. restored already-claimed swaps).
        const claimPromise = this.chainClaimPromises.get(swapId);
        if (claimPromise) {
            const claimTxid = await claimPromise.then(
                (result) => result?.txid,
                () => undefined,
            );
            if (claimTxid && claimTxid.trim() !== "") {
                return { txid: claimTxid };
            }
        }
        const status = await this.swapProvider.getSwapStatus(swapId);
        const txid = status.transaction?.id;
        if (!txid || txid.trim() === "") {
            throw new SwapError({
                message: `Transaction ID not available for completed swap ${swapId}`,
            });
        }
        return { txid };
    }

    /**
     * Check if a swap is currently being processed
     * Useful for preventing race conditions
     */
    async isProcessing(swapId: string): Promise<boolean> {
        return this.swapsInProgress.has(swapId);
    }

    /**
     * Check if manager has a specific swap
     */
    async hasSwap(swapId: string): Promise<boolean> {
        return this.monitoredSwaps.has(swapId);
    }

    /**
     * Try connecting to WebSocket for real-time swap updates.
     * If WebSocket is unavailable in the current runtime, switch directly to polling fallback.
     * If connection setup fails, also switches to polling fallback.
     */
    private async tryConnectWebSocket(): Promise<void> {
        if (this.isReconnecting || this.webSocketUnavailable) return;
        if (!this.hasWebSocketSupport()) {
            this.webSocketUnavailable = true;
            this.enterPollingFallback(
                new NetworkError("WebSocket is not available in this runtime"),
            );
            return;
        }
        this.isReconnecting = true;

        try {
            const wsUrl = this.swapProvider.getWsUrl();
            this.websocket = new globalThis.WebSocket(wsUrl);

            // Connection timeout
            const connectionTimeout = setTimeout(() => {
                logger.error("WebSocket connection timeout");
                this.websocket?.close();
                this.enterPollingFallback(new NetworkError("WebSocket connection failed"));
            }, 10000);

            this.websocket.onerror = (error) => {
                clearTimeout(connectionTimeout);
                logger.error("WebSocket error:", error);
                this.enterPollingFallback(new NetworkError("WebSocket connection failed"));
            };

            this.websocket.onopen = () => {
                clearTimeout(connectionTimeout);

                // Reset reconnect delay on successful connection
                this.currentReconnectDelay = this.config.reconnectDelayMs!;
                this.usePollingFallback = false;
                this.isReconnecting = false;

                // Subscribe to all monitored swaps
                for (const swapId of this.monitoredSwaps.keys()) {
                    this.subscribeToSwap(swapId);
                }

                // Poll all swaps after WebSocket connects to catch any
                // status changes missed while disconnected. Delayed to avoid
                // hitting Boltz rate limits when other API calls (e.g. swap
                // restoration) fire during startup.
                if (this.initialPollTimer) {
                    clearTimeout(this.initialPollTimer);
                    this.initialPollTimer = null;
                }
                this.initialPollTimer = setTimeout(() => {
                    this.initialPollTimer = null;
                    if (this.isRunning) {
                        this.pollAllSwaps();
                    }
                }, 2000);

                // Start regular polling interval
                this.startPolling();

                // Emit connected event
                // Emit WebSocket connected event to all listeners
                this.wsConnectedListeners.forEach((listener) => listener());
            };

            this.websocket.onclose = () => {
                clearTimeout(connectionTimeout);

                if (this.initialPollTimer) {
                    clearTimeout(this.initialPollTimer);
                    this.initialPollTimer = null;
                }

                this.websocket = null;

                // Only attempt reconnect if manager is still running
                if (this.isRunning) {
                    this.scheduleReconnect();
                }

                // Emit WebSocket disconnected event to all listeners
                this.wsDisconnectedListeners.forEach((listener) => listener());
            };

            this.websocket.onmessage = async (rawMsg) => {
                await this.handleWebSocketMessage(rawMsg);
            };
        } catch (error) {
            logger.error("Failed to create WebSocket:", error);
            this.enterPollingFallback(new NetworkError("WebSocket connection failed"));
        }
    }

    /**
     * Runtime feature detection for WebSocket API.
     */
    private hasWebSocketSupport(): boolean {
        return typeof globalThis.WebSocket === "function";
    }

    /**
     * Enter polling fallback mode and notify listeners about WebSocket unavailability/failure.
     * Resets fallback delay to its configured initial value (capped by max poll interval).
     */
    private enterPollingFallback(error: Error): void {
        if (!this.isRunning) return;

        if (this.initialPollTimer) {
            clearTimeout(this.initialPollTimer);
            this.initialPollTimer = null;
        }

        this.isReconnecting = false;
        this.websocket = null;
        this.usePollingFallback = true;

        this.currentPollRetryDelay = Math.min(
            this.config.pollRetryDelayMs!,
            this.config.maxPollIntervalMs!,
        );

        this.startPollingFallback();
        this.wsDisconnectedListeners.forEach((listener) => {
            listener(error);
        });
    }

    /**
     * Schedule WebSocket reconnection with exponential backoff
     */
    private scheduleReconnect(): void {
        if (this.reconnectTimer || this.webSocketUnavailable || !this.hasWebSocketSupport()) return;

        logger.log(`Scheduling WebSocket reconnect in ${this.currentReconnectDelay}ms`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.isReconnecting = false;
            this.tryConnectWebSocket();
        }, this.currentReconnectDelay);

        // Exponential backoff for reconnection
        this.currentReconnectDelay = Math.min(
            this.currentReconnectDelay * 2,
            this.config.maxReconnectDelayMs!,
        );
    }

    /**
     * Subscribe to a specific swap ID on the WebSocket
     */
    private subscribeToSwap(swapId: string): void {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;

        this.websocket.send(
            JSON.stringify({
                op: "subscribe",
                channel: "swap.update",
                args: [swapId],
            }),
        );
    }

    /**
     * Handle incoming WebSocket message
     */
    private async handleWebSocketMessage(rawMsg: MessageEvent): Promise<void> {
        try {
            const msg = JSON.parse(rawMsg.data as string);

            // Only process update events
            if (msg.event !== "update") return;

            const swapId = msg.args[0]?.id;
            if (!swapId) return;

            const swap = this.monitoredSwaps.get(swapId);
            if (!swap) return;

            // Handle error from Boltz
            if (msg.args[0].error) {
                logger.error(`Swap ${swapId} error:`, msg.args[0].error);
                const error = new Error(msg.args[0].error);
                this.swapFailedListeners.forEach((listener) => listener(swap, error));
                return;
            }

            const newStatus = msg.args[0].status as BoltzSwapStatus;
            await this.handleSwapStatusUpdate(swap, newStatus);
        } catch (error) {
            logger.error("Error handling WebSocket message:", error);
        }
    }

    /**
     * Handle status update for a swap
     * This is the core logic that determines what actions to take
     */
    private async handleSwapStatusUpdate(
        swap: BoltzSwap,
        newStatus: BoltzSwapStatus,
    ): Promise<void> {
        // Any real status update (poll or WebSocket) means Boltz still
        // recognises this swap — clear the unknown-to-provider counter.
        this.notFoundCounts.delete(swap.id);

        const oldStatus = swap.status;

        // Skip if status hasn't changed
        if (oldStatus === newStatus) return;

        // Update swap status
        swap.status = newStatus;

        // Emit update event to all listeners
        this.swapUpdateListeners.forEach((listener) => listener(swap, oldStatus));

        // Notify per-swap subscribers
        const subscribers = this.swapSubscriptions.get(swap.id);
        if (subscribers) {
            subscribers.forEach((callback) => {
                try {
                    callback(swap, oldStatus);
                } catch (error) {
                    logger.error(`Error in swap subscription callback for ${swap.id}:`, error);
                }
            });
        }

        // Save updated swap to storage
        await this.saveSwap(swap);

        // Execute autonomous actions if enabled
        if (this.config.enableAutoActions) {
            await this.executeAutonomousAction(swap);
        }

        // Remove from monitoring if final status — unless a refund retry
        // is pending, in which case the retry callback owns finalization
        // once the local refund work completes.
        if (this.isFinalStatus(swap)) {
            if (this.refundRetryTimers.has(swap.id)) {
                return;
            }
            this.finalizeMonitoredSwap(swap);
        }
    }

    /**
     * Drop a swap from monitoring and emit the terminal completion event.
     * Shared between the on-status-update finalization path and the
     * refund-retry finalization path (used when a previously-deferred
     * chain refund has finished its remaining work).
     */
    private finalizeMonitoredSwap(swap: BoltzSwap): void {
        if (!this.monitoredSwaps.has(swap.id)) return;
        this.monitoredSwaps.delete(swap.id);
        this.swapSubscriptions.delete(swap.id);
        this.chainClaimPromises.delete(swap.id);
        const retryTimer = this.pollRetryTimers.get(swap.id);
        if (retryTimer) {
            clearTimeout(retryTimer);
            this.pollRetryTimers.delete(swap.id);
        }
        const refundRetry = this.refundRetryTimers.get(swap.id);
        if (refundRetry) {
            clearTimeout(refundRetry);
            this.refundRetryTimers.delete(swap.id);
        }
        this.swapCompletedListeners.forEach((listener) => listener(swap));
    }

    /**
     * How long to wait before re-attempting a refund, given the `retryAt`
     * (Unix seconds) the outcome reported. Clamped at both ends: see
     * {@link SwapManager.REFUND_RETRY_DELAY_MS} and
     * {@link SwapManager.MAX_REFUND_RETRY_DELAY_MS}.
     */
    private static refundRetryDelayMs(retryAt?: number): number {
        if (retryAt === undefined) return SwapManager.REFUND_RETRY_DELAY_MS;
        return Math.min(
            Math.max(retryAt * 1000 - Date.now(), SwapManager.REFUND_RETRY_DELAY_MS),
            SwapManager.MAX_REFUND_RETRY_DELAY_MS,
        );
    }

    /**
     * Schedule another `executeAutonomousAction` run for a swap whose refund
     * left VTXOs deferred. After the retry completes, if no further deferral
     * was reported, finalize monitoring cleanup.
     */
    private scheduleRefundRetry(swap: BoltzSwap, delayMs: number): void {
        const existing = this.refundRetryTimers.get(swap.id);
        if (existing) clearTimeout(existing);
        this.refundRetryTimers.set(
            swap.id,
            setTimeout(async () => {
                this.refundRetryTimers.delete(swap.id);
                if (!this.isRunning) return;
                // Re-read rather than reuse the swap captured at scheduling
                // time: a submarine swap can advance invoice.failedToPay →
                // swap.expired while the retry is pending, and finalization
                // below must report the status it actually ended on.
                const current = this.monitoredSwaps.get(swap.id);
                if (!current) return;
                let ran = false;
                try {
                    ran = await this.executeAutonomousAction(current);
                } finally {
                    // The retry either re-scheduled itself (still deferred) or
                    // finished the work; in the latter case we owe the
                    // terminal-status finalization that handleSwapStatusUpdate
                    // skipped. Only when it actually ran, though: this timer
                    // has already removed itself, so finalizing on a call that
                    // was skipped for a concurrent action would drop the swap
                    // mid-refund and strand whatever that action defers.
                    if (
                        ran &&
                        !this.refundRetryTimers.has(current.id) &&
                        this.isFinalStatus(current)
                    ) {
                        this.finalizeMonitoredSwap(current);
                    }
                }
            }, delayMs),
        );
    }

    /**
     * Execute autonomous action based on swap status
     * Uses locking to prevent race conditions with manual operations
     *
     * @returns `false` when another action for this swap already held the lock
     * and this call did nothing, `true` when it ran. Callers that finalize on
     * the result must not act on `false`: the in-flight action owns the swap's
     * outcome and will re-arm or finalize from its own result.
     */
    private async executeAutonomousAction(swap: BoltzSwap): Promise<boolean> {
        // Skip if already processing this swap
        if (this.swapsInProgress.has(swap.id)) {
            logger.log(`Swap ${swap.id} is already being processed, skipping autonomous action`);
            return false;
        }

        try {
            // Lock the swap
            this.swapsInProgress.add(swap.id);

            if (isPendingReverseSwap(swap)) {
                // Skip restored swaps without preimage (cannot claim without it)
                if (!swap.preimage || swap.preimage.length === 0) {
                    logger.log(
                        `Skipping claim for swap ${swap.id}: missing preimage (restored swap)`,
                    );
                    return true;
                }
                // Claim reverse swap if status is claimable
                if (isReverseClaimableStatus(swap.status)) {
                    logger.log(`Auto-claiming reverse swap ${swap.id}`);
                    await this.executeClaimAction(swap);
                    // Emit action executed event to all listeners
                    this.actionExecutedListeners.forEach((listener) => listener(swap, "claim"));
                }
            } else if (isPendingSubmarineSwap(swap)) {
                // Skip restored swaps without invoice (cannot refund without it)
                if (!swap.request?.invoice || swap.request.invoice.length === 0) {
                    logger.log(
                        `Skipping refund for swap ${swap.id}: missing invoice (restored swap)`,
                    );
                    return true;
                }
                // Refund submarine swap if status is refundable
                if (isSubmarineRefundableStatus(swap.status)) {
                    logger.log(`Auto-refunding submarine swap ${swap.id}`);
                    // invoice.failedToPay and swap.expired are refundable *and*
                    // final, so a deferred refund left alone would be dropped
                    // from monitoring with funds still locked and no further
                    // Boltz update to re-trigger it. Only a partial outcome
                    // schedules a retry: a throw is a genuine failure (already
                    // spent, VHTLC not found) that retrying can't clear, so it
                    // propagates to the catch below and stays loud.
                    const outcome = await this.executeRefundAction(swap);
                    if (outcome && outcome.skipped > 0) {
                        const delayMs = SwapManager.refundRetryDelayMs(outcome.retryAt);
                        logger.log(
                            `Submarine swap ${swap.id}: ${outcome.skipped} VTXO(s) deferred — ` +
                                `scheduling refund retry in ${Math.round(delayMs / 1000)}s`,
                        );
                        this.scheduleRefundRetry(swap, delayMs);
                    }
                    // Emit action executed event to all listeners
                    this.actionExecutedListeners.forEach((listener) => listener(swap, "refund"));
                }
            } else if (isPendingChainSwap(swap)) {
                if (isChainClaimableStatus(swap.status)) {
                    // Determine if it's Ark or BTC claim
                    if (swap.request.to === "ARK") {
                        logger.log(`Auto-claiming ARK chain swap ${swap.id}`);
                        await this.executeClaimArkAction(swap);
                        // Emit action executed event to all listeners
                        this.actionExecutedListeners.forEach((listener) =>
                            listener(swap, "claimArk"),
                        );
                    } else if (swap.request.to === "BTC") {
                        logger.log(`Auto-claiming BTC chain swap ${swap.id}`);
                        await this.executeClaimBtcAction(swap);
                        // Emit action executed event to all listeners
                        this.actionExecutedListeners.forEach((listener) =>
                            listener(swap, "claimBtc"),
                        );
                    }
                } else if (isChainRefundableStatus(swap.status)) {
                    if (swap.request.from === "ARK") {
                        logger.log(`Auto-refunding ARK chain swap ${swap.id}`);
                        // Boltz won't send another status update for an
                        // already-`swap.expired` swap, so any failure to
                        // sweep — partial outcome OR thrown error — must
                        // schedule a local retry, otherwise the swap
                        // would be dropped from monitoring with funds
                        // still stranded. The inner try/catch keeps the
                        // retry-scheduling logic out of the broader
                        // `executeAutonomousAction` catch below, which
                        // logs and emits but cannot reach the chain-
                        // specific retry path.
                        try {
                            const outcome = await this.executeRefundArkAction(swap);
                            if (outcome && outcome.skipped > 0) {
                                const delayMs = SwapManager.refundRetryDelayMs(outcome.retryAt);
                                logger.log(
                                    `Chain swap ${swap.id}: ${outcome.skipped} VTXO(s) deferred — ` +
                                        `scheduling refund retry in ${Math.round(delayMs / 1000)}s`,
                                );
                                this.scheduleRefundRetry(swap, delayMs);
                            }
                            this.actionExecutedListeners.forEach((listener) =>
                                listener(swap, "refundArk"),
                            );
                        } catch (error) {
                            logger.error(
                                `Auto-refunding ARK chain swap ${swap.id} failed; scheduling retry`,
                                error,
                            );
                            this.swapFailedListeners.forEach((listener) =>
                                listener(swap, error as Error),
                            );
                            this.scheduleRefundRetry(swap, SwapManager.REFUND_RETRY_DELAY_MS);
                        }
                    }
                    if (swap.request.from === "BTC") {
                        // BTC-side lockup refunds are handled on-chain by
                        // Boltz after the timelock expires — there is no
                        // client-side action to take. We log a warning so
                        // the event is visible in diagnostics.
                        logger.warn(
                            `Chain swap ${swap.id} expired: BTC lockup will be refunded by Boltz after timelock`,
                        );
                    }
                } else if (swap.request.to === "ARK" && isChainSignableStatus(swap.status)) {
                    logger.log(
                        `Auto-signing server's cooperative claim for ARK chain swap ${swap.id}`,
                    );
                    try {
                        const signed = await this.executeSignServerClaimAction(swap);
                        if (signed) {
                            this.actionExecutedListeners.forEach((listener) =>
                                listener(swap, "signServerClaim"),
                            );
                        }
                    } catch (error) {
                        logger.error(
                            `Non-fatal: failed to sign server claim for swap ${swap.id}:`,
                            error,
                        );
                    }
                }
            }
        } catch (error) {
            logger.error(`Failed to execute autonomous action for swap ${swap.id}:`, error);
            // Emit swap failed event to all listeners
            this.swapFailedListeners.forEach((listener) => listener(swap, error as Error));
        } finally {
            // Always release the lock
            this.swapsInProgress.delete(swap.id);
        }
        return true;
    }

    /**
     * Execute claim action for reverse swap
     */
    private async executeClaimAction(swap: BoltzReverseSwap): Promise<void> {
        if (!this.claimCallback) {
            logger.error("Claim callback not set");
            return;
        }

        await this.claimCallback(swap);
    }

    /**
     * Execute refund action for submarine swap
     *
     * @returns The refund outcome, or `undefined` if no callback is wired.
     */
    private async executeRefundAction(
        swap: BoltzSubmarineSwap,
    ): Promise<SubmarineRefundOutcome | undefined> {
        if (!this.refundCallback) {
            logger.error("Refund callback not set");
            return;
        }

        return this.refundCallback(swap);
    }

    /**
     * Execute claim action for chain swap Btc to Ark
     */
    private async executeClaimArkAction(swap: BoltzChainSwap): Promise<void> {
        if (!this.claimArkCallback) {
            logger.error("claimArk callback not set");
            return;
        }

        const claimPromise = this.claimArkCallback(swap);
        this.rememberChainClaim(swap.id, claimPromise);
        await claimPromise;
    }

    /**
     * Execute claim action for chain swap Ark to Btc
     */
    private async executeClaimBtcAction(swap: BoltzChainSwap): Promise<void> {
        if (!this.claimBtcCallback) {
            logger.error("claimBtc callback not set");
            return;
        }

        const claimPromise = this.claimBtcCallback(swap);
        this.rememberChainClaim(swap.id, claimPromise);
        await claimPromise;
    }

    /**
     * Store the in-flight claim promise returned by a claim callback so
     * {@link resolveClaimedTxid} can await it and surface the real on-chain
     * txid at transaction.claimed — even when that update races the still
     * in-flight claim. Storing the promise (not the resolved txid) closes the
     * window where the txid is not yet captured when transaction.claimed
     * arrives. Defensive against callbacks that don't return a promise (older
     * integrations, test doubles): those simply fall back to getSwapStatus.
     */
    private rememberChainClaim(
        swapId: string,
        claimPromise: Promise<{ txid?: string } | void>,
    ): void {
        if (claimPromise) {
            this.chainClaimPromises.set(swapId, claimPromise);
        }
    }

    /**
     * Execute refund action for chain swap Ark to Btc
     */
    private async executeRefundArkAction(
        swap: BoltzChainSwap,
    ): Promise<ChainArkRefundOutcome | undefined> {
        if (!this.refundArkCallback) {
            logger.error("refundArk callback not set");
            return;
        }

        return this.refundArkCallback(swap);
    }

    /**
     * Execute sign server claim action for chain swap.
     * Returns true on success, false if no callback is set.
     * Throws if the callback itself throws.
     */
    private async executeSignServerClaimAction(swap: BoltzChainSwap): Promise<boolean> {
        if (!this.signServerClaimCallback) {
            logger.error("signServerClaim callback not set");
            return false;
        }

        await this.signServerClaimCallback(swap);
        return true;
    }

    /**
     * Save swap to storage
     */
    private async saveSwap(swap: BoltzSwap): Promise<void> {
        if (!this.saveSwapCallback) {
            logger.error("Save swap callback not set");
            return;
        }

        await this.saveSwapCallback(swap);
    }

    /**
     * Resume actionable swaps on startup
     * This checks all pending swaps and executes actions if needed
     */
    private async resumeActionableSwaps(): Promise<void> {
        // Only resume if auto actions are enabled
        if (!this.config.enableAutoActions) {
            return;
        }

        for (const swap of this.monitoredSwaps.values()) {
            try {
                // Check if swap needs action based on current status
                if (isPendingReverseSwap(swap) && isReverseClaimableStatus(swap.status)) {
                    logger.log(`Resuming claim for swap ${swap.id}`);
                    await this.executeAutonomousAction(swap);
                } else if (
                    isPendingSubmarineSwap(swap) &&
                    isSubmarineRefundableStatus(swap.status)
                ) {
                    logger.log(`Resuming refund for swap ${swap.id}`);
                    await this.executeAutonomousAction(swap);
                } else if (isPendingChainSwap(swap) && isChainClaimableStatus(swap.status)) {
                    logger.log(`Resuming chain claim for swap ${swap.id}`);
                    await this.executeAutonomousAction(swap);
                } else if (isPendingChainSwap(swap) && isChainRefundableStatus(swap.status)) {
                    logger.log(`Resuming chain refund for swap ${swap.id}`);
                    await this.executeAutonomousAction(swap);
                } else if (
                    isPendingChainSwap(swap) &&
                    swap.request.to === "ARK" &&
                    isChainSignableStatus(swap.status)
                ) {
                    logger.log(`Resuming server claim signing for swap ${swap.id}`);
                    await this.executeAutonomousAction(swap);
                }
            } catch (error) {
                logger.error(`Failed to resume swap ${swap.id}:`, error);
            }
        }
    }

    /**
     * Start regular polling
     * Polls all swaps at configured interval when WebSocket is active
     */
    private startPolling(): void {
        // Clear existing timer
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }

        // Schedule next poll
        this.pollTimer = setTimeout(async () => {
            await this.pollAllSwaps();

            // Reschedule if manager is still running
            if (this.isRunning) {
                this.startPolling();
            }
        }, this.config.pollInterval);
    }

    /**
     * Start polling fallback when WebSocket is unavailable
     * Uses exponential backoff for retry delay
     */
    private startPollingFallback(): void {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }

        this.pollTimer = setTimeout(async () => {
            await this.pollAllSwaps();

            // Increase poll retry delay with exponential backoff
            this.currentPollRetryDelay = Math.min(
                this.currentPollRetryDelay * 2,
                this.config.maxPollRetryDelayMs!,
            );

            // Reschedule if manager is still running and still in fallback mode
            if (this.isRunning && this.usePollingFallback) {
                this.startPollingFallback();
            }
        }, this.currentPollRetryDelay);
    }

    /**
     * Poll all monitored swaps for status updates
     * This is called:
     * 1. After WebSocket connects
     * 2. After WebSocket reconnects
     * 3. Periodically while WebSocket is active
     * 4. As fallback when WebSocket is unavailable
     */
    private async pollAllSwaps(): Promise<void> {
        if (this.monitoredSwaps.size === 0) return;

        const pollPromises = Array.from(this.monitoredSwaps.values())
            // Swaps with a pending refund retry are driven entirely by the
            // refund-retry loop, not by Boltz polling. Skip them so a 404 on
            // an already-expired swap can't trip handleSwapNotFound and tear
            // down the in-flight retry.
            .filter((swap) => !this.refundRetryTimers.has(swap.id))
            .map((swap) => this.pollSingleSwap(swap));

        await Promise.allSettled(pollPromises);
    }

    private async pollSingleSwap(swap: BoltzSwap): Promise<void> {
        try {
            const statusResponse = await this.swapProvider.getSwapStatus(swap.id);
            // A successful response means Boltz still recognises this swap
            // — clear the consecutive-not-found counter.
            this.notFoundCounts.delete(swap.id);
            if (statusResponse.status !== swap.status) {
                await this.handleSwapStatusUpdate(swap, statusResponse.status);
            }
        } catch (error) {
            if (error instanceof SwapNotFoundError) {
                await this.handleSwapNotFound(swap);
                return;
            }
            // On 429 (rate-limited), schedule a single retry for this
            // swap rather than waiting the full poll interval. This
            // avoids a 30s gap in status tracking after a burst.
            if (error instanceof NetworkError && error.statusCode === 429) {
                logger.warn(`Rate-limited polling swap ${swap.id}, retrying in 2s`);
                const existing = this.pollRetryTimers.get(swap.id);
                if (existing) clearTimeout(existing);
                this.pollRetryTimers.set(
                    swap.id,
                    setTimeout(async () => {
                        this.pollRetryTimers.delete(swap.id);
                        try {
                            const retry = await this.swapProvider.getSwapStatus(swap.id);
                            this.notFoundCounts.delete(swap.id);
                            if (retry.status !== swap.status) {
                                await this.handleSwapStatusUpdate(swap, retry.status);
                            }
                        } catch (retryError) {
                            if (retryError instanceof SwapNotFoundError) {
                                await this.handleSwapNotFound(swap);
                                return;
                            }
                            logger.error(`Retry poll for swap ${swap.id} also failed:`, retryError);
                        }
                    }, 2000),
                );
            } else {
                logger.error(`Failed to poll swap ${swap.id}:`, error);
            }
        }
    }

    /**
     * Increment the consecutive-not-found counter and, once the threshold is
     * reached, transition the swap to a terminal state and stop polling it.
     * Driven from {@link pollSingleSwap} when `getSwapStatus` throws
     * {@link SwapNotFoundError}. The threshold rides out a transient blip
     * but ensures we stop hammering Boltz with requests for swap IDs the
     * server has no record of (e.g. after switching the configured
     * Boltz endpoint).
     */
    private async handleSwapNotFound(swap: BoltzSwap): Promise<void> {
        // A pending refund retry owns this swap's lifecycle; a transient 404
        // must not increment the not-found counter or abort the retry.
        if (this.refundRetryTimers.has(swap.id)) return;
        const count = (this.notFoundCounts.get(swap.id) ?? 0) + 1;
        this.notFoundCounts.set(swap.id, count);
        logger.warn(
            `Swap ${swap.id}: unknown to Boltz (${count}/${SwapManager.NOT_FOUND_THRESHOLD} consecutive)`,
        );
        if (count >= SwapManager.NOT_FOUND_THRESHOLD) {
            await this.markSwapAsUnknownToProvider(swap);
        }
    }

    /**
     * Transition a swap to {@code swap.expired} (terminal for all swap types)
     * after Boltz has consistently reported it unknown for
     * {@link SwapManager.NOT_FOUND_THRESHOLD} consecutive polls. The swap is
     * persisted, removed from monitoring, and reported via `onSwapFailed`.
     * Bypasses {@link handleSwapStatusUpdate} on purpose: we don't want to
     * trigger autonomous claim/refund actions against a Boltz instance that
     * has no record of this swap — the requests would just generate more
     * 404s without recovering anything.
     */
    private async markSwapAsUnknownToProvider(swap: BoltzSwap): Promise<void> {
        // Never tear down a swap with a pending refund retry: clearing
        // refundRetryTimers here would strand the deferred refund work. The
        // retry loop owns finalization once that work completes.
        if (this.refundRetryTimers.has(swap.id)) return;
        // Idempotency: bail if a concurrent path already removed the swap.
        if (!this.monitoredSwaps.has(swap.id)) {
            this.notFoundCounts.delete(swap.id);
            return;
        }

        const oldStatus = swap.status;
        // `swap.expired` is final for submarine, reverse, and chain swaps
        // (see is*FinalStatus helpers). On next start the swap is loaded
        // with a final status and won't be re-added to monitoredSwaps.
        swap.status = "swap.expired";

        // Remove from monitoring up-front so any in-flight poll/WS handler
        // for this ID becomes a no-op. Subscribers are NOT cleared yet —
        // we still need to deliver the terminal status update to them
        // (e.g. waitForSwapCompletion is awaiting that callback).
        this.monitoredSwaps.delete(swap.id);
        const retryTimer = this.pollRetryTimers.get(swap.id);
        if (retryTimer) {
            clearTimeout(retryTimer);
            this.pollRetryTimers.delete(swap.id);
        }
        const refundRetryTimer = this.refundRetryTimers.get(swap.id);
        if (refundRetryTimer) {
            clearTimeout(refundRetryTimer);
            this.refundRetryTimers.delete(swap.id);
        }
        this.notFoundCounts.delete(swap.id);

        // Mirror the emission shape of handleSwapStatusUpdate so listeners
        // and per-swap subscribers see the terminal transition even though
        // we bypassed that path (we did so to skip the auto-action branch).
        this.swapUpdateListeners.forEach((listener) => listener(swap, oldStatus));
        const subscribers = this.swapSubscriptions.get(swap.id);
        if (subscribers) {
            subscribers.forEach((callback) => {
                try {
                    callback(swap, oldStatus);
                } catch (subscriberError) {
                    logger.error(
                        `Error in swap subscription callback for ${swap.id}:`,
                        subscriberError,
                    );
                }
            });
        }

        try {
            await this.saveSwap(swap);
        } catch (saveError) {
            logger.error(
                `Failed to persist unknown-to-provider state for swap ${swap.id}:`,
                saveError,
            );
        }

        logger.warn(
            `Swap ${swap.id}: marked failed after ${SwapManager.NOT_FOUND_THRESHOLD} consecutive Boltz 404s — swap is unknown to the configured Boltz instance`,
        );

        const error = new SwapNotFoundError(swap.id);
        this.swapFailedListeners.forEach((listener) => listener(swap, error));

        // Subscribers have been notified; safe to drop the set now.
        this.swapSubscriptions.delete(swap.id);
    }

    /**
     * Check if a status is final (no more updates expected)
     */
    private isFinalStatus(pendingSwap: BoltzSwap): boolean {
        const status = pendingSwap.status;
        return (
            (isPendingReverseSwap(pendingSwap) && isReverseFinalStatus(status)) ||
            (isPendingSubmarineSwap(pendingSwap) && isSubmarineFinalStatus(status)) ||
            (isPendingChainSwap(pendingSwap) && isChainFinalStatus(status))
        );
    }

    /**
     * Get current manager statistics (for debugging/monitoring)
     */
    async getStats(): Promise<{
        isRunning: boolean;
        monitoredSwaps: number;
        websocketConnected: boolean;
        usePollingFallback: boolean;
        currentReconnectDelay: number;
        currentPollRetryDelay: number;
    }> {
        return {
            isRunning: this.isRunning,
            monitoredSwaps: this.monitoredSwaps.size,
            websocketConnected:
                this.websocket !== null && this.websocket.readyState === WebSocket.OPEN,
            usePollingFallback: this.usePollingFallback,
            currentReconnectDelay: this.currentReconnectDelay,
            currentPollRetryDelay: this.currentPollRetryDelay,
        };
    }
}
