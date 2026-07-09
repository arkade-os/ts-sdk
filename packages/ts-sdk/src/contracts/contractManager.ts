import { hex } from "@scure/base";
import { IndexerProvider } from "../providers/indexer";
import { isRetryableProviderError } from "../providers/availability";
import { WalletRepository } from "../repositories/walletRepository";
import {
    Contract,
    ContractEvent,
    ContractEventCallback,
    ContractState,
    ContractWithVtxos,
    DiscoveryDeps,
    GetContractsFilter,
    PathContext,
    PathSelection,
    ExtendedContractVtxo,
    isDiscoverable,
} from "./types";
import { ContractWatcher, ContractWatcherConfig } from "./contractWatcher";
import { contractHandlers } from "./handlers";
import { ExtendedVirtualCoin, Outpoint, VirtualCoin } from "../wallet";
import { extendVirtualCoinForContract, type ContractTapscriptCache } from "../wallet/utils";
import { ContractFilter, ContractRepository, IntentRepository } from "../repositories";
import { reconcileIntents } from "../wallet/intentReconciliation";
import {
    advanceSyncCursor,
    computeSyncWindow,
    cursorCutoff,
    getSyncCursor,
} from "../utils/syncCursors";
import {
    getVtxosForContract,
    saveVtxosForContract,
    warnAndFilterVtxosForScript,
} from "./vtxoOwnership";
import { DEFAULT_PAGE_SIZE } from "./constants";

/**
 * Whether two *different* contract types may legitimately share a single
 * repository row when their derived scripts collide (byte-identical pkScript).
 *
 * Contracts are keyed by their pkScript (`script` is the unique identity), so a
 * given script can own exactly one row. `default` and `boarding` are both built
 * from the same `DefaultVtxo.Script` shape and differ only by CSV-timelock
 * value; when the server's offchain unilateral-exit delay and its boarding-exit
 * delay coincide (a degenerate / misconfigured server — a sound server keeps
 * them distinct), the two derive a byte-identical script and must share a
 * single row. {@link ContractManager.upsertContract} resolves such a collision
 * first-wins (keep the existing row, don't throw). Every other distinct pairing
 * (e.g. `default` ↔ `vhtlc`, or a `delegate` script — which carries an extra
 * leaf and cannot collide under sound semantics) signals a real script/params
 * mismatch and still throws.
 *
 * This is a pure *type-pair* rule with no notion of HD index or "baseline":
 * `upsertContract` sees only the two type strings, so a `default` ↔ `boarding`
 * collision coalesces at ANY index, including rotated ones — exactly what
 * equal-delay restore needs (see
 * docs/hd-wallets_onchain_rotation_collision_fix.md §5.1).
 *
 * @internal Exported for unit tests; not part of the public API surface.
 */
export function areCoalescibleContractTypes(a: string, b: string): boolean {
    return (a === "default" && b === "boarding") || (a === "boarding" && b === "default");
}

/**
 * Hard upper bound on the HD index range probed by {@link scanContracts}.
 * Safety valve: a buggy or malicious `Discoverable` handler that returns a
 * hit at every index would otherwise keep the gap window open forever and
 * hang the wallet. 10k is far past any plausible real-world receive
 * history; reaching it without the gap closing is treated as a structural
 * failure rather than a normal scan completion.
 */
const SCAN_MAX_INDEX = 10_000;

/**
 * Default number of HD indices probed concurrently per {@link scanContracts}
 * window. The gap loop is still gap-limit bounded and its discovered set is
 * identical to a one-index-at-a-time scan (see the over-scan-discard rule in
 * `scanContracts`); the window only overlaps the per-index network round-trips
 * so an empty wallet closes its `gapLimit` window in `ceil(gapLimit / batch)`
 * rounds instead of `gapLimit` serial ones. 10 keeps the worst-case over-scan
 * (indices probed but discarded past the gap-close point) under one window.
 */
