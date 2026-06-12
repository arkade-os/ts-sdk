import { IndexerProvider, SubscriptionResponse } from "../providers/indexer";
import { VirtualCoin } from "../wallet";
import { extendVirtualCoinForContract } from "../wallet/utils";
import { WalletRepository } from "../repositories/walletRepository";
import { Contract, ContractVtxo, ContractEventCallback, ContractEvent } from "./types";
import { isEventSourceError } from "../providers/utils";
import { getVtxosForContract } from "./vtxoOwnership";

/**
 * Configuration for the ContractWatcher.
 *
 * @see ContractWatcher
 *
 * @example
 * ```typescript
 * const watcher = new ContractWatcher({
 *   indexerProvider,
 *   walletRepository,
 * })
 * ```
 */
export interface ContractWatcherConfig {
    /** Indexer provider used for subscriptions and queries. */
    indexerProvider: IndexerProvider;

    /** Wallet repository used to store virtual output state between watcher updates. */
    walletRepository: WalletRepository;

    /**
     * Interval for failsafe polling (ms).
     * Polls even when subscription is active to catch missed events.
     *
     * @defaultValue `60_000` (1 minute)
     */
    failsafePollIntervalMs?: number;

    /**
     * Initial reconnection delay (ms).
     * Uses exponential backoff on repeated failures.
     *
     * @defaultValue `1_000` (1 second)
     */
    reconnectDelayMs?: number;

    /**
     * Maximum reconnection delay (ms).
     *
     * @defaultValue `30_000` (30 seconds)
     */
    maxReconnectDelayMs?: number;

    /**
     * Maximum reconnection attempts before giving up.
     * Set to 0 for unlimited attempts.
     *
     * @defaultValue `0` (unlimited)
     */
    maxReconnectAttempts?: number;
}

/**
 * Internal state for tracking contracts.
 */
interface ContractState {
    contract: Contract;

    /** Last known virtual outputs keyed by `txid:vout`. */
    lastKnownVtxos: Map<string, VirtualCoin>;
}

/**
 * Connection state for the watcher.
 */
type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/**
 * Watches multiple contracts for virtual output state changes with resilient connection handling.
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Failsafe polling to catch missed events
 * - Polls immediately after (re)connection to sync state
 * - Graceful handling of subscription failures
 *
 * @example
 * ```typescript
 * const watcher = new ContractWatcher({
 *   indexerProvider: wallet.indexerProvider,
 * });
 *
 * // Add the wallet's default contract
 * await watcher.addContract(defaultContract);
 *
 * // Add additional contracts (swaps, etc.)
 * await watcher.addContract(swapContract);
 *
 * // Start watching for events
 * const stop = await watcher.startWatching((event) => {
 *   console.log(`${event.type} on contract ${event.contractScript}`);
 * });
 *
 * // Later: stop watching
 * stop();
 * ```
 */
export class ContractWatcher {
    private config: Required<Omit<ContractWatcherConfig, "walletRepository">> &
        Pick<ContractWatcherConfig, "walletRepository">;
    private contracts: Map<string, ContractState> = new Map();
    private subscriptionId?: string;
    private abortController?: AbortController;
    private isWatching = false;
    private eventCallback?: ContractEventCallback;
    private connectionState: ConnectionState = "disconnected";
    private reconnectAttempts = 0;
    private reconnectTimeoutId?: ReturnType<typeof setTimeout>;
    private failsafePollIntervalId?: ReturnType<typeof setInterval>;

    /**
     * Create a contract watcher with the given providers and polling settings.
     *
     * @param config - Contract watcher configuration
     * @see ContractWatcherConfig
     */
    constructor(config: ContractWatcherConfig) {
        this.config = {
            failsafePollIntervalMs: 60_000, // 1 minute
            reconnectDelayMs: 1000, // 1 second
            maxReconnectDelayMs: 30_000, // 30 seconds
            maxReconnectAttempts: 0, // unlimited
            ...config,
        };
    }

