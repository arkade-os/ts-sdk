import { IndexerProvider, SubscriptionResponse } from "../providers/indexer";
import { VirtualCoin, ExtendedVirtualCoin } from "../wallet";
import { WalletRepository } from "../repositories/walletRepository";
import {
    Contract,
    ContractVtxo,
    ContractEvent,
    ContractEventCallback,
    GetContractVtxosOptions,
    ContractBalance,
} from "./types";

/**
 * Configuration for the ContractWatcher.
 */
export interface ContractWatcherConfig {
    /** The indexer provider to use for subscriptions and queries */
    indexerProvider: IndexerProvider;

    /** The wallet repository for VTXO persistence (optional) */
    walletRepository?: WalletRepository;

    /**
     * Interval for failsafe polling (ms).
     * Polls even when subscription is active to catch missed events.
     * Default: 60000 (1 minute)
     */
    failsafePollIntervalMs?: number;

    /**
     * Initial reconnection delay (ms).
     * Uses exponential backoff on repeated failures.
     * Default: 1000 (1 second)
     */
    reconnectDelayMs?: number;

    /**
     * Maximum reconnection delay (ms).
     * Default: 30000 (30 seconds)
     */
    maxReconnectDelayMs?: number;

    /**
     * Maximum reconnection attempts before giving up.
     * Set to 0 for unlimited attempts.
     * Default: 0 (unlimited)
     */
    maxReconnectAttempts?: number;
}

/**
 * Internal state for tracking contracts.
 */
interface ContractState {
    contract: Contract;
    lastKnownVtxos: Map<string, VirtualCoin>; // "txid:vout" -> vtxo
}

/**
 * Connection state for the watcher.
 */
type ConnectionState =
    | "disconnected"
    | "connecting"
    | "connected"
    | "reconnecting";

