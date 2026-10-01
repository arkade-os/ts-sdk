import { collectContracts } from "../repositories/contractRepository";
import { hex } from "@scure/base";
import { IndexerProvider } from "../providers/indexer";
import { isRetryableProviderError } from "../providers/availability";
import { WalletRepository } from "../repositories/walletRepository";
import {
    CandidateDeps,
    Contract,
    ContractEvent,
    ContractEventCallback,
    ContractState,
    ContractWatchState,
    ContractHandler,
    ContractWithVtxos,
    Discoverable,
    DiscoveredContract,
    DiscoveryDeps,
    GetContractsFilter,
    PathContext,
    PathSelection,
    ExtendedContractVtxo,
    WatchedScript,
    hasCandidates,
    isContractVtxoEvent,
    isDiscoverable,
    watchStateOf,
} from "./types";
import { ContractWatcher, ContractWatcherConfig } from "./contractWatcher";
import { contractHandlers } from "./handlers";
import { speculativeReceiveMetadata } from "./handlers/helpers";
import { ExtendedVirtualCoin, Outpoint, VirtualCoin } from "../wallet";
import {
    getAllNormalizedVtxos,
    getNormalizedVtxos,
    isVirtualCoin,
    normalizeVtxo,
    type NormalizedExtendedVirtualCoin,
} from "../wallet/vtxo";
import {
    deriveContractTapscripts,
    extendVirtualCoinForContract,
    type ContractTapscriptCache,
    type ContractTapscripts,
} from "../wallet/utils";
import { UnannotatableInputError } from "./spendability";
import { ContractFilter, ContractRepository, IntentRepository } from "../repositories";
import { reconcileIntents } from "../wallet/intentReconciliation";
import {
    advanceSyncCursor,
    computeSyncWindow,
    cursorCutoff,
    getSyncCursor,
} from "../utils/syncCursors";
import {
    applyRecordedSpends,
    getVtxosForContract,
    hasVtxosForContract,
    inVtxoWriteOrder,
    saveVtxosForContract,
    warnAndFilterVtxosForScript,
} from "./vtxoOwnership";
import { DEFAULT_PAGE_SIZE } from "./constants";

/**
 * Whether two *different* contract types may share one repository row when their derived
 * pkScripts collide (`script` is the row identity).
 *
 * `default` and `boarding` share the `DefaultVtxo.Script` shape and differ only by CSV value, so
 * a server whose unilateral-exit and boarding-exit delays coincide makes them byte-identical;
 * {@link ContractManager.upsertContract} keeps the first row. Any other pairing is a real
 * script/params mismatch and throws. The rule is type-only, so it applies at every HD index,
 * which equal-delay restore needs.
 *
 * @internal Exported for unit tests; not part of the public API surface.
 */
export function areCoalescibleContractTypes(a: string, b: string): boolean {
    return (a === "default" && b === "boarding") || (a === "boarding" && b === "default");
}

/** A {@link Contract} for {@link ContractWatcher.addContract} only; never persisted. */
function toWatchOnlyContract(params: CreateContractParams): Contract {
    return { ...params, state: params.state ?? "active", createdAt: Date.now() };
}

type TapscriptMemo = Map<
    string,
    { key: string; handler: ContractHandler<unknown>; tapscripts: ContractTapscripts }
>;
const TAPSCRIPT_MEMO_MAX_ENTRIES = 1024;

/**
 * Which of `vtxos`' contracts this runtime can annotate, with the tapscripts built along the way
 * and a reason for each that it cannot.
 *
 * A persisted row stops being annotatable when its handler is not registered in this build or
 * rejects the stored params. A bulk sync must drop just that contract's VTXOs rather than let
 * one row fail balance, history, coin selection and `initialize`.
 */
