import { hex } from "@scure/base";
import { IndexerProvider } from "../providers/indexer";
import { WalletRepository } from "../repositories/walletRepository";
import {
    Contract,
    ContractEvent,
    ContractEventCallback,
    ContractState,
    ContractVtxo,
    ContractWithVtxos,
    GetContractsFilter,
    PathContext,
    PathSelection,
} from "./types";
import { ContractWatcher, ContractWatcherConfig } from "./contractWatcher";
import { contractHandlers } from "./handlers";
import { VirtualCoin } from "../wallet";
import { extendVtxoFromContract } from "../wallet/utils";
import { ContractFilter, ContractRepository } from "../repositories";
import {
    advanceSyncCursors,
    clearSyncCursors,
    computeSyncWindow,
    cursorCutoff,
    getAllSyncCursors,
} from "../utils/syncCursors";

const DEFAULT_PAGE_SIZE = 500;

/**
 * Contract lifecycle and VTXO orchestration API.
 *
 * Responsibilities:
 * - Create and persist contracts
 * - Query stored contracts (optionally with their VTXOs)
 * - Provide spendable path selection for a contract
 * - Emit contract-related events (VTXO received/spent, expiry, connection reset)
 *
 * Notes:
 * - Implementations typically start watching automatically during initialization
 *   (so `onContractEvent()` is just for subscribing).
 *
 * @example
 * ```typescript
 * const manager = await ContractManager.create({
 *   indexerProvider,
 *   contractRepository,
 *   walletRepository,
 *   getDefaultAddress,
 * });
 *
 * const unsubscribe = manager.onContractEvent((event) => {
 *   console.log(event.type, event.timestamp);
 * });
 *
 * const contract = await manager.createContract({
 *   label: "Lightning Receive",
 *   type: "vhtlc",
 *   params: { sender: "ab12...", receiver: "cd34..." },
 *   script: "5120...",
 *   address: "tark1...",
 * });
 *
 * // Later:
 * unsubscribe();
 * manager.dispose();
 * ```
 */
export type RefreshVtxosOptions = {
    scripts?: string[];
    after?: number;
    before?: number;
};

export interface IContractManager extends Disposable {
    /**
     * Create and register a new contract.
     *
     * Implementations may validate that:
     * - A handler exists for `params.type`
     * - `params.script` matches the script derived from `params.params`
     *
     * The contract script is used as the unique identifier.
     */
    createContract(params: CreateContractParams): Promise<Contract>;

    /**
     * List contracts with optional filters.
     *
     * @example
     * ```typescript
     * const vhtlcs = await manager.getContracts({ type: "vhtlc" });
     * const active = await manager.getContracts({ state: "active" });
     * ```
     */
    getContracts(filter?: GetContractsFilter): Promise<Contract[]>;

    /**
     * List contracts and include their current VTXOs.
     *
     * If no filter is provided, returns all contracts with their VTXOs.
     */
    getContractsWithVtxos(
        filter?: GetContractsFilter
    ): Promise<ContractWithVtxos[]>;

    /**
     * Update mutable contract fields.
     *
     * `script` and `createdAt` are immutable.
     */
    updateContract(
        script: string,
        updates: Partial<Omit<Contract, "script" | "createdAt">>
    ): Promise<Contract>;

    /**
     * Convenience helper to update only the contract state.
     */
    setContractState(script: string, state: ContractState): Promise<void>;

    /**
     * Delete a contract by script and stop watching it (if applicable).
     */
    deleteContract(script: string): Promise<void>;

    /**
     * Get all currently spendable paths for a contract.
     *
     * Returns an empty array if the contract or its handler cannot be found.
     */
    getSpendablePaths(
        options: GetSpendablePathsOptions
    ): Promise<PathSelection[]>;

    /**
     * Get all possible spending paths for a contract.
     *
     * Returns an empty array if the contract or its handler cannot be found.
     */
    getAllSpendingPaths(
        options: GetAllSpendingPathsOptions
    ): Promise<PathSelection[]>;

