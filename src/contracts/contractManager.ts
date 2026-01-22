import { hex } from "@scure/base";
import { IndexerProvider } from "../providers/indexer";
import { WalletRepository } from "../repositories/walletRepository";
import {
    Contract,
    ContractBalance,
    ContractEvent,
    ContractEventCallback,
    ContractState,
    ContractVtxo,
    ContractWithVtxos,
    GetContractsFilter,
    GetContractVtxosOptions,
    PathContext,
    PathSelection,
} from "./types";
import { ContractWatcher, ContractWatcherConfig } from "./contractWatcher";
import { ContractVtxoCache, IndexerContractVtxoCache } from "./contractCache";
import { contractHandlers } from "./handlers";
import { ExtendedVirtualCoin, VirtualCoin } from "../wallet";
import { ContractRepository } from "../repositories";
import { Response } from "../wallet/serviceWorker/response";

/**
 * Options for getting spendable paths.
 */
export type GetSpendablePathsOptions = {
    /** The contract ID */
    contractId: string;
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

    /** Optional VTXO cache to centralize data retrieval */
    vtxoCache?: ContractVtxoCache;

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
export type CreateContractParams = Omit<
    Contract,
    "id" | "createdAt" | "state"
> & {
    /** Optional ID override (auto-generated if not provided) */
    id?: string;
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
 *   console.log(`${event.type} on ${event.contractId}`);
 * });
 *
 * // Get balance across all contracts
 * const balances = await manager.getAllBalances();
 * ```
 */
export class ContractManager {
    private config: ContractManagerConfig;
    private watcher: ContractWatcher;
    private vtxoCache: ContractVtxoCache;
    private initialized = false;
    private eventCallbacks: Set<ContractEventCallback> = new Set();
    private stopWatcherFn?: () => void;

    private constructor(config: ContractManagerConfig) {
        this.config = config;
        this.vtxoCache =
            config.vtxoCache ||
            new IndexerContractVtxoCache(
                config.indexerProvider,
                config.walletRepository
            );

        // Create watcher with wallet repository for VTXO caching
        this.watcher = new ContractWatcher({
            indexerProvider: config.indexerProvider,
            walletRepository: config.walletRepository,
            ...config.watcherConfig,
        });
    }

    /**
     * Static factory method for creating a new ContractManager, handles initialization.
     * @param config
     */
    static async create(
        config: ContractManagerConfig
    ): Promise<ContractManager> {
        const cm = new ContractManager(config);
        await cm.initialize();
        return cm;
    }

    /**
     * Initialize the manager by loading persisted contracts and starting to watch.
     *
     * After initialization, the manager automatically watches all active contracts
     * and contracts with VTXOs. Use `onContractEvent()` to register event callbacks.
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        // Load persisted contracts
        const contracts = await this.config.contractRepository.getContracts();

        // fetch latest VTXOs for all contracts, ensure cache is up to date
        await this.vtxoCache.getContractVtxos(contracts, {
            refresh: true,
            includeSpent: true,
        });

        // add all contracts to the watcher
        const now = Date.now();
        for (const contract of contracts) {
            // Check for expired contracts
            if (
                contract.state === "active" &&
                contract.expiresAt &&
                contract.expiresAt <= now
            ) {
                contract.state = "expired";
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
     * The contract ID defaults to the script (pkScript hex), ensuring
     * uniqueness since each script represents a unique spending condition.
     *
     * @param params - Contract parameters
     * @returns The created contract
     */
    async createContract(params: CreateContractParams): Promise<Contract> {
        this.ensureInitialized();

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

        // Use provided ID or default to script (scripts are unique identifiers)
        const id = params.id || params.script;

        // Check if contract already exists and verify it's the same type to avoid silent mismatches
        const existing = await this.getContract(id);
        if (existing) {
            if (existing.type === params.type) return existing;
            throw new Error(
                `Contract with ID ${id} already exists with with type ${existing.type}.`
            );
        }

        const contract: Contract = {
            ...params,
            id,
            createdAt: Date.now(),
            state: params.state || "active",
        };

        // Persist
        await this.config.contractRepository.saveContract(contract);

        // ensure cache is up to date for the contract
        await this.vtxoCache.getContractVtxos([contract], {
            refresh: true,
            includeSpent: true,
        });

        // Add to watcher
        await this.watcher.addContract(contract);

        return contract;
    }

    /**
     * Get a contract by ID.
     */
    async getContract(id: string): Promise<Contract | null> {
        this.ensureInitialized();
        const result = await this.config.contractRepository.getContracts({
            id,
        });
        return result[0] ?? null;
    }

    /**
     * Get a contract by its script.
     */
    async getContractByScript(script: string): Promise<Contract | null> {
        this.ensureInitialized();
        const contracts = await this.config.contractRepository.getContracts({
            script,
        });
        return contracts[0] || null;
    }

    /**
     * Get all contracts.
     */
    async getAllContracts(): Promise<Contract[]> {
        this.ensureInitialized();
        return await this.config.contractRepository.getContracts();
    }

    /**
     * Get all active contracts.
     */
    async getActiveContracts(): Promise<Contract[]> {
        this.ensureInitialized();
        return await this.config.contractRepository.getContracts({
            state: "active",
        });
    }

    /**
     * Get contracts with optional filters.
     *
     * @param filter - Optional filter criteria
     * @returns Filtered contracts
     *
     * @example
     * ```typescript
     * // Get all VHTLC contracts
     * const vhtlcs = await manager.getContracts({ type: 'vhtlc' });
     *
     * // Get all active contracts
     * const active = await manager.getContracts({ state: 'active' });
     *
     * // Get contracts with their VTXOs included
     * const withVtxos = await manager.getContracts({ withVtxos: true });
     * // withVtxos[0].contract, withVtxos[0].vtxos
     * ```
     */
    async getContracts(
        filter: GetContractsFilter & { withVtxos: true }
    ): Promise<ContractWithVtxos[]>;
    async getContracts(filter?: GetContractsFilter): Promise<Contract[]>;
    async getContracts(
        filter?: GetContractsFilter
    ): Promise<Contract[] | ContractWithVtxos[]> {
        this.ensureInitialized();

        // TODO: filter here
        let contracts = await this.config.contractRepository.getContracts();

        if (!filter) {
            return contracts;
        }

        // Filter by state
        if (filter.state !== undefined) {
            const states = Array.isArray(filter.state)
                ? filter.state
                : [filter.state];
            contracts = contracts.filter((c) => states.includes(c.state));
        }

        // Filter by type
        if (filter.type !== undefined) {
            const types = Array.isArray(filter.type)
                ? filter.type
                : [filter.type];
            contracts = contracts.filter((c) => types.includes(c.type));
        }

        // Include VTXOs in result
        if (filter.withVtxos) {
            // Fetch all VTXOs in bulk
            const vtxosMap = await this.getVtxosForContracts(contracts);
            return contracts.map((contract) => ({
                contract,
                vtxos: vtxosMap.get(contract.id) || [],
            }));
        }

        return contracts;
    }

    /**
     * Update a contract.
     *
     * @param id - Contract ID
     * @param updates - Fields to update
     */
    async updateContract(
        id: string,
        updates: Partial<Omit<Contract, "id" | "createdAt">>
    ): Promise<Contract> {
        this.ensureInitialized();

        const contracts = await this.config.contractRepository.getContracts({
            id,
        });
        const existing = contracts[0];
        if (!existing) {
            throw new Error(`Contract ${id} not found`);
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
     * Set a contract's state.
     */
    async setContractState(id: string, state: ContractState): Promise<void> {
        this.ensureInitialized();

        const contracts = await this.config.contractRepository.getContracts({
            id,
        });
        const contract = contracts[0];
        if (!contract) {
            throw new Error(`Contract ${id} not found`);
        }

        const updated: Contract = { ...contract, state };
        await this.config.contractRepository.saveContract(updated);
        await this.watcher.updateContract(updated);
    }

    /**
     * Activate a contract.
     */
    async activateContract(id: string): Promise<void> {
        await this.setContractState(id, "active");
    }

    /**
     * Deactivate a contract.
     */
    async deactivateContract(id: string): Promise<void> {
        await this.setContractState(id, "inactive");
    }

    /**
     * Update a contract's runtime data.
     * Useful for setting preimages, etc.
     */
    async updateContractData(
        id: string,
        data: Record<string, string>
    ): Promise<void> {
        this.ensureInitialized();

        const contract = await this.getContract(id);
        if (!contract) {
            throw new Error(`Contract ${id} not found`);
        }

        const updatedContract: Contract = {
            ...contract,
            data: {
                ...contract.data,
                ...data,
            },
        };

        await this.config.contractRepository.saveContract(updatedContract);
        await this.watcher.updateContract(updatedContract);
    }

    /**
     * Delete a contract.
     *
     * @param id - Contract ID
     */
    async deleteContract(id: string): Promise<void> {
        this.ensureInitialized();

        await this.config.contractRepository.deleteContract(id);
        await this.watcher.removeContract(id);
    }

    /**
     * Get VTXOs for contracts.
     */
    async getContractVtxos(
        options?: GetContractVtxosOptions
    ): Promise<Map<string, ContractVtxo[]>> {
        this.ensureInitialized();
        const contracts = await this.getAllContracts();
        return this.vtxoCache.getContractVtxos(
            contracts,
            options,
            this.config.extendVtxo
        );
    }

    private async getVtxosForContracts(
        contracts: Contract[]
    ): Promise<Map<string, ContractVtxo[]>> {
        this.ensureInitialized();
        return this.vtxoCache.getContractVtxos(
            contracts,
            {},
            this.config.extendVtxo
        );
    }

    /**
     * Get VTXOs for a specific contract.
     */
    async getVtxosForContract(contractId: string): Promise<ContractVtxo[]> {
        const vtxosMap = await this.getContractVtxos({
            activeOnly: false,
            contractIds: [contractId],
        });
        return vtxosMap.get(contractId) || [];
    }

    /**
     * Get balance for a specific contract.
     */
    async getContractBalance(contractId: string): Promise<ContractBalance> {
        this.ensureInitialized();
        const vtxosMap = await this.getContractVtxos({
            activeOnly: false,
            contractIds: [contractId],
        });

        const vtxos = vtxosMap.get(contractId) || [];

        let total = 0;
        let spendable = 0;

        for (const vtxo of vtxos) {
            if (vtxo.isSpent) continue;

            total += vtxo.value;

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
     * Get balances for all contracts.
     */
    async getAllBalances(): Promise<Map<string, ContractBalance>> {
        this.ensureInitialized();

        const contracts = await this.getAllContracts();
        const balances = new Map<string, ContractBalance>();

        for (const contract of contracts) {
            const balance = await this.getContractBalance(contract.id);
            balances.set(contract.id, balance);
        }

        return balances;
    }

    /**
     * Get total balance across all active contracts.
     */
    async getTotalContractBalance(): Promise<ContractBalance> {
        const allBalances = await this.getAllBalances();

        const result: ContractBalance = {
            total: 0,
            spendable: 0,
            vtxoCount: 0,
        };

        for (const balance of allBalances.values()) {
            result.total += balance.total;
            result.spendable += balance.spendable;
            result.vtxoCount += balance.vtxoCount;
        }

        return result;
    }

    /**
     * Get spendable paths for a contract.
     *
     * @param contractId - The contract ID
     * @param options - Options for getting spendable paths
     */
    async getSpendablePaths(
        options: GetSpendablePathsOptions
    ): Promise<PathSelection[]> {
        const { contractId, collaborative = true, walletPubKey } = options;

        const contract = await this.getContract(contractId);
        if (!contract) return [];

        const handler = contractHandlers.get(contract.type);
        if (!handler) return [];

        const script = handler.createScript(contract.params);
        const context: PathContext = {
            collaborative,
            currentTime: Date.now(),
            walletPubKey,
        };

        return handler.getSpendablePaths(script, contract, context);
    }

    /**
     * Check if a contract has any spendable paths.
     *
     * @param contractId - The contract ID
     * @param collaborative - Whether collaborative spending is available
     * @param walletPubKey - Wallet's public key (hex) to determine role
     */
    async canSpend(
        contractId: string,
        collaborative: boolean = true,
        walletPubKey?: string
    ): Promise<boolean> {
        const spendablePaths = await this.getSpendablePaths({
            contractId,
            collaborative,
            walletPubKey,
        });
        return spendablePaths.length > 0;
    }

    /**
     * Get the spending path for a contract's VTXOs.
     *
     * @param contractId - The contract ID
     * @param collaborative - Whether collaborative spending is available
     */
    async getSpendingPath(contractId: string, collaborative: boolean = true) {
        const [contract] = await this.config.contractRepository.getContracts({
            id: contractId,
        });
        if (!contract) return null;

        const handler = contractHandlers.get(contract.type);
        if (!handler) return null;

        const script = handler.createScript(contract.params);
        const context: PathContext = {
            collaborative,
            currentTime: Date.now(),
        };

        return handler.selectPath(script, contract, context);
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
     *   console.log(`${event.type} on ${event.contractId}`);
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
    isWatching(): boolean {
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
                {
                    if (event.contract) {
                        this.vtxoCache.getContractVtxos([event.contract], {
                            includeSpent: true,
                            refresh: true,
                        });
                    }
                }
                break;
            case "connection_reset":
                // Refetch all VTXOs for all active contracts
                const activeWatchedContracts =
                    this.watcher.getActiveContracts();
                await this.vtxoCache.getContractVtxos(activeWatchedContracts, {
                    includeSpent: true,
                    refresh: true,
                });
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

    /**
     * Ensure the manager has been initialized.
     */
    private ensureInitialized(): void {
        if (!this.initialized) {
            throw new Error(
                "ContractManager not initialized. Call initialize() first."
            );
        }
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
        this.dispose();
    }
}