    /**
     * Add a contract to be watched.
     *
     * Active contracts are immediately subscribed.
     *
     * All contracts are polled to discover any existing virtual outputs
     * (which may cause them to be watched even if inactive).
     */
    async addContract(contract: Contract): Promise<void> {
        const state: ContractState = {
            contract,
            lastKnownVtxos: new Map(),
        };

        this.contracts.set(contract.script, state);

        // Seed the baseline from the repository BEFORE any poll or event
        // emits. Without this, the first poll after (re)start treats every
        // persisted vtxo as "new" and emits `vtxo_received` for each —
        // which downstream triggers a redundant per-vtxo sync on every
        // app launch and can confuse consumers that react to the event.
        await this.seedLastKnownVtxos(state);

        // If we're already watching, poll to discover virtual outputs and update subscription
        if (this.isWatching) {
            // Poll first to discover virtual outputs (may affect whether we watch this contract).
            await this.pollContracts([contract.script]);
            // Update subscription based on active state and virtual outputs.
            await this.tryUpdateSubscription();
        }
    }

    /**
     * Pre-populate `lastKnownVtxos` from the wallet repository.
     *
     * Runs on add (and can be re-run after reconnect) so polling always
     * compares the indexer's view against what is already persisted,
     * emitting only genuine deltas.
     */
    private async seedLastKnownVtxos(state: ContractState): Promise<void> {
        try {
            // Apply the same script gate used by getContractVtxos so a legacy
            // wrong-script row in the address bucket can't seed the baseline
            // and then look "spent" on the first poll.
            const cached = await getVtxosForContract(this.config.walletRepository, state.contract);
            for (const vtxo of cached) {
                if (vtxo.isSpent) continue;
                const key = `${vtxo.txid}:${vtxo.vout}`;
                state.lastKnownVtxos.set(key, vtxo);
            }
        } catch (error) {
            // Don't throw — the watcher can still recover via poll and
            // subscription events. A failed seed just means the first poll
            // may emit some redundant `vtxo_received` events for already
            // known vtxos.
            console.error(
                `ContractWatcher: failed to seed lastKnownVtxos for ${state.contract.script}`,
                error,
            );
        }
    }

    /**
     * Update an existing contract.
     */
    async updateContract(contract: Contract): Promise<void> {
        const existing = this.contracts.get(contract.script);
        if (!existing) {
            throw new Error(`Contract ${contract.script} not found`);
        }

        existing.contract = contract;

        if (this.isWatching) {
            await this.tryUpdateSubscription();
        }
    }

    /**
     * Remove a contract from watching.
     */
    async removeContract(contractScript: string): Promise<void> {
        const state = this.contracts.get(contractScript);
        if (state) {
            this.contracts.delete(contractScript);

            if (this.isWatching) {
                await this.tryUpdateSubscription();
            }
        }
    }

    /**
     * Get all in-memory contracts.
     */
    getAllContracts(): Contract[] {
        return Array.from(this.contracts.values()).map((s) => s.contract);
    }

    /**
     * Contracts the watcher is actually tracking:
     * - all active contracts, plus
     * - inactive contracts that still hold known virtual outputs
     *   (the subscription keeps watching them so `vtxo_spent` events for
     *   those unspent outputs are still observed).
     *
     * This is the single source of truth for "contracts whose VTXO state
     * we still care about" — callers and the subscription itself fan out
     * over the same set so nothing is reconciled that isn't also watched.
     */
    getWatchedContracts(): Contract[] {
        return Array.from(this.contracts.values())
            .filter((s) => s.contract.state === "active" || s.lastKnownVtxos.size > 0)
            .map((s) => s.contract);
    }

    /**
     * Get virtual outputs for contracts, grouped by contract script.
     * @see WalletRepository for `repo`
     */
    private async getContractVtxos(options: {
        includeSpent?: boolean;
        contractScripts?: string[];
    }): Promise<Map<string, ContractVtxo[]>> {
        const { contractScripts, includeSpent } = options;
        const repo = this.config.walletRepository;

        const contractsToQuery = Array.from(this.contracts.values());

        const asyncResults = contractsToQuery
            .filter((_) => {
                if (contractScripts && !contractScripts.includes(_.contract.script)) return false;
                return true;
            })
            .map(async (state): Promise<[[string, ContractVtxo[]]] | []> => {
                // Use contract address as cache key. Legacy address buckets
                // can contain rows from other contracts; gate by script before
                // converting so a wrong-script row never reaches the watcher.
                const cached = await getVtxosForContract(repo, state.contract);
                if (cached.length > 0) {
                    // Convert to ContractVtxo with contractScript
                    const contractVtxos: ContractVtxo[] = cached.map((v) => ({
                        ...v,
                        contractScript: state.contract.script,
                    }));
                    const filtered = includeSpent
                        ? contractVtxos
                        : contractVtxos.filter((v) => !v.isSpent);
                    return [[state.contract.script, filtered]];
                }
                return [];
            });

        const results = await Promise.all(asyncResults);
        return new Map(results.flat(1));
    }