    /**
     * Subscribe to contract events.
     *
     * @returns Unsubscribe function
     */
    onContractEvent(callback: ContractEventCallback): () => void;

    /**
     * Force a VTXO refresh from the indexer.
     *
     * Without options, refreshes all contracts from scratch.
     * With options, narrows the refresh to specific scripts and/or a time window.
     */
    refreshVtxos(opts?: RefreshVtxosOptions): Promise<void>;

    /**
     * Whether the underlying watcher is currently active.
     */
    isWatching(): Promise<boolean>;

    /**
     * Release resources (stop watching, clear listeners).
     */
    dispose(): void;
}

/**
 * Options for getting spendable paths.
 */
export type GetSpendablePathsOptions = {
    /** The contract script */
    contractScript: string;
    /** The specific VTXO being evaluated */
    vtxo: VirtualCoin;
    /** Whether collaborative spending is available (default: true) */
    collaborative?: boolean;
    /** Wallet's public key (hex) to determine role */
    walletPubKey?: string;
};

/**
 * Options for getting all possible spending paths.
 */
export type GetAllSpendingPathsOptions = {
    /** The contract script */
    contractScript: string;
    /** Whether collaborative spending is available (default: true) */
    collaborative?: boolean;
    /** Wallet's public key (hex) to determine role */
    walletPubKey?: string;
};

/**
 * Configuration for the ContractManager.
 */
export interface ContractManagerConfig {
    /** The indexer provider */
    indexerProvider: IndexerProvider;

    /** The contract repository for persistence */
    contractRepository: ContractRepository;

    /** The wallet repository for VTXO storage (single source of truth) */
    walletRepository: WalletRepository;

    /** Function to get the wallet's default Ark address */
    getDefaultAddress: () => Promise<string>;

    /** Watcher configuration */
    watcherConfig?: Partial<ContractWatcherConfig>;
}

/**
 * Parameters for creating a new contract.
 */
export type CreateContractParams = Omit<Contract, "createdAt" | "state"> & {
    /** Initial state (defaults to "active") */
    state?: ContractState;
};

/**
 * Central manager for contract lifecycle and operations.
 *
 * The ContractManager orchestrates:
 * - Contract registration and persistence
 * - Multi-contract watching via ContractWatcher
 * - VTXO queries across contracts
 *
 * @example
 * ```typescript
 * const manager = new ContractManager({
 *   indexerProvider: wallet.indexerProvider,
 *   contractRepository: wallet.contractRepository,
 *   getDefaultAddress: () => wallet.getAddress(),
 * });
 *
 * // Initialize (loads persisted contracts)
 * await manager.initialize();
 *
 * // Create a new VHTLC contract
 * const contract = await manager.createContract({
 *   label: "Lightning Receive",
 *   type: "vhtlc",
 *   params: { sender: "ab12...", receiver: "cd34...", ... },
 *   script: "5120...",
 *   address: "tark1...",
 * });
 *
 * // Start watching for events
 * const stop = await manager.startWatching((event) => {
 *   console.log(`${event.type} on ${event.contractScript}`);
 * });
 *
 * // Get balance across all contracts
 * const balances = await manager.getAllBalances();
 * ```
 */
export class ContractManager implements IContractManager {
    private config: ContractManagerConfig;
    private watcher: ContractWatcher;
    private initialized = false;
    private eventCallbacks: Set<ContractEventCallback> = new Set();
    private stopWatcherFn?: () => void;

    private constructor(config: ContractManagerConfig) {
        this.config = config;

        // Create watcher with wallet repository for VTXO caching
        this.watcher = new ContractWatcher({
            indexerProvider: config.indexerProvider,
            walletRepository: config.walletRepository,
            ...config.watcherConfig,
        });
    }

    /**
     * Static factory method for creating a new ContractManager.
     * Initialize the manager by loading persisted contracts and starting to watch.
     *
     * After initialization, the manager automatically watches all active contracts
     * and contracts with VTXOs. Use `onContractEvent()` to register event callbacks.
     *
     * @param config ContractManagerConfig
     */
    static async create(
        config: ContractManagerConfig
    ): Promise<ContractManager> {
        const cm = new ContractManager(config);
        await cm.initialize();
        return cm;
    }

