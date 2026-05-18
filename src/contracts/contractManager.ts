import { hex } from "@scure/base";
import { ChainTx, ChainTxType, IndexerProvider } from "../providers/indexer";
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
    ExtendedContractVtxo,
} from "./types";
import { ContractWatcher, ContractWatcherConfig } from "./contractWatcher";
import { contractHandlers } from "./handlers";
import { ExtendedVirtualCoin, Outpoint, VirtualCoin } from "../wallet";
import { extendVirtualCoinForContract } from "../wallet/utils";
import {
    ContractFilter,
    ContractRepository,
    VtxoBranch,
    VirtualTx,
    VirtualTxRepository,
    VirtualTxMode,
    ChainedTxType,
} from "../repositories";
import {
    advanceSyncCursor,
    computeSyncWindow,
    cursorCutoff,
    getSyncCursor,
} from "../utils/syncCursors";
import {
    filterVtxosForScript,
    getVtxosForContract,
    saveVtxosForContract,
    warnAndFilterVtxosForScript,
} from "./vtxoOwnership";

const DEFAULT_PAGE_SIZE = 500;

/** Map the indexer's chained-tx type onto the persisted numeric enum. */
export function chainTxTypeToChained(t: ChainTxType): ChainedTxType {
    switch (t) {
        case ChainTxType.COMMITMENT:
            return ChainedTxType.Commitment;
        case ChainTxType.ARK:
            return ChainedTxType.Ark;
        case ChainTxType.TREE:
            return ChainedTxType.Tree;
        case ChainTxType.CHECKPOINT:
            return ChainedTxType.Checkpoint;
        default:
            return ChainedTxType.Unspecified;
    }
}

/** Parse an indexer `expiresAt` (unix-seconds string or ISO) to ms epoch. */
function parseExpiry(raw: string | null | undefined): number | null {
    if (!raw) return null;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
        // Heuristic shared with the rest of the codebase: a value too small
        // to be ms-epoch is unix seconds.
        return n < 1e12 ? n * 1000 : n;
    }
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Normalise an indexer VTXO chain into the persisted branch + virtual-tx
 * shapes. `position` 0 is the commitment/root end (spec convention); the
 * indexer returns the chain leaf-first, so positions are reversed.
 * `hexByTxid` supplies raw tx bodies in Full mode; omitted ⇒ Lite (hex null).
 */
export function chainToBranchAndTxs(
    vtxo: Outpoint,
    chain: ChainTx[],
    hexByTxid?: Map<string, string>
): { branch: VtxoBranch[]; txs: VirtualTx[] } {
    const branch: VtxoBranch[] = chain.map((c, i) => ({
        vtxoTxid: vtxo.txid,
        vtxoVout: vtxo.vout,
        virtualTxid: c.txid,
        position: chain.length - 1 - i,
    }));
    const txs: VirtualTx[] = chain.map((c) => ({
        txid: c.txid,
        hex: hexByTxid?.get(c.txid) ?? null,
        expiresAt: parseExpiry(c.expiresAt),
        type: chainTxTypeToChained(c.type),
    }));
    return { branch, txs };
}