    /**
     * Start watching for virtual output events across all active contracts.
     */
    async startWatching(callback: ContractEventCallback): Promise<() => void> {
        if (this.isWatching) {
            throw new Error("Already watching");
        }

        this.eventCallback = callback;
        this.isWatching = true;
        this.abortController = new AbortController();
        this.reconnectAttempts = 0;

        // Start connection
        await this.connect();

        // Start failsafe polling
        this.startFailsafePolling();

        return () => this.stopWatching();
    }

    /**
     * Stop watching for events.
     */
    async stopWatching(): Promise<void> {
        this.isWatching = false;
        this.connectionState = "disconnected";
        this.abortController?.abort();

        // Clear timers
        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = undefined;
        }
        if (this.failsafePollIntervalId) {
            clearInterval(this.failsafePollIntervalId);
            this.failsafePollIntervalId = undefined;
        }

        // Unsubscribe
        if (this.subscriptionId) {
            try {
                await this.config.indexerProvider.unsubscribeForScripts(this.subscriptionId);
            } catch {
                // Ignore unsubscribe errors
            }
            this.subscriptionId = undefined;
        }

        this.eventCallback = undefined;
    }

    /**
     * Check if currently watching.
     */
    isCurrentlyWatching(): boolean {
        return this.isWatching;
    }

    /**
     * Get current connection state.
     */
    getConnectionState(): ConnectionState {
        return this.connectionState;
    }

    /**
     * Force a poll of all active contracts.
     * Useful for manual refresh or after app resume.
     */
    async forcePoll(): Promise<void> {
        if (!this.isWatching) return;
        await this.pollAllContracts();
    }

    /**
     * Connect to the subscription.
     *
     * @param skipUpdate - Skip the leading `updateSubscription` call when
     *   the caller has already established `subscriptionId`.
     */
    private async connect(skipUpdate = false): Promise<void> {
        if (!this.isWatching) return;

        this.connectionState = "connecting";

        try {
            if (!skipUpdate) {
                await this.updateSubscription();
            }

            // Poll immediately after connection to sync state
            await this.pollAllContracts();

            this.connectionState = "connected";
            this.reconnectAttempts = 0;

            // Start listening
            this.listenLoop().catch((e) => {
                // This is handled asynchronously otherwise `connect()` would hang
                // indefinitely and block the caller.
                // Error management must be implemented to ensure the connection
                // is restored and events are fired.
                if (isEventSourceError(e)) {
                    console.debug("ContractWatcher subscription disconnected; reconnecting");
                } else {
                    console.error(e);
                }
                this.connectionState = "disconnected";
                this.eventCallback?.({
                    type: "connection_reset",
                    timestamp: Date.now(),
                });
                this.scheduleReconnect();
            });
        } catch (error) {
            console.error("ContractWatcher connection failed:", error);
            this.connectionState = "disconnected";
            this.eventCallback?.({
                type: "connection_reset",
                timestamp: Date.now(),
            });
            this.scheduleReconnect();
        }
    }

    /**
     * Schedule a reconnection attempt.
     */
    private scheduleReconnect(): void {
        if (!this.isWatching) return;

        // Check max attempts
        if (
            this.config.maxReconnectAttempts > 0 &&
            this.reconnectAttempts >= this.config.maxReconnectAttempts
        ) {
            console.error(
                `ContractWatcher: Max reconnection attempts (${this.config.maxReconnectAttempts}) reached`,
            );
            return;
        }

        this.connectionState = "reconnecting";
        this.reconnectAttempts++;

        // Calculate delay with exponential backoff
        const delay = Math.min(
            this.config.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1),
            this.config.maxReconnectDelayMs,
        );

        this.reconnectTimeoutId = setTimeout(() => {
            this.reconnectTimeoutId = undefined;
            this.connect();
        }, delay);
    }

    /**
     * Start the failsafe polling interval.
     */
    private startFailsafePolling(): void {
        if (this.failsafePollIntervalId) {
            clearInterval(this.failsafePollIntervalId);
        }

        this.failsafePollIntervalId = setInterval(() => {
            if (this.isWatching) {
                this.pollAllContracts().catch((error) => {
                    console.error("ContractWatcher failsafe poll failed:", error);
                });
            }
        }, this.config.failsafePollIntervalMs);
    }

    private async pollAllContracts(): Promise<void> {
        const scripts = this.getWatchedContracts().map((c) => c.script);
        if (scripts.length === 0) return;
        await this.pollContracts(scripts);
    }

    /**
     * Poll specific contracts and emit events for changes.
     */
    private async pollContracts(contractScripts: string[]): Promise<void> {
        if (!this.eventCallback) return;

        const now = Date.now();

        try {
            // Load all the virtual outputs for these contracts, from DB
            const vtxosMap = await this.getContractVtxos({
                contractScripts,
                includeSpent: false, // only spendable ones!
            });

            for (const contractScript of contractScripts) {
                const state = this.contracts.get(contractScript);
                if (!state) continue;

                const currentVtxos = vtxosMap.get(contractScript) || [];
                const currentKeys = new Set(currentVtxos.map((v) => `${v.txid}:${v.vout}`));

                // Find new virtual outputs and add them to the contract's state
                const newVtxos: VirtualCoin[] = [];
                for (const vtxo of currentVtxos) {
                    const key = `${vtxo.txid}:${vtxo.vout}`;
                    if (!state.lastKnownVtxos.has(key)) {
                        newVtxos.push(vtxo);
                        state.lastKnownVtxos.set(key, vtxo);
                    }
                }

                // Find spent virtual outputs and remove them from the contract's state
                const spentVtxos: VirtualCoin[] = [];
                for (const [key, vtxo] of state.lastKnownVtxos) {
                    if (!currentKeys.has(key)) {
                        spentVtxos.push(vtxo);
                        state.lastKnownVtxos.delete(key);
                    }
                }

                // Emit events
                if (newVtxos.length > 0) {
                    this.emitVtxoEvent(contractScript, newVtxos, "vtxo_received", now);
                }

                if (spentVtxos.length > 0) {
                    // Note: We can't distinguish spent vs swept from polling alone
                    // The subscription provides more accurate event types
                    this.emitVtxoEvent(contractScript, spentVtxos, "vtxo_spent", now);
                }
            }
        } catch (error) {
            console.error("ContractWatcher poll failed:", error);
            // Don't throw - polling failures shouldn't crash the watcher
        }
    }

    private async tryUpdateSubscription() {
        const hadSubscription = this.subscriptionId !== undefined;
        try {
            await this.updateSubscription();
        } catch (error) {
            // nothing, the connection will be retried later
            return;
        }

        // Cold start: `startWatching` may have run with zero scripts,
        // leaving `listenLoop` parked behind the reconnect timer. Kick
        // `connect` now so streaming resumes without waiting on the
        // backoff. `skipUpdate` avoids re-issuing `subscribeForScripts`.
        const justGotSubscription = !hadSubscription && this.subscriptionId !== undefined;
        const listenerParked =
            this.connectionState === "disconnected" || this.connectionState === "reconnecting";
        if (this.isWatching && justGotSubscription && listenerParked) {
            if (this.reconnectTimeoutId) {
                clearTimeout(this.reconnectTimeoutId);
                this.reconnectTimeoutId = undefined;
            }
            this.reconnectAttempts = 0;
            this.connect(true).catch((error) => {
                console.warn("ContractWatcher cold-start connect failed:", error);
            });
        }
    }

    /**
     * Update the subscription with scripts that should be watched.
     *
     * Watches both active contracts and contracts with virtual outputs.
     */
    private async updateSubscription(): Promise<void> {
        const scriptsToWatch = this.getWatchedContracts().map((c) => c.script);

        if (scriptsToWatch.length === 0) {
            if (this.subscriptionId) {
                try {
                    await this.config.indexerProvider.unsubscribeForScripts(this.subscriptionId);
                } catch {
                    // Ignore
                }
                this.subscriptionId = undefined;
            }
            return;
        }

        try {
            this.subscriptionId = await this.config.indexerProvider.subscribeForScripts(
                scriptsToWatch,
                this.subscriptionId,
            );
        } catch (error) {
            // If we sent a stale subscription ID that the server no longer
            // recognises, clear it and retry to create a fresh subscription.
            // The server currently returns HTTP 500 with a JSON body whose
            // message field looks like "subscription <uuid> not found".
            // All other errors (network failures, parse errors, etc.) are rethrown.
            const isStale =
                error instanceof Error && /subscription\s+\S+\s+not\s+found/i.test(error.message);
            if (this.subscriptionId && isStale) {
                this.subscriptionId = undefined;
                this.subscriptionId =
                    await this.config.indexerProvider.subscribeForScripts(scriptsToWatch);
            } else {
                throw error;
            }
        }
    }

    /**
     * Main listening loop for subscription events.
     */
    private async listenLoop(): Promise<void> {
        if (!this.subscriptionId || !this.abortController || !this.isWatching) {
            if (this.isWatching) {
                this.connectionState = "disconnected";
                this.scheduleReconnect();
            }
            return;
        }

        const subscription = this.config.indexerProvider.getSubscription(
            this.subscriptionId,
            this.abortController.signal,
        );

        for await (const update of subscription) {
            if (!this.isWatching) break;
            this.handleSubscriptionUpdate(update);
        }

        // Stream ended normally - reconnect if still watching
        if (this.isWatching) {
            this.connectionState = "disconnected";
            this.scheduleReconnect();
        }
    }

    /**
     * Handle a subscription update.
     */
    private handleSubscriptionUpdate(update: SubscriptionResponse): void {
        if (!this.eventCallback) return;

        const timestamp = Date.now();

        if (update.newVtxos?.length) {
            this.processSubscriptionVtxos(update.newVtxos, "vtxo_received", timestamp);
        }

        if (update.spentVtxos?.length) {
            this.processSubscriptionVtxos(update.spentVtxos, "vtxo_spent", timestamp);
        }
    }

    /**
     * Process virtual outputs from subscription and route each VTXO to the
     * single contract that actually locks it via `vtxo.script`. If the script
     * doesn't match any watched contract, skip the VTXO rather than fan it
     * out to every matching contract — fan-out produced phantom state in
     * non-owning contracts that then never reconciled.
     */
    private processSubscriptionVtxos(
        vtxos: VirtualCoin[],
        eventType: ContractEvent["type"],
        timestamp: number,
    ): void {
        const byContract = new Map<string, VirtualCoin[]>();
        let unknownScript = 0;
        for (const vtxo of vtxos) {
            if (!this.contracts.has(vtxo.script)) {
                unknownScript++;
                continue;
            }
            let bucket = byContract.get(vtxo.script);
            if (!bucket) {
                bucket = [];
                byContract.set(vtxo.script, bucket);
            }
            bucket.push(vtxo);
        }

        if (unknownScript > 0) {
            // The failsafe poll is the backstop for these; log at debug so we
            // can correlate "VTXO state drift" reports with subscription
            // drops rather than chase phantom bugs.
            console.debug(
                `ContractWatcher.processSubscriptionVtxos[${eventType}]: dropped ${unknownScript} unknown-script VTXOs (${vtxos.length} total)`,
            );
        }

        for (const [contractScript, bucketVtxos] of byContract) {
            const state = this.contracts.get(contractScript);
            if (state) {
                for (const vtxo of bucketVtxos) {
                    const key = `${vtxo.txid}:${vtxo.vout}`;
                    if (eventType === "vtxo_received") {
                        state.lastKnownVtxos.set(key, vtxo);
                    } else if (eventType === "vtxo_spent") {
                        state.lastKnownVtxos.delete(key);
                    }
                }
            }
            this.emitVtxoEvent(contractScript, bucketVtxos, eventType, timestamp);
        }
    }

    /**
     * Emit a virtual output event for a contract.
     */
    private emitVtxoEvent(
        contractScript: string,
        vtxos: VirtualCoin[],
        eventType: ContractEvent["type"],
        timestamp: number,
    ): void {
        if (!this.eventCallback) return;
        const state = this.contracts.get(contractScript);
        if (!state) return;

        const extended: ContractVtxo[] = [];
        for (const v of vtxos) {
            try {
                const extendedVtxo = extendVirtualCoinForContract(v, state.contract);
                extended.push({ ...extendedVtxo, contractScript });
            } catch (err) {
                console.warn(`failed to extend vtxo ${v.txid}:${v.vout}`, err);
                extended.push({ ...v, contractScript });
            }
        }

        switch (eventType) {
            case "vtxo_received":
                this.eventCallback({
                    type: "vtxo_received",
                    vtxos: extended,
                    contractScript,
                    contract: state.contract,
                    timestamp,
                });
                return;
            case "vtxo_spent":
                this.eventCallback({
                    type: "vtxo_spent",
                    vtxos: extended,
                    contractScript,
                    contract: state.contract,
                    timestamp,
                });
                return;
            default:
                return;
        }
    }
}