    private async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        // Load persisted contracts
        const contracts = await this.config.contractRepository.getContracts();

        // Delta-sync: fetch only VTXOs that changed since the last cursor,
        // falling back to a full bootstrap for scripts seen for the first time.
        await this.deltaSyncContracts(contracts);

        // Reconcile the pending frontier: fetch all not-yet-finalized VTXOs
        // to catch any that the delta window may have missed.
        if (contracts.length > 0) {
            await this.reconcilePendingFrontier(contracts);
        }

        // add all contracts to the watcher
        const now = Date.now();
        for (const contract of contracts) {
            // Check for expired contracts and mark as inactive
            if (
                contract.state === "active" &&
                contract.expiresAt &&
                contract.expiresAt <= now
            ) {
                contract.state = "inactive";
                await this.config.contractRepository.saveContract(contract);
            }

            // Add to watcher
            await this.watcher.addContract(contract);
        }

        this.initialized = true;

        // Start watching automatically
        this.stopWatcherFn = await this.watcher.startWatching((event) => {
            this.handleContractEvent(event).catch((error) => {
                console.error("Error handling contract event:", error);
            });
        });
    }

    /**
     * Create and register a new contract.
     *
     * @param params - Contract parameters
     * @returns The created contract
     */
    async createContract(params: CreateContractParams): Promise<Contract> {
        // Validate that a handler exists for this contract type
        const handler = contractHandlers.get(params.type);
        if (!handler) {
            throw new Error(
                `No handler registered for contract type '${params.type}'`
            );
        }

        // Validate params by attempting to create the script
        // This catches invalid/missing params early
        try {
            const script = handler.createScript(params.params);
            const derivedScript = hex.encode(script.pkScript);

            // Verify the derived script matches the provided script
            if (derivedScript !== params.script) {
                throw new Error(
                    `Script mismatch: provided script does not match script derived from params. ` +
                        `Expected ${derivedScript}, got ${params.script}`
                );
            }
        } catch (error) {
            if (error instanceof Error && error.message.includes("mismatch")) {
                throw error;
            }
            throw new Error(
                `Invalid params for contract type '${params.type}': ${error instanceof Error ? error.message : String(error)}`
            );
        }

        // Check if contract already exists and verify it's the same type to avoid silent mismatches
        const [existing] = await this.getContracts({ script: params.script });
        if (existing) {
            if (existing.type === params.type) return existing;
            throw new Error(
                `Contract with script ${params.script} already exists with with type ${existing.type}.`
            );
        }

        const contract: Contract = {
            ...params,
            createdAt: Date.now(),
            state: params.state || "active",
        };

        // Persist
        await this.config.contractRepository.saveContract(contract);

        // fetch all VTXOs (including spent/swept) for this contract
        await this.fetchContractVxosFromIndexer([contract], true);

        // Add to watcher
        await this.watcher.addContract(contract);

        return contract;
    }

    /**
     * Get contracts with optional filters.
     *
     * @param filter - Optional filter criteria
     * @returns Filtered contracts TODO: filter spent/unspent
     *
     * @example
     * ```typescript
     * // Get all VHTLC contracts
     * const vhtlcs = await manager.getContracts({ type: 'vhtlc' });
     *
     * // Get all active contracts
     * const active = await manager.getContracts({ state: 'active' });
     * ```
     */
    async getContracts(filter?: GetContractsFilter): Promise<Contract[]> {
        const dbFilter = this.buildContractsDbFilter(filter ?? {});
        return await this.config.contractRepository.getContracts(dbFilter);
    }

    async getContractsWithVtxos(
        filter?: GetContractsFilter,
        pageSize?: number
    ): Promise<ContractWithVtxos[]> {
        const contracts = await this.getContracts(filter);
        const vtxos = await this.getVtxosForContracts(contracts, pageSize);
        return contracts.map((contract) => ({
            contract,
            vtxos: vtxos.get(contract.script) ?? [],
        }));
    }

    private buildContractsDbFilter(filter: GetContractsFilter): ContractFilter {
        return {
            script: filter.script,
            state: filter.state,
            type: filter.type,
        };
    }

    /**
     * Update a contract.
     * Nested fields like `params` and `metadata` are replaced with the provided values.
     * If you need to preserve existing fields, merge them manually.
     *
     * @param script - Contract script
     * @param updates - Fields to update
     */
    async updateContract(
        script: string,
        updates: Partial<Omit<Contract, "script" | "createdAt">>
    ): Promise<Contract> {
        const contracts = await this.config.contractRepository.getContracts({
            script,
        });
        const existing = contracts[0];
        if (!existing) {
            throw new Error(`Contract ${script} not found`);
        }

        const updated: Contract = {
            ...existing,
            ...updates,
        };

        await this.config.contractRepository.saveContract(updated);
        await this.watcher.updateContract(updated);

        return updated;
    }

    /**
     * Update a contract's params.
     * This method preserves existing params by merging the provided values.
     *
     * @param script - Contract script
     * @param updates - The new values to merge with existing params
     */
    async updateContractParams(
        script: string,
        updates: Contract["params"]
    ): Promise<Contract> {
        const contracts = await this.config.contractRepository.getContracts({
            script,
        });
        const existing = contracts[0];
        if (!existing) {
            throw new Error(`Contract ${script} not found`);
        }

        const updated: Contract = {
            ...existing,
            params: { ...existing.params, ...updates },
        };

        await this.config.contractRepository.saveContract(updated);
        await this.watcher.updateContract(updated);

        return updated;
    }

    /**
     * Set a contract's state.
     */
    async setContractState(
        script: string,
        state: ContractState
    ): Promise<void> {
        await this.updateContract(script, { state });
    }

    /**
     * Delete a contract.
     *
     * @param script - Contract script
     */
    async deleteContract(script: string): Promise<void> {
        await this.config.contractRepository.deleteContract(script);
        await this.watcher.removeContract(script);
    }

    /**
     * Get currently spendable paths for a contract.
     *
     * @param contractScript - The contract script
     * @param options - Options for getting spendable paths
     */
    async getSpendablePaths(
        options: GetSpendablePathsOptions
    ): Promise<PathSelection[]> {
        const {
            contractScript,
            collaborative = true,
            walletPubKey,
            vtxo,
        } = options;

        const [contract] = await this.getContracts({ script: contractScript });
        if (!contract) return [];

        const handler = contractHandlers.get(contract.type);
        if (!handler) return [];

        const script = handler.createScript(contract.params);
        const context: PathContext = {
            collaborative,
            currentTime: Date.now(),
            walletPubKey,
            vtxo,
        };

        return handler.getSpendablePaths(script, contract, context);
    }

    async getAllSpendingPaths(
        options: GetAllSpendingPathsOptions
    ): Promise<PathSelection[]> {
        const { contractScript, collaborative = true, walletPubKey } = options;

        const [contract] = await this.getContracts({ script: contractScript });
        if (!contract) return [];

        const handler = contractHandlers.get(contract.type);
        if (!handler) return [];

        const script = handler.createScript(contract.params);
        const context: PathContext = {
            collaborative,
            currentTime: Date.now(),
            walletPubKey,
        };

        return handler.getAllSpendingPaths(script, contract, context);
    }

    /**
     * Register a callback for contract events.
     *
     * The manager automatically watches after `initialize()`. This method
     * allows registering callbacks to receive events.
     *
     * @param callback - Event callback
     * @returns Unsubscribe function to remove this callback
     *
     * @example
     * ```typescript
     * const unsubscribe = manager.onContractEvent((event) => {
     *   console.log(`${event.type} on ${event.contractScript}`);
     * });
     *
     * // Later: stop receiving events
     * unsubscribe();
     * ```
     */
    onContractEvent(callback: ContractEventCallback): () => void {
        this.eventCallbacks.add(callback);
        return () => {
            this.eventCallbacks.delete(callback);
        };
    }

    /**
     * Force a VTXO refresh from the indexer.
     *
     * Without options, clears all sync cursors and re-fetches every contract.
     * With options, narrows the refresh to specific scripts and/or a time window.
     */
    async refreshVtxos(opts?: RefreshVtxosOptions): Promise<void> {
        let contracts = await this.config.contractRepository.getContracts();

        if (opts?.scripts && opts.scripts.length > 0) {
            const scriptSet = new Set(opts.scripts);
            contracts = contracts.filter((c) => scriptSet.has(c.script));
        }

        const syncWindow =
            opts?.after !== undefined || opts?.before !== undefined
                ? {
                      after: opts.after ?? 0,
                      before: opts.before ?? Date.now(),
                  }
                : undefined;

        if (!syncWindow) {
            // Full refresh — clear cursors so the next delta sync re-bootstraps.
            if (opts?.scripts && opts.scripts.length > 0) {
                await clearSyncCursors(
                    this.config.walletRepository,
                    opts.scripts
                );
            } else {
                await clearSyncCursors(this.config.walletRepository);
            }
        }

        const requestStartedAt = Date.now();
        const fetched = await this.fetchContractVxosFromIndexer(
            contracts,
            true,
            undefined,
            syncWindow
        );

        // Persist cursors so subsequent incremental syncs don't re-bootstrap.
        const cutoff = cursorCutoff(requestStartedAt);
        const cursorUpdates: Record<string, number> = {};
        for (const script of fetched.keys()) {
            cursorUpdates[script] = cutoff;
        }
        if (Object.keys(cursorUpdates).length > 0) {
            await advanceSyncCursors(
                this.config.walletRepository,
                cursorUpdates
            );
        }
    }

    /**
     * Check if currently watching.
     */
    async isWatching(): Promise<boolean> {
        return this.watcher.isCurrentlyWatching();
    }

    /**
     * Emit an event to all registered callbacks.
     */
    private emitEvent(event: ContractEvent): void {
        for (const callback of this.eventCallbacks) {
            try {
                callback(event);
            } catch (error) {
                console.error("Error in contract event callback:", error);
            }
        }
    }

    /**
     * Handle events from the watcher.
     */
    private async handleContractEvent(event: ContractEvent) {
        switch (event.type) {
            // Delta-sync only the changed VTXOs for this contract.
            case "vtxo_received":
            case "vtxo_spent":
                await this.deltaSyncContracts([event.contract]);
                break;
            case "connection_reset": {
                // After a reconnect we don't know what we missed — full refetch.
                const activeWatchedContracts =
                    this.watcher.getActiveContracts();
                await this.fetchContractVxosFromIndexer(
                    activeWatchedContracts,
                    true
                );
                break;
            }
            case "contract_expired":
                // just update DB
                await this.config.contractRepository.saveContract(
                    event.contract
                );
        }

        // Forward to all callbacks
        this.emitEvent(event);
    }

    private async getVtxosForContracts(
        contracts: Contract[],
        pageSize?: number
    ): Promise<Map<string, ContractVtxo[]>> {
        if (contracts.length === 0) {
            return new Map();
        }

        return await this.fetchContractVxosFromIndexer(
            contracts,
            false,
            pageSize
        );
    }

    /**
     * Incrementally sync VTXOs for the given contracts.
     * Uses per-script cursors to fetch only what changed since the last sync.
     * Scripts without a cursor are bootstrapped with a full fetch.
     */
    private async deltaSyncContracts(
        contracts: Contract[],
        pageSize?: number
    ): Promise<Map<string, ContractVtxo[]>> {
        if (contracts.length === 0) return new Map();

        const cursors = await getAllSyncCursors(this.config.walletRepository);

        // Partition into bootstrap (no cursor) and delta (has cursor) groups.
        const bootstrap: Contract[] = [];
        const delta: Contract[] = [];
        for (const c of contracts) {
            if (cursors[c.script] !== undefined) {
                delta.push(c);
            } else {
                bootstrap.push(c);
            }
        }

        const result = new Map<string, ContractVtxo[]>();
        const cursorUpdates: Record<string, number> = {};

        // Full bootstrap for new scripts.
        if (bootstrap.length > 0) {
            const requestStartedAt = Date.now();
            const fetched = await this.fetchContractVxosFromIndexer(
                bootstrap,
                true
            );
            const cutoff = cursorCutoff(requestStartedAt);
            for (const [script, vtxos] of fetched) {
                result.set(script, vtxos);
                cursorUpdates[script] = cutoff;
            }
        }

        // Delta sync for scripts with an existing cursor.
        if (delta.length > 0) {
            // Use the oldest cursor so the shared window covers every script.
            const minCursor = Math.min(...delta.map((c) => cursors[c.script]));
            const window = computeSyncWindow(minCursor);
            if (window) {
                const requestStartedAt = Date.now();
                const fetched = await this.fetchContractVxosFromIndexer(
                    delta,
                    true,
                    pageSize,
                    window
                );
                const cutoff = cursorCutoff(requestStartedAt);
                for (const [script, vtxos] of fetched) {
                    result.set(script, vtxos);
                    cursorUpdates[script] = cutoff;
                }
            }
        }

        if (Object.keys(cursorUpdates).length > 0) {
            await advanceSyncCursors(
                this.config.walletRepository,
                cursorUpdates
            );
        }

        return result;
    }

    /**
     * Fetch all pending (not-yet-finalized) VTXOs and upsert them into the
     * repository. This catches VTXOs whose state changed outside the delta
     * window (e.g. a spend that hasn't settled yet).
     */
    private async reconcilePendingFrontier(
        contracts: Contract[]
    ): Promise<void> {
        const scripts = contracts.map((c) => c.script);
        const scriptToContract = new Map<string, Contract>(
            contracts.map((c) => [c.script, c])
        );

        const { vtxos } = await this.config.indexerProvider.getVtxos({
            scripts,
            pendingOnly: true,
        });

        // Group by contract and upsert.
        const byContract = new Map<string, ContractVtxo[]>();
        for (const vtxo of vtxos) {
            if (!vtxo.script) continue;
            const contract = scriptToContract.get(vtxo.script);
            if (!contract) continue;
            let arr = byContract.get(contract.address);
            if (!arr) {
                arr = [];
                byContract.set(contract.address, arr);
            }
            arr.push({
                ...extendVtxoFromContract(vtxo, contract),
                contractScript: contract.script,
            });
        }

        for (const [addr, contractVtxos] of byContract) {
            await this.config.walletRepository.saveVtxos(addr, contractVtxos);
        }
    }

    private async fetchContractVxosFromIndexer(
        contracts: Contract[],
        includeSpent: boolean,
        pageSize?: number,
        syncWindow?: { after?: number; before?: number }
    ): Promise<Map<string, ContractVtxo[]>> {
        const fetched = await this.fetchContractVtxosBulk(
            contracts,
            includeSpent,
            pageSize,
            syncWindow
        );
        const result = new Map<string, ContractVtxo[]>();
        for (const [contractScript, vtxos] of fetched) {
            result.set(contractScript, vtxos);
            const contract = contracts.find((c) => c.script === contractScript);
            if (contract) {
                await this.config.walletRepository.saveVtxos(
                    contract.address,
                    vtxos
                );
            }
        }
        return result;
    }

    private async fetchContractVtxosBulk(
        contracts: Contract[],
        includeSpent: boolean,
        pageSize: number = DEFAULT_PAGE_SIZE,
        syncWindow?: { after?: number; before?: number }
    ): Promise<Map<string, ContractVtxo[]>> {
        if (contracts.length === 0) {
            return new Map();
        }

        // For a single contract, use the paginated path directly.
        if (contracts.length === 1) {
            const contract = contracts[0];
            const vtxos = await this.fetchContractVtxosPaginated(
                contract,
                includeSpent,
                pageSize,
                syncWindow
            );
            return new Map([[contract.script, vtxos]]);
        }

        // For multiple contracts, batch all scripts into a single indexer call
        // per page to minimise round-trips.  Results are keyed by script so we
        // can distribute them back to the correct contract afterwards.
        const scriptToContract = new Map<string, Contract>(
            contracts.map((c) => [c.script, c])
        );
        const result = new Map<string, ContractVtxo[]>(
            contracts.map((c) => [c.script, []])
        );

        const scripts = contracts.map((c) => c.script);
        const opts = includeSpent ? {} : { spendableOnly: true };
        const windowOpts = syncWindow
            ? {
                  ...(syncWindow.after !== undefined && {
                      after: syncWindow.after,
                  }),
                  ...(syncWindow.before !== undefined && {
                      before: syncWindow.before,
                  }),
              }
            : {};
        let pageIndex = 0;
        let hasMore = true;

        while (hasMore) {
            const { vtxos, page } = await this.config.indexerProvider.getVtxos({
                scripts,
                ...opts,
                ...windowOpts,
                pageIndex,
                pageSize,
            });

            for (const vtxo of vtxos) {
                // Match the VTXO back to its contract via the script field
                // populated by the indexer.
                if (!vtxo.script) continue;
                const contract = scriptToContract.get(vtxo.script);
                if (!contract) continue;
                result.get(contract.script)!.push({
                    ...extendVtxoFromContract(vtxo, contract),
                    contractScript: contract.script,
                });
            }

            hasMore = page ? vtxos.length === pageSize : false;
            pageIndex++;
            if (hasMore) await new Promise((r) => setTimeout(r, 500));
        }

        return result;
    }

    private async fetchContractVtxosPaginated(
        contract: Contract,
        includeSpent: boolean,
        pageSize: number = DEFAULT_PAGE_SIZE,
        syncWindow?: { after?: number; before?: number }
    ): Promise<ContractVtxo[]> {
        const allVtxos: ContractVtxo[] = [];
        let pageIndex = 0;
        let hasMore = true;

        const opts = includeSpent ? {} : { spendableOnly: true };
        const windowOpts = syncWindow
            ? {
                  ...(syncWindow.after !== undefined && {
                      after: syncWindow.after,
                  }),
                  ...(syncWindow.before !== undefined && {
                      before: syncWindow.before,
                  }),
              }
            : {};

        while (hasMore) {
            const { vtxos, page } = await this.config.indexerProvider.getVtxos({
                scripts: [contract.script],
                ...opts,
                ...windowOpts,
                pageIndex,
                pageSize,
            });

            for (const vtxo of vtxos) {
                allVtxos.push({
                    ...extendVtxoFromContract(vtxo, contract),
                    contractScript: contract.script,
                });
            }

            hasMore = page ? vtxos.length === pageSize : false;
            pageIndex++;
            if (hasMore) await new Promise((r) => setTimeout(r, 500));
        }

        return allVtxos;
    }

    /**
     * Dispose of the ContractManager and release all resources.
     *
     * Stops the watcher, clears callbacks, and marks
     * the manager as uninitialized.
     *
     * Implements the disposable pattern for cleanup.
     */
    dispose(): void {
        // Stop watching
        this.stopWatcherFn?.();
        this.stopWatcherFn = undefined;

        // Clear callbacks
        this.eventCallbacks.clear();

        // Mark as uninitialized
        this.initialized = false;
    }

    /**
     * Symbol.dispose implementation for using with `using` keyword.
     * @example
     * ```typescript
     * {
     *   using manager = await wallet.getContractManager();
     *   // ... use manager
     * } // automatically disposed
     * ```
     */
    [Symbol.dispose](): void {
        // Stop watching
        this.stopWatcherFn?.();
        this.stopWatcherFn = undefined;

        // Clear callbacks
        this.eventCallbacks.clear();

        // Mark as uninitialized
        this.initialized = false;
    }
}
