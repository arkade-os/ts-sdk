import { hex } from "@scure/base";
import { IndexerProvider } from "../providers/indexer";
import { ContractManagerRepository } from "../repositories/contractRepository";
import { WalletRepository } from "../repositories/walletRepository";
import {
    Contract,
    ContractVtxo,
    ContractState,
    ContractEvent,
    ContractEventType,
    ContractEventCallback,
    ContractBalance,
    ContractWithVtxos,
    GetContractsFilter,
    GetContractVtxosOptions,
    SweeperConfig,
    SweepResult,
    PathContext,
    PathSelection,
} from "./types";
import { ContractWatcher, ContractWatcherConfig } from "./contractWatcher";
import { ContractSweeper, ContractSweeperDeps } from "./contractSweeper";
import { contractHandlers } from "./handlers";
import { VirtualCoin, ExtendedVirtualCoin, isSpendable } from "../wallet";

/**
 * Configuration for the ContractManager.
 */
export interface ContractManagerConfig {
    /** The indexer provider */
    indexerProvider: IndexerProvider;

    /** The contract repository for persistence */
    contractRepository: ContractManagerRepository;

    /** The wallet repository for VTXO storage (single source of truth) */
    walletRepository?: WalletRepository;

    /** Function to extend VirtualCoin to ExtendedVirtualCoin */
    extendVtxo: (vtxo: VirtualCoin) => ExtendedVirtualCoin;

    /** Function to get the wallet's default Ark address */
    getDefaultAddress: () => Promise<string>;

    /** Function to execute a sweep transaction */
    executeSweep?: (
        vtxos: ContractVtxo[],
        destination: string
    ) => Promise<string>;

    /** Function to get current block height (optional) */
    getCurrentBlockHeight?: () => Promise<number>;