/**
 * Watches multiple contracts for VTXO changes with resilient connection handling.
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
 *   console.log(`${event.type} on contract ${event.contractId}`);
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
    private scriptToContract: Map<string, string> = new Map(); // script -> contractId
    private subscriptionId?: string;
    private abortController?: AbortController;
    private isWatching = false;
    private eventCallback?: ContractEventCallback;
    private connectionState: ConnectionState = "disconnected";
    private reconnectAttempts = 0;
    private reconnectTimeoutId?: ReturnType<typeof setTimeout>;
    private failsafePollIntervalId?: ReturnType<typeof setInterval>;
    private lastPollTime = 0;

    constructor(config: ContractWatcherConfig) {
        this.config = {
            failsafePollIntervalMs: 60000, // 1 minute
            reconnectDelayMs: 1000, // 1 second
            maxReconnectDelayMs: 30000, // 30 seconds
            maxReconnectAttempts: 0, // unlimited
            ...config,
        };
    }

    /**
     * Add a contract to be watched.
     *
     * Active contracts are immediately subscribed. All contracts are polled
     * to discover any existing VTXOs (which may cause them to be watched
     * even if inactive).
     */
    async addContract(contract: Contract): Promise<void> {
        const state: ContractState = {
            contract,
            lastKnownVtxos: new Map(),
        };

        this.contracts.set(contract.id, state);
        this.scriptToContract.set(contract.script, contract.id);

        // If we're already watching, poll to discover VTXOs and update subscription
        if (this.isWatching) {
            // Poll first to discover VTXOs (may affect whether we watch this contract)
            await this.pollContracts([contract.id]);
            // Update subscription based on active state and VTXOs
            await this.updateSubscription();
        }
    }

    /**
     * Update an existing contract.
     */
    async updateContract(contract: Contract): Promise<void> {
        const existing = this.contracts.get(contract.id);
        if (!existing) {
            throw new Error(`Contract ${contract.id} not found`);
        }

        // If script changed, update the mapping
        if (existing.contract.script !== contract.script) {
            this.scriptToContract.delete(existing.contract.script);
            this.scriptToContract.set(contract.script, contract.id);
        }

        existing.contract = contract;

        if (this.isWatching) {
            await this.updateSubscription();
        }
    }

    /**
     * Remove a contract from watching.
     */
    async removeContract(contractId: string): Promise<void> {
        const state = this.contracts.get(contractId);
        if (state) {
            this.scriptToContract.delete(state.contract.script);
            this.contracts.delete(contractId);

            if (this.isWatching) {
                await this.updateSubscription();
            }
        }
    }

    /**
     * Set a contract's active state.
     */
    async setContractActive(
        contractId: string,
        active: boolean
    ): Promise<void> {
        const state = this.contracts.get(contractId);
        if (state) {
            state.contract.state = active ? "active" : "inactive";

            if (this.isWatching) {
                await this.updateSubscription();
            }
        }
    }

    /**
     * Get a contract by ID.
     */
    getContract(contractId: string): Contract | undefined {
        return this.contracts.get(contractId)?.contract;
    }

    /**
     * Get all contracts.
     */
    getAllContracts(): Contract[] {
        return Array.from(this.contracts.values()).map((s) => s.contract);
    }

    /**
     * Get all active contracts.
     */
    getActiveContracts(): Contract[] {
        return this.getAllContracts().filter((c) => c.state === "active");
    }

    /**
     * Get the scripts of all active contracts.
     */
    getActiveScripts(): string[] {
        return this.getActiveContracts().map((c) => c.script);
    }

    /**
     * Get scripts that should be watched.
     *
     * Returns scripts for:
     * - All active contracts
     * - All contracts with known VTXOs (regardless of state)
     *
     * This ensures we continue monitoring contracts even after they're
     * deactivated, as long as they have unspent VTXOs.
     */
    getScriptsToWatch(): string[] {
        const scripts = new Set<string>();

        for (const [, state] of this.contracts) {
            // Always watch active contracts
            if (state.contract.state === "active") {
                scripts.add(state.contract.script);
                continue;
            }

            // Also watch inactive/expired contracts that have VTXOs
            if (state.lastKnownVtxos.size > 0) {
                scripts.add(state.contract.script);
            }
        }

        return Array.from(scripts);
    }

    /**
     * Find contract ID by script.
     */
    getContractByScript(script: string): string | undefined {
        return this.scriptToContract.get(script);
    }

    /**
     * Get VTXOs for contracts, grouped by contract ID.
     *
     * By default, reads from cached storage. Use `refresh: true` to force
     * fetching from the API and updating the cache.
     */
    async getContractVtxos(
        options: GetContractVtxosOptions = {},
        extendVtxo?: (vtxo: VirtualCoin) => ExtendedVirtualCoin
    ): Promise<Map<string, ContractVtxo[]>> {
        const {
            activeOnly = true,
            contractIds,
            includeSpent = false,
            refresh = false,
        } = options;

        // Determine which contracts to query
        let contractsToQuery = Array.from(this.contracts.values());

        if (activeOnly) {
            contractsToQuery = contractsToQuery.filter(
                (s) => s.contract.state === "active"
            );
        }

        if (contractIds?.length) {
            const idSet = new Set(contractIds);
            contractsToQuery = contractsToQuery.filter((s) =>
                idSet.has(s.contract.id)
            );
        }

        if (contractsToQuery.length === 0) {
            return new Map();
        }

        const result = new Map<string, ContractVtxo[]>();
        const repo = this.config.walletRepository;

        // Try cache first for all contracts (if not forcing refresh)
        const contractsNeedingFetch: ContractState[] = [];

        if (!refresh && repo) {
            for (const state of contractsToQuery) {
                // Use contract address as cache key
                const cached = await repo.getVtxos(state.contract.address);
                if (cached.length > 0) {
                    // Convert to ContractVtxo with contractId
                    const contractVtxos: ContractVtxo[] = cached.map((v) => ({
                        ...v,
                        contractId: state.contract.id,
                    }));
                    const filtered = includeSpent
                        ? contractVtxos
                        : contractVtxos.filter((v) => !v.isSpent);
                    result.set(state.contract.id, filtered);
                } else {
                    contractsNeedingFetch.push(state);
                }
            }
        } else {
            contractsNeedingFetch.push(...contractsToQuery);
        }

        // Fetch remaining from API in bulk
        if (contractsNeedingFetch.length > 0) {
            const fetched = await this.fetchContractVtxosBulk(
                contractsNeedingFetch.map((s) => s.contract),
                includeSpent,
                extendVtxo
            );

            // Merge results and persist to cache
            for (const [contractId, vtxos] of fetched) {
                result.set(contractId, vtxos);
                if (repo) {
                    const contract = contractsNeedingFetch.find(
                        (s) => s.contract.id === contractId
                    )?.contract;
                    if (contract) {
                        // Save using contract address as key
                        await repo.saveVtxos(contract.address, vtxos);
                    }
                }
            }
        }

        return result;
    }

    /**
     * Fetch VTXOs for multiple contracts from the API.
     * Fetches each contract separately since VirtualCoin doesn't include script.
     * Uses server-side filtering and handles pagination.
     */
    private async fetchContractVtxosBulk(
        contracts: Contract[],
        includeSpent: boolean,
        extendVtxo?: (vtxo: VirtualCoin) => ExtendedVirtualCoin
    ): Promise<Map<string, ContractVtxo[]>> {
        const result = new Map<string, ContractVtxo[]>();

        // Fetch each contract separately (VirtualCoin doesn't have script field)
        await Promise.all(
            contracts.map(async (contract) => {
                const vtxos = await this.fetchContractVtxosPaginated(
                    contract,
                    includeSpent,
                    extendVtxo
                );
                result.set(contract.id, vtxos);
            })
        );

        return result;
    }

    /**
     * Fetch all VTXOs for a single contract with pagination.
     */
    private async fetchContractVtxosPaginated(
        contract: Contract,
        includeSpent: boolean,
        extendVtxo?: (vtxo: VirtualCoin) => ExtendedVirtualCoin
    ): Promise<ContractVtxo[]> {
        const PAGE_SIZE = 100;
        const allVtxos: ContractVtxo[] = [];
        let pageIndex = 0;
        let hasMore = true;

        // Use server-side filtering when possible
        const opts = includeSpent ? {} : { spendableOnly: true };

        while (hasMore) {
            const { vtxos, page } = await this.config.indexerProvider.getVtxos({
                scripts: [contract.script],
                ...opts,
                pageIndex,
                pageSize: PAGE_SIZE,
            });

            for (const vtxo of vtxos) {
                const ext = extendVtxo
                    ? extendVtxo(vtxo)
                    : (vtxo as ExtendedVirtualCoin);

                allVtxos.push({
                    ...ext,
                    contractId: contract.id,
                });
            }

            // Check if there are more pages
            hasMore = page ? vtxos.length === PAGE_SIZE : false;
            pageIndex++;
        }

        return allVtxos;
    }

    /**
     * Get balance summary for a specific contract.
     */
    async getContractBalance(
        contractId: string,
        extendVtxo?: (vtxo: VirtualCoin) => ExtendedVirtualCoin
    ): Promise<ContractBalance> {
        const vtxosMap = await this.getContractVtxos(
            {
                activeOnly: false,
                contractIds: [contractId],
            },
            extendVtxo
        );

        const vtxos = vtxosMap.get(contractId) || [];

        let total = 0;
        let spendable = 0;

        for (const vtxo of vtxos) {
            if (vtxo.isSpent) continue;

            total += vtxo.value;

            // Spendable = settled or preconfirmed (not swept)
            if (
                vtxo.virtualStatus.state === "settled" ||
                vtxo.virtualStatus.state === "preconfirmed"
            ) {
                spendable += vtxo.value;
            }
        }

        return {
            total,
            spendable,
            vtxoCount: vtxos.filter((v) => !v.isSpent).length,
        };
    }

    /**
     * Start watching for VTXO events across all active contracts.
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
                await this.config.indexerProvider.unsubscribeForScripts(
                    this.subscriptionId
                );
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
     * Check for expired contracts and update their state.
     */
    checkExpiredContracts(): Contract[] {
        const now = Date.now();
        const expired: Contract[] = [];

        for (const state of this.contracts.values()) {
            const contract = state.contract;
            if (
                contract.state === "active" &&
                contract.expiresAt &&
                contract.expiresAt <= now
            ) {
                contract.state = "expired";
                expired.push(contract);

                this.eventCallback?.({
                    type: "contract_expired",
                    contractId: contract.id,
                    contract,
                    timestamp: now,
                });
            }
        }

        return expired;
    }

    /**
     * Connect to the subscription.
     */
    private async connect(): Promise<void> {
        if (!this.isWatching) return;

        this.connectionState = "connecting";

        try {
            await this.updateSubscription();

            // Poll immediately after connection to sync state
            await this.pollAllContracts();

            this.connectionState = "connected";
            this.reconnectAttempts = 0;

            // Start listening
            this.listenLoop();
        } catch (error) {
            console.error("ContractWatcher connection failed:", error);
            this.connectionState = "disconnected";
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
                `ContractWatcher: Max reconnection attempts (${this.config.maxReconnectAttempts}) reached`
            );
            return;
        }

        this.connectionState = "reconnecting";
        this.reconnectAttempts++;

        // Calculate delay with exponential backoff
        const delay = Math.min(
            this.config.reconnectDelayMs *
                Math.pow(2, this.reconnectAttempts - 1),
            this.config.maxReconnectDelayMs
        );

        console.log(
            `ContractWatcher: Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`
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
                    console.error(
                        "ContractWatcher failsafe poll failed:",
                        error
                    );
                });
            }
        }, this.config.failsafePollIntervalMs);
    }

    /**
     * Poll all active contracts for current state.
     */
    private async pollAllContracts(): Promise<void> {
        const activeIds = this.getActiveContracts().map((c) => c.id);
        if (activeIds.length === 0) return;
        await this.pollContracts(activeIds);
    }

    /**
     * Poll specific contracts and emit events for changes.
     */
    private async pollContracts(contractIds: string[]): Promise<void> {
        if (!this.eventCallback) return;

        const now = Date.now();
        this.lastPollTime = now;

        try {
            // Always refresh from API when polling to detect changes
            const vtxosMap = await this.getContractVtxos({
                activeOnly: false,
                contractIds,
                refresh: true,
            });

            for (const contractId of contractIds) {
                const state = this.contracts.get(contractId);
                if (!state) continue;

                const currentVtxos = vtxosMap.get(contractId) || [];
                const currentKeys = new Set(
                    currentVtxos.map((v) => `${v.txid}:${v.vout}`)
                );
                const previousKeys = new Set(state.lastKnownVtxos.keys());

                // Find new VTXOs
                const newVtxos: VirtualCoin[] = [];
                for (const vtxo of currentVtxos) {
                    const key = `${vtxo.txid}:${vtxo.vout}`;
                    if (!previousKeys.has(key)) {
                        newVtxos.push(vtxo);
                        state.lastKnownVtxos.set(key, vtxo);
                    }
                }

                // Find spent/swept VTXOs
                const spentVtxos: VirtualCoin[] = [];
                for (const [key, vtxo] of state.lastKnownVtxos) {
                    if (!currentKeys.has(key)) {
                        spentVtxos.push(vtxo);
                        state.lastKnownVtxos.delete(key);
                    }
                }

                // Emit events
                if (newVtxos.length > 0) {
                    this.emitVtxoEvent(
                        contractId,
                        newVtxos,
                        "vtxo_received",
                        now
                    );
                }

                if (spentVtxos.length > 0) {
                    // Note: We can't distinguish spent vs swept from polling alone
                    // The subscription provides more accurate event types
                    this.emitVtxoEvent(
                        contractId,
                        spentVtxos,
                        "vtxo_spent",
                        now
                    );
                }
            }
        } catch (error) {
            console.error("ContractWatcher poll failed:", error);
            // Don't throw - polling failures shouldn't crash the watcher
        }
    }

    /**
     * Update the subscription with scripts that should be watched.
     *
     * Watches both active contracts and contracts with VTXOs.
     */
    private async updateSubscription(): Promise<void> {
        const scriptsToWatch = this.getScriptsToWatch();

        if (scriptsToWatch.length === 0) {
            if (this.subscriptionId) {
                try {
                    await this.config.indexerProvider.unsubscribeForScripts(
                        this.subscriptionId
                    );
                } catch {
                    // Ignore
                }
                this.subscriptionId = undefined;
            }
            return;
        }

        this.subscriptionId =
            await this.config.indexerProvider.subscribeForScripts(
                scriptsToWatch,
                this.subscriptionId
            );
    }

    /**
     * Main listening loop for subscription events.
     */
    private async listenLoop(): Promise<void> {
        if (!this.subscriptionId || !this.abortController || !this.isWatching) {
            return;
        }

        try {
            const subscription = this.config.indexerProvider.getSubscription(
                this.subscriptionId,
                this.abortController.signal
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
        } catch (error) {
            if (this.isWatching) {
                console.error("ContractWatcher subscription error:", error);
                this.connectionState = "disconnected";

                // Poll immediately after failure to catch any missed events
                await this.pollAllContracts().catch(() => {});

                this.scheduleReconnect();
            }
        }
    }

    /**
     * Handle a subscription update.
     */
    private handleSubscriptionUpdate(update: SubscriptionResponse): void {
        if (!this.eventCallback) return;

        const timestamp = Date.now();
        const scripts = update.scripts || [];

        if (update.newVtxos?.length) {
            this.processSubscriptionVtxos(
                update.newVtxos,
                scripts,
                "vtxo_received",
                timestamp
            );
        }

        if (update.spentVtxos?.length) {
            this.processSubscriptionVtxos(
                update.spentVtxos,
                scripts,
                "vtxo_spent",
                timestamp
            );
        }

        if (update.sweptVtxos?.length) {
            this.processSubscriptionVtxos(
                update.sweptVtxos,
                scripts,
                "vtxo_swept",
                timestamp
            );
        }
    }

    /**
     * Process VTXOs from subscription and route to correct contracts.
     * Uses the scripts from the subscription response to determine contract ownership.
     */
    private processSubscriptionVtxos(
        vtxos: VirtualCoin[],
        scripts: string[],
        eventType: "vtxo_received" | "vtxo_spent" | "vtxo_swept",
        timestamp: number
    ): void {
        // If we have exactly one script, all VTXOs belong to that contract
        // Otherwise, we can't reliably determine ownership without script in VirtualCoin
        if (scripts.length === 1) {
            const contractId = this.scriptToContract.get(scripts[0]);
            if (contractId) {
                // Update tracking
                const state = this.contracts.get(contractId);
                if (state) {
                    for (const vtxo of vtxos) {
                        const key = `${vtxo.txid}:${vtxo.vout}`;
                        if (eventType === "vtxo_received") {
                            state.lastKnownVtxos.set(key, vtxo);
                        } else {
                            state.lastKnownVtxos.delete(key);
                        }
                    }
                }
                this.emitVtxoEvent(contractId, vtxos, eventType, timestamp);
            }
            return;
        }

        // Multiple scripts - assign VTXOs to all matching contracts
        // This is a limitation: we can't know which VTXO belongs to which script
        // In practice, subscription events usually come with a single script context
        for (const script of scripts) {
            const contractId = this.scriptToContract.get(script);
            if (contractId) {
                const state = this.contracts.get(contractId);
                if (state) {
                    for (const vtxo of vtxos) {
                        const key = `${vtxo.txid}:${vtxo.vout}`;
                        if (eventType === "vtxo_received") {
                            state.lastKnownVtxos.set(key, vtxo);
                        } else {
                            state.lastKnownVtxos.delete(key);
                        }
                    }
                }
                this.emitVtxoEvent(contractId, vtxos, eventType, timestamp);
            }
        }
    }

    /**
     * Emit a VTXO event for a contract.
     */
    private emitVtxoEvent(
        contractId: string,
        vtxos: VirtualCoin[],
        eventType: "vtxo_received" | "vtxo_spent" | "vtxo_swept",
        timestamp: number
    ): void {
        const state = this.contracts.get(contractId);
        if (!state || !this.eventCallback) return;

        this.eventCallback({
            type: eventType,
            contractId,
            vtxos: vtxos.map((v) => ({
                ...v,
                contractId,
                // These fields may not be available from basic VirtualCoin
                forfeitTapLeafScript: undefined as any,
                intentTapLeafScript: undefined as any,
                tapTree: undefined as any,
            })),
            contract: state.contract,
            timestamp,
        });
    }
}
