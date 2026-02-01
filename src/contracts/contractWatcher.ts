import { IndexerProvider, SubscriptionResponse } from "../providers/indexer";
import {
    ExplorerTransaction,
    OnchainProvider,
} from "../providers/onchain";
import { Coin, VirtualCoin } from "../wallet";
import { WalletRepository } from "../repositories/walletRepository";
import {
    Contract,
    ContractCoin,
    ContractVtxo,
    ContractEventCallback,
    ContractBalance,
    ContractEvent,
} from "./types";

/**
 * Configuration for the ContractWatcher.
 */
export interface ContractWatcherConfig {
    /** The indexer provider to use for subscriptions and queries */
    indexerProvider: IndexerProvider;

    /** The wallet repository for VTXO persistence (optional) */
    walletRepository: WalletRepository;

    /**
     * The onchain provider for watching onchain UTXOs.
     * Required for contracts with layer "onchain" or "both".
     */
    onchainProvider?: OnchainProvider;

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
    lastKnownCoins: Map<string, Coin>; // "txid:vout" -> coin (for onchain)
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
 *   console.log(`${event.type} on contract ${event.contractScript}`);
 * });
 *
 * // Later: stop watching
 * stop();
 * ```
 */
export class ContractWatcher {
    private config: Required<
        Omit<ContractWatcherConfig, "walletRepository" | "onchainProvider">
    > &
        Pick<ContractWatcherConfig, "walletRepository" | "onchainProvider">;
    private contracts: Map<string, ContractState> = new Map();
    private subscriptionId?: string;
    private abortController?: AbortController;
    private isWatching = false;
    private eventCallback?: ContractEventCallback;
    private connectionState: ConnectionState = "disconnected";
    private reconnectAttempts = 0;
    private reconnectTimeoutId?: ReturnType<typeof setTimeout>;
    private failsafePollIntervalId?: ReturnType<typeof setInterval>;

    // Onchain watching state
    private onchainStopFuncs: Map<string, () => void> = new Map(); // contractScript -> stopFunc
    private watchedOnchainAddresses: Set<string> = new Set();

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
     * to discover any existing VTXOs/coins (which may cause them to be watched
     * even if inactive).
     *
     * For contracts with layer "onchain" or "both", onchain watching is enabled
     * if onchainProvider is configured.
     */
    async addContract(contract: Contract): Promise<void> {
        const state: ContractState = {
            contract,
            lastKnownVtxos: new Map(),
            lastKnownCoins: new Map(),
        };

        this.contracts.set(contract.script, state);

        // If we're already watching, poll to discover VTXOs/coins and update subscription
        if (this.isWatching) {
            // Poll first to discover VTXOs (may affect whether we watch this contract)
            await this.pollContracts([contract.script]);
            // Update subscription based on active state and VTXOs
            await this.tryUpdateSubscription();
            // Start onchain watching if applicable
            await this.updateOnchainWatching();
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
     * Get all active in-memory contracts.
     */
    getActiveContracts(): Contract[] {
        return this.getAllContracts().filter((c) => c.state === "active");
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
    private getScriptsToWatch(): string[] {
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
     * Get VTXOs for contracts, grouped by contract script.
     * Uses Repository.
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
                if (
                    contractScripts &&
                    !contractScripts.includes(_.contract.script)
                )
                    return false;
                return true;
            })
            .map(async (state): Promise<[[string, ContractVtxo[]]] | []> => {
                // Use contract address as cache key
                const cached = await repo.getVtxos(state.contract.address);
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

        // Stop onchain watching
        for (const stopFunc of this.onchainStopFuncs.values()) {
            stopFunc();
        }
        this.onchainStopFuncs.clear();
        this.watchedOnchainAddresses.clear();

        // Unsubscribe from indexer
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
     * Check for expired contracts, update their state, and emit events.
     */
    private checkExpiredContracts(): void {
        const now = Date.now();
        const expired: Contract[] = [];

        for (const state of this.contracts.values()) {
            const contract = state.contract;
            if (
                contract.state === "active" &&
                contract.expiresAt &&
                contract.expiresAt <= now
            ) {
                contract.state = "inactive";
                expired.push(contract);

                this.eventCallback?.({
                    type: "contract_expired",
                    contractScript: contract.script,
                    contract,
                    timestamp: now,
                });
            }
        }
    }

    /**
     * Connect to the subscription.
     */
    private async connect(): Promise<void> {
        if (!this.isWatching) return;

        this.connectionState = "connecting";

        try {
            await this.updateSubscription();

            // Start onchain watching for applicable contracts
            await this.updateOnchainWatching();

            // Poll immediately after connection to sync state
            await this.pollAllContracts();

            this.connectionState = "connected";
            this.reconnectAttempts = 0;

            // Start listening
            await this.listenLoop();
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
        const activeScripts = this.getActiveContracts().map((c) => c.script);
        if (activeScripts.length === 0) return;
        await this.pollContracts(activeScripts);
    }

    /**
     * Poll specific contracts and emit events for changes.
     */
    private async pollContracts(contractScripts: string[]): Promise<void> {
        if (!this.eventCallback) return;

        const now = Date.now();

        try {
            // Load all the VTXOs for these contracts, from DB
            const vtxosMap = await this.getContractVtxos({
                contractScripts,
                includeSpent: false, // only spendable ones!
            });

            for (const contractScript of contractScripts) {
                const state = this.contracts.get(contractScript);
                if (!state) continue;

                const currentVtxos = vtxosMap.get(contractScript) || [];
                const currentKeys = new Set(
                    currentVtxos.map((v) => `${v.txid}:${v.vout}`)
                );

                // Find new VTXOs and add them to the contract's state
                const newVtxos: VirtualCoin[] = [];
                for (const vtxo of currentVtxos) {
                    const key = `${vtxo.txid}:${vtxo.vout}`;
                    if (!state.lastKnownVtxos.has(key)) {
                        newVtxos.push(vtxo);
                        state.lastKnownVtxos.set(key, vtxo);
                    }
                }

                // Find spent VTXOs and remove them from the contract's state
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
                        contractScript,
                        newVtxos,
                        "vtxo_received",
                        now
                    );
                }

                if (spentVtxos.length > 0) {
                    // Note: We can't distinguish spent vs swept from polling alone
                    // The subscription provides more accurate event types
                    this.emitVtxoEvent(
                        contractScript,
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

    private async tryUpdateSubscription() {
        try {
            await this.updateSubscription();
        } catch (error) {
            // nothing, the connection will be retried later
        }
    }

    /**
     * Update the subscription with scripts that should be watched (offchain only).
     *
     * Watches both active contracts and contracts with VTXOs.
     * Only subscribes for contracts with layer "offchain" or "both".
     */
    private async updateSubscription(): Promise<void> {
        // Only subscribe to offchain-capable contracts
        const scriptsToWatch = this.getScriptsToWatch().filter((script) => {
            const state = this.contracts.get(script);
            return (
                state &&
                (state.contract.layer === "offchain" ||
                    state.contract.layer === "both")
            );
        });

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
     * Get contracts that need onchain watching.
     *
     * Returns contracts with layer "onchain" or "both" that are active
     * or have known coins.
     */
    private getOnchainContractsToWatch(): Contract[] {
        const contracts: Contract[] = [];

        for (const state of this.contracts.values()) {
            const { contract, lastKnownCoins } = state;

            // Only watch onchain-capable contracts
            if (contract.layer !== "onchain" && contract.layer !== "both") {
                continue;
            }

            // Watch active contracts or those with coins
            if (contract.state === "active" || lastKnownCoins.size > 0) {
                contracts.push(contract);
            }
        }

        return contracts;
    }

    /**
     * Update onchain watching based on contract configuration.
     *
     * Starts watching for contracts with layer "onchain" or "both".
     * Stops watching for removed/deactivated contracts.
     */
    private async updateOnchainWatching(): Promise<void> {
        if (!this.config.onchainProvider || !this.isWatching) {
            return;
        }

        const contractsToWatch = this.getOnchainContractsToWatch();
        const addressesToWatch = new Set(
            contractsToWatch.map((c) => c.address)
        );

        // Stop watching addresses that are no longer needed
        for (const [script, stopFunc] of this.onchainStopFuncs) {
            const state = this.contracts.get(script);
            if (!state || !addressesToWatch.has(state.contract.address)) {
                stopFunc();
                this.onchainStopFuncs.delete(script);
                if (state) {
                    this.watchedOnchainAddresses.delete(state.contract.address);
                }
            }
        }

        // Start watching new addresses
        for (const contract of contractsToWatch) {
            if (this.watchedOnchainAddresses.has(contract.address)) {
                continue; // Already watching
            }

            try {
                const stopFunc = await this.config.onchainProvider.watchAddresses(
                    [contract.address],
                    (txs) => this.handleOnchainTransactions(contract, txs)
                );

                this.onchainStopFuncs.set(contract.script, stopFunc);
                this.watchedOnchainAddresses.add(contract.address);
            } catch (error) {
                console.error(
                    `Failed to start onchain watching for ${contract.script}:`,
                    error
                );
            }
        }
    }

    /**
     * Handle onchain transactions for a contract.
     */
    private handleOnchainTransactions(
        contract: Contract,
        txs: ExplorerTransaction[]
    ): void {
        if (!this.eventCallback) return;

        const state = this.contracts.get(contract.script);
        if (!state) return;

        const timestamp = Date.now();
        const newCoins: ContractCoin[] = [];
        const confirmedCoins: ContractCoin[] = [];

        for (const tx of txs) {
            // Find outputs to this contract's address
            for (let vout = 0; vout < tx.vout.length; vout++) {
                const output = tx.vout[vout];
                if (output.scriptpubkey_address !== contract.address) {
                    continue;
                }

                const key = `${tx.txid}:${vout}`;
                const existingCoin = state.lastKnownCoins.get(key);
                const coin: ContractCoin = {
                    contractScript: contract.script,
                    txid: tx.txid,
                    vout,
                    value: Number(output.value),
                    confirmed: tx.status.confirmed,
                };

                if (!existingCoin) {
                    // New coin received
                    newCoins.push(coin);
                    state.lastKnownCoins.set(key, {
                        txid: tx.txid,
                        vout,
                        value: Number(output.value),
                        status: {
                            confirmed: tx.status.confirmed,
                            block_time: tx.status.block_time,
                        },
                    });
                } else if (
                    !existingCoin.status.confirmed &&
                    tx.status.confirmed
                ) {
                    // Coin confirmed
                    confirmedCoins.push(coin);
                    state.lastKnownCoins.set(key, {
                        txid: tx.txid,
                        vout,
                        value: Number(output.value),
                        status: {
                            confirmed: tx.status.confirmed,
                            block_time: tx.status.block_time,
                        },
                    });
                }
            }
        }

        // Emit events
        if (newCoins.length > 0) {
            this.eventCallback({
                type: "coin_received",
                contractScript: contract.script,
                coins: newCoins,
                contract,
                timestamp,
            });
        }

        if (confirmedCoins.length > 0) {
            this.eventCallback({
                type: "coin_confirmed",
                contractScript: contract.script,
                coins: confirmedCoins,
                contract,
                timestamp,
            });
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
    }

    /**
     * Process VTXOs from subscription and route to correct contracts.
     * Uses the scripts from the subscription response to determine contract ownership.
     */
    private processSubscriptionVtxos(
        vtxos: VirtualCoin[],
        scripts: string[],
        eventType: ContractEvent["type"],
        timestamp: number
    ): void {
        // If we have exactly one script, all VTXOs belong to that contract
        // Otherwise, we can't reliably determine ownership without script in VirtualCoin
        if (scripts.length === 1) {
            const contractScript = scripts[0];
            if (contractScript) {
                // Update tracking
                const state = this.contracts.get(contractScript);
                if (state) {
                    for (const vtxo of vtxos) {
                        const key = `${vtxo.txid}:${vtxo.vout}`;
                        if (eventType === "vtxo_received") {
                            state.lastKnownVtxos.set(key, vtxo);
                        } else if (eventType === "vtxo_spent") {
                            state.lastKnownVtxos.delete(key);
                        }
                    }
                }
                this.emitVtxoEvent(contractScript, vtxos, eventType, timestamp);
            }
            return;
        }

        // Multiple scripts - assign VTXOs to all matching contracts
        // This is a limitation: we can't know which VTXO belongs to which script
        // In practice, subscription events usually come with a single script context
        for (const script of scripts) {
            const contractScript = script;
            if (contractScript) {
                const state = this.contracts.get(contractScript);
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
                this.emitVtxoEvent(contractScript, vtxos, eventType, timestamp);
            }
        }
    }

    /**
     * Emit a VTXO event for a contract.
     */
    private emitVtxoEvent(
        contractScript: string,
        vtxos: VirtualCoin[],
        eventType: ContractEvent["type"],
        timestamp: number
    ): void {
        if (!this.eventCallback) return;
        const state = this.contracts.get(contractScript);
        // ensure we check somehow regularly
        this.checkExpiredContracts();
        switch (eventType) {
            case "vtxo_received":
                if (!state) return;
                this.eventCallback({
                    type: "vtxo_received",
                    vtxos: vtxos.map((v) => ({
                        ...v,
                        contractScript,
                        // These fields may not be available from basic VirtualCoin
                        forfeitTapLeafScript: undefined as any,
                        intentTapLeafScript: undefined as any,
                        tapTree: undefined as any,
                    })),
                    contractScript,
                    contract: state.contract,
                    timestamp,
                });
                return;
            case "vtxo_spent":
                if (!state) return;
                this.eventCallback({
                    type: "vtxo_spent",
                    vtxos: vtxos.map((v) => ({
                        ...v,
                        contractScript,
                        // These fields may not be available from basic VirtualCoin
                        forfeitTapLeafScript: undefined as any,
                        intentTapLeafScript: undefined as any,
                        tapTree: undefined as any,
                    })),
                    contractScript,
                    contract: state.contract,
                    timestamp,
                });
                return;
            case "contract_expired":
                if (!state) return;
                this.eventCallback({
                    type: "contract_expired",
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