    /** Sweeper configuration */
    sweeperConfig?: Partial<SweeperConfig>;

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
 * - Automatic sweeping via ContractSweeper
 * - VTXO queries across contracts
 *
 * @example
 * ```typescript
 * const manager = new ContractManager({
 *   indexerProvider: wallet.indexerProvider,
 *   contractRepository: wallet.contractRepository,
 *   extendVtxo: (vtxo) => extendVirtualCoin(wallet, vtxo),
 *   getDefaultAddress: () => wallet.getAddress(),
 *   executeSweep: async (vtxos, dest) => {
 *     // Build and execute sweep transaction
 *     return txid;
 *   },
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
 *   autoSweep: true,
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
    private sweeper?: ContractSweeper;
    private initialized = false;
    private eventCallbacks: Set<ContractEventCallback> = new Set();
    private stopWatcherFn?: () => void;

    constructor(config: ContractManagerConfig) {
        this.config = config;

        // Create watcher with wallet repository for VTXO caching
        this.watcher = new ContractWatcher({
            indexerProvider: config.indexerProvider,
            walletRepository: config.walletRepository,
            ...config.watcherConfig,
        });

        // Create sweeper if executeSweep is provided
        if (config.executeSweep) {
            const sweeperDeps: ContractSweeperDeps = {
                contractWatcher: this.watcher,
                getDefaultAddress: config.getDefaultAddress,
                executeSweep: config.executeSweep,
                extendVtxo: config.extendVtxo,
                getCurrentBlockHeight: config.getCurrentBlockHeight,
            };

            this.sweeper = new ContractSweeper(
                sweeperDeps,
                config.sweeperConfig
            );
        }
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

        // Check for expired contracts
        const now = Date.now();
        for (const contract of contracts) {
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

        // Start sweeper if configured
        this.sweeper?.start((event) => {
            if (event.type === "vtxo_spendable") {
                this.emitEvent({
                    type: "vtxo_spendable" as ContractEventType,
                    contractId: event.contractId,
                    vtxos: event.vtxos,
                    timestamp: Date.now(),
                });
            }
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
        if (!contractHandlers.has(params.type)) {
            throw new Error(
                `No handler registered for contract type '${params.type}'`
            );
        }

        // Use provided ID or default to script (scripts are unique identifiers)
        const id = params.id || params.script;

        // Check if contract already exists
        const existing = await this.getContract(id);
        if (existing) {
            return existing;
        }

        const contract: Contract = {
            ...params,
            id,
            createdAt: Date.now(),
            state: params.state || "active",
        };

        // Persist
        await this.config.contractRepository.saveContract(contract);

        // Add to watcher
        await this.watcher.addContract(contract);

        return contract;
    }

    /**
     * Get a contract by ID.
     */
    async getContract(id: string): Promise<Contract | null> {
        this.ensureInitialized();
        return this.watcher.getContract(id) || null;
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
    getAllContracts(): Contract[] {
        this.ensureInitialized();
        return this.watcher.getAllContracts();
    }

    /**
     * Get all active contracts.
     */
    getActiveContracts(): Contract[] {
        this.ensureInitialized();
        return this.watcher.getActiveContracts();
    }

    /**
     * Get contracts by state.
     * @deprecated Use getContracts({ state }) instead
     */
    async getContractsByState(state: ContractState): Promise<Contract[]> {
        this.ensureInitialized();
        return this.config.contractRepository.getContracts({ state });
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
     * // Get active contracts with autoSweep enabled
     * const sweepable = await manager.getContracts({
     *   state: 'active',
     *   autoSweep: true
     * });
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

        let contracts = this.watcher.getAllContracts();

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

        // Filter by autoSweep
        if (filter.autoSweep !== undefined) {
            contracts = contracts.filter(
                (c) => (c.autoSweep ?? false) === filter.autoSweep
            );
        }

        // Include VTXOs in result
        if (filter.withVtxos) {
            // Fetch all VTXOs in bulk
            const vtxosMap = await this.getContractVtxos({
                activeOnly: false,
                contractIds: contracts.map((c) => c.id),
            });

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
        await this.watcher.setContractActive(id, state === "active");
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
     * @param sweepFirst - If true, sweep any remaining VTXOs first
     */
    async deleteContract(id: string, sweepFirst = false): Promise<void> {
        this.ensureInitialized();

        if (sweepFirst && this.sweeper) {
            await this.sweeper.sweepContract(id);
        }

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
        return this.watcher.getContractVtxos(options, this.config.extendVtxo);
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
        return this.watcher.getContractBalance(
            contractId,
            this.config.extendVtxo
        );
    }

    /**
     * Get balances for all contracts.
     */
    async getAllBalances(): Promise<Map<string, ContractBalance>> {
        this.ensureInitialized();

        const contracts = this.getAllContracts();
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
     * @param collaborative - Whether collaborative spending is available
     * @param walletPubKey - Wallet's public key (hex) to determine role
     */
    getSpendablePaths(
        contractId: string,
        collaborative: boolean = true,
        walletPubKey?: string
    ): PathSelection[] {
        const contract = this.watcher.getContract(contractId);
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
    canSpend(
        contractId: string,
        collaborative: boolean = true,
        walletPubKey?: string
    ): boolean {
        return (
            this.getSpendablePaths(contractId, collaborative, walletPubKey)
                .length > 0
        );
    }

    /**
     * Get the spending path for a contract's VTXOs.
     *
     * @param contractId - The contract ID
     * @param collaborative - Whether collaborative spending is available
     */
    getSpendingPath(contractId: string, collaborative: boolean = true) {
        const contract = this.watcher.getContract(contractId);
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
     * Start watching for contract events.
     *
     * @deprecated Use `onContractEvent()` instead. Watching starts automatically on `initialize()`.
     * @param callback - Event callback
     * @returns Stop function (only removes callback, does not stop watching)
     */
    async startWatching(callback: ContractEventCallback): Promise<() => void> {
        this.ensureInitialized();
        return this.onContractEvent(callback);
    }

    /**
     * Check if currently watching.
     */
    isWatching(): boolean {
        return this.watcher.isCurrentlyWatching();
    }

    /**
     * Manually trigger a sweep of all eligible contracts.
     */
    async sweepAll(): Promise<SweepResult[]> {
        if (!this.sweeper) {
            throw new Error("Sweeper not configured");
        }
        return this.sweeper.sweepAll();
    }

    /**
     * Manually sweep a specific contract.
     */
    async sweepContract(contractId: string): Promise<SweepResult | null> {
        if (!this.sweeper) {
            throw new Error("Sweeper not configured");
        }
        return this.sweeper.sweepContract(contractId);
    }

    /**
     * Get pending sweepable VTXOs.
     */
    async getPendingSweeps(): Promise<Map<string, ContractVtxo[]>> {
        if (!this.sweeper) {
            return new Map();
        }
        return this.sweeper.getPendingSweeps();
    }

    /**
     * Update sweeper configuration.
     */
    updateSweeperConfig(config: Partial<SweeperConfig>): void {
        this.sweeper?.updateConfig(config);
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
    private handleContractEvent(event: ContractEvent): void {
        // Check for contract expiration
        this.watcher.checkExpiredContracts();

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
     * Stops the watcher and sweeper, clears callbacks, and marks
     * the manager as uninitialized.
     *
     * Implements the disposable pattern for cleanup.
     */
    dispose(): void {
        // Stop watching
        this.stopWatcherFn?.();
        this.stopWatcherFn = undefined;

        // Stop sweeper if configured
        this.sweeper?.stop();

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