function annotatableIn(
    scriptToContract: ReadonlyMap<string, Contract>,
    vtxos: readonly { script: string }[],
    memo?: TapscriptMemo,
): { scripts: Set<string>; cache: ContractTapscriptCache; failures: Map<string, string> } {
    const scripts = new Set<string>();
    const cache: ContractTapscriptCache = new Map();
    const failures = new Map<string, string>();
    for (const script of new Set(vtxos.map((vtxo) => vtxo.script))) {
        const contract = scriptToContract.get(script);
        if (!contract) continue; // not ours; dropped by the caller's filter
        try {
            // Pure in (type, params) under one handler; a swapped or removed handler must re-derive.
            const key = `${contract.type}\u0000${script}\u0000${JSON.stringify(contract.params)}`;
            const handler = contractHandlers.get(contract.type);
            const hit = memo?.get(script);
            let tapscripts: ContractTapscripts;
            if (hit && hit.key === key && hit.handler === handler) {
                tapscripts = hit.tapscripts;
                memo!.delete(script);
                memo!.set(script, hit);
            } else {
                memo?.delete(script);
                tapscripts = deriveContractTapscripts(contract);
                if (handler && memo) {
                    memo.set(script, { key, handler, tapscripts });
                    if (memo.size > TAPSCRIPT_MEMO_MAX_ENTRIES) {
                        memo.delete(memo.keys().next().value!);
                    }
                }
            }
            cache.set(script, tapscripts); // aliases the memo; extendVtxoFromContract clones before use
            scripts.add(script);
        } catch (err) {
            failures.set(
                script,
                `'${contract.type}' at ${script}: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }
    return { scripts, cache, failures };
}

/**
 * Hard cap on the HD index range {@link scanContracts} probes, so a handler that reports a hit
 * at every index cannot hang the wallet. Reaching it is a structural failure, not completion.
 */
const SCAN_MAX_INDEX = 10_000;

/**
 * HD indices probed concurrently per {@link scanContracts} window. Only overlaps round trips;
 * the discovered set equals a serial scan. 10 keeps worst-case over-scan under one window.
 */
const DEFAULT_SCAN_BATCH = 10;

/**
 * How long a chain tip read stays usable for {@link PathContext.blockHeight}. A stale (lower)
 * height can only withhold a just-matured height-gated path, never offer an immature one.
 */
const CHAIN_TIP_TTL_MS = 30_000;

/**
 * Upper bound on a chain tip read. `fetch` has no timeout and a quiet socket never settles, so
 * without this one stalled read hangs every path query joined to it. Expiry = tip unknown.
 */
const CHAIN_TIP_TIMEOUT_MS = 5_000;

/**
 * An input for {@link IContractManager.assertSpendableNow}.
 *
 * Prefer passing a full {@link VirtualCoin}: a relative (CSV) timelock is measured from the
 * coin's own confirmation (`status.block_height` / `status.block_time`). The bare shape still
 * answers every absolute (CLTV) question.
 */
export type AssertSpendableInput = { txid: string; vout: number; script: string };

export type RefreshVtxosOptions = {
    /** Narrow the refresh to these scripts. A subset query, so the sync cursor does not advance. */
    scripts?: string[];
    /** Time window overriding the cursor-derived one. The cursor never advances on a window. */
    after?: number;
    /** @see after */
    before?: number;
    /**
     * When true and `scripts` is not set, refresh every repository contract rather than the
     * watcher's watched set. A superset, so the cursor still advances (absent `after`/`before`).
     *
     * @defaultValue `false`
     */
    includeInactive?: boolean;
};

/**
 * A single `Discoverable` handler's discovery failure, captured during a
 * {@link IContractManager.scanContracts} run instead of aborting the loop.
 */
export interface HandlerError {
    handler: string;
    /** The failed index, or the first index of a failed `discoverRange` window. */
    fromIndex: number;
    /** Inclusive end of a failed `discoverRange` window; absent for a single index. */
    toIndex?: number;
    error: unknown;
}

/**
 * One handler's answer for a whole scan window. Failures are keyed by anchor index (a batched
 * failure anchors at the range's first index).
 */
interface HandlerWindowProbe {
    found: Map<number, DiscoveredContract[]>;
    indeterminate: Set<number>;
    errors: Map<number, HandlerError>;
}

/** Outcome of a {@link IContractManager.scanContracts} run. */
export interface ScanResult {
    /**
     * Highest HD index at which any handler confirmed a contract (`-1` if none), including hits
     * past {@link ScanResult.truncatedAt}. Safe to record unconditionally (the watermark is a
     * monotonic max); withholding it risks re-issuing a funded index as a fresh address.
     */
    highestConfirmedUsedIndex: number;
    /**
     * First index a handler failed at (neither hit nor confirmed miss). Indices `>= truncatedAt`
     * are unverified and the caller must retry; scanning is idempotent. `undefined` when the
     * scan closed a genuine gap.
     */
    truncatedAt?: number;
    /** Per-handler discovery failures. Non-empty implies `truncatedAt` is set. */
    handlerErrors: HandlerError[];
}

/** Options for {@link IContractManager.scanContracts}. */
export interface ScanContractsOptions {
    /** Default 20. A non-positive / non-integer value throws. */
    gapLimit?: number;
    /**
     * HD indices probed per window (default {@link DEFAULT_SCAN_BATCH}); also the width a
     * {@link Discoverable.discoverRange} handler collapses into one request. The discovered set
     * is independent of it. A non-positive / non-integer value throws. Ignored when `hd` is false.
     */
    batchSize?: number;
    /** HD mode → gap loop guided by the gap counter; false → probe only index 0. */
    hd: boolean;
    /** Materialize the descriptor at an HD index. A throw here is fatal and propagates. */
    materialize: (index: number) => string;
    /** Read-only context injected into every `discoverAt` call. */
    deps: DiscoveryDeps;
}

/**
 * Freshness of the ContractManager's provider-backed sync. `degraded` means the most recent sync
 * hit a retryable indexer/operator failure and repository state is being served; it returns to
 * `online` on the next successful sync.
 */
export type ContractSyncState =
    | { mode: "online"; lastSyncedAt?: number }
    | { mode: "degraded"; reason: string; lastSyncedAt?: number };

export interface IContractManager extends Disposable {
    /**
     * Create and register a new contract, keyed by its script. Implementations may validate that
     * a handler exists for `params.type` and that `params.script` matches the derived script.
     */
    createContract(params: CreateContractParams): Promise<Contract>;

    /**
     * {@link createContract} for a set, one indexer round trip instead of N. Optional so existing
     * implementers (e.g. the service-worker proxy) keep compiling; callers fall back.
     */
    createContracts?(paramsList: CreateContractParams[]): Promise<Contract[]>;

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

    /** List contracts (all when no filter) with their current virtual outputs. `unspentOnly`
     * omits spent VTXOs from the repository result; it does not narrow the provider sync. */
    getContractsWithVtxos(
        filter?: GetContractsFilter,
        pageSize?: number,
        options?: { maxSyncAgeMs?: number; unspentOnly?: boolean; requireSynced?: boolean },
    ): Promise<ContractWithVtxos[]>;

    /** Latest provider-sync health. See {@link ContractSyncState}. */
    getSyncState(): ContractSyncState;

    /**
     * Stamp raw virtual outputs with their contract's tapscripts (forfeit, intent, tap tree).
     * Throws when a vtxo's script has no registered contract, so the wallet never silently stamps
     * the default tapscript onto a non-default vtxo.
     */
    annotateVtxos(
        vtxos: VirtualCoin[],
        tapscripts?: ContractTapscriptCache,
    ): Promise<NormalizedExtendedVirtualCoin[]>;

    /**
     * Throw unless every one of `vtxos` still has an annotatable contract.
     *
     * Spending uses the tapscripts stored on the coin, so an unannotatable contract still
     * broadcasts and only fails in the post-submit bookkeeping. Call this before submitting to
     * refuse the spend instead of broadcasting a transaction whose local state can't be recorded.
     */
    assertAnnotatable(
        vtxos: readonly { txid: string; vout: number; script: string }[],
    ): Promise<void>;

    /**
     * Throw when one of `vtxos` belongs to a contract that provably cannot be spent right now,
     * asking each owning handler's {@link ContractHandler.assertSpendableNow}.
     *
     * Complements {@link isContractGenericallySpendable}: explicit-input APIs stay open to escrow
     * on purpose, but spending too early fails locally, naming the timelock, instead of as a
     * protocol rejection. Contracts whose handler has no opinion cost nothing (no chain-tip read).
     *
     * Optional so embedders' own `IContractManager`s keep compiling; omitting it = no opinion.
     */
    assertSpendableNow?(
        vtxos: readonly AssertSpendableInput[],
        walletDescriptor?: () => Promise<string | undefined>,
    ): Promise<void>;

    /**
     * Which of `vtxos` their owning handler refuses right now, keyed by outpoint (`txid:vout`)
     * with the handler's reason. The predicate form of {@link assertSpendableNow}, for callers
     * that drop a refused input rather than fail the batch.
     *
     * Keyed per outpoint, not per script: a CSV timelock is measured from each coin's own
     * confirmation, so two coins on one contract can disagree.
     */
    unspendableNowReasons?(
        vtxos: readonly AssertSpendableInput[],
        walletDescriptor?: () => Promise<string | undefined>,
    ): Promise<Map<string, string>>;

    /** Update mutable contract fields; `script` and `createdAt` are immutable. */
    updateContract(
        script: string,
        updates: Partial<Omit<Contract, "script" | "createdAt">>,
    ): Promise<Contract>;

    /**
     * Update only the contract state. `inactive` governs receive-address selection and does not
     * stop watching; see {@link ContractState} and {@link setContractWatchState}.
     */
    setContractState(script: string, state: ContractState): Promise<void>;

    /**
     * Update only the contract's watch state.
     *
     * `retained` drops the script from the subscription and sweep while keeping the row (history,
     * annotation, restore). `awaiting-funds` watches only until funded, then the manager demotes
     * it to `retained`.
     *
     * @see ContractWatchState
     */
    setContractWatchState(script: string, watch: ContractWatchState): Promise<void>;

    /**
     * Delete a contract by script, dropping both the row and the watch. Destructive: the row keeps
     * its VTXOs annotatable and its history readable, so to stop watching a finished contract use
     * {@link setContractWatchState}(`"retained"`) instead.
     */
    deleteContract(script: string): Promise<void>;

    /** Currently spendable paths for a contract; empty if the contract or handler is unknown. */
    getSpendablePaths(options: GetSpendablePathsOptions): Promise<PathSelection[]>;

    /** All possible spending paths for a contract; empty if the contract or handler is unknown. */
    getAllSpendingPaths(options: GetAllSpendingPathsOptions): Promise<PathSelection[]>;

    /** Subscribe to contract events. @returns Unsubscribe function */
    onContractEvent(callback: ContractEventCallback): () => void;

    /**
     * Force a virtual output refresh from the indexer: all contracts from scratch, or narrowed to
     * scripts and/or a time window.
     */
    refreshVtxos(opts?: RefreshVtxosOptions): Promise<void>;

    /**
     * Reconcile specific outpoints with the indexer's authoritative state and upsert the result.
     *
     * The delta sync filters by `created_at`, so a VTXO created before the cursor but spent
     * recently never surfaces in `refreshVtxos()`. Use this when handed a stale outpoint (e.g.
     * arkd's `VTXO_ALREADY_SPENT` with a `vtxo_outpoint` in its metadata); the cursor is untouched.
     *
     * Outpoints not owned by any tracked contract are silently dropped.
     */
    refreshOutpoints(outpoints: Outpoint[]): Promise<void>;

    /**
     * Rebuild the HD look-ahead watch window around the current allocation watermark. No-op
     * without `lookAhead`. Call after anything that moves the watermark (restore, boarding
     * allocation, receive rotation, server-signer rotation); concurrent calls coalesce.
     */
    refillLookAhead(): Promise<void>;

    /**
     * Allocate the next signing descriptor through the manager-owned HD watermark. `undefined`
     * when allocation is not configured.
     */
    getNextSigningDescriptor(): Promise<string | undefined>;

    /**
     * Advance the HD signing descriptor watermark to `index` and refill the look-ahead band.
     * No-op when allocation is not configured.
     */
    advanceSigningDescriptorWatermark(index: number): Promise<void>;

    /**
     * Explicit, gap-limit contract discovery used by `wallet.restore()`.
     *
     * Walks HD indices from 0, asking every `Discoverable` handler whether it owns a contract at
     * that index, and registers each find via the idempotent {@link createContract}. A hit by any
     * handler (including an injected swap handler) resets the gap counter.
     *
     * Error contract (safety-critical):
     * - A handler rejecting is **collected** into `handlerErrors` and makes its index (or its
     *   whole {@link Discoverable.discoverRange} range) *indeterminate*: it never advances the
     *   gap counter and the scan stops verifying there, rather than closing a window it never
     *   observed close.
     * - `materialize()` throwing or `createContract` rejecting **propagates**: a silent
     *   truncation would risk hiding user funds.
     *
     * @param opts See {@link ScanContractsOptions}.
     * @returns See {@link ScanResult}. The caller surfaces `truncatedAt` /
     *   `handlerErrors` *after* the inline VTXO pull.
     */
    scanContracts(opts: ScanContractsOptions): Promise<ScanResult>;

    /**
     * Report VTXO activity at `script` without registering a contract or the wallet owning it.
     * Activity arrives as `vtxo_received` / `vtxo_spent` {@link ContractEvent}s without
     * `contract` (narrow with {@link isContractVtxoEvent}); nothing is persisted or counted in
     * balance, renewal or recovery.
     *
     * At-least-once, and re-announces on restart (registration is in-memory). Deduplicate by
     * outpoint and tolerate a `vtxo_spent` with no prior `vtxo_received` (created and spent in
     * one stream gap). Re-registering is a no-op. Reports spendable outputs, preconfirmed
     * included; recoverable or swept ones are not. A set costs one subscription update and one
     * indexer read. Optional so embedders' own `IContractManager`s keep compiling.
     */
    watchScript?(script: string | string[], options?: { label?: string }): Promise<void>;

    /** Stop watching script(s) registered via {@link watchScript}; one subscription rebuild. */
    unwatchScript?(script: string | string[]): Promise<void>;

    /** Scripts registered via {@link watchScript}. Async: a service worker answers over the bus. */
    getWatchedScripts?(): Promise<WatchedScript[]>;

    /** Whether the underlying watcher is currently active. */
    isWatching(): Promise<boolean>;

    /** Release resources (stop watching, clear listeners). */
    dispose(): void;
}

/** Options for getting spendable paths. */
export type GetSpendablePathsOptions = {
    contractScript: string;
    /** The virtual output being evaluated */
    vtxo: VirtualCoin;
    /** Whether collaborative spending is available (default: true) */
    collaborative?: boolean;
    /** Wallet descriptor to determine role */
    walletDescriptor?: string;
};

/** Options for getting all possible spending paths. */
export type GetAllSpendingPathsOptions = {
    contractScript: string;
    /** Whether collaborative spending is available (default: true) */
    collaborative?: boolean;
    /** Wallet descriptor to determine role */
    walletDescriptor?: string;
};

/** Configuration for the ContractManager. */
export interface ContractManagerConfig {
    indexerProvider: IndexerProvider;

    contractRepository: ContractRepository;

    /** Virtual output storage (single source of truth). */
    walletRepository: WalletRepository;

    /**
     * When present, the online sync reconciles persisted non-terminal settlement intents against
     * indexer state (crash recovery) on boot and reconnect; see {@link reconcileIntents}.
     */
    intentRepository?: IntentRepository;

    /**
     * Exit-data capture hook, fired best-effort after VTXOs are persisted so a
     * virtualTxRepository can store each one's unilateral-exit branch.
     */
    onVtxosPersisted?: (contract: Contract, vtxos: ExtendedVirtualCoin[]) => Promise<void>;

    /** Exit-data prune hook, fired best-effort with the spent outpoints on `vtxo_spent`. */
    onVtxosSpent?: (vtxos: Outpoint[]) => Promise<void>;

    watcherConfig?: Partial<ContractWatcherConfig>;

    /**
     * Enables the HD look-ahead watch window; absent for static / non-HD wallets and embedders.
     * See {@link ContractManager.refillLookAhead}.
     */
    lookAhead?: LookAheadConfig;

    /**
     * Current chain tip for {@link PathContext}; absent or `undefined` leaves `blockHeight` unset,
     * which makes `isCltvSatisfied` refuse every height-typed locktime. Resolve `undefined`
     * rather than rejecting when the tip can't be read.
     *
     * `time` is the tip's timestamp in SECONDS; seconds-typed timelocks should be judged against
     * it because the local clock drifts from chain time. Block-typed CSV stays unspendable
     * regardless: virtual coins never carry `status.block_height`.
     */
    chainTip?: () => Promise<{ height: number; time: number } | undefined>;

    /**
     * How stale {@link ContractManager.getContractsWithVtxos} may let its opportunistic sync be
     * before repeating it (`0`, the default, repeats every call). A budget: it widens the
     * staleness a send's coin selection already has by this much.
     */
    vtxoSyncMaxAgeMs?: number;
}

/**
 * Wallet-injected surface backing the HD look-ahead window; a callback bundle so the contracts
 * layer never learns what an HD descriptor is.
 */
export interface LookAheadConfig {
    /** Per-side band bound: the window spans `[max(0, w - size), w + size]`. */
    size: number;
    /** Current allocation watermark (`lastIndexUsed ?? -1`). */
    currentWatermark(): Promise<number>;
    /** Allocate the next signing descriptor, advancing the watermark. */
    allocate?(): Promise<string | undefined>;
    /** Advance the allocation watermark to a confirmed/restored index. */
    advanceWatermark?(index: number): Promise<void>;
    /** Signing descriptor at an HD index. Pure derivation. */
    materialize(index: number): string;
    /**
     * Key and timelock axes an externally issued receive script could be anchored to. Read once
     * per refill, so a band rebuilt after `rotateServerSigner` fans the new signer set.
     */
    candidateDeps(): CandidateDeps;
}

/**
 * A watched-but-unpersisted look-ahead index. Never in `contractRepository`, so speculative
 * entries cannot leak into balances, address lists, or history.
 */
interface LookAheadEntry {
    index: number;
    /** Promotion payload. */
    params: CreateContractParams;
    /** Synthesized watcher object (never persisted as-is). */
    contract: Contract;
    /** Awaiting the one-time full-history catch-up sync. */
    catchUpPending: boolean;
}

/** Parameters for creating a new contract. */
export type CreateContractParams = Omit<Contract, "createdAt" | "state"> & {
    /** Initial state (defaults to "active") */
    state?: ContractState;
};

/**
 * Central manager for contract lifecycle: creates and persists contracts, queries them with
 * their virtual outputs, selects spendable paths, and emits contract events. The only component
 * that writes VTXO/contract state to the repositories. Watching starts during initialization, so
 * `onContractEvent()` only subscribes.
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
    /** Per-sync tapscript caches start empty; this outlives them. Consumers only ever see clones. */
    private readonly tapscriptMemo: TapscriptMemo = new Map();
    private initialized = false;
    private eventCallbacks: Set<ContractEventCallback> = new Set();
    private stopWatcherFn?: () => void;
    /** `undefined` while online; the failure reason once a sync degrades. */
    private syncDegradedReason?: string;
    /** Epoch-ms of the last successful provider sync, if any. */
    private lastSyncedAt?: number;
    private syncedAtByScript = new Map<string, number>();
    /** Last chain tip read, with the epoch-ms it was read at. @see currentChainTip */
    private chainTipCache?: { height: number; time: number; at: number };
    /** In-flight chain tip read, so concurrent cache misses share one. */
    private chainTipInflight?: Promise<{ height: number; time: number } | undefined>;
    /** Speculative look-ahead scripts, keyed by script. @see LookAheadEntry */
    private lookAheadEntries: Map<string, LookAheadEntry> = new Map();
    /** In-flight look-ahead drain, if any. @see scheduleLookAheadDrain */
    private lookAheadDrain?: Promise<void>;
    /** A refill was requested while a drain was running. */
    private lookAheadDirty = false;
    /** A fire-and-forget drain failed, so the band is behind the watermark and
     * owes a retry. @see requestLookAheadDrain */
    private lookAheadRefillOwed = false;
    /** Set by {@link dispose}, cleared by a re-`initialize`. A drain outlives the synchronous
     * `dispose()`, so it re-checks this at every await rather than run on a torn-down watcher. */
    private disposed = false;

    private constructor(config: ContractManagerConfig) {
        this.config = config;

        this.watcher = new ContractWatcher({
            indexerProvider: config.indexerProvider,
            walletRepository: config.walletRepository,
            ...config.watcherConfig,
        });
    }

    /**
     * Create a ContractManager, load persisted contracts and start watching all of them. Use
     * `onContractEvent()` to register event callbacks.
     */
    static async create(config: ContractManagerConfig): Promise<ContractManager> {
        const cm = new ContractManager(config);
        await cm.initialize();
        return cm;
    }

    /**
     * Latest provider-sync health. See {@link ContractSyncState}. Degradation is recorded by
     * {@link initialize}, {@link getContractsWithVtxos} and {@link createContract}.
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

    /** @see ContractManagerConfig.vtxoSyncMaxAgeMs — for factory-built managers. */
    setVtxoSyncMaxAge(maxAgeMs: number): void {
        this.config.vtxoSyncMaxAgeMs = maxAgeMs;
    }

    private markSyncOnline(): void {
        this.lastSyncedAt = Date.now();
        this.syncDegradedReason = this.syncGapReason();
    }

    /**
     * Why a sync that just succeeded still hasn't covered everything. These outlive the failing
     * sync on purpose: reporting `online` while the band lags or a contract can't be annotated
     * would claim coverage the wallet never had.
     */
    private syncGapReason(): string | undefined {
        const annotations = this.annotationDegradedReason();
        const owedRefill = this.lookAheadRefillOwed
            ? "the look-ahead band is behind the allocation watermark, so a funded address inside it is not being watched yet"
            : undefined;
        const reasons = [annotations, owedRefill].filter((r): r is string => r !== undefined);
        return reasons.length === 0 ? undefined : reasons.join("; ");
    }

    /** Contracts a sync could not annotate, as `script → reason`. */
    private annotationFailures = new Map<string, string>();

    private annotationDegradedReason(): string | undefined {
        if (this.annotationFailures.size === 0) return undefined;
        return `cannot annotate ${this.annotationFailures.size} contract(s), their vtxos are not being synced — ${[...this.annotationFailures.values()].join("; ")}`;
    }

    /**
     * Fold one batch's verdict in. Merged, not replaced: a batch may cover only a subset of the
     * wallet's contracts and must not erase what a wider sync found.
     */
    private recordAnnotationFailures(
        annotated: ReadonlySet<string>,
        failures: ReadonlyMap<string, string>,
    ): void {
        for (const script of annotated) this.annotationFailures.delete(script);
        for (const [script, reason] of failures) {
            this.annotationFailures.set(script, reason);
            console.warn(`[contracts] cannot annotate contract ${reason}; skipping its vtxos`);
        }
    }

    /** A retryable failure degrades sync state instead of propagating; terminal ones still throw. */
    /** Returns the swallowed retryable error, if any. */
    private async trySync(sync: () => Promise<unknown>): Promise<unknown> {
        try {
            await sync();
            this.markSyncOnline();
            return undefined;
        } catch (err) {
            if (!isRetryableProviderError(err)) throw err;
            this.markSyncDegraded(err);
            return err;
        }
    }

    private markSyncDegraded(err: unknown): void {
        this.syncDegradedReason = err instanceof Error ? err.message : String(err);
    }

    private async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }
        this.disposed = false;

        // Register persisted contracts BEFORE the first sync so it scopes to the real watched set.
        const contracts = await collectContracts(this.config.contractRepository);
        for (const contract of contracts) {
            await this.watcher.addContract(contract);
        }

        // Band BEFORE the boot sync, so new window scripts get their full-history catch-up first.
        // A retryable failure must not end startup, but the band now lags the watermark: record
        // an owed refill, paid by the next contract event (`handleContractEvent`).
        try {
            await this.scheduleLookAheadDrain();
        } catch (err) {
            if (!isRetryableProviderError(err)) throw err;
            this.lookAheadRefillOwed = true;
            this.markSyncDegraded(err);
        }

        // Best-effort: a retryable failure degrades; the watcher still starts and reconciles later.
        await this.trySync(() => this.reconcileWatched());

        this.initialized = true;

        this.stopWatcherFn = await this.watcher.startWatching((event) => {
            this.handleContractEvent(event).catch((error) => {
                console.error("Error handling contract event:", error);
            });
        });
    }

    /**
     * Delta-sync the watched set (boot and reconnect), then reconcile the pending frontier, which
     * catches not-yet-finalized virtual outputs that can sit outside any delta window.
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
     * Crash-recovery for settlement intents left non-terminal by a mid-settle crash (see
     * {@link reconcileIntents}). Online sync path only, never from a read API. Best-effort: not a
     * sync invariant, so failures are logged.
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

    /** @see IContractManager.refillLookAhead */
    refillLookAhead(): Promise<void> {
        return this.scheduleLookAheadDrain();
    }

    /** @see IContractManager.getNextSigningDescriptor */
    async getNextSigningDescriptor(): Promise<string | undefined> {
        const descriptor = await this.config.lookAhead?.allocate?.();
        // The watermark already moved: a drain failure must not fail this call, or a retry would
        // burn another index.
        if (descriptor !== undefined) this.requestLookAheadDrain();
        return descriptor;
    }

    /** @see IContractManager.advanceSigningDescriptorWatermark */
    async advanceSigningDescriptorWatermark(index: number): Promise<void> {
        await this.advanceLookAheadWatermark(index);
        this.requestLookAheadDrain();
    }

    /**
     * Serialized drain of the look-ahead band: concurrent callers join the active drain and mark
     * it dirty, so boot / SSE / rotate / reconnect / promotion refills coalesce, not recurse.
     */
    private scheduleLookAheadDrain(): Promise<void> {
        if (!this.config.lookAhead || this.disposed) return Promise.resolve();
        if (this.lookAheadDrain) {
            this.lookAheadDirty = true;
            return this.lookAheadDrain;
        }
        const drain = (async () => {
            do {
                this.lookAheadDirty = false;
                await this.ensureLookAhead();
            } while (this.lookAheadDirty && !this.disposed);
            this.lookAheadRefillOwed = false;
        })().finally(() => {
            this.lookAheadDrain = undefined;
        });
        this.lookAheadDrain = drain;
        return drain;
    }

    /**
     * Request a drain without awaiting it (from inside a sync, or after an allocation). A failure
     * leaves the band behind the watermark and the balance under-reporting, so it records the
     * debt for the next contract event to retry. @see handleContractEvent
     */
    private requestLookAheadDrain(): void {
        if (!this.config.lookAhead || this.disposed) return;
        if (this.lookAheadDrain) {
            this.lookAheadDirty = true;
            return;
        }
        void this.scheduleLookAheadDrain().catch((err) => {
            this.lookAheadRefillOwed = true;
            console.error("ContractManager: look-ahead refill failed", err);
        });
    }

    /**
     * Rebuild the speculative watch band around the allocation watermark.
     *
     * No NArk analogue: NArk is the address issuer and persists a row at derivation time. Here a
     * third party may issue addresses from the shared seed unobserved; the window compensates.
     * Entries are watched but NOT persisted until funded (see {@link promoteLookAheadHits}), and
     * each index contributes every {@link Discoverable.candidatesAt} variant, as restore probes.
     */
    private async ensureLookAhead(): Promise<void> {
        const lookAhead = this.config.lookAhead;
        if (!lookAhead || this.disposed) return;

        const watermark = await lookAhead.currentWatermark();
        if (this.disposed) return;
        // A fresh wallet (watermark -1) yields [0, size - 1].
        const from = Math.max(0, watermark - lookAhead.size);
        const to = watermark + lookAhead.size;

        const deps = lookAhead.candidateDeps();
        const handlers = contractHandlers
            .getRegisteredTypes()
            .map((t) => contractHandlers.get(t))
            .filter(hasCandidates);

        const band = new Map<string, { index: number; params: CreateContractParams }>();
        for (let index = from; index <= to; index++) {
            const descriptor = lookAhead.materialize(index);
            for (const handler of handlers) {
                for (const candidate of handler.candidatesAt(index, descriptor, deps)) {
                    // First-wins on a colliding script, like `upsertContract`.
                    if (band.has(candidate.script)) continue;
                    band.set(candidate.script, {
                        index,
                        params: {
                            ...candidate,
                            ...speculativeReceiveMetadata(descriptor),
                        },
                    });
                }
            }
        }

        // One coalesced subscription update, not N growing POSTs.
        await this.watcher.withCoalescedSubscription(async () => {
            const persisted = await collectContracts(this.config.contractRepository, {
                script: [...band.keys()],
            });
            const persistedScripts = new Set(persisted.map((c) => c.script));

            for (const [script, { index, params }] of band) {
                // Per entry: dispose() may land between two registrations.
                if (this.disposed) return;
                // A persisted row is watched through the repository path, not as speculative.
                if (persistedScripts.has(script)) {
                    this.lookAheadEntries.delete(script);
                    continue;
                }
                if (this.lookAheadEntries.has(script)) continue;
                const contract = toWatchOnlyContract(params);
                this.lookAheadEntries.set(script, {
                    index,
                    params,
                    contract,
                    catchUpPending: true,
                });
                await this.watcher.addContract(contract);
            }

            const stale = [...this.lookAheadEntries.keys()].filter((s) => !band.has(s));
            if (stale.length > 0) {
                // A script that gained a repository row meanwhile must keep its subscription.
                const rows = await collectContracts(this.config.contractRepository, {
                    script: stale,
                });
                const nowPersisted = new Set(rows.map((c) => c.script));
                for (const script of stale) {
                    this.lookAheadEntries.delete(script);
                    if (!nowPersisted.has(script)) await this.watcher.removeContract(script);
                }
            }
        });

        await this.runLookAheadCatchUp();
    }

    /**
     * One-time full-history sync for speculative entries not yet caught up.
     *
     * The delta window and SSE both miss a script first registered after its funding (a band
     * sliding over a funded index). Passed as in-memory contracts because `refreshVtxos` resolves
     * through the repository, where they deliberately don't exist. Windowed: cursor stays put.
     */
    private async runLookAheadCatchUp(): Promise<void> {
        // `syncContracts` writes VTXO rows; after dispose the repositories belong to a successor.
        if (this.disposed) return;
        const pending = [...this.lookAheadEntries.values()].filter((e) => e.catchUpPending);
        if (pending.length === 0) return;
        try {
            await this.syncContracts({
                contracts: pending.map((e) => e.contract),
                window: { after: 0 },
            });
            for (const entry of pending) entry.catchUpPending = false;
        } catch (err) {
            // Retryable: degrade; entries stay pending for the next boot or `connection_reset`.
            if (!isRetryableProviderError(err)) throw err;
            this.markSyncDegraded(err);
        }
    }

    private async advanceLookAheadWatermark(index: number): Promise<void> {
        const lookAhead = this.config.lookAhead;
        if (!lookAhead) return;
        await lookAhead.advanceWatermark?.(index);
    }

    /**
     * Promote every look-ahead entry funded by `vtxos` into a repository row, returning the rows
     * keyed by script.
     *
     * MUST run on each raw indexer fetch before `annotateVtxos`, which throws for a script with
     * no row. Callers swap the returned rows into their local contract maps so
     * `saveVtxosForContract` and `onVtxosPersisted` never see the synthetic watcher object.
     */
    private async promoteLookAheadHits(
        vtxos: { script: string }[],
    ): Promise<Map<string, Contract>> {
        const promoted = new Map<string, Contract>();
        if (this.lookAheadEntries.size === 0) return promoted;

        const hits = new Map<string, LookAheadEntry>();
        for (const vtxo of vtxos) {
            const entry = this.lookAheadEntries.get(vtxo.script);
            if (entry) hits.set(vtxo.script, entry);
        }
        if (hits.size === 0) return promoted;

        for (const [script, entry] of hits) {
            // `upsertContract` declassifies the entry.
            promoted.set(script, await this.persistAndWatchContract(entry.params));
            await this.advanceLookAheadWatermark(entry.index);
        }
        // Slide the band, but not from inside the sync this promotion belongs to.
        this.requestLookAheadDrain();
        return promoted;
    }

    /** Create and register a new contract. */
    async createContract(params: CreateContractParams): Promise<Contract> {
        const { contract, persisted } = await this.upsertContract(params);
        if (persisted) {
            // Best-effort hydration so wallet construction survives an offline operator; the
            // contract is still watched and hydrates on the next reconcile.
            await this.trySync(() => this.fetchContractVxosFromIndexer([contract]));
            await this.watcher.addContract(contract);
        }
        return contract;
    }

    /**
     * `createContract`'s step order, fetch batched: persist all, hydrate once, then watch.
     * Hydrate before watching: the watcher seeds from the repository, so an unhydrated row reads
     * as all-new. A part-way failure still watches what it wrote.
     */
    async createContracts(paramsList: CreateContractParams[]): Promise<Contract[]> {
        if (paramsList.length === 0) return [];
        return this.watcher.withCoalescedSubscription(async () => {
            const upserted = [];
            try {
                for (const params of paramsList) upserted.push(await this.upsertContract(params));
            } catch (err) {
                // not hydrated: that can fail too, and would take the watch with it
                for (const u of upserted) {
                    if (!u.persisted) continue;
                    await this.watcher
                        .addContract(u.contract)
                        .catch((e) =>
                            console.error(`ContractManager: ${u.contract.script} left dark`, e),
                        );
                }
                throw err;
            }

            const fresh = upserted.filter((u) => u.persisted).map((u) => u.contract);
            if (fresh.length > 0) {
                await this.trySync(() => this.fetchContractVxosFromIndexer(fresh));
                for (const contract of fresh) await this.watcher.addContract(contract);
            }
            return upserted.map((u) => u.contract);
        });
    }

    /**
     * {@link createContract} without the per-contract indexer hydration, for batch discovery.
     * The caller hydrates afterwards with one bulk `refreshVtxos(...)`. Errors propagate the same.
     */
    private async persistAndWatchContract(params: CreateContractParams): Promise<Contract> {
        const { contract, persisted } = await this.upsertContract(params);
        if (persisted) {
            await this.watcher.addContract(contract);
        }
        return contract;
    }

    /**
     * Validate + dedupe + persist. `persisted` says whether *this* call wrote the row; only then
     * do callers attach hydration / watcher work.
     */
    private async upsertContract(
        params: CreateContractParams,
    ): Promise<{ contract: Contract; persisted: boolean }> {
        const result = await this.upsertContractRow(params);
        // Declassify but keep the watcher registration: a later refill must not read a stale
        // speculative entry and unsubscribe a real contract.
        this.lookAheadEntries.delete(params.script);
        return result;
    }

    private async upsertContractRow(
        params: CreateContractParams,
    ): Promise<{ contract: Contract; persisted: boolean }> {
        const handler = contractHandlers.get(params.type);
        if (!handler) {
            throw new Error(`No handler registered for contract type '${params.type}'`);
        }

        try {
            const script = handler.createScript(params.params);
            const derivedScript = hex.encode(script.pkScript);

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

        const [existing] = await this.getContracts({ script: params.script });
        if (existing) {
            if (existing.type === params.type) return { contract: existing, persisted: false };
            // Equal-delay default/boarding collision: FIRST-WINS, row untouched (NArk's
            // script-keyed dedup). Never mutating it keeps the watcher's registered type
            // authoritative.
            if (areCoalescibleContractTypes(existing.type, params.type)) {
                return { contract: existing, persisted: false };
            }
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
     * Gap-limit contract discovery (error contract: {@link IContractManager.scanContracts}).
     * Hits go through {@link persistAndWatchContract}; `Wallet.restore` then hydrates with one
     * bulk `refreshVtxos({ includeInactive: true })`.
     *
     * - A {@link Discoverable.discoverRange} handler answers the whole window in ONE call (keeps
     *   a large restore under the operator's rate limiter); its failures are range-wide and an
     *   incomplete answer counts as a rejection.
     * - Handlers are probed concurrently; hits persist in ascending index, then `discoverables`
     *   order (the first-wins tie-break).
     * - Each window is capped to `gapLimit - unused` indices, the most a serial scan could still
     *   reach, so results equal a serial scan's; a truncated scan may find a superset, never less.
     * - One coalesced subscription scope: N discoveries cost ONE `subscribeForScripts`.
     */
    scanContracts(opts: ScanContractsOptions): Promise<ScanResult> {
        return this.watcher.withCoalescedSubscription(() => this.runScan(opts));
    }

    private async runScan(opts: ScanContractsOptions): Promise<ScanResult> {
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

        // LOAD-BEARING order: hits persist in this order and collisions are first-wins. In the
        // equal-delay case one script can hold both a boarding UTXO and a VTXO; a `boarding` row
        // keeps the UTXO visible to type-gated `getBoardingUtxos` (a `default` row would hide it)
        // while `getVtxos` is type-agnostic. A unit test pins it.
        const discoverables = [
            ...registered.filter((h) => h.type === "boarding"),
            ...registered.filter((h) => h.type !== "boarding"),
        ];

        const maxIdx = opts.hd ? SCAN_MAX_INDEX : 0;
        const handlerErrors: HandlerError[] = [];
        let highestConfirmedUsedIndex = -1;
        let truncatedAt: number | undefined;
        let unused = 0;
        let i = 0;

        // A rejection is captured, never propagated, so one failing handler can't abort the others.
        const probeHandler = async (
            h: ContractHandler<unknown> & Discoverable,
            entries: { index: number; descriptor: string }[],
        ): Promise<HandlerWindowProbe> => {
            const probe: HandlerWindowProbe = {
                found: new Map(),
                indeterminate: new Set(),
                // Keyed by anchor index so errors report in ascending order, as per-index does.
                errors: new Map(),
            };

            if (!h.discoverRange) {
                await Promise.all(
                    entries.map(async ({ index, descriptor }) => {
                        try {
                            probe.found.set(
                                index,
                                await h.discoverAt(index, descriptor, opts.deps),
                            );
                        } catch (error) {
                            probe.indeterminate.add(index);
                            probe.errors.set(index, { handler: h.type, fromIndex: index, error });
                        }
                    }),
                );
                return probe;
            }

            const from = entries[0].index;
            const to = entries[entries.length - 1].index;
            const failRange = (error: unknown) => {
                for (const e of entries) probe.indeterminate.add(e.index);
                probe.errors.set(from, {
                    handler: h.type,
                    fromIndex: from,
                    ...(to > from && { toIndex: to }),
                    error,
                });
            };

            let ranged: Map<number, DiscoveredContract[]>;
            try {
                ranged = await h.discoverRange(entries, opts.deps);
            } catch (error) {
                failRange(error);
                return probe;
            }

            for (const e of entries) {
                const found = ranged.get(e.index);
                if (found) probe.found.set(e.index, found);
            }
            // Enforce coverage: an absent index read as "empty" would silently under-report a
            // restore. Returned hits are affirmative and kept.
            const missing = entries.find((e) => !ranged.has(e.index));
            if (missing) {
                failRange(
                    new Error(
                        `${h.type}.discoverRange resolved without index ${missing.index} of the requested range [${from}..${to}]`,
                    ),
                );
            }
            return probe;
        };

        while (i <= maxIdx && unused < gapLimit) {
            const windowEnd = Math.min(maxIdx, i + Math.min(batchSize, gapLimit - unused) - 1);
            const entries: { index: number; descriptor: string }[] = [];
            // Up front: a materialize throw is fatal and must propagate before any probe is issued.
            for (let idx = i; idx <= windowEnd; idx++) {
                entries.push({ index: idx, descriptor: opts.materialize(idx) });
            }
            const windowProbes = await Promise.all(
                discoverables.map((h) => probeHandler(h, entries)),
            );

            for (const { index } of entries) {
                let hitAtThisIndex = false;
                let indeterminate = false;
                for (const probe of windowProbes) {
                    const error = probe.errors.get(index);
                    if (error) handlerErrors.push(error);
                    if (probe.indeterminate.has(index)) indeterminate = true;
                    for (const c of probe.found.get(index) ?? []) {
                        await this.persistAndWatchContract(c); // idempotent (script-keyed)
                        hitAtThisIndex = true;
                    }
                }

                // Three outcomes: hit, confirmed miss, indeterminate. Counting indeterminate as a
                // miss lets a rate-limited scan close its gap on failed requests and lose funds.
                if (indeterminate && truncatedAt === undefined) truncatedAt = index;
                if (hitAtThisIndex) highestConfirmedUsedIndex = index;

                // Past truncation only hits count; the gap window cannot close across it.
                if (truncatedAt !== undefined) continue;
                if (hitAtThisIndex) unused = 0;
                else unused += 1;
            }

            if (truncatedAt !== undefined) break;
            i = windowEnd + 1;
        }

        // Ceiling hit without the gap closing: throw, since a partial result is indistinguishable
        // from "no more funds". A `truncatedAt` scan exits early by design and is excluded.
        if (opts.hd && truncatedAt === undefined && i > maxIdx && unused < gapLimit) {
            throw new Error(
                `scanContracts: reached SCAN_MAX_INDEX (${SCAN_MAX_INDEX}) without closing the ` +
                    `${gapLimit}-index gap window; a Discoverable handler may be returning ` +
                    `unconditional hits`,
            );
        }

        return {
            highestConfirmedUsedIndex,
            ...(truncatedAt !== undefined && { truncatedAt }),
            handlerErrors,
        };
    }

    /**
     * Get contracts with optional filters.
     *
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
        return await collectContracts(this.config.contractRepository, dbFilter);
    }

    async getContractsWithVtxos(
        filter?: GetContractsFilter,
        pageSize?: number,
        options?: { maxSyncAgeMs?: number; unspentOnly?: boolean; requireSynced?: boolean },
    ): Promise<ContractWithVtxos[]> {
        if (
            options?.maxSyncAgeMs !== undefined &&
            (!Number.isSafeInteger(options.maxSyncAgeMs) || options.maxSyncAgeMs < 0)
        ) {
            throw new Error("maxSyncAgeMs must be a non-negative safe integer");
        }
        const contracts = await this.getContracts(filter);
        // Best-effort: a retryable failure serves repository state (no partial write or cursor move).
        if (
            this.syncedWithin(
                contracts,
                options?.maxSyncAgeMs ??
                    (options?.requireSynced ? 0 : (this.config.vtxoSyncMaxAgeMs ?? 0)),
            )
        ) {
            // Skipping the fetch must not skip the repository-only demotion it carries.
            await this.demoteFundedAwaitingContracts(contracts);
        } else {
            const failure = await this.trySync(() => this.syncContracts({ contracts, pageSize }));
            if (failure && options?.requireSynced) {
                throw new Error("Spendable VTXO read requires an online contract sync", {
                    cause: failure,
                });
            }
        }
        const vtxos = await this.getVtxosForContracts(contracts, options);
        const vtxosByScript = new Map<string, ExtendedContractVtxo[]>();
        for (const vtxo of vtxos) {
            const group = vtxosByScript.get(vtxo.contractScript) ?? [];
            group.push(vtxo);
            vtxosByScript.set(vtxo.contractScript, group);
        }
        return contracts.map((contract) => ({
            contract,
            vtxos: vtxosByScript.get(contract.script)?.slice() ?? [],
        }));
    }

    async annotateVtxos(
        vtxos: VirtualCoin[],
        tapscripts?: ContractTapscriptCache,
    ): Promise<NormalizedExtendedVirtualCoin[]> {
        if (vtxos.length === 0) return [];

        const scripts = Array.from(new Set(vtxos.map((v) => v.script)));

        const byScript = new Map<string, Contract>();
        const contracts = await collectContracts(this.config.contractRepository, {
            script: scripts,
        });
        for (const contract of contracts) {
            byScript.set(contract.script, contract);
        }

        // Per-contract memo: rebuilding the taproot tree per VTXO dominates long histories (#521).
        const tapscriptCache: ContractTapscriptCache = tapscripts ?? new Map();
        // `vtxos` is caller-supplied, so normalize before annotating: the annotated coins flow on
        // into forfeit construction and repository writes.
        return vtxos.map((vtxo) =>
            extendVirtualCoinForContract(normalizeVtxo(vtxo), byScript, tapscriptCache),
        );
    }

    /** @inheritdoc */
    async assertAnnotatable(
        vtxos: readonly { txid: string; vout: number; script: string }[],
    ): Promise<void> {
        if (vtxos.length === 0) return;
        const contracts = await collectContracts(this.config.contractRepository, {
            script: Array.from(new Set(vtxos.map((vtxo) => vtxo.script))),
        });
        const { scripts, failures } = annotatableIn(
            new Map(contracts.map((contract) => [contract.script, contract])),
            vtxos,
            this.tapscriptMemo,
        );
        const orphans = vtxos.filter(
            (vtxo) => !scripts.has(vtxo.script) && !failures.has(vtxo.script),
        );
        for (const vtxo of orphans) {
            failures.set(vtxo.script, `no contract registered for ${vtxo.script}`);
        }
        if (failures.size === 0) return;
        const outpoints = vtxos
            .filter((vtxo) => failures.has(vtxo.script))
            .map((vtxo) => `${vtxo.txid}:${vtxo.vout}`);
        throw new UnannotatableInputError(
            `refusing to spend ${outpoints.length} vtxo(s) whose contract cannot be annotated ` +
                `(${outpoints.join(", ")}): ${[...failures.values()].join("; ")}`,
        );
    }

    /** @inheritdoc */
    async assertSpendableNow(
        vtxos: readonly AssertSpendableInput[],
        walletDescriptor?: () => Promise<string | undefined>,
    ): Promise<void> {
        const refused = await this.unspendableNowReasons(vtxos, walletDescriptor);
        if (refused.size === 0) return;
        // Verbatim: the handler's message names the maturity to wait for.
        if (refused.size === 1) throw new Error([...refused.values()][0]);
        throw new Error(
            `refusing to spend ${refused.size} vtxo(s) that cannot be spent yet: ` +
                [...refused].map(([outpoint, why]) => `${outpoint}: ${why}`).join("; "),
        );
    }

    /** @inheritdoc */
    async unspendableNowReasons(
        vtxos: readonly AssertSpendableInput[],
        walletDescriptor?: () => Promise<string | undefined>,
    ): Promise<Map<string, string>> {
        const refused = new Map<string, string>();
        if (vtxos.length === 0) return refused;
        const contracts = await collectContracts(this.config.contractRepository, {
            script: Array.from(new Set(vtxos.map((vtxo) => vtxo.script))),
        });
        const byScript = new Map(contracts.map((contract) => [contract.script, contract]));

        // Contracts with no opinion must cost nothing: no chain-tip read and no identity access,
        // which is why `walletDescriptor` is a thunk.
        const asking = vtxos.filter((vtxo) => {
            const contract = byScript.get(vtxo.script);
            return (
                contract !== undefined &&
                contractHandlers.get(contract.type)?.assertSpendableNow !== undefined
            );
        });
        if (asking.length === 0) return refused;

        const tip = await this.currentChainTip();
        const walletDescriptorValue = await walletDescriptor?.();
        // Per INPUT: a CSV timelock runs from THIS coin's confirmation, so two vtxos on one
        // contract can disagree about the same leaf.
        for (const vtxo of asking) {
            const contract = byScript.get(vtxo.script)!;
            const handler = contractHandlers.get(contract.type);
            if (!handler?.assertSpendableNow) continue;
            const context: PathContext = {
                collaborative: true,
                currentTime: Date.now(),
                blockHeight: tip?.height,
                chainTime: tip?.time,
                walletDescriptor: walletDescriptorValue,
                // `isVirtualCoin` only checks `script`, which every input has; `isCsvSpendable`
                // reads `vtxo.status.block_time` unguarded, so require `status` too.
                vtxo: isVirtualCoin(vtxo) && "status" in vtxo ? vtxo : undefined,
            };
            try {
                // Awaited: an un-awaited rejection would escape this catch and read as approval.
                await handler.assertSpendableNow(
                    handler.createScript(contract.params),
                    contract,
                    context,
                );
            } catch (err) {
                refused.set(
                    `${vtxo.txid}:${vtxo.vout}`,
                    err instanceof Error ? err.message : String(err),
                );
            }
        }
        return refused;
    }

    // A field missing here is not a narrower query, it is an unfiltered one.
    private buildContractsDbFilter(filter: GetContractsFilter): ContractFilter {
        return {
            script: filter.script,
            state: filter.state,
            type: filter.type,
            watch: filter.watch,
        };
    }

    /** Update a contract. Nested fields like `params` and `metadata` are replaced, not merged. */
    async updateContract(
        script: string,
        updates: Partial<Omit<Contract, "script" | "createdAt">>,
    ): Promise<Contract> {
        return this.updateExistingContract(script, (existing) => ({ ...existing, ...updates }));
    }

    /** Update a contract's params, merging `updates` into the existing ones. */
    async updateContractParams(script: string, updates: Contract["params"]): Promise<Contract> {
        return this.updateExistingContract(script, (existing) => ({
            ...existing,
            params: { ...existing.params, ...updates },
        }));
    }

    private async updateExistingContract(
        script: string,
        update: (existing: Contract) => Contract,
    ): Promise<Contract> {
        const [existing] = await collectContracts(this.config.contractRepository, { script });
        if (!existing) {
            throw new Error(`Contract ${script} not found`);
        }

        const updated = update(existing);

        await this.config.contractRepository.saveContract(updated);
        await this.watcher.updateContract(updated);

        return updated;
    }

    /**
     * Set a contract's state. Retiring (`inactive`) keeps it watched; to stop watching while
     * keeping the row, use {@link setContractWatchState}.
     */
    async setContractState(script: string, state: ContractState): Promise<void> {
        await this.updateContract(script, { state });
    }

    /** @see IContractManager.setContractWatchState */
    async setContractWatchState(script: string, watch: ContractWatchState): Promise<void> {
        await this.updateContract(script, { watch });
    }

    /**
     * Delete a contract, dropping the row along with the watch. To stop watching a finished
     * contract without losing its history, use {@link setContractWatchState}(`"retained"`).
     */
    async deleteContract(script: string): Promise<void> {
        await this.config.contractRepository.deleteContract(script);
        this.tapscriptMemo.delete(script);
        await this.watcher.removeContract(script);
    }

    /**
     * Chain tip for a {@link PathContext}, or `undefined` when no source is configured or it
     * can't be read. Cached for {@link CHAIN_TIP_TTL_MS}.
     */
    private async currentChainTip(): Promise<{ height: number; time: number } | undefined> {
        const source = this.config.chainTip;
        if (!source) return undefined;
        if (this.chainTipCache && Date.now() - this.chainTipCache.at < CHAIN_TIP_TTL_MS) {
            return { height: this.chainTipCache.height, time: this.chainTipCache.time };
        }
        if (!this.chainTipInflight) {
            // Cleared out here, not in an inner `finally`: a source that throws synchronously
            // would clear the field before this assignment, pinning it for good.
            this.chainTipInflight = this.readChainTip(source).finally(() => {
                this.chainTipInflight = undefined;
            });
        }
        return this.chainTipInflight;
    }

    /** One chain tip read, bounded by {@link CHAIN_TIP_TIMEOUT_MS}. Never rejects. */
    private async readChainTip(
        source: () => Promise<{ height: number; time: number } | undefined>,
    ): Promise<{ height: number; time: number } | undefined> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const tip = await Promise.race([
                source(),
                new Promise<undefined>((resolve) => {
                    timer = setTimeout(() => resolve(undefined), CHAIN_TIP_TIMEOUT_MS);
                }),
            ]);
            // Stamped after the await so the TTL runs from when the tip was true. An absent tip
            // is not cached, so the next call asks again.
            if (tip !== undefined) {
                this.chainTipCache = { ...tip, at: Date.now() };
            }
            return tip;
        } catch {
            return undefined;
        } finally {
            clearTimeout(timer);
        }
    }

    /** Get currently spendable paths for a contract. */
    async getSpendablePaths(options: GetSpendablePathsOptions): Promise<PathSelection[]> {
        const { contractScript, collaborative = true, walletDescriptor, vtxo } = options;

        const [contract] = await this.getContracts({ script: contractScript });
        if (!contract) return [];

        const handler = contractHandlers.get(contract.type);
        if (!handler) return [];

        const script = handler.createScript(contract.params);
        const tip = await this.currentChainTip();
        const context: PathContext = {
            collaborative,
            currentTime: Date.now(),
            blockHeight: tip?.height,
            chainTime: tip?.time,
            walletDescriptor,
            vtxo,
        };

        return handler.getSpendablePaths(script, contract, context);
    }

    /**
     * Get every currently valid spending path for a contract. No `blockHeight`: no handler
     * evaluates a timelock here, so fetching the tip would only add network latency.
     */
    async getAllSpendingPaths(options: GetAllSpendingPathsOptions): Promise<PathSelection[]> {
        const { contractScript, collaborative = true, walletDescriptor } = options;

        const [contract] = await this.getContracts({ script: contractScript });
        if (!contract) return [];

        const handler = contractHandlers.get(contract.type);
        if (!handler) return [];

        const script = handler.createScript(contract.params);
        const context: PathContext = {
            collaborative,
            currentTime: Date.now(),
            walletDescriptor,
        };

        return handler.getAllSpendingPaths(script, contract, context);
    }

    /**
     * Register a callback for contract events (watching already started in `initialize()`).
     *
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
     * Force refresh virtual outputs from the indexer. Without options, re-fetches the watched set
     * and advances the global cursor; see {@link RefreshVtxosOptions} for how each option scopes.
     */
    async refreshVtxos(opts?: RefreshVtxosOptions): Promise<void> {
        const contracts = opts?.scripts
            ? await this.getContracts({ script: opts.scripts })
            : undefined;
        // An empty `{ after: undefined, before: undefined }` would defeat both `??` in
        // `syncContracts` and the cursor-advance gate: a full re-scan whose cursor never moves.
        const hasExplicitWindow = opts?.after !== undefined || opts?.before !== undefined;
        await this.syncContracts({
            contracts,
            includeInactive: contracts ? false : opts?.includeInactive,
            window: hasExplicitWindow ? { after: opts?.after, before: opts?.before } : undefined,
        });
    }

    async refreshOutpoints(outpoints: Outpoint[]): Promise<void> {
        if (outpoints.length === 0) return;

        const { vtxos } = await getNormalizedVtxos(this.config.indexerProvider, {
            outpoints,
        });
        if (vtxos.length === 0) return;

        const scripts = Array.from(new Set(vtxos.map((v) => v.script)));
        const contracts = await collectContracts(this.config.contractRepository, {
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
                // Unreachable today: every `address` came from `contracts`. Guarded
                // so it cannot become a silent bypass if that mapping is loosened.
                await inVtxoWriteOrder(this.config.walletRepository, async () =>
                    this.config.walletRepository.saveVtxos(
                        address,
                        applyRecordedSpends(this.config.walletRepository, addressVtxos),
                    ),
                );
            }
        }
    }

    async isWatching(): Promise<boolean> {
        return this.watcher.isCurrentlyWatching();
    }

    /** @see IContractManager.watchScript */
    async watchScript(script: string | string[], options?: { label?: string }): Promise<void> {
        await this.watcher.addWatchedScript(script, options);
    }

    /** @see IContractManager.unwatchScript */
    async unwatchScript(script: string | string[]): Promise<void> {
        await this.watcher.removeWatchedScript(script);
    }

    /** @see IContractManager.getWatchedScripts */
    async getWatchedScripts(): Promise<WatchedScript[]> {
        return this.watcher.getWatchedScripts();
    }

    private emitEvent(event: ContractEvent): void {
        for (const callback of this.eventCallbacks) {
            try {
                callback(event);
            } catch (error) {
                console.error("Error in contract event callback:", error);
            }
        }
    }

    private async handleContractEvent(event: ContractEvent) {
        // Any event proves the transport is back, so pay an owed band refill now.
        if (this.lookAheadRefillOwed) this.requestLookAheadDrain();
        // A retryable failure must degrade sync state here, not be swallowed by startWatching's
        // `.catch`, or diagnostics keep reporting online. The event is forwarded either way.
        try {
            switch (event.type) {
                // `isContractVtxoEvent` is the ownership boundary: watch-only scripts report these
                // same types and must never reach `syncContracts`.
                case "vtxo_received":
                    if (!isContractVtxoEvent(event)) break;
                    await this.syncContracts({ contracts: [event.contract] });
                    this.markSyncOnline();
                    break;
                case "vtxo_spent":
                    if (!isContractVtxoEvent(event)) break;
                    await this.syncContracts({ contracts: [event.contract] });
                    this.markSyncOnline();
                    if (this.config.onVtxosSpent) {
                        try {
                            await this.config.onVtxosSpent(
                                event.vtxos.map((v) => ({ txid: v.txid, vout: v.vout })),
                            );
                        } catch {
                            // prune is best-effort; never block the spend event
                        }
                    }
                    break;
                case "connection_reset":
                    // Same recovery as boot. Freshness drops first (a reset means events were
                    // missed); the refill runs before the reconcile so pending catch-ups retry.
                    this.syncedAtByScript.clear();
                    await this.scheduleLookAheadDrain();
                    await this.reconcileWatched();
                    this.markSyncOnline();
                    break;
            }
        } catch (err) {
            if (!isRetryableProviderError(err)) throw err;
            this.markSyncDegraded(err);
        }

        this.emitEvent(event);
    }

    private async getVtxosForContracts(
        contracts: Contract[],
        options?: { unspentOnly?: boolean },
    ): Promise<ExtendedContractVtxo[]> {
        const res = await Promise.all(
            contracts.map((contract) =>
                getVtxosForContract(this.config.walletRepository, contract, options).then((vtxos) =>
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

    /** Sync virtual outputs for the given contracts (default: the watched set). */
    private async syncContracts(options: {
        contracts?: Contract[];
        pageSize?: number;
        // Overrides the cursor-derived window.
        window?: { after?: number; before?: number };
        // With no `contracts`: every repository row instead of the watched set (a superset).
        includeInactive?: boolean;
    }): Promise<Map<string, ExtendedContractVtxo[]>> {
        const cursor = await getSyncCursor(this.config.walletRepository);
        const window = options.window ?? computeSyncWindow(cursor);

        // Only a cursor-derived sync covering at least the watched set may advance the cursor;
        // subsets and explicit windows may skip data. `<=` lets the bootstrap (cursor=0,
        // after=0) write the migration marker on first boot.
        const mustUpdateCursor =
            options.contracts === undefined &&
            options.window === undefined &&
            (window.after ?? 0) <= cursor;

        const contracts =
            options.contracts ??
            (options.includeInactive
                ? await collectContracts(this.config.contractRepository, {})
                : this.watcher.getWatchedContracts());

        const requestStartedAt = Date.now();
        const result = await this.fetchContractVxosFromIndexer(contracts, options.pageSize, window);

        if (mustUpdateCursor) {
            const cutoff = cursorCutoff(requestStartedAt);
            await advanceSyncCursor(this.config.walletRepository, cutoff);
        }

        // A narrowed window saw less than a normal sync, so it earns no freshness.
        if (options.window === undefined) {
            for (const contract of contracts) {
                this.syncedAtByScript.set(contract.script, requestStartedAt);
            }
        }

        await this.demoteFundedAwaitingContracts(contracts);

        return result;
    }

    private syncedWithin(contracts: Contract[], maxAgeMs: number): boolean {
        if (maxAgeMs <= 0) return false;
        const floor = Date.now() - maxAgeMs;
        return contracts.every(
            (contract) => (this.syncedAtByScript.get(contract.script) ?? 0) >= floor,
        );
    }

    /**
     * Demote every funded `awaiting-funds` contract to `retained` (see {@link ContractWatchState}).
     *
     * Runs after the sync persisted, so the funding VTXO is saved while still watched, and reads
     * the repository rather than this delta: funds that landed while the app was closed are
     * outside every later window. Best-effort: must not fail the sync that carried it.
     */
    private async demoteFundedAwaitingContracts(contracts: Contract[]): Promise<void> {
        const awaiting = contracts.filter((c) => watchStateOf(c) === "awaiting-funds");
        if (awaiting.length === 0) return;

        for (const contract of awaiting) {
            try {
                if (!(await hasVtxosForContract(this.config.walletRepository, contract))) continue;
                await this.setContractWatchState(contract.script, "retained");
            } catch (err) {
                console.warn(
                    `[contracts] could not demote funded contract ${contract.script}`,
                    err,
                );
            }
        }
    }

    /**
     * Fetch all pending (unfinalized) virtual outputs and upsert them, catching state changes
     * outside the delta window (e.g. a spend that hasn't settled yet).
     */
    private async reconcilePendingFrontier(contracts: Contract[]): Promise<void> {
        const scriptToContract = new Map<string, Contract>(contracts.map((c) => [c.script, c]));

        const vtxos = await getAllNormalizedVtxos(
            this.config.indexerProvider,
            contracts.map((c) => c.script),
            { pendingOnly: true },
        );

        // Raw fetch path outside `fetchContractVxosFromIndexer`: promote before annotating.
        for (const [script, contract] of await this.promoteLookAheadHits(vtxos)) {
            scriptToContract.set(script, contract);
        }

        const {
            scripts: annotatable,
            cache,
            failures,
        } = annotatableIn(scriptToContract, vtxos, this.tapscriptMemo);
        this.recordAnnotationFailures(annotatable, failures);
        const owned = vtxos.filter((v) => annotatable.has(v.script));
        const annotated = await this.annotateVtxos(owned, cache);

        const byContract = new Map<string, ExtendedContractVtxo[]>();
        // So a just-promoted script saves against its row, not the synthetic watcher object.
        const contractByAddress = new Map<string, Contract>();
        for (const vtxo of annotated) {
            const contract = scriptToContract.get(vtxo.script)!;
            contractByAddress.set(contract.address, contract);
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
            await this.persistContractVtxos(
                contractByAddress.get(addr)!,
                contractVtxos,
                "ContractManager.reconcilePendingFrontier",
            );
        }
    }

    private async persistContractVtxos(
        contract: Contract,
        vtxos: ExtendedContractVtxo[],
        context: string,
    ): Promise<void> {
        const filtered = warnAndFilterVtxosForScript(
            vtxos,
            contract.script,
            context,
        ) as ExtendedVirtualCoin[];
        if (filtered.length === 0) return;
        await saveVtxosForContract(this.config.walletRepository, contract, filtered);
        if (this.config.onVtxosPersisted) {
            try {
                await this.config.onVtxosPersisted(contract, filtered);
            } catch {
                // capture is best-effort; never block sync or reconciliation
            }
        }
    }

    private async fetchContractVxosFromIndexer(
        contracts: Contract[],
        pageSize?: number,
        syncWindow?: { after?: number; before?: number },
    ): Promise<Map<string, ExtendedContractVtxo[]>> {
        const { vtxosByScript, promoted } = await this.fetchContractVtxosBulk(
            contracts,
            pageSize,
            syncWindow,
        );
        const result = new Map<string, ExtendedContractVtxo[]>();
        for (const [contractScript, vtxos] of vtxosByScript) {
            result.set(contractScript, vtxos);
            // A just-promoted script saves against its row, not the synthetic watcher object.
            const contract =
                promoted.get(contractScript) ?? contracts.find((c) => c.script === contractScript);
            if (contract) {
                await this.persistContractVtxos(
                    contract,
                    vtxos,
                    "ContractManager.fetchContractVxosFromIndexer",
                );
            }
        }
        return result;
    }

    private async fetchContractVtxosBulk(
        contracts: Contract[],
        pageSize: number = DEFAULT_PAGE_SIZE,
        syncWindow?: { after?: number; before?: number },
    ): Promise<{
        vtxosByScript: Map<string, ExtendedContractVtxo[]>;
        /** Look-ahead entries this fetch funded. @see promoteLookAheadHits */
        promoted: Map<string, Contract>;
    }> {
        if (contracts.length === 0) {
            return { vtxosByScript: new Map(), promoted: new Map() };
        }

        // Full history (spent/swept included) so the repository is the source of truth.
        const scriptToContract = new Map<string, Contract>(contracts.map((c) => [c.script, c]));
        const result = new Map<string, ExtendedContractVtxo[]>(
            contracts.map((c) => [c.script, []]),
        );

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

        const vtxos = await getAllNormalizedVtxos(
            this.config.indexerProvider,
            contracts.map((c) => c.script),
            { ...windowOpts, pageSize },
        );

        // Promote before annotating (see promoteLookAheadHits).
        const promoted = await this.promoteLookAheadHits(vtxos);
        for (const [script, contract] of promoted) {
            scriptToContract.set(script, contract);
        }

        const {
            scripts: annotatable,
            cache,
            failures,
        } = annotatableIn(scriptToContract, vtxos, this.tapscriptMemo);
        this.recordAnnotationFailures(annotatable, failures);
        const owned = vtxos.filter((v) => annotatable.has(v.script));
        const annotated = await this.annotateVtxos(owned, cache);
        for (const vtxo of annotated) {
            result.get(vtxo.script)!.push({
                ...vtxo,
                contractScript: vtxo.script,
            });
        }

        return { vtxosByScript: result, promoted };
    }

    /** Stop the watcher, clear callbacks, and mark the manager uninitialized. */
    dispose(): void {
        // First, before the watcher goes away: a fire-and-forget drain parked on an await must
        // not addContract or persist catch-up VTXOs after teardown.
        this.disposed = true;
        const pendingDrain = this.lookAheadDrain;

        this.stopWatcherFn?.();
        this.stopWatcherFn = undefined;

        this.eventCallbacks.clear();

        this.lookAheadEntries.clear();
        // Sweep again once the drain unwinds: its current iteration can register one last entry.
        if (pendingDrain) {
            void pendingDrain
                .catch(() => {})
                .then(() => {
                    if (this.disposed) this.lookAheadEntries.clear();
                });
        }

        this.initialized = false;
    }

    /**
     * Symbol.dispose implementation for the `using` keyword.
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