const DEFAULT_SCAN_BATCH = 10;

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

/**
 * A single `Discoverable` handler's `discoverAt` rejection, captured during
 * a {@link IContractManager.scanContracts} run instead of aborting the loop.
 */
export interface HandlerError {
    handler: string;
    index: number;
    error: unknown;
}

/**
 * Outcome of a {@link IContractManager.scanContracts} run.
 *
 * `lastIndexUsed` is the highest HD index at which any handler discovered a
 * contract (`-1` if nothing was found). `handlerErrors` collects per-handler
 * `discoverAt` failures — non-empty means the gap window may have closed
 * early and the caller should surface this (the scan itself still resolved).
 */
export interface ScanResult {
    lastIndexUsed: number;
    handlerErrors: HandlerError[];
}

/**
 * Options for {@link IContractManager.scanContracts}.
 */
export interface ScanContractsOptions {
    /** Default 20. A non-positive / non-integer value throws. */
    gapLimit?: number;
    /**
     * Number of HD indices probed concurrently per window (default
     * {@link DEFAULT_SCAN_BATCH}). Pure latency knob: the gap loop stays
     * gap-limit bounded and the discovered set is identical regardless of
     * batch size. A non-positive / non-integer value throws. Ignored when
     * `hd` is false (the static pass probes only index 0).
     */
    batchSize?: number;
    /** HD mode → unbounded gap loop guided by the gap counter; false → probe only index 0 (single static pass). */
    hd: boolean;
    /**
     * Materialize the descriptor at an HD index. Pure derivation; a throw
     * here is structural/fatal and propagates out of `scanContracts`.
     */
    materialize: (index: number) => string;
    /** Read-only context injected into every `discoverAt` call. */
    deps: DiscoveryDeps;
}

/**
 * Freshness of the ContractManager's provider-backed sync. `degraded` means the
 * most recent sync (boot, best-effort read, or contract hydration) hit a
 * retryable indexer/operator failure and the manager is serving repository
 * state; it returns to `online` on the next successful sync. This only
 * describes sync freshness — never wallet data itself.
 */