export type RefreshVtxosOptions = {
    scripts?: string[];
    after?: number;
    before?: number;
    /**
     * When true and `scripts` is not set, refresh every contract in
     * the repository — including those marked `inactive` and those
     * that have dropped out of the watcher's active set. Useful for
     * "did anyone send funds to a stale rotated display address?"
     * audits.
     *
     * Because this is a *superset* of the watcher's watched set, the
     * cursor invariant still holds and the cursor advances normally
     * (unless an explicit `after` / `before` window is also supplied).
     *
     * Ignored when `scripts` is set (the explicit list already
     * specifies what to refresh, regardless of contract state).
     *
     * @defaultValue `false`
     */
    includeInactive?: boolean;
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
     * List contracts and their current virtual outputs.
     *
     * If no filter is provided, returns all contracts with their virtual outputs.
     */
    getContractsWithVtxos(
        filter?: GetContractsFilter
    ): Promise<ContractWithVtxos[]>;

    /**
     * Stamp raw virtual outputs with the correct per-contract tapscripts
     * (forfeit, intent, tap tree).
     *
     * Resolves each vtxo's `script` to its owning contract via the contract
     * repository and attaches the matching tapscripts. Throws when any vtxo
     * references a script with no registered contract — callers are expected
     * to register the contract before asking for annotation. This is the
     * single shared path that replaces scattered `extendVirtualCoin*` calls
     * in wallet/handler code, and keeps the wallet from silently stamping the
     * default tapscript onto a non-default vtxo.
     */
    annotateVtxos(vtxos: VirtualCoin[]): Promise<ExtendedVirtualCoin[]>;

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
     * Force a virtual output refresh from the indexer.
     *
     * Without options, refreshes all contracts from scratch.
     * With options, narrows the refresh to specific scripts and/or a time window.
     */
    refreshVtxos(opts?: RefreshVtxosOptions): Promise<void>;

    /**
     * Reconcile specific outpoints with the indexer's authoritative state and
     * upsert the result into the wallet repository.
     *
     * The cursor-derived delta sync filters by `created_at`, so a VTXO that
     * was created before the cursor but spent recently won't surface in a
     * standard `refreshVtxos()` call. This method is the surgical recovery
     * path for that case: when something hands us a stale outpoint (e.g. the
     * server returns `VTXO_ALREADY_SPENT` with a `vtxo_outpoint` in its
     * error metadata), call this to pull the latest state and unblock the
     * caller — no full re-scan, no cursor change.
     *
     * Outpoints not owned by any tracked contract are silently dropped.
     */
    refreshOutpoints(outpoints: Outpoint[]): Promise<void>;

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
    /** The specific virtual output being evaluated */
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

    /** The wallet repository for virtual output storage (single source of truth) */
    walletRepository: WalletRepository;

    /** Optional virtual-tx / exit-branch repository (opt-in; no-op when absent). */
    virtualTxRepository?: VirtualTxRepository;

    /** How much virtual-tx data to persist during sync. Default: `"lite"`. */
    virtualTxMode?: VirtualTxMode;

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
 * Responsibilities:
 * - Create and persist contracts
 * - Query stored contracts (optionally with their virtual outputs)
 * - Provide spendable path selection for a contract
 * - Emit contract-related events (virtual output received/spent, connection reset)
 *
 * Notes:
 * - Implementations typically start watching automatically during initialization
 *   (so `onContractEvent()` is just for subscribing).
 *
 * @example
 * ```typescript
 * const manager = await ContractManager.create({
 *   indexerProvider: wallet.indexerProvider,
 *   contractRepository: wallet.contractRepository,
 * });
 *
 * // Create a new VHTLC contract
 * const contract = await manager.createContract({
 *   label: "Lightning Receive",
 *   type: "vhtlc",
 *   params: { sender: "ark1q...", receiver: "ark1q...", ... },
 *   script: "5120...",
 *   address: "ark1q...",
 * });
 *
 * // Start watching for events
 * const unsubscribe = manager.onContractEvent((event) => {
 *   console.log(`${event.type} on ${event.contractScript}`);
 * });
 *
 * // Query contracts together with their current virtual outputs
 * const contractsWithVtxos = await manager.getContractsWithVtxos();
 *
 * // Get balance across all contracts
 * const balances = contractsWithVtxos.flatMap(({vtxos}) => vtxos).reduce((acc, vtxo) => acc + vtxo.value, 0)
 *
 * // Later: unsubscribe from events
 * unsubscribe();
 *
 * // Clean up
 * manager.dispose();
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

        // Create watcher with wallet repository for virtual output caching
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
     * and contracts with virtual outputs. Use `onContractEvent()` to register event callbacks.
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

        // Register persisted contracts with the watcher BEFORE the first
        // sync. `addContract` seeds `lastKnownVtxos` from the repo without
        // starting to poll, so it's cheap, and it populates
        // `getWatchedContracts()` so the sync below can scope itself to the
        // real watched set instead of every contract ever persisted.
        const contracts = await this.config.contractRepository.getContracts();
        for (const contract of contracts) {
            await this.watcher.addContract(contract);
        }

        await this.reconcileWatched();

        this.initialized = true;

        // Start watching automatically
        this.stopWatcherFn = await this.watcher.startWatching((event) => {
            this.handleContractEvent(event).catch((error) => {
                console.error("Error handling contract event:", error);
            });
        });
    }

    /**
     * Delta-sync the full watched set and reconcile the pending frontier.
     *
     * Shared recovery path used on initial boot and after a subscription
     * reconnect. `syncContracts({})` scopes to the current watched set
     * (see {@link ContractWatcher.getWatchedContracts}), uses the
     * cursor-derived delta window, and advances the cursor on success.
     * `reconcilePendingFrontier` catches not-yet-finalized virtual
     * outputs that could sit outside any delta window.
     */
    private async reconcileWatched(): Promise<void> {
        await this.syncContracts({});
        const watched = this.watcher.getWatchedContracts();
        if (watched.length > 0) {
            await this.reconcilePendingFrontier(watched);
        }
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

        // fetch all virtual outputs (including spent/swept) for this contract
        await this.fetchContractVxosFromIndexer([contract]);

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
        await this.syncContracts({ contracts, pageSize });
        const vtxos = await this.getVtxosForContracts(contracts);
        return contracts.map((contract) => ({
            contract,
            vtxos: vtxos.filter(
                (vtxo) => vtxo.contractScript === contract.script
            ),
        }));
    }

    async annotateVtxos(vtxos: VirtualCoin[]): Promise<ExtendedVirtualCoin[]> {
        if (vtxos.length === 0) return [];

        const scripts = Array.from(new Set(vtxos.map((v) => v.script)));

        const byScript = new Map<string, Contract>();
        const contracts = await this.config.contractRepository.getContracts({
            script: scripts,
        });
        for (const contract of contracts) {
            byScript.set(contract.script, contract);
        }

        return vtxos.map((vtxo) =>
            extendVirtualCoinForContract(vtxo, byScript)
        );
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

    /**
     * Get every currently valid spending path for a contract.
     *
     * @param options - Options for getting spending paths
     */
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
     * Force refresh virtual outputs from the indexer.
     *
     * Without options, re-fetches every contract in the watcher's
     * watched set and advances the global cursor.
     *
     * `scripts` narrows the refresh to a specific list (subset query —
     * cursor is not advanced because contracts outside the list may
     * have data we'd skip).
     *
     * `includeInactive: true` (and no `scripts`) widens the refresh to
     * every contract in the repository, including ones marked
     * `inactive` and ones that have dropped out of the watcher's
     * active set. This is a *superset* of the watched set, so the
     * cursor invariant still holds and the cursor advances normally.
     *
     * `after` / `before` apply a caller-supplied time window. The
     * cursor never advances on a windowed query because the window
     * may skip data outside its bounds.
     */
    async refreshVtxos(opts?: RefreshVtxosOptions): Promise<void> {
        const contracts = opts?.scripts
            ? await this.getContracts({ script: opts.scripts })
            : undefined;
        // Only forward an explicit window when the caller supplied one. An
        // empty `{ after: undefined, before: undefined }` would short-circuit
        // both the cursor-derived `?after=` query in `syncContracts` (because
        // `??` doesn't fire on a non-nullish object) AND the cursor-advance
        // gate (which requires `options.window === undefined`), turning every
        // `refreshVtxos()` call into an unbounded full re-scan whose cursor
        // never moves forward.
        const hasExplicitWindow =
            opts?.after !== undefined || opts?.before !== undefined;
        await this.syncContracts({
            contracts,
            // Scope-only widener; never set together with explicit
            // `contracts` because `scripts` already names the exact set.
            includeInactive: contracts ? false : opts?.includeInactive,
            window: hasExplicitWindow
                ? { after: opts?.after, before: opts?.before }
                : undefined,
        });
    }

    async refreshOutpoints(outpoints: Outpoint[]): Promise<void> {
        if (outpoints.length === 0) return;

        const { vtxos } = await this.config.indexerProvider.getVtxos({
            outpoints,
        });
        if (vtxos.length === 0) return;

        // Filter to outputs whose script we own. Map them to their owning
        // contract so we can write through to the right per-address entry
        // in the wallet repository.
        const scripts = Array.from(new Set(vtxos.map((v) => v.script)));
        const contracts = await this.config.contractRepository.getContracts({
            script: scripts,
        });
        const scriptToContract = new Map(contracts.map((c) => [c.script, c]));
        const owned = vtxos.filter((v) => scriptToContract.has(v.script));
        if (owned.length === 0) return;

        const annotated = await this.annotateVtxos(owned);
        const byAddress = new Map<string, ExtendedVirtualCoin[]>();
        for (const vtxo of annotated) {
            const contract = scriptToContract.get(vtxo.script);
            if (!contract) continue;
            const address = contract.address;
            const arr = byAddress.get(address) ?? [];
            arr.push(vtxo);
            byAddress.set(address, arr);
        }
        for (const [address, addressVtxos] of byAddress) {
            const contract = contracts.find((c) => c.address === address);
            if (contract) {
                await saveVtxosForContract(
                    this.config.walletRepository,
                    contract,
                    addressVtxos
                );
            } else {
                await this.config.walletRepository.saveVtxos(
                    address,
                    addressVtxos
                );
            }
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
            // Delta-sync only the changed virtual outputs for this contract.
            case "vtxo_received":
            case "vtxo_spent":
                await this.syncContracts({ contracts: [event.contract] });
                break;
            case "connection_reset":
                // Same recovery path as boot: delta-sync the watched set
                // and reconcile the pending frontier. `advanceSyncCursor`
                // is monotonic so this never rewinds the cursor.
                await this.reconcileWatched();
                break;
        }

        // Forward to all callbacks
        this.emitEvent(event);
    }

    private async getVtxosForContracts(
        contracts: Contract[]
    ): Promise<ExtendedContractVtxo[]> {
        const res = await Promise.all(
            contracts.map((contract) =>
                getVtxosForContract(
                    this.config.walletRepository,
                    contract
                ).then((vtxos) =>
                    vtxos.map(
                        (vtxo): ExtendedContractVtxo => ({
                            ...vtxo,
                            contractScript: contract.script,
                        })
                    )
                )
            )
        );
        return res.flat();
    }

    /**
     * Sync virtual outputs for the given contracts against the indexer.
     *
     * When `options.contracts` is omitted the sync covers the full
     * watched set (active contracts plus any inactive contracts still
     * holding cached VTXOs) and the global cursor is advanced on
     * success. Passing an explicit subset leaves the cursor alone so a
     * narrow poll can't hide data that other contracts still need to
     * pick up.
     */
    private async syncContracts(options: {
        contracts?: Contract[];
        pageSize?: number;
        // Overrides the cursor-derived window.
        window?: { after?: number; before?: number };
        // When `contracts` is omitted: query every contract in the
        // repository (active + inactive) instead of just the watcher's
        // watched set. This is a superset of the watched set, so the
        // cursor invariant still holds and the cursor still advances.
        includeInactive?: boolean;
    }): Promise<Map<string, ExtendedContractVtxo[]>> {
        const cursor = await getSyncCursor(this.config.walletRepository);
        const window = options.window ?? computeSyncWindow(cursor);

        // Advance the global cursor only on cursor-derived delta syncs
        // whose contract scope covers at least the watcher's watched
        // set. Targeted subset queries (caller-supplied `contracts`) and
        // bounded-window queries must not move the cursor — they may
        // skip data outside their bounds. `includeInactive` (with no
        // `contracts`) widens the scope rather than narrowing it, so it
        // is cursor-safe. `<=` lets the bootstrap case (cursor=0,
        // window.after=0) write the migration marker on first boot.
        const mustUpdateCursor =
            options.contracts === undefined &&
            options.window === undefined &&
            (window.after ?? 0) <= cursor;

        const contracts =
            options.contracts ??
            (options.includeInactive
                ? await this.config.contractRepository.getContracts({})
                : this.watcher.getWatchedContracts());

        const requestStartedAt = Date.now();
        const result = await this.fetchContractVxosFromIndexer(
            contracts,
            options.pageSize,
            window
        );

        if (mustUpdateCursor) {
            const cutoff = cursorCutoff(requestStartedAt);
            await advanceSyncCursor(this.config.walletRepository, cutoff);
        }

        return result;
    }

    /**
     * Fetch all pending (unfinalized) virtual outputs and upsert them into the
     * repository. This catches virtual outputs whose state changed outside the delta
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

        // Share the annotation path with external callers so the two entry
        // points can't drift.
        const owned = vtxos.filter((v) => scriptToContract.has(v.script));
        const annotated = await this.annotateVtxos(owned);

        const byContract = new Map<string, ExtendedContractVtxo[]>();
        for (const vtxo of annotated) {
            const contract = scriptToContract.get(vtxo.script)!;
            let arr = byContract.get(contract.address);
            if (!arr) {
                arr = [];
                byContract.set(contract.address, arr);
            }
            arr.push({
                ...vtxo,
                contractScript: contract.script,
            });
        }

        for (const [addr, contractVtxos] of byContract) {
            // The bucket is keyed by contract address, so the script filter
            // here is the same as the contract's. Skip wrong-script rows
            // rather than crash the reconcile loop.
            const contract = contracts.find((c) => c.address === addr)!;
            const filtered = warnAndFilterVtxosForScript(
                contractVtxos,
                contract.script,
                "ContractManager.reconcilePendingFrontier"
            );
            if (filtered.length === 0) continue;
            await saveVtxosForContract(
                this.config.walletRepository,
                contract,
                filtered as ExtendedVirtualCoin[]
            );
        }
    }

    private async fetchContractVxosFromIndexer(
        contracts: Contract[],
        pageSize?: number,
        syncWindow?: { after?: number; before?: number }
    ): Promise<Map<string, ExtendedContractVtxo[]>> {
        const fetched = await this.fetchContractVtxosBulk(
            contracts,
            pageSize,
            syncWindow
        );
        const result = new Map<string, ExtendedContractVtxo[]>();
        for (const [contractScript, vtxos] of fetched) {
            result.set(contractScript, vtxos);
            const contract = contracts.find((c) => c.script === contractScript);
            if (contract) {
                const filtered = warnAndFilterVtxosForScript(
                    vtxos,
                    contract.script,
                    "ContractManager.fetchContractVxosFromIndexer"
                );
                if (filtered.length === 0) continue;
                await saveVtxosForContract(
                    this.config.walletRepository,
                    contract,
                    filtered as ExtendedVirtualCoin[]
                );
            }
        }
        return result;
    }

    private async fetchContractVtxosBulk(
        contracts: Contract[],
        pageSize: number = DEFAULT_PAGE_SIZE,
        syncWindow?: { after?: number; before?: number }
    ): Promise<Map<string, ExtendedContractVtxo[]>> {
        if (contracts.length === 0) {
            return new Map();
        }

        // Batch all scripts into a single indexer call per page to minimise
        // round-trips. Results are keyed by script so we can distribute them
        // back to the correct contract afterwards. Always fetches the full
        // history (spent/swept included) so the repo is the source of truth.
        const scriptToContract = new Map<string, Contract>(
            contracts.map((c) => [c.script, c])
        );
        const result = new Map<string, ExtendedContractVtxo[]>(
            contracts.map((c) => [c.script, []])
        );

        const scripts = contracts.map((c) => c.script);
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
                ...windowOpts,
                pageIndex,
                pageSize,
            });

            // Match virtual outputs back to their contract via the script field
            // populated by the indexer, then share the annotation path with
            // external callers via annotateVtxos so the two entry points can't
            // drift.
            const owned = vtxos.filter((v) => scriptToContract.has(v.script));
            const annotated = await this.annotateVtxos(owned);
            for (const vtxo of annotated) {
                result.get(vtxo.script)!.push({
                    ...vtxo,
                    contractScript: vtxo.script,
                });
            }

            hasMore = page ? vtxos.length === pageSize : false;
            pageIndex++;
            if (hasMore) await new Promise((r) => setTimeout(r, 500));
        }

        return result;
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
