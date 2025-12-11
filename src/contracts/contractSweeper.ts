import {
    Contract,
    ContractVtxo,
    SweeperConfig,
    SweepResult,
    PathContext,
} from "./types";
import { ContractWatcher } from "./contractWatcher";
import { contractHandlers } from "./handlers";
import { VirtualCoin, ExtendedVirtualCoin, isSpendable } from "../wallet";

/**
 * Callback for sweep events.
 */
export type SweepEventCallback = (
    event:
        | { type: "sweep_started"; contractIds: string[] }
        | { type: "sweep_completed"; result: SweepResult }
        | { type: "sweep_failed"; contractIds: string[]; error: Error }
        | { type: "vtxo_spendable"; contractId: string; vtxos: ContractVtxo[] }
) => void;

/**
 * Dependencies required by the ContractSweeper.
 */
export interface ContractSweeperDeps {
    /** The contract watcher instance */
    contractWatcher: ContractWatcher;

    /** Function to get the wallet's default address */
    getDefaultAddress: () => Promise<string>;

    /** Function to execute a sweep transaction */
    executeSweep: (
        vtxos: ContractVtxo[],
        destination: string
    ) => Promise<string>;

    /** Function to extend VirtualCoin to ExtendedVirtualCoin */
    extendVtxo: (vtxo: VirtualCoin) => ExtendedVirtualCoin;

    /** Optional: function to get current block height */
    getCurrentBlockHeight?: () => Promise<number>;
}

/**
 * Default sweeper configuration.
 */
const DEFAULT_CONFIG: SweeperConfig = {
    pollIntervalMs: 60000, // 1 minute
    minSweepValue: 1000, // 1000 sats minimum
    maxVtxosPerSweep: 50,
    batchSweeps: true,
    enabled: false,
};

/**
 * Service that automatically sweeps spendable VTXOs from contracts
 * back to the wallet's default address.
 *
 * The sweeper periodically checks all active contracts with autoSweep
 * enabled, determines which VTXOs are spendable according to their
 * contract handler, and creates sweep transactions.
 *
 * @example
 * ```typescript
 * const sweeper = new ContractSweeper(
 *   {
 *     contractWatcher,
 *     getDefaultAddress: () => wallet.getAddress(),
 *     executeSweep: async (vtxos, dest) => {
 *       // Build and submit sweep transaction
 *       return txid;
 *     },
 *     extendVtxo: (vtxo) => extendVirtualCoin(wallet, vtxo),
 *   },
 *   { enabled: true, pollIntervalMs: 30000 }
 * );
 *
 * // Start the sweeper
 * sweeper.start((event) => {
 *   if (event.type === "sweep_completed") {
 *     console.log("Swept", event.result.totalValue, "sats");
 *   }
 * });
 *
 * // Later: stop the sweeper
 * sweeper.stop();
 * ```
 */
export class ContractSweeper {
    private config: SweeperConfig;
    private deps: ContractSweeperDeps;
    private intervalId?: ReturnType<typeof setInterval>;
    private isRunning = false;
    private eventCallback?: SweepEventCallback;

