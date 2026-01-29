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
import { ExtendedVirtualCoin, VirtualCoin } from "../wallet";
import { ContractFilter, ContractRepository } from "../repositories";

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
 *   extendVtxo,
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

    /** Function to extend VirtualCoin to ExtendedVirtualCoin */
    extendVtxo: (vtxo: VirtualCoin) => ExtendedVirtualCoin;

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
 *   extendVtxo: (vtxo) => extendVirtualCoin(wallet, vtxo),
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

        // fetch latest VTXOs for all contracts, ensure cache is up to date
        // TODO: what if the user has 1k contracts?
        await this.getVtxosForContracts(contracts);

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
            this.handleContractEvent(event);
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

        // ensure we have the latest VTXOs for this contract
        await this.getVtxosForContracts([contract]);

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
        filter?: GetContractsFilter
    ): Promise<ContractWithVtxos[]> {
        const contracts = await this.getContracts(filter);
        const vtxos = await this.getVtxosForContracts(contracts);
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
            // Every time there is a VTXO event for a contract, refresh all its VTXOs
            case "vtxo_received":
            case "vtxo_spent":
                await this.fetchContractVxosFromIndexer([event.contract], true);
                break;
            case "connection_reset":
                // Refetch all VTXOs for all active contracts
                const activeWatchedContracts =
                    this.watcher.getActiveContracts();
                await this.fetchContractVxosFromIndexer(
                    activeWatchedContracts,
                    false
                );
                break;
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
        contracts: Contract[]
    ): Promise<Map<string, ContractVtxo[]>> {
        if (contracts.length === 0) {
            return new Map();
        }

        return await this.fetchContractVxosFromIndexer(
            contracts,
            false,
            this.config.extendVtxo
        );
    }

    private async fetchContractVxosFromIndexer(
        contracts: Contract[],
        includeSpent: boolean,
        extendVtxo?: (vtxo: VirtualCoin) => ExtendedVirtualCoin
    ): Promise<Map<string, ContractVtxo[]>> {
        const fetched = await this.fetchContractVtxosBulk(
            contracts,
            includeSpent,
            extendVtxo
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
        extendVtxo?: (vtxo: VirtualCoin) => ExtendedVirtualCoin
    ): Promise<Map<string, ContractVtxo[]>> {
        const result = new Map<string, ContractVtxo[]>();

        await Promise.all(
            contracts.map(async (contract) => {
                const vtxos = await this.fetchContractVtxosPaginated(
                    contract,
                    includeSpent,
                    extendVtxo
                );
                result.set(contract.script, vtxos);
            })
        );

        return result;
    }

    private async fetchContractVtxosPaginated(
        contract: Contract,
        includeSpent: boolean,
        extendVtxo?: (vtxo: VirtualCoin) => ExtendedVirtualCoin
    ): Promise<ContractVtxo[]> {
        const pageSize = 100;
        const allVtxos: ContractVtxo[] = [];
        let pageIndex = 0;
        let hasMore = true;

        const opts = includeSpent ? {} : { spendableOnly: true };

        while (hasMore) {
            const { vtxos, page } = await this.config.indexerProvider.getVtxos({
                scripts: [contract.script],
                ...opts,
                pageIndex,
                pageSize,
            });

            for (const vtxo of vtxos) {
                const ext = extendVtxo
                    ? extendVtxo(vtxo)
                    : (vtxo as ExtendedVirtualCoin);

                allVtxos.push({
                    ...ext,
                    contractScript: contract.script,
                });
            }

            hasMore = page ? vtxos.length === pageSize : false;
            pageIndex++;
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