export type ContractSyncState =
    | { mode: "online"; lastSyncedAt?: number }
    | { mode: "degraded"; reason: string; lastSyncedAt?: number };

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
    getContractsWithVtxos(filter?: GetContractsFilter): Promise<ContractWithVtxos[]>;

    /**
     * Latest provider-sync health (online vs. degraded to repository data).
     * See {@link ContractSyncState}.
     */
    getSyncState(): ContractSyncState;

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
        updates: Partial<Omit<Contract, "script" | "createdAt">>,
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
    getSpendablePaths(options: GetSpendablePathsOptions): Promise<PathSelection[]>;

    /**
     * Get all possible spending paths for a contract.
     *
     * Returns an empty array if the contract or its handler cannot be found.
     */
    getAllSpendingPaths(options: GetAllSpendingPathsOptions): Promise<PathSelection[]>;

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
     * Explicit, gap-limit contract discovery used by `wallet.restore()`.
     *
     * Walks HD indices from 0, asking every registered `Discoverable`
     * handler whether it owns a contract anchored at that index, and
     * registers each find via the idempotent {@link createContract}. A hit
     * at index `i` (by any handler, including an injected swap handler)
     * resets the gap counter, so swap discovery keeps the HD window open.
     *
     * Error contract (safety-critical — see spec §4):
     * - A handler's `discoverAt` rejecting is **collected** into
     *   `handlerErrors` and the loop **continues**; it never aborts the
     *   scan or throws.
     * - A fatal operational error — `materialize()` throwing, or
     *   `createContract` rejecting — **propagates** out of `scanContracts`
     *   (it invalidates the gap-window signal, so a silent truncation
     *   would risk hiding user funds).
     *
     * @param opts See {@link ScanContractsOptions}.
     * @returns `{ lastIndexUsed, handlerErrors }` — the caller surfaces
     *   `handlerErrors` *after* the inline VTXO pull.
     */
    scanContracts(opts: ScanContractsOptions): Promise<ScanResult>;

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

    /**
     * Optional intent store. When present, the online sync path reconciles
     * persisted non-terminal settlement intents against authoritative indexer
     * state (crash recovery) on boot and reconnect — see
     * {@link reconcileIntents}. Absent ⇒ no-op.
     */
    intentRepository?: IntentRepository;

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
    /** `undefined` while online; the failure reason once a sync degrades. */
    private syncDegradedReason?: string;
    /** Epoch-ms of the last successful provider sync, if any. */
    private lastSyncedAt?: number;

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
    static async create(config: ContractManagerConfig): Promise<ContractManager> {
        const cm = new ContractManager(config);
        await cm.initialize();
        return cm;
    }

    /**
     * Latest provider-sync health. See {@link ContractSyncState}. Degradation is
     * recorded by {@link initialize}, {@link getContractsWithVtxos}, and
     * {@link createContract}; it flips back to `online` on the next successful
     * sync. Purely a freshness signal — not a source of truth for wallet data.
     */
    getSyncState(): ContractSyncState {
        return this.syncDegradedReason === undefined
            ? { mode: "online", lastSyncedAt: this.lastSyncedAt }
            : {
                  mode: "degraded",
                  reason: this.syncDegradedReason,
                  lastSyncedAt: this.lastSyncedAt,
              };
    }

    private markSyncOnline(): void {
        this.syncDegradedReason = undefined;
        this.lastSyncedAt = Date.now();
    }

    private markSyncDegraded(err: unknown): void {
        this.syncDegradedReason = err instanceof Error ? err.message : String(err);
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

        // Best-effort boot sync: a retryable indexer/operator failure must not
        // fail construction. Record degraded state and continue with repository
        // data — the watcher still starts below and reconciles when the operator
        // returns. Terminal failures still propagate.
        try {
            await this.reconcileWatched();
            this.markSyncOnline();
        } catch (err) {
            if (!isRetryableProviderError(err)) throw err;
            this.markSyncDegraded(err);
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
        await this.reconcileStaleIntents();
    }

    /**
     * Crash-recovery for persisted settlement intents: reconcile any
     * non-terminal intent left behind by a mid-settle crash against
     * authoritative indexer state (see {@link reconcileIntents}). Runs on the
     * online sync path only — boot and subscription reconnect — never from a
     * wallet read API. Best-effort: intent recovery is not a sync invariant, so
     * a failure is logged and sync continues. No-op without an intent store.
     */
    private async reconcileStaleIntents(): Promise<void> {
        if (!this.config.intentRepository) return;
        try {
            await reconcileIntents({
                intentRepository: this.config.intentRepository,
                indexerProvider: this.config.indexerProvider,
            });
        } catch (e) {
            console.error("ContractManager: intent reconciliation failed", e);
        }
    }

    /**
     * Create and register a new contract.
     *
     * @param params - Contract parameters
     * @returns The created contract
     */
    async createContract(params: CreateContractParams): Promise<Contract> {
        const { contract, persisted } = await this.upsertContract(params);
        if (persisted) {
            // Best-effort VTXO hydration (including spent/swept): on a retryable
            // indexer failure the contract stays persisted and is still watched,
            // so it hydrates on the next reconcile — wallet construction (which
            // registers baseline contracts) survives an offline operator.
            try {
                await this.fetchContractVxosFromIndexer([contract]);
                this.markSyncOnline();
            } catch (err) {
                if (!isRetryableProviderError(err)) throw err;
                this.markSyncDegraded(err);
            }
            await this.watcher.addContract(contract);
        }
        return contract;
    }

    /**
     * Lightweight variant of {@link createContract} for batch discovery
     * paths (currently: {@link scanContracts}). Validates, dedupes, persists,
     * and registers the watcher — but skips the per-contract
     * `fetchContractVxosFromIndexer` round-trip. The caller is responsible
     * for hydrating VTXOs afterwards via a bulk `refreshVtxos(...)` so a
     * scan that finds N contracts costs one batched indexer call instead
     * of N + 1. Error semantics are identical to `createContract`:
     * validation / type-mismatch / persistence failures propagate.
     */
    private async persistAndWatchContract(params: CreateContractParams): Promise<Contract> {
        const { contract, persisted } = await this.upsertContract(params);
        if (persisted) {
            await this.watcher.addContract(contract);
        }
        return contract;
    }

    /**
     * Shared validate + check-existing + persist core for
     * {@link createContract} and {@link persistAndWatchContract}. Returns
     * the resolved contract and whether *this* call wrote it — callers
     * that need to attach hydration / watcher work do so only when
     * `persisted` is `true`.
     */
    private async upsertContract(
        params: CreateContractParams,
    ): Promise<{ contract: Contract; persisted: boolean }> {
        // Validate that a handler exists for this contract type
        const handler = contractHandlers.get(params.type);
        if (!handler) {
            throw new Error(`No handler registered for contract type '${params.type}'`);
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
                        `Expected ${derivedScript}, got ${params.script}`,
                );
            }
        } catch (error) {
            if (error instanceof Error && error.message.includes("mismatch")) {
                throw error;
            }
            throw new Error(
                `Invalid params for contract type '${params.type}': ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        // A script is its own unique identity, so at most one row per script.
        const [existing] = await this.getContracts({ script: params.script });
        if (existing) {
            // Same type → idempotent no-op (re-registering is a no-op).
            if (existing.type === params.type) return { contract: existing, persisted: false };
            // Degenerate equal-delay collision: a `default` and a `boarding`
            // script are byte-identical when the server's unilateral-exit and
            // boarding-exit delays coincide. Tolerate it FIRST-WINS — keep the
            // existing row exactly as-is (no overwrite, no type promotion, no
            // throw) and report it was not (re)persisted. This mirrors NArk's
            // script-keyed dedup (one row per script) and is the single source
            // of truth for the collision, covering both `createContract` (init)
            // and `persistAndWatchContract` (the restore scan). Because it never
            // mutates the row it also preserves the watcher invariant: the
            // winning row was registered with the watcher when first persisted,
            // so event callbacks always see the authoritative type — there is no
            // promote-then-forget-the-watcher gap. See
            // docs/hd-wallets_onchain_rotation_collision_fix.md §5.1.
            if (areCoalescibleContractTypes(existing.type, params.type)) {
                return { contract: existing, persisted: false };
            }
            // Any other same-script/different-type collision is a real bug or
            // hash anomaly — surface it loudly.
            throw new Error(
                `Contract with script ${params.script} already exists with type ${existing.type}.`,
            );
        }

        const contract: Contract = {
            ...params,
            createdAt: Date.now(),
            state: params.state || "active",
        };

        await this.config.contractRepository.saveContract(contract);
        return { contract, persisted: true };
    }

    /**
     * Explicit, gap-limit contract discovery (see {@link IContractManager.scanContracts}).
     *
     * Each hit is routed through {@link persistAndWatchContract} — the same
     * dedupe + watcher-register path as {@link createContract} minus the
     * per-contract indexer round-trip. The caller (`Wallet.restore`) follows
     * up with a single bulk `refreshVtxos({ includeInactive: true })`, so a
     * scan that finds N contracts costs one batched indexer call instead of
     * N + 1.
     *
     * Safety-critical invariants (spec §2.C / §4):
     * - `opts.materialize(i)` throwing is structural/fatal: it is NOT
     *   wrapped — it propagates and aborts the scan.
     * - A `discoverAt` rejection is collected into `handlerErrors` and the
     *   loop continues (the gap counter still advances for that index if no
     *   other handler hit it).
     * - `persistAndWatchContract` rejecting is operational/fatal and
     *   propagates (only `discoverAt` is guarded).
     * - Within an index the handler probes run concurrently (independent
     *   network reads); their hits are persisted sequentially in
     *   `discoverables` order to preserve the first-wins collision tie-break.
     * - Indices are probed `batchSize` at a time (a second concurrency layer
     *   over the per-index probes), but each window is CAPPED to
     *   `gapLimit - unused` indices — the most a serial scan could still reach
     *   before the gap window is guaranteed to close. So every index probed in
     *   a window is one a one-index-at-a-time scan would also reach: nothing is
     *   over-scanned, nothing is discarded, and `materialize`/`discoverAt` are
     *   invoked on exactly the same index set. The window's hits are still
     *   processed strictly in ascending index order, so the discovered set,
     *   persisted rows, `lastIndexUsed`, and `handlerErrors` are byte-for-byte
     *   identical to the serial path — only the wall-clock differs.
     */
    async scanContracts(opts: ScanContractsOptions): Promise<ScanResult> {
        const gapLimit = opts.gapLimit ?? 20;
        if (!Number.isInteger(gapLimit) || gapLimit <= 0) {
            throw new Error(
                `scanContracts: gapLimit must be a positive integer (got ${String(opts.gapLimit)})`,
            );
        }
        const batchSize = opts.batchSize ?? DEFAULT_SCAN_BATCH;
        if (!Number.isInteger(batchSize) || batchSize <= 0) {
            throw new Error(
                `scanContracts: batchSize must be a positive integer (got ${String(opts.batchSize)})`,
            );
        }
        const registered = contractHandlers
            .getRegisteredTypes()
            .map((t) => contractHandlers.get(t))
            .filter(isDiscoverable);

        // Probe `boarding` before `default`/`delegate`. This ordering is
        // LOAD-BEARING, not cosmetic: within each index the probes run
        // concurrently, but their hits are persisted in THIS order and
        // `upsertContract` resolves a same-script collision FIRST-WINS, so this
        // order IS the persistence tie-break. In the degenerate equal-delay case
        // a rotated index can carry BOTH an on-chain boarding UTXO and an L2
        // VTXO at the same (byte-identical) script; probing boarding first
        // resolves that collision to a `boarding` row, which keeps the on-chain
        // UTXO visible to the type-gated `getBoardingUtxos` while the VTXO stays
        // visible via the type-agnostic `getVtxos`. Resolving to `default` would
        // hide the on-chain boarding UTXO (the original Finding #1 bug). The
        // stable partition preserves the relative order of all non-boarding
        // handlers. A future reorder must not regress this; a unit test pins it.
        // See docs/hd-wallets_onchain_rotation_collision_fix.md §5.2.
        const discoverables = [
            ...registered.filter((h) => h.type === "boarding"),
            ...registered.filter((h) => h.type !== "boarding"),
        ];

        const maxIdx = opts.hd ? SCAN_MAX_INDEX : 0;
        const handlerErrors: HandlerError[] = [];
        let lastIndexUsed = -1;
        let unused = 0;
        let i = 0;

        // Probe one index's discoverable handlers CONCURRENTLY: they are
        // independent network reads (indexer / on-chain explorer), so
        // overlapping them cuts per-index latency. Each probe's try/catch
        // mirrors the former serial guard, capturing a discoverAt rejection
        // (or synchronous throw) instead of propagating it, so one failing
        // handler never aborts the others. Materialization failure is
        // fatal/structural — it is NOT guarded and propagates.
        const probeIndex = async (index: number) => {
            const descriptor = opts.materialize(index);
            return Promise.all(
                discoverables.map(async (h) => {
                    try {
                        return {
                            ok: true as const,
                            found: await h.discoverAt(index, descriptor, opts.deps),
                        };
                    } catch (error) {
                        return { ok: false as const, error };
                    }
                }),
            );
        };

        while (i <= maxIdx && unused < gapLimit) {
            // Probe a WINDOW of indices concurrently (a second concurrency
            // layer over the per-index probes). The window is capped to
            // `gapLimit - unused` indices: the most a serial scan could still
            // reach before the gap window is guaranteed to close. So every
            // index probed here is one a one-index-at-a-time scan would also
            // reach — nothing is over-scanned or discarded, and the discovered
            // set stays byte-for-byte identical to the serial path.
            const windowEnd = Math.min(maxIdx, i + Math.min(batchSize, gapLimit - unused) - 1);
            const windowIndices: number[] = [];
            for (let idx = i; idx <= windowEnd; idx++) windowIndices.push(idx);
            const windowProbes = await Promise.all(windowIndices.map(probeIndex));

            // Process the window strictly in ASCENDING index order, and within
            // each index persist in the original `discoverables` order — that
            // order is the FIRST-WINS collision tie-break (boarding before
            // default/delegate), so it must not be reordered. Only the I/O
            // above overlapped. A persistAndWatchContract rejection stays
            // operational/fatal (unguarded), matching the materialize contract.
            for (let w = 0; w < windowIndices.length; w++) {
                const index = windowIndices[w];
                const probes = windowProbes[w];
                let hitAtThisIndex = false;
                for (let h = 0; h < discoverables.length; h++) {
                    const probe = probes[h];
                    if (!probe.ok) {
                        handlerErrors.push({
                            handler: discoverables[h].type,
                            index,
                            error: probe.error,
                        });
                        continue;
                    }
                    for (const c of probe.found) {
                        await this.persistAndWatchContract(c); // idempotent (script-keyed)
                        hitAtThisIndex = true;
                    }
                }

                if (hitAtThisIndex) {
                    lastIndexUsed = index;
                    unused = 0;
                } else {
                    unused += 1;
                }
            }
            i = windowEnd + 1;
        }

        // Hit the safety ceiling without the gap window closing — the
        // scan was truncated. Surface loudly (matching the materialize-
        // fatal contract) rather than silently returning a partial
        // result, since the caller cannot otherwise distinguish "no
        // more funds past lastIndexUsed" from "we stopped scanning".
        if (opts.hd && i > maxIdx && unused < gapLimit) {
            throw new Error(
                `scanContracts: reached SCAN_MAX_INDEX (${SCAN_MAX_INDEX}) without closing the ` +
                    `${gapLimit}-index gap window; a Discoverable handler may be returning ` +
                    `unconditional hits`,
            );
        }

        return { lastIndexUsed, handlerErrors };
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
        pageSize?: number,
    ): Promise<ContractWithVtxos[]> {
        const contracts = await this.getContracts(filter);
        // Best-effort opportunistic sync: on a retryable indexer/operator
        // failure, serve repository state rather than failing the read. The
        // failed sync writes no partial state and does not advance the cursor
        // (targeted subset queries never do). Terminal failures still propagate.
        try {
            await this.syncContracts({ contracts, pageSize });
            this.markSyncOnline();
        } catch (err) {
            if (!isRetryableProviderError(err)) throw err;
            this.markSyncDegraded(err);
        }
        const vtxos = await this.getVtxosForContracts(contracts);
        return contracts.map((contract) => ({
            contract,
            vtxos: vtxos.filter((vtxo) => vtxo.contractScript === contract.script),
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

        // Tapscript data is derived solely from a contract's params, so it is
        // identical for every VTXO locked to the same contract. Memoize it per
        // contract to avoid rebuilding the taproot tree once per VTXO — the
        // dominant cost when annotating long spent/swept histories (see #521).
        const tapscriptCache: ContractTapscriptCache = new Map();
        return vtxos.map((vtxo) => extendVirtualCoinForContract(vtxo, byScript, tapscriptCache));
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
        updates: Partial<Omit<Contract, "script" | "createdAt">>,
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
    async updateContractParams(script: string, updates: Contract["params"]): Promise<Contract> {
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
    async setContractState(script: string, state: ContractState): Promise<void> {
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
    async getSpendablePaths(options: GetSpendablePathsOptions): Promise<PathSelection[]> {
        const { contractScript, collaborative = true, walletPubKey, vtxo } = options;

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
    async getAllSpendingPaths(options: GetAllSpendingPathsOptions): Promise<PathSelection[]> {
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
        const hasExplicitWindow = opts?.after !== undefined || opts?.before !== undefined;
        await this.syncContracts({
            contracts,
            // Scope-only widener; never set together with explicit
            // `contracts` because `scripts` already names the exact set.
            includeInactive: contracts ? false : opts?.includeInactive,
            window: hasExplicitWindow ? { after: opts?.after, before: opts?.before } : undefined,
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
                await saveVtxosForContract(this.config.walletRepository, contract, addressVtxos);
            } else {
                await this.config.walletRepository.saveVtxos(address, addressVtxos);
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

    private async getVtxosForContracts(contracts: Contract[]): Promise<ExtendedContractVtxo[]> {
        const res = await Promise.all(
            contracts.map((contract) =>
                getVtxosForContract(this.config.walletRepository, contract).then((vtxos) =>
                    vtxos.map(
                        (vtxo): ExtendedContractVtxo => ({
                            ...vtxo,
                            contractScript: contract.script,
                        }),
                    ),
                ),
            ),
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
        const result = await this.fetchContractVxosFromIndexer(contracts, options.pageSize, window);

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
    private async reconcilePendingFrontier(contracts: Contract[]): Promise<void> {
        const scripts = contracts.map((c) => c.script);
        const scriptToContract = new Map<string, Contract>(contracts.map((c) => [c.script, c]));

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
                "ContractManager.reconcilePendingFrontier",
            );
            if (filtered.length === 0) continue;
            await saveVtxosForContract(
                this.config.walletRepository,
                contract,
                filtered as ExtendedVirtualCoin[],
            );
        }
    }

    private async fetchContractVxosFromIndexer(
        contracts: Contract[],
        pageSize?: number,
        syncWindow?: { after?: number; before?: number },
    ): Promise<Map<string, ExtendedContractVtxo[]>> {
        const fetched = await this.fetchContractVtxosBulk(contracts, pageSize, syncWindow);
        const result = new Map<string, ExtendedContractVtxo[]>();
        for (const [contractScript, vtxos] of fetched) {
            result.set(contractScript, vtxos);
            const contract = contracts.find((c) => c.script === contractScript);
            if (contract) {
                const filtered = warnAndFilterVtxosForScript(
                    vtxos,
                    contract.script,
                    "ContractManager.fetchContractVxosFromIndexer",
                );
                if (filtered.length === 0) continue;
                await saveVtxosForContract(
                    this.config.walletRepository,
                    contract,
                    filtered as ExtendedVirtualCoin[],
                );
            }
        }
        return result;
    }

    private async fetchContractVtxosBulk(
        contracts: Contract[],
        pageSize: number = DEFAULT_PAGE_SIZE,
        syncWindow?: { after?: number; before?: number },
    ): Promise<Map<string, ExtendedContractVtxo[]>> {
        if (contracts.length === 0) {
            return new Map();
        }

        // Batch all scripts into a single indexer call per page to minimise
        // round-trips. Results are keyed by script so we can distribute them
        // back to the correct contract afterwards. Always fetches the full
        // history (spent/swept included) so the repo is the source of truth.
        const scriptToContract = new Map<string, Contract>(contracts.map((c) => [c.script, c]));
        const result = new Map<string, ExtendedContractVtxo[]>(
            contracts.map((c) => [c.script, []]),
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
