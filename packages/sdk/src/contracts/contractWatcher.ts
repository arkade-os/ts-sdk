import { IndexerProvider, SubscriptionResponse } from "../providers/indexer";
import { VirtualCoin } from "../wallet";
import { getAllNormalizedVtxos, isVtxoSpent, isPastExpiry, normalizeVtxo } from "../wallet/vtxo";
import { extendVirtualCoinForContract } from "../wallet/utils";
import { WalletRepository } from "../repositories/walletRepository";
import {
    Contract,
    ContractVtxo,
    ContractEventCallback,
    ContractEvent,
    WatchedScript,
    isWatchedContract,
} from "./types";
import { isEventSourceError } from "../providers/utils";
import { isEventSourceUnavailableError } from "../providers/eventSource";
import { getVtxosForContract } from "./vtxoOwnership";

/** Exponential reconnect backoff: `baseMs * 2^(attempt-1)`, capped at `maxMs`. */
export function computeReconnectDelay(attempt: number, baseMs: number, maxMs: number): number {
    return Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
}

/**
 * Default tunables for {@link ContractWatcher}. Kept low so a wallet re-syncs promptly after its
 * subscription drops (e.g. a server restart for an operator signer rotation).
 */
export const DEFAULT_CONTRACT_WATCHER_CONFIG = {
    failsafePollIntervalMs: 20_000,
    reconnectDelayMs: 1_000,
    maxReconnectDelayMs: 5_000,
    maxReconnectAttempts: 0, // unlimited
};

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
     * Failsafe polling interval (ms); polls even while subscribed, to catch missed events.
     *
     * @defaultValue `20_000` (20 seconds)
     */
    failsafePollIntervalMs?: number;

    /**
     * Initial reconnection delay (ms), backed off exponentially on repeated failures.
     *
     * @defaultValue `1_000` (1 second)
     */
    reconnectDelayMs?: number;

    /**
     * Maximum reconnection delay (ms).
     *
     * @defaultValue `5_000` (5 seconds)
     */
    maxReconnectDelayMs?: number;

    /**
     * Maximum reconnection attempts before giving up; 0 for unlimited.
     *
     * @defaultValue `0` (unlimited)
     */
    maxReconnectAttempts?: number;
}

interface ContractState {
    contract: Contract;

    /** Last known virtual outputs keyed by `txid:vout`. */
    lastKnownVtxos: Map<string, VirtualCoin>;
}

/** No `Contract` — that absence is the ownership boundary. */
interface WatchedScriptState {
    label?: string;
    lastKnownVtxos: Map<string, VirtualCoin>;
}

type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