    constructor(
        deps: ContractSweeperDeps,
        config: Partial<SweeperConfig> = {}
    ) {
        this.deps = deps;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Start the sweeper service.
     *
     * @param callback - Optional callback for sweep events
     */
    start(callback?: SweepEventCallback): void {
        if (this.isRunning) {
            return;
        }

        this.eventCallback = callback;
        this.isRunning = true;

        if (this.config.enabled) {
            // Run immediately, then on interval
            this.checkAndSweep();
            this.intervalId = setInterval(
                () => this.checkAndSweep(),
                this.config.pollIntervalMs
            );
        }
    }

    /**
     * Stop the sweeper service.
     */
    stop(): void {
        this.isRunning = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
        this.eventCallback = undefined;
    }

    /**
     * Update sweeper configuration.
     *
     * @param config - Partial configuration to update
     */
    updateConfig(config: Partial<SweeperConfig>): void {
        const wasEnabled = this.config.enabled;
        this.config = { ...this.config, ...config };

        // Handle enable/disable changes
        if (this.isRunning) {
            if (!wasEnabled && this.config.enabled) {
                // Was disabled, now enabled - start polling
                this.checkAndSweep();
                this.intervalId = setInterval(
                    () => this.checkAndSweep(),
                    this.config.pollIntervalMs
                );
            } else if (wasEnabled && !this.config.enabled) {
                // Was enabled, now disabled - stop polling
                if (this.intervalId) {
                    clearInterval(this.intervalId);
                    this.intervalId = undefined;
                }
            } else if (this.config.enabled && this.intervalId) {
                // Still enabled but interval may have changed - restart
                clearInterval(this.intervalId);
                this.intervalId = setInterval(
                    () => this.checkAndSweep(),
                    this.config.pollIntervalMs
                );
            }
        }
    }

    /**
     * Check if the sweeper is running.
     */
    isActive(): boolean {
        return this.isRunning && this.config.enabled;
    }

    /**
     * Get the current configuration.
     */
    getConfig(): SweeperConfig {
        return { ...this.config };
    }

    /**
     * Manually trigger a sweep check.
     * Can be called even if automatic sweeping is disabled.
     */
    async checkAndSweep(): Promise<SweepResult[]> {
        const results: SweepResult[] = [];

        try {
            const spendableByContract = await this.findSpendableVtxos();

            if (spendableByContract.size === 0) {
                return results;
            }

            // Notify about spendable VTXOs
            for (const [contractId, vtxos] of spendableByContract) {
                this.eventCallback?.({
                    type: "vtxo_spendable",
                    contractId,
                    vtxos,
                });
            }

            // Group for batching or process individually
            if (this.config.batchSweeps) {
                const result =
                    await this.executeBatchedSweep(spendableByContract);
                if (result) {
                    results.push(result);
                }
            } else {
                for (const [contractId, vtxos] of spendableByContract) {
                    const result = await this.executeSingleContractSweep(
                        contractId,
                        vtxos
                    );
                    if (result) {
                        results.push(result);
                    }
                }
            }
        } catch (error) {
            console.error("Sweep check failed:", error);
        }

        return results;
    }

    /**
     * Manually sweep a specific contract.
     *
     * @param contractId - The contract to sweep
     * @returns Sweep result, or null if nothing to sweep
     */
    async sweepContract(contractId: string): Promise<SweepResult | null> {
        const contract = this.deps.contractWatcher.getContract(contractId);
        if (!contract) {
            throw new Error(`Contract ${contractId} not found`);
        }

        const spendableByContract = await this.findSpendableVtxos([contractId]);
        const vtxos = spendableByContract.get(contractId);

        if (!vtxos || vtxos.length === 0) {
            return null;
        }

        return this.executeSingleContractSweep(contractId, vtxos);
    }

    /**
     * Sweep all contracts that have spendable VTXOs.
     *
     * @returns Array of sweep results
     */
    async sweepAll(): Promise<SweepResult[]> {
        const spendableByContract = await this.findSpendableVtxos();

        if (spendableByContract.size === 0) {
            return [];
        }

        if (this.config.batchSweeps) {
            const result = await this.executeBatchedSweep(spendableByContract);
            return result ? [result] : [];
        }

        const results: SweepResult[] = [];
        for (const [contractId, vtxos] of spendableByContract) {
            const result = await this.executeSingleContractSweep(
                contractId,
                vtxos
            );
            if (result) {
                results.push(result);
            }
        }
        return results;
    }

    /**
     * Get pending sweepable VTXOs without executing sweeps.
     */
    async getPendingSweeps(): Promise<Map<string, ContractVtxo[]>> {
        return this.findSpendableVtxos();
    }

    /**
     * Find all spendable VTXOs across contracts.
     */
    private async findSpendableVtxos(
        contractIds?: string[]
    ): Promise<Map<string, ContractVtxo[]>> {
        const result = new Map<string, ContractVtxo[]>();

        // Get contracts to check
        let contracts = this.deps.contractWatcher.getActiveContracts();

        if (contractIds?.length) {
            const idSet = new Set(contractIds);
            contracts = contracts.filter((c) => idSet.has(c.id));
        }

        // Filter to only contracts with autoSweep enabled
        contracts = contracts.filter((c) => c.autoSweep);

        if (contracts.length === 0) {
            return result;
        }

        // Build spend context
        const context = await this.buildPathContext();

        // Get VTXOs for these contracts
        const vtxosMap = await this.deps.contractWatcher.getContractVtxos(
            {
                activeOnly: true,
                contractIds: contracts.map((c) => c.id),
            },
            this.deps.extendVtxo
        );

        // Check each contract's VTXOs for spendability
        for (const contract of contracts) {
            const vtxos = vtxosMap.get(contract.id) || [];
            const handler = contractHandlers.get(contract.type);

            if (!handler) {
                console.warn(
                    `No handler found for contract type '${contract.type}', skipping contract ${contract.id}`
                );
                continue;
            }

            const script = handler.createScript(contract.params);
            const paths = handler.getSpendablePaths(script, contract, context);

            // Only include VTXOs if there are spendable paths
            const spendable =
                paths.length > 0
                    ? vtxos.filter((vtxo) => {
                          try {
                              return isSpendable(vtxo);
                          } catch {
                              return false;
                          }
                      })
                    : [];

            if (spendable.length > 0) {
                result.set(contract.id, spendable);
            }
        }

        return result;
    }

    /**
     * Execute a sweep for a single contract.
     */
    private async executeSingleContractSweep(
        contractId: string,
        vtxos: ContractVtxo[]
    ): Promise<SweepResult | null> {
        const contract = this.deps.contractWatcher.getContract(contractId);
        if (!contract) {
            return null;
        }

        // Check minimum value
        const totalValue = vtxos.reduce((sum, v) => sum + v.value, 0);
        if (totalValue < this.config.minSweepValue) {
            return null;
        }

        // Limit VTXOs per sweep
        const toSweep = vtxos.slice(0, this.config.maxVtxosPerSweep);

        // Determine destination
        const destination =
            contract.sweepDestination || (await this.deps.getDefaultAddress());

        this.eventCallback?.({
            type: "sweep_started",
            contractIds: [contractId],
        });

        try {
            const txid = await this.deps.executeSweep(toSweep, destination);

            const result: SweepResult = {
                txid,
                contractIds: [contractId],
                totalValue: toSweep.reduce((sum, v) => sum + v.value, 0),
                vtxoCount: toSweep.length,
                destination,
            };

            this.eventCallback?.({
                type: "sweep_completed",
                result,
            });

            return result;
        } catch (error) {
            this.eventCallback?.({
                type: "sweep_failed",
                contractIds: [contractId],
                error:
                    error instanceof Error ? error : new Error(String(error)),
            });
            return null;
        }
    }

    /**
     * Execute a batched sweep across multiple contracts.
     */
    private async executeBatchedSweep(
        vtxosByContract: Map<string, ContractVtxo[]>
    ): Promise<SweepResult | null> {
        // Collect all VTXOs
        const allVtxos: ContractVtxo[] = [];
        const contractIds: string[] = [];

        for (const [contractId, vtxos] of vtxosByContract) {
            contractIds.push(contractId);
            allVtxos.push(...vtxos);
        }

        if (allVtxos.length === 0) {
            return null;
        }

        // Check minimum value
        const totalValue = allVtxos.reduce((sum, v) => sum + v.value, 0);
        if (totalValue < this.config.minSweepValue) {
            return null;
        }

        // Limit total VTXOs
        const toSweep = allVtxos.slice(0, this.config.maxVtxosPerSweep);

        // Use wallet's default address for batched sweeps
        const destination = await this.deps.getDefaultAddress();

        this.eventCallback?.({
            type: "sweep_started",
            contractIds,
        });

        try {
            const txid = await this.deps.executeSweep(toSweep, destination);

            const result: SweepResult = {
                txid,
                contractIds,
                totalValue: toSweep.reduce((sum, v) => sum + v.value, 0),
                vtxoCount: toSweep.length,
                destination,
            };

            this.eventCallback?.({
                type: "sweep_completed",
                result,
            });

            return result;
        } catch (error) {
            this.eventCallback?.({
                type: "sweep_failed",
                contractIds,
                error:
                    error instanceof Error ? error : new Error(String(error)),
            });
            return null;
        }
    }

    /**
     * Build the path context for handler evaluation.
     */
    private async buildPathContext(): Promise<PathContext> {
        const context: PathContext = {
            collaborative: true, // Default to collaborative for sweeps
            currentTime: Date.now(),
        };

        if (this.deps.getCurrentBlockHeight) {
            try {
                context.blockHeight = await this.deps.getCurrentBlockHeight();
            } catch {
                // Ignore - block height is optional
            }
        }

        return context;
    }
}