/**
 * Watches contracts for virtual output changes: subscription with exponential-backoff reconnect,
 * a poll after every (re)connect, and failsafe polling for missed events.
 *
 * Event-only: it reads the wallet repository for baselines but never writes it;
 * `ContractManager` owns persistence.
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
    /** In-memory and process-lifetime; never persisted. */
    private watchedScripts: Map<string, WatchedScriptState> = new Map();
    private subscriptionId?: string;
    private abortController?: AbortController;
    private isWatching = false;
    private eventCallback?: ContractEventCallback;
    private connectionState: ConnectionState = "disconnected";
    private reconnectAttempts = 0;
    private reconnectTimeoutId?: ReturnType<typeof setTimeout>;
    private failsafePollIntervalId?: ReturnType<typeof setInterval>;
    /** See {@link withCoalescedSubscription}. */
    private subscriptionBatchDepth = 0;
    private subscriptionUpdateDeferred = false;
    /** See {@link reportEventSourceUnavailable} — said once, not per attempt. */
    private eventSourceReported = false;

    /** @see ContractWatcherConfig */
    constructor(config: ContractWatcherConfig) {
        this.config = {
            ...DEFAULT_CONTRACT_WATCHER_CONFIG,
            ...config,
        };
    }

    /**
     * Add a contract to be watched. Every contract is subscribed and polled whatever its
     * {@link ContractState}, except a `retained` one, which is held for reads only.
     *
     * @see getWatchedContracts
     */
    async addContract(contract: Contract): Promise<void> {
        const state: ContractState = {
            contract,
            lastKnownVtxos: new Map(),
        };

        this.contracts.set(contract.script, state);

        // Seed BEFORE any poll, or every persisted vtxo is re-announced as `vtxo_received` on
        // each launch.
        await this.seedLastKnownVtxos(state);

        if (this.isWatching && isWatchedContract(contract)) {
            await this.pollContracts([contract.script]);
            await this.tryUpdateSubscription();
        }
    }

    /** Pre-populate `lastKnownVtxos` from the wallet repository so polls emit only real deltas. */
    private async seedLastKnownVtxos(state: ContractState): Promise<void> {
        try {
            // Script-gated, so a legacy wrong-script row in the address bucket can't seed the
            // baseline and then look "spent" on the first poll.
            const cached = await getVtxosForContract(this.config.walletRepository, state.contract);
            for (const vtxo of cached) {
                if (vtxo.isSpent) continue;
                const key = `${vtxo.txid}:${vtxo.vout}`;
                state.lastKnownVtxos.set(key, vtxo);
            }
        } catch (error) {
            // Non-fatal: at worst the first poll re-emits some `vtxo_received`.
            console.error(
                `ContractWatcher: failed to seed lastKnownVtxos for ${state.contract.script}`,
                error,
            );
        }
    }

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

    async removeContract(contractScript: string): Promise<void> {
        const state = this.contracts.get(contractScript);
        if (state) {
            this.contracts.delete(contractScript);

            if (this.isWatching) {
                await this.tryUpdateSubscription();
            }
        }
    }

    /** All in-memory contracts. */
    getAllContracts(): Contract[] {
        return Array.from(this.contracts.values()).map((s) => s.contract);
    }

    /**
     * Every registered contract except `retained` ones, retired (`inactive`) addresses included.
     *
     * Feeds both the subscription and the sweep scope. `state` must never narrow it: an Ark
     * receive address can be paid again after the wallet rotated past it, and such a payment
     * would stay invisible. Only an owner's explicit {@link ContractWatchState} narrows it; the
     * row stays in {@link getAllContracts} for reads, annotation and history.
     */
    getWatchedContracts(): Contract[] {
        return this.getAllContracts().filter(isWatchedContract);
    }

    /** Scripts the subscription carries; wider than the sync scope {@link getWatchedContracts}. */
    private getSubscribedScripts(): string[] {
        const scripts = new Set(this.getWatchedContracts().map((c) => c.script));
        for (const script of this.watchedScripts.keys()) {
            scripts.add(script);
        }
        return Array.from(scripts);
    }

    /** @see IContractManager.watchScript for the delivery and filter contract. */
    async addWatchedScript(script: string | string[], options?: { label?: string }): Promise<void> {
        const added: string[] = [];
        for (const one of Array.isArray(script) ? script : [script]) {
            const existing = this.watchedScripts.get(one);
            if (existing) {
                // Idempotent, so callers can re-derive their whole set on a timer.
                if (options?.label !== undefined) existing.label = options.label;
                continue;
            }

            this.watchedScripts.set(one, {
                label: options?.label,
                lastKnownVtxos: new Map(),
            });
            added.push(one);
        }

        if (added.length === 0 || !this.isWatching) return;

        await this.withCoalescedSubscription(async () => {
            // The catch-up a coalesced scope demands (see withCoalescedSubscription): reports
            // outputs already sitting at these scripts before the deferred flush.
            await this.pollWatchedScripts(added);
            // Inside the scope: it only flushes an update something requested.
            await this.tryUpdateSubscription();
        });
    }

    /** Stop watching a script added by {@link addWatchedScript}. */
    async removeWatchedScript(script: string | string[]): Promise<void> {
        let removed = false;
        for (const one of Array.isArray(script) ? script : [script]) {
            if (this.watchedScripts.delete(one)) removed = true;
        }
        if (!removed) return;

        if (this.isWatching) {
            await this.tryUpdateSubscription();
        }
    }

    /** Every script registered via {@link addWatchedScript}. */
    getWatchedScripts(): WatchedScript[] {
        return Array.from(this.watchedScripts.entries()).map(([script, state]) => ({
            script,
            label: state.label,
        }));
    }

    /** Repository virtual outputs for contracts, grouped by contract script. */
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
                // Script-gated: legacy address buckets can hold other contracts' rows.
                const cached = await getVtxosForContract(repo, state.contract);
                if (cached.length > 0) {
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

    /** Start watching for virtual output events across all watched contracts. */
    async startWatching(callback: ContractEventCallback): Promise<() => void> {
        if (this.isWatching) {
            throw new Error("Already watching");
        }

        this.eventCallback = callback;
        this.isWatching = true;
        this.abortController = new AbortController();
        this.reconnectAttempts = 0;

        await this.connect();

        this.startFailsafePolling();

        return () => this.stopWatching();
    }

    async stopWatching(): Promise<void> {
        this.isWatching = false;
        this.connectionState = "disconnected";
        this.abortController?.abort();

        if (this.reconnectTimeoutId) {
            clearTimeout(this.reconnectTimeoutId);
            this.reconnectTimeoutId = undefined;
        }
        if (this.failsafePollIntervalId) {
            clearInterval(this.failsafePollIntervalId);
            this.failsafePollIntervalId = undefined;
        }

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

    isCurrentlyWatching(): boolean {
        return this.isWatching;
    }

    getConnectionState(): ConnectionState {
        return this.connectionState;
    }

    /** Force a poll of all watched contracts (manual refresh, app resume). */
    async forcePoll(): Promise<void> {
        if (!this.isWatching) return;
        await this.pollAllContracts();
    }

    /** @param skipUpdate - The caller already established `subscriptionId`. */
    private async connect(skipUpdate = false): Promise<void> {
        if (!this.isWatching) return;

        this.connectionState = "connecting";

        try {
            if (!skipUpdate) {
                await this.updateSubscription();
            }

            await this.pollAllContracts();

            this.connectionState = "connected";
            this.reconnectAttempts = 0;

            // Not awaited, or `connect()` would never return; errors here must still reconnect.
            this.listenLoop().catch((e) => {
                if (isEventSourceError(e)) {
                    console.debug("ContractWatcher subscription disconnected; reconnecting");
                } else if (!isEventSourceUnavailableError(e)) {
                    console.error(e);
                }
                this.connectionState = "disconnected";
                if (this.reportEventSourceUnavailable(e)) return;
                this.eventCallback?.({
                    type: "connection_reset",
                    timestamp: Date.now(),
                });
                this.scheduleReconnect();
            });
        } catch (error) {
            if (!isEventSourceUnavailableError(error)) {
                console.error("ContractWatcher connection failed:", error);
            }
            this.connectionState = "disconnected";
            if (this.reportEventSourceUnavailable(error)) return;
            this.eventCallback?.({
                type: "connection_reset",
                timestamp: Date.now(),
            });
            this.scheduleReconnect();
        }
    }

    /**
     * Handle "this environment has no `EventSource`": warn once and return true so the caller
     * skips reconnecting. A missing global is not a dropped connection; unlimited backoff would
     * retry forever and fire a `connection_reset` (read as "resync, stream coming back") every
     * few seconds.
     */
    private reportEventSourceUnavailable(error: unknown): boolean {
        if (!isEventSourceUnavailableError(error)) return false;
        if (!this.eventSourceReported) {
            this.eventSourceReported = true;
            console.warn(
                `ContractWatcher: contract events are OFF and will not be retried — ` +
                    `the wallet's own contracts update only when it syncs (reads, refreshVtxos()); ` +
                    `watch-only scripts are still polled. ` +
                    error.message,
            );
        }
        return true;
    }

    private scheduleReconnect(): void {
        if (!this.isWatching) return;

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

        const delay = computeReconnectDelay(
            this.reconnectAttempts,
            this.config.reconnectDelayMs,
            this.config.maxReconnectDelayMs,
        );

        this.reconnectTimeoutId = setTimeout(() => {
            this.reconnectTimeoutId = undefined;
            this.connect();
        }, delay);
    }

    /** Replays repository state — only what a sync stored; watch-only scripts poll the indexer. */
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
        if (scripts.length > 0) {
            await this.pollContracts(scripts);
        }
        await this.pollWatchedScripts(Array.from(this.watchedScripts.keys()));
    }

    /**
     * Poll watch-only scripts against the indexer and emit the delta. Not {@link pollContracts}:
     * that diffs the wallet repository, permanently empty for a script the wallet doesn't own, so
     * every live output would read as spent.
     */
    private async pollWatchedScripts(candidates: string[]): Promise<void> {
        if (!this.eventCallback) return;

        // Same precedence as processSubscriptionVtxos: a `retained` contract is polled here.
        const scripts = candidates.filter((s) => {
            const state = this.contracts.get(s);
            return (
                this.watchedScripts.has(s) &&
                (state === undefined || !isWatchedContract(state.contract))
            );
        });
        if (scripts.length === 0) return;

        const now = Date.now();

        let current: VirtualCoin[];
        try {
            current = await getAllNormalizedVtxos(this.config.indexerProvider, scripts, {
                spendableOnly: true,
            });
        } catch (error) {
            // Fail closed: treating a rejection as empty would emit `vtxo_spent` for everything.
            console.error("ContractWatcher watch-only poll failed:", error);
            return;
        }

        const byScript = new Map<string, VirtualCoin[]>();
        for (const vtxo of current) {
            let bucket = byScript.get(vtxo.script);
            if (!bucket) {
                bucket = [];
                byScript.set(vtxo.script, bucket);
            }
            bucket.push(vtxo);
        }

        for (const script of scripts) {
            const state = this.watchedScripts.get(script);
            if (!state) continue;

            const currentVtxos = byScript.get(script) || [];
            const currentKeys = new Set(currentVtxos.map((v) => `${v.txid}:${v.vout}`));

            const newVtxos: VirtualCoin[] = [];
            for (const vtxo of currentVtxos) {
                const key = `${vtxo.txid}:${vtxo.vout}`;
                if (!state.lastKnownVtxos.has(key)) {
                    newVtxos.push(vtxo);
                    state.lastKnownVtxos.set(key, vtxo);
                }
            }

            const spentVtxos: VirtualCoin[] = [];
            for (const [key, vtxo] of state.lastKnownVtxos) {
                if (!currentKeys.has(key)) {
                    spentVtxos.push(vtxo);
                    state.lastKnownVtxos.delete(key);
                }
            }

            if (newVtxos.length > 0) {
                this.emitWatchedScriptEvent(script, newVtxos, "vtxo_received", now);
            }

            if (spentVtxos.length > 0) {
                this.emitWatchedScriptEvent(script, spentVtxos, "vtxo_spent", now);
            }
        }
    }

    /** Poll specific contracts' repository state and emit events for changes. */
    private async pollContracts(contractScripts: string[]): Promise<void> {
        if (!this.eventCallback) return;

        const now = Date.now();

        try {
            // Spent rows too, so a spend is reported with the row that records it; the cached
            // baseline row was unspent (#864).
            const vtxosMap = await this.getContractVtxos({
                contractScripts,
                includeSpent: true,
            });

            for (const contractScript of contractScripts) {
                const state = this.contracts.get(contractScript);
                if (!state) continue;

                const known = vtxosMap.get(contractScript) || [];
                const knownByKey = new Map(known.map((v) => [`${v.txid}:${v.vout}`, v]));
                // the diff below is still against the unspent set
                const currentVtxos = known.filter((v) => !v.isSpent);
                const currentKeys = new Set(currentVtxos.map((v) => `${v.txid}:${v.vout}`));

                const newVtxos: VirtualCoin[] = [];
                for (const vtxo of currentVtxos) {
                    const key = `${vtxo.txid}:${vtxo.vout}`;
                    if (!state.lastKnownVtxos.has(key)) {
                        newVtxos.push(vtxo);
                        state.lastKnownVtxos.set(key, vtxo);
                    }
                }

                const spentVtxos: VirtualCoin[] = [];
                for (const [key, vtxo] of state.lastKnownVtxos) {
                    if (!currentKeys.has(key)) {
                        // the cached row only when storage has nothing fresher
                        spentVtxos.push(knownByKey.get(key) ?? vtxo);
                        state.lastKnownVtxos.delete(key);
                    }
                }

                if (newVtxos.length > 0) {
                    this.emitVtxoEvent(contractScript, newVtxos, "vtxo_received", now);
                }

                if (spentVtxos.length > 0) {
                    // Polling can't tell spent from swept; the subscription can.
                    this.emitVtxoEvent(contractScript, spentVtxos, "vtxo_spent", now);
                }
            }
        } catch (error) {
            console.error("ContractWatcher poll failed:", error);
        }
    }

    /**
     * Run `fn` with subscription updates coalesced into one `subscribeForScripts` on the way out
     * (success or error). Each subscribe posts the *whole* script list, so N eager updates would
     * be quadratic.
     *
     * A contract added inside the scope isn't streaming until the flush, and the failsafe poll
     * only replays repository state. Callers must supply their own catch-up (`Wallet.restore`
     * follows `scanContracts` with a bulk `refreshVtxos`) or keep the scope short.
     */
    async withCoalescedSubscription<T>(fn: () => Promise<T>): Promise<T> {
        this.subscriptionBatchDepth++;
        try {
            return await fn();
        } finally {
            this.subscriptionBatchDepth--;
            if (this.subscriptionBatchDepth === 0 && this.subscriptionUpdateDeferred) {
                this.subscriptionUpdateDeferred = false;
                // Never throws, so a flush cannot mask an error `fn` is rejecting with.
                if (this.isWatching) await this.tryUpdateSubscription();
            }
        }
    }

    private async tryUpdateSubscription() {
        if (this.subscriptionBatchDepth > 0) {
            this.subscriptionUpdateDeferred = true;
            return;
        }
        const hadSubscription = this.subscriptionId !== undefined;
        try {
            await this.updateSubscription();
        } catch (error) {
            // nothing, the connection will be retried later
            return;
        }

        // Cold start: `startWatching` may have run with zero scripts, parking `listenLoop` behind
        // the reconnect timer; connect now instead of waiting on the backoff.
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

    /** @see getSubscribedScripts */
    private async updateSubscription(): Promise<void> {
        const scriptsToWatch = this.getSubscribedScripts();

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
            // A stale subscription id: retry fresh. Matches both server phrasings,
            // "subscription <uuid> not found" and "subscription not found: <uuid>".
            const isStale =
                error instanceof Error && /subscription\b.*\bnot\s+found/i.test(error.message);
            if (this.subscriptionId && isStale) {
                this.subscriptionId = undefined;
                this.subscriptionId =
                    await this.config.indexerProvider.subscribeForScripts(scriptsToWatch);
            } else {
                throw error;
            }
        }
    }

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

        if (this.isWatching) {
            this.connectionState = "disconnected";
            this.scheduleReconnect();
        }
    }

    /**
     * Normalization boundary: a consumer `IndexerProvider` may yield legacy-shaped VTXOs, and the
     * normalized shape is what external event consumers receive.
     */
    private handleSubscriptionUpdate(update: SubscriptionResponse): void {
        if (!this.eventCallback) return;

        const timestamp = Date.now();

        if (update.newVtxos?.length) {
            this.processSubscriptionVtxos(
                update.newVtxos.map(normalizeVtxo),
                "vtxo_received",
                timestamp,
            );
        }

        if (update.spentVtxos?.length) {
            this.processSubscriptionVtxos(
                update.spentVtxos.map(normalizeVtxo),
                "vtxo_spent",
                timestamp,
            );
        }
    }

    /**
     * Route each subscription VTXO to the single contract locking it via `vtxo.script`, skipping
     * unknown scripts: fan-out produced phantom state in non-owning contracts.
     */
    private processSubscriptionVtxos(
        vtxos: VirtualCoin[],
        eventType: "vtxo_received" | "vtxo_spent",
        timestamp: number,
    ): void {
        const byContract = new Map<string, VirtualCoin[]>();
        const byWatchedScript = new Map<string, VirtualCoin[]>();
        let unknownScript = 0;
        const now = { timestamp: new Date() };
        for (const vtxo of vtxos) {
            const state = this.contracts.get(vtxo.script);
            const watchOnly = this.watchedScripts.has(vtxo.script);
            // A registered contract wins unless `retained`: a contract event would trigger
            // syncContracts and undo the owner's opt-out.
            const preferContract =
                state !== undefined && (!watchOnly || isWatchedContract(state.contract));
            const target = preferContract ? byContract : watchOnly ? byWatchedScript : undefined;
            if (!target) {
                unknownScript++;
                continue;
            }
            // Admit only what the spendable poll would return, or the next
            // tick reads the difference as a spend. Spends stay unfiltered.
            if (target === byWatchedScript && eventType === "vtxo_received") {
                const n = normalizeVtxo(vtxo);
                // No chain tip here: time-based expiry only.
                if (isVtxoSpent(n) || n.isSwept || isPastExpiry(n, now)) continue;
            }
            let bucket = target.get(vtxo.script);
            if (!bucket) {
                bucket = [];
                target.set(vtxo.script, bucket);
            }
            bucket.push(vtxo);
        }

        if (unknownScript > 0) {
            // The failsafe poll is the backstop; logged to correlate state-drift reports.
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

        for (const [script, bucketVtxos] of byWatchedScript) {
            const state = this.watchedScripts.get(script);
            if (state) {
                for (const vtxo of bucketVtxos) {
                    const key = `${vtxo.txid}:${vtxo.vout}`;
                    if (eventType === "vtxo_received") {
                        state.lastKnownVtxos.set(key, vtxo);
                    } else {
                        state.lastKnownVtxos.delete(key);
                    }
                }
            }
            this.emitWatchedScriptEvent(script, bucketVtxos, eventType, timestamp);
        }
    }

    /** As {@link emitVtxoEvent}, less the `contract` and the annotation. */
    private emitWatchedScriptEvent(
        script: string,
        vtxos: VirtualCoin[],
        eventType: "vtxo_received" | "vtxo_spent",
        timestamp: number,
    ): void {
        if (!this.eventCallback) return;
        if (eventType === "vtxo_received") {
            this.eventCallback({ type: "vtxo_received", contractScript: script, vtxos, timestamp });
            return;
        }
        this.eventCallback({ type: "vtxo_spent", contractScript: script, vtxos, timestamp });
    }

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
