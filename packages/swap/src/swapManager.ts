/**
 * Driving a set of live RFQ swaps to their end: calling the corridor building blocks at
 * the right moment, remembering where each swap got to, and emitting events.
 *
 * - **The solver is never asked.** No `RfqTransport`: every fact is read from chain
 *   ({@link readLockupFate}, {@link classifyOnchainHtlc}). A silent solver cannot degrade
 *   the trader's view, and its `settled`/`refunded` is self-reported while the chain is
 *   not: a spend witness that HASHES to `payment_hash` proves settlement. On the receive
 *   leg the meanings mirror (see {@link RfqSwapState}), and chain-only is required there:
 *   the reference solver's `rfq_status_request` answers `unknown` for receives.
 * - **The onchain claim is on a consensus deadline**, not the solver's word; see
 *   {@link nextOnchainAction}.
 * - **No manager-level retry backoff.** The `refundWithoutReceiver` push is atomic, so
 *   there is no partial success to track. Early pushes are EXPECTED to be refused
 *   (median-time-past lags wall clock); the poll interval is the retry cadence and
 *   {@link REFUND_MTP_LAG_SECONDS} the deadline.
 *
 * **The manager owns WHEN, the caller owns HOW**: money-moving actions are
 * {@link RfqSwapManagerCallbacks}, so no key material reaches it. Contract events only run
 * a pass early; polling stays the failsafe ({@link RfqSwapManager.subscribe}).
 */
import { hex } from "@scure/base";
import {
    ArkErrorName,
    isArkError,
    isContractVtxoEvent,
    maybeArkError,
    type ContractEvent,
    type IContractManager,
    type VHTLC,
} from "@arkade-os/sdk";

import {
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    classifyOnchainHtlc,
    type ChainSource,
    type ChainUtxo,
    type OnchainHtlc,
    type OnchainHtlcPhase,
} from "./onchainHtlc";
import {
    REFUND_MTP_LAG_SECONDS,
    findLockupVtxos,
    readLockupFate,
    type LockupFate,
    type LockupSpend,
    type LockupSpendIndexer,
    type LockupVtxo,
} from "./refund";
import { lockupContractParams, registerLockupContract } from "./lockupContract";
import { collectRfqSwaps, type AssetSwapRepository } from "./repository";
import {
    assertSameSwap,
    createRfqSwapRecord,
    normalizeRfqSwapRecord,
    rebuildRfqSwap,
    rfqSwapOriginOf,
    shouldRetainRfqSwap,
    updateRfqSwapRecord,
    type LockupParams,
    type RfqSwapOrigin,
    type RfqSwapRecord,
} from "./rfqRecord";
import { RefundNotLocallyPossibleError } from "./refundBlocked";
import { LOCKUP_RETIRABLE } from "./coverage";
import { RFQ_SWAP_ACTIVE_STATES, isRfqSwapTerminal, type RfqSwapState } from "./rfqSwapState";

// ── Records ──────────────────────────────────────────────────────────────────

// Defined in `rfqSwapState.ts` so the record layer need not import the manager at runtime.
export {
    RFQ_SWAP_ACTIVE_STATES,
    RFQ_SWAP_TERMINAL_STATES,
    isRfqSwapTerminal,
    type RfqSwapState,
} from "./rfqSwapState";

/**
 * What the manager needs to register a swap's lockup with the wallet, so the indexer
 * pushes its funding and spend.
 *
 * `address` is taken, not re-derived: it must be the one actually funded, and a local
 * re-derivation would silently use the SDK's default network.
 *
 * @deprecated Use `createSwapClient` and `client.onUpdate()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export interface RfqSwapLockup {
    /** The covenant. Its `pkScript` MUST equal the record's `lockupPkScript`. */
    script: InstanceType<typeof VHTLC.ScriptV2>;
    /** The Arkade address that was funded. */
    address: string;
}

interface RfqSwapCommon {
    /** The negotiation id — this record's identity. */
    rfqId: string;
    state: RfqSwapState;
    /** The Arkade lockup's scriptPubKey (`swapPkScript` from the request entrypoint): the
     * only handle on the covenant whose spend witness decides the swap. */
    lockupPkScript: Uint8Array;
    /** The covenant behind {@link lockupPkScript}. Without it the manager still polls the
     * swap, it just cannot subscribe; see {@link RfqSwapManagerDeps.contracts}. */
    lockup?: RfqSwapLockup;
    /**
     * `sha256(P)`, hex — the quote's `payment_hash`. The claim leaf is spendable only by
     * revealing its preimage, which makes settlement provable. For an onchain send the L1
     * `htlc` carries the SAME hash. Not final: a hashlock belongs to a corridor (the stored
     * record keeps it in `profile.hashlock`), and hashlock-free corridors may follow.
     */
    paymentHash: string;
    /**
     * `refund_locktime` from the quote, unix seconds. On a send leg it is the TRADER's:
     * refund AFTER it. On a receive leg it is the SOLVER's: the trader must have claimed
     * BEFORE it.
     */
    refundLocktime: number;
    createdAt: number;
    updatedAt: number;
    /** Set once the trader's own `refundWithoutReceiver` push landed. */
    refundTxid?: string;
    /**
     * The ark transactions that SPENT the lockup, from the chain read that ended the swap
     * (`LockupFate.spends`) — moves no local action produced, so a terminal record can
     * name them without another network read. Absent without a chain verdict, or when the
     * indexer named only the checkpoint.
     */
    lockupSpendTxids?: string[];
    /**
     * `P`, hex — the preimage the solver revealed to claim the lockup. Lightning sends
     * only (the payee mints `P`). A public settlement receipt, not a claim secret;
     * `readLockupFate` verifies it against {@link paymentHash} before it is stamped.
     */
    settlementPreimageHex?: string;
    /** Why `state` is `failed`. */
    failure?: string;
    /**
     * Last local claim error while the receive swap is still retryable. Becomes the
     * terminal `failure` if the window closes without a submitted claim.
     */
    claimFailure?: string;
    /** Why `state` is `needs_counterparty`. Distinct from {@link failure},
     * which means an action was attempted and did not work. */
    blockedReason?: string;
}

/** `arkade:BTC->lightning:BTC`. The solver claims the lockup with the preimage it learns
 * by paying, so that spend's witness proves the payment landed. */
export interface LightningSendSwap extends RfqSwapCommon {
    kind: "lightning_send";
}

/** `arkade:BTC->onchain:BTC`. Carries the L1 half the trader must claim. */
export interface OnchainSendSwap extends RfqSwapCommon {
    kind: "onchain_send";
    /** The locally derived HTLC from `requestOnchainSend` — the manager reads
     * `pkScript`, `paymentHash` and `refundLocktime` off it to classify. */
    htlc: OnchainHtlc;
    /** `profile.min_confirmations` from the quote. */
    minConfirmations: number;
    /** The quote's `to_amount`, captured at REQUEST time: read at claim time it
     * would be whatever the solver funded. */
    expectedAmount: number;
    /** Where {@link RfqSwapManagerCallbacks.claimOnchain} pays; optional only
     * so records predating its profile slot still restore. */
    payoutPkScript?: Uint8Array;
    /** The fill's outpoint, learned on first sighting. Without it a SPENT
     * HTLC reads as never funded — see {@link classifyOnchainHtlc}. */
    funding?: { txid: string; vout: number };
    /** Our L1 claim's txid. */
    claimTxid?: string;
}

/**
 * `lightning:BTC->arkade:BTC`. The SOLVER funds the lockup and the TRADER claims it,
 * publishing `P` so the solver can settle the payer's held Lightning HTLC.
 *
 * - **No trader-side refund.** Every non-claim leaf is the solver's; an unclaimed swap is
 *   lost when the solver reclaims at {@link RfqSwapCommon.refundLocktime}.
 * - **The claim is the whole swap, on a deadline**, and the trader must be online:
 *   covclaimd cannot claim this covenant today.
 */
export interface LightningReceiveSwap extends RfqSwapCommon {
    kind: "lightning_receive";
    /**
     * What the lockup must carry — the quote's `to_amount`, captured at REQUEST time.
     *
     * **Not re-derivable, not optional.** Read at claim time it would be whatever the
     * solver funded (the dust-funding attack). A non-finite value is reported
     * `needs_counterparty` and never claimed: comparing against `undefined`/`NaN` is
     * false, which would delete the value gate rather than fail it.
     */
    expectedAmount: number;
    /** Our Arkade claim's txid, once submitted. Set from the callback's return
     * and never from a chain read — the chain's answer is `settled`. */
    claimTxid?: string;
}

/**
 * A monitored swap: a live record holding derived `Uint8Array`s, whose storable
 * projection is `RfqSwapRecord`. With {@link RfqSwapManagerDeps.repository} the manager
 * writes and rebuilds these itself ({@link RfqSwapManager.restoreFromRepository});
 * otherwise the caller persists via {@link RfqSwapManagerCallbacks.saveSwap} and hands
 * rebuilt swaps to {@link RfqSwapManager.start}.
 *
 * **`onchain:BTC->arkade:BTC` is deliberately not a member**: monitoring only its lockup
 * half would silently let the trader's own L1 refund window pass.
 */
export type RfqSwap = LightningSendSwap | OnchainSendSwap | LightningReceiveSwap;

// ── The onchain state machine ───────────────────────────────────────────────

/** What the manager should do next about an onchain-send swap's L1 half.
 *
 * @deprecated Use `createSwapClient` and `client.onUpdate()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export type OnchainSendAction =
    /** Not funded yet, or not confirmed deep enough. */
    | "wait"
    /** Funded, confirmed, and far enough from the refund leaf to claim safely. */
    | "claim"
    /** The claim is off the table for good; the money comes back through the
     * Arkade lockup instead. */
    | "claim_window_closed"
    /** Our claim already landed (only the trader holds P). */
    | "claimed"
    /** The solver took its L1 refund — the fill is gone. */
    | "swept";

/**
 * The decision a "poll status, refund on timeout" loop gets wrong.
 *
 * `refundable` does NOT mean "refund the L1 HTLC": that leaf is the SOLVER's, so reaching
 * it means the trader's claim was missed and only the Arkade-side refund remains.
 *
 * And `classifyOnchainHtlc` reports `claimable` until MTP reaches `refundLocktime`, while
 * `claimOnchainFill` refuses from {@link ONCHAIN_CLAIM_MARGIN_SECONDS} before it
 * (publishing P into the solver's live refund window risks losing the race AND the
 * preimage). This function applies that margin so the drive falls back instead of
 * throwing every poll.
 */
export function nextOnchainAction(input: {
    phase: OnchainHtlcPhase;
    /** `htlc.refundLocktime` — when the solver's L1 refund leaf opens. */
    htlcLocktime: number;
    /** Unix seconds. */
    now: number;
}): OnchainSendAction {
    switch (input.phase.phase) {
        case "unfunded":
        case "awaiting_confirmations":
            return "wait";
        case "claimed":
            return "claimed";
        case "swept":
            return "swept";
        case "refundable":
            return "claim_window_closed";
        case "claimable":
            return input.htlcLocktime - input.now >= ONCHAIN_CLAIM_MARGIN_SECONDS
                ? "claim"
                : "claim_window_closed";
    }
}

// ── Callbacks, events, configuration ─────────────────────────────────────────

/** What the trader's own `refundWithoutReceiver` push returned, or `null` when
 * the lockup held nothing to return.
 */
export type ArkadeRefundResult = { txid: string; amount: number } | null;

/**
 * The money-moving half, injected. The manager decides when; these do it.
 *
 * Use `arkadeRefunder` for `refundArkade` rather than assembling it. Do NOT wire it to
 * `refundIfUnresolved`, whose own polling and MTP retry loop would nest inside the
 * manager's. Resolve the sender key via `senderIdentityForSwapRecord`, which turns "this
 * wallet cannot sign" into {@link RefundNotLocallyPossibleError} (`needs_counterparty`)
 * instead of retrying for the whole refund window.
 */
export interface RfqSwapManagerCallbacks {
    /** Build and broadcast the L1 claim. See `claimOnchainFill`. */
    claimOnchain: (swap: OnchainSendSwap, utxo: ChainUtxo) => Promise<{ txid: string }>;
    /**
     * Claim the solver-funded lockup on a receive leg, revealing `P`. Wire it to
     * `pushClaim` (the outputs are supplied, so `claimReceiveLockup`'s wait is redundant).
     *
     * **Pass `expectedAmount` and `partiallyClaimed` straight through.** The manager's
     * value check decides WHEN to act; `pushClaim`'s decides whether `P` is published and
     * is the load-bearing one. Do not drop it because the outer one exists.
     */
    claimLockup: (
        swap: LightningReceiveSwap,
        vtxos: readonly LockupVtxo[],
        options: {
            /** A claim of ours is already out, so `P` is public and the value gate has
             * nothing left to protect; lets a piecemeal funding still be swept. */
            partiallyClaimed: boolean;
        },
    ) => Promise<{ txid: string; amount: number }>;
    /**
     * Push `refundWithoutReceiver` for every output at the lockup (see
     * `pushRefundWithoutReceiver`); return `null` for an empty lockup. Never called for a
     * {@link LightningReceiveSwap}.
     *
     * Only {@link RefundNotLocallyPossibleError} is permanent. Any other throw is RETRIED
     * each poll (reported via `onSwapFailed`) until `refundLocktime +
     * REFUND_MTP_LAG_SECONDS`, then `failed` — right for e.g. `LockupNeedsRecoveryError`,
     * but a wiring bug that always throws also looks transient. Throw
     * {@link RefundNotLocallyPossibleError} for anything this wallet can never do.
     */
    refundArkade: (swap: RfqSwap) => Promise<ArkadeRefundResult>;
    /**
     * Whether a local refund is possible at all. Called every pass, even *before* the
     * window opens, so an unrefundable swap says so while the solver can still act, and
     * restoring the right wallet lifts it. Never called for a receive swap.
     *
     * Optional: omit to learn at push time via {@link RefundNotLocallyPossibleError}.
     * Local by contract — no network call belongs here.
     */
    canRefundArkade?: (swap: RfqSwap) => Promise<{ ok: true } | { ok: false; reason: string }>;
    /**
     * Persist the record. Called after any pass that changed it.
     *
     * With {@link RfqSwapManagerDeps.repository} wired this is the SECOND write (after the
     * canonical record); both must succeed for the pass to count as persisted. Keep it for
     * secondary sinks only (metrics, a cache), not a duplicate write of that repository.
     */
    saveSwap: (swap: RfqSwap) => Promise<void>;
}

/**
 * What {@link RfqSwapManager.setCallbacks} accepts: the full contract with the two
 * kind-gated claims and `saveSwap` optional, so a consumer driving only lightning sends
 * need not stub them to throw. Omitting all persistence is process-local mode.
 *
 * A kind whose claim is missing blocks at runtime instead: non-terminal, re-evaluated
 * every pass, lifted once `setCallbacks` supplies it.
 */
export type AvailableRfqSwapManagerCallbacks = Omit<
    RfqSwapManagerCallbacks,
    "claimOnchain" | "claimLockup" | "saveSwap"
> &
    Partial<Pick<RfqSwapManagerCallbacks, "claimOnchain" | "claimLockup" | "saveSwap">>;

// The actions the manager executes on a caller's behalf.
export type RfqSwapActionName = "claimOnchain" | "claimLockup" | "refundArkade";

/**
 * The `needs_counterparty` reasons that describe THIS PROCESS'S CONFIGURATION rather than
 * the swap: nothing is wired to act, and wiring it lifts the state on the next pass.
 * Exported so a deliberately unwired (read-only) consumer need not read every live swap
 * as needing recovery. These are the block sites' own strings.
 */
export const RFQ_CONFIGURATION_REFUSAL = {
    noClaimLockupCallback:
        "no claimLockup callback is wired, so this wallet cannot claim the lockup",
    noCallbacksForClaim: "no callbacks are wired, so this wallet cannot claim the lockup",
    noClaimOnchainCallback:
        "no claimOnchain callback is wired, so this wallet cannot claim the L1 fill",
    autoActionsDisabled: "automatic actions are disabled, so this wallet will not push the refund",
    noCallbacksForRefund: "no callbacks are wired, so this wallet cannot push the refund",
} as const;

/** {@link RFQ_CONFIGURATION_REFUSAL}'s values. */
export const RFQ_CONFIGURATION_REFUSALS: readonly string[] =
    Object.values(RFQ_CONFIGURATION_REFUSAL);

/** Whether a `blockedReason` is one of {@link RFQ_CONFIGURATION_REFUSAL}'s. */
export const isRfqConfigurationRefusal = (reason: string | undefined): boolean =>
    reason !== undefined && RFQ_CONFIGURATION_REFUSALS.includes(reason);

/** @deprecated Use `createSwapClient` and `client.onUpdate()`. Moved off the package root to `@arkade-os/swap/protocol`. */
export interface RfqSwapManagerEvents {
    /** Every state change, including backwards ones: `claimed -> claimable` is expected on
     * a receive the solver tops up after a claim. States describe what to do next, not
     * progress. */
    onSwapUpdate?: (swap: RfqSwap, previous: RfqSwapState) => void;
    /** Fired once, when a swap leaves monitoring `settled` or `refunded`. Mutually
     * exclusive with the final `onSwapFailed`. */
    onSwapCompleted?: (swap: RfqSwap) => void;
    /** Fired for any action that threw — including ones the manager will retry
     * on the next pass — and once more when the swap finally ends `failed`. */
    onSwapFailed?: (swap: RfqSwap, error: Error) => void;
    onActionExecuted?: (swap: RfqSwap, action: RfqSwapActionName) => void;
}

type SwapUpdateListener = NonNullable<RfqSwapManagerEvents["onSwapUpdate"]>;
type SwapCompletedListener = NonNullable<RfqSwapManagerEvents["onSwapCompleted"]>;
type SwapFailedListener = NonNullable<RfqSwapManagerEvents["onSwapFailed"]>;
type ActionExecutedListener = NonNullable<RfqSwapManagerEvents["onActionExecuted"]>;

/** @deprecated Use `createSwapClient` and `client.onUpdate()`. Moved off the package root to `@arkade-os/swap/protocol`. */
export interface RfqSwapManagerConfig {
    /** Drive claims and refunds automatically (default: true). With this off the manager
     * still watches and reports. */
    enableAutoActions?: boolean;
    /** How often to run a pass, ms. Default 5000. */
    pollIntervalMs?: number;
    /** Injected for tests; defaults to wall clock, in unix seconds. */
    now?: () => number;
    events?: RfqSwapManagerEvents;
}

/** The contract-manager surface this needs, satisfied structurally by a real
 * `ContractManager` (`await wallet.getContractManager()`). */
export type SwapContractRegistry = Pick<
    IContractManager,
    | "createContract"
    | "getContracts"
    | "getContractsWithVtxos"
    | "onContractEvent"
    | "setContractWatchState"
>;

/**
 * The record store the manager writes to: the four RFQ methods of `AssetSwapRepository`,
 * so other backing stores need not implement the rest.
 *
 * Expect TWO calls per dirty swap per poll, `getRfqSwap` then `saveRfqSwap`: the store is
 * the system of record, so a consumer's edit to a record's origin half must not be
 * overwritten by the manager's boot-time copy.
 */
export interface RfqSwapRecordStore {
    saveRfqSwap(record: RfqSwapRecord): Promise<void>;
    getRfqSwap(rfqId: string): Promise<RfqSwapRecord | undefined>;
    getRfqSwapsPage: AssetSwapRepository["getRfqSwapsPage"];
    removeRfqSwap(rfqId: string): Promise<void>;
}

/**
 * A swap was handed to the manager with a repository wired, no origin, and no record
 * already in the store. Thrown at the door, not at the first write a pass later: by then
 * funding is broadcast and the record would exist only in memory. Pass the origin the
 * request entrypoint returned.
 *
 * @deprecated Use `createSwapClient` and `client.onUpdate()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export class RfqSwapOriginRequired extends Error {
    /** The swap that could not be admitted. */
    readonly rfqId: string;
    constructor(rfqId: string) {
        super(
            `rfq swap ${rfqId} has no stored record and no origin was supplied; pass the ` +
                `request-time origin as addSwap's second argument so its first record can be ` +
                `written`,
        );
        this.name = "RfqSwapOriginRequired";
        this.rfqId = rfqId;
    }
}

/** One stored record that could not be turned back into a live swap.
 *
 * @deprecated Use `createSwapClient` and `client.onUpdate()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export interface RfqRestoreFailure {
    rfqId: string;
    /** Why — a covenant that does not derive the funded address, a lockup with
     * no contract row, a corridor with no handler registered. */
    error: Error;
}

/** @deprecated Use `createSwapClient` and `client.onUpdate()`. Moved off the package root to `@arkade-os/swap/protocol`. */
export interface RfqRestoreOptions {
    /**
     * Where each record's covenant parameters come from. Defaults to the lockup's contract
     * row via {@link RfqSwapManagerDeps.contracts}. Whatever it returns is checked against
     * the funded address by `rebuildRfqSwap`, so an override cannot watch the wrong
     * covenant.
     */
    params?: (record: RfqSwapRecord) => Promise<LockupParams>;
    /** Include terminal history in the returned array. Expensive for large wallets. */
    includeTerminal?: boolean;
}

/** What {@link RfqSwapManager.restoreFromRepository} did.
 *
 * @deprecated Use `createSwapClient` and `client.onUpdate()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export interface RfqRestoreResult {
    /** Rebuilt active swaps, plus terminal history when `includeTerminal` is set. */
    restored: RfqSwap[];
    /** Kept in the store, but not rebuildable right now. */
    failed: RfqRestoreFailure[];
    /** Compatibility field; normal restore leaves history stored. */
    pruned: string[];
}

/** The observation seams. None is owned by the manager and none holds keys; there is no
 * `RfqTransport` on purpose (see the module doc). */
export interface RfqSwapManagerDeps {
    /** Arkade access: how every swap's resolution is determined. */
    indexer: LockupSpendIndexer;
    /** L1 access. Required to monitor onchain-send swaps. */
    chain?: ChainSource;
    /**
     * The CANONICAL sink for RFQ swap records, read back by
     * {@link RfqSwapManager.restoreFromRepository}. A first write needs the request-time
     * `origin` ({@link RfqSwapManager.addSwap}).
     */
    repository?: RfqSwapRecordStore;
    /**
     * The wallet's contract manager (prefer `await wallet.getContractManager()`). Required:
     * the lockup's VTXO state is read through `getContractsWithVtxos`, so claim and refund
     * cannot work without it.
     */
    contracts: SwapContractRegistry;
}

/** A listener that throws must not derail the state machine mid-swap. */
const notify = <T extends (...args: never[]) => void>(
    listeners: Iterable<T>,
    call: (listener: T) => void,
): void => {
    for (const listener of listeners) {
        try {
            call(listener);
        } catch {
            // a consumer's callback is not this manager's correctness
        }
    }
};

// ── The manager ──────────────────────────────────────────────────────────────

/**
 * Watches a set of live RFQ swaps and drives each to its end.
 *
 * One pass per swap every {@link RfqSwapManagerConfig.pollIntervalMs}, and early when a
 * contract event names its lockup (which changes only WHEN a pass runs; see
 * {@link subscribe}):
 *
 * 0. **Register the lockup** if needed. Best-effort; never blocks the steps below.
 * 1. **Ask the chain what became of the lockup** ({@link readLockupFate}). A spend whose
 *    witness HASHES to `payment_hash` ends the swap `settled`; fully spent otherwise ends
 *    it `refunded`. `unknown` is NOT an answer: the pass continues, since deadlines ignore
 *    indexer outages. `exited` blocks the Arkade half but leaves the L1 half running.
 * 2. **Drive the trader's claim**: the L1 fill on an onchain send
 *    ({@link nextOnchainAction}); the lockup itself on a receive, which ends the pass.
 * 3. **Take the lockup back** (send legs, after `refundLocktime`), even after a
 *    successful L1 claim: the lockup is still the trader's if the solver never takes it.
 *    If no local refund is possible, report `needs_counterparty` instead of retrying.
 *
 * On a receive leg step 1's readings invert: `settled` is the trader's own claim,
 * `refunded` the solver reclaiming an unclaimed lockup. And on the receive arm:
 *
 * - **A claim is matched by its preimage, never by our txid**, so a claim that lands
 *   without us (e.g. covclaimd) is still `settled`.
 * - **`LockupFate.fate === "claimed"` maps to state `settled`, never `claimed`**: the
 *   state `claimed` only means we submitted something.
 *
 * @deprecated Use `createSwapClient`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export class RfqSwapManager {
    private static readonly POLL_CONCURRENCY = 16;
    private readonly deps: RfqSwapManagerDeps;
    private readonly config: Required<Omit<RfqSwapManagerConfig, "events">>;
    private callbacks: AvailableRfqSwapManagerCallbacks | null = null;

    private readonly swapUpdateListeners = new Set<SwapUpdateListener>();
    private readonly swapCompletedListeners = new Set<SwapCompletedListener>();
    private readonly swapFailedListeners = new Set<SwapFailedListener>();
    private readonly actionExecutedListeners = new Set<ActionExecutedListener>();

    private readonly monitored = new Map<string, RfqSwap>();
    /** Monitored swaps by lockup script hex: a contract event names only a script. */
    private readonly byLockupScript = new Map<string, RfqSwap>();
    /**
     * Swaps whose lockup registration has SETTLED, mapped to whether a contract row
     * resulted. Membership stops per-pass round trips; the value stops a never-registered
     * swap from retiring a nonexistent row and reporting a spurious failure.
     */
    private readonly registered = new Map<string, boolean>();
    /**
     * Swaps whose `refundArkade` threw {@link RefundNotLocallyPossibleError} in this
     * process, so the push is not re-issued every pass. Only
     * {@link RfqSwapManagerCallbacks.canRefundArkade} clears it.
     */
    private readonly refundRefused = new Set<string>();
    /**
     * Lockup outpoints already handed to a receive swap's claim callback, by rfqId. After a
     * claim SUCCEEDS the indexer may still list its outputs as unspent; without this each
     * pass would re-submit and report a working swap as failing. Process-local: a restart
     * costs at most one rejected re-claim.
     */
    private readonly claimedOutpoints = new Map<string, Set<string>>();
    /** Live `onContractEvent` subscription, held so `stop()` can drop it. */
    private unsubscribeContracts: (() => void) | null = null;
    /** Recent terminal swaps; older durable outcomes are read from the record store on demand. */
    private readonly finished = new Map<string, RfqSwap>();
    /** Explicit removals stay suppressed for this manager lifetime; normal completions never enter this set.
     * Each maps to its removal sequence, so restore can tell a removal made during its rebuild. */
    private readonly removed = new Map<string, number>();
    private removalSeq = 0;
    private readonly waiters = new Map<
        string,
        Set<{ resolve: (v: RfqSwapOutcome) => void; reject: (e: Error) => void }>
    >();
    /**
     * The request-time origin of each swap, by rfqId, needed to CREATE a record. Kept for
     * the swap's whole life so a record the store loses is rewritten; dropped by
     * {@link removeSwap} and by retention.
     */
    private readonly origins = new Map<string, RfqSwapOrigin>();
    /** Records changed during the current pass, flushed to the repository and
     * through `saveSwap`. */
    private readonly dirty = new Set<string>();
    /** Race guard: one action at a time per swap. */
    private readonly inProgress = new Set<string>();
    private activePolls = 0;
    private readonly pollWaiters = new Set<() => void>();

    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;

    constructor(deps: RfqSwapManagerDeps, config: RfqSwapManagerConfig = {}) {
        this.deps = deps;
        this.config = {
            enableAutoActions: config.enableAutoActions ?? true,
            pollIntervalMs: config.pollIntervalMs ?? 5_000,
            now: config.now ?? (() => Math.floor(Date.now() / 1000)),
        };
        if (config.events?.onSwapUpdate) this.swapUpdateListeners.add(config.events.onSwapUpdate);
        if (config.events?.onSwapCompleted) {
            this.swapCompletedListeners.add(config.events.onSwapCompleted);
        }
        if (config.events?.onSwapFailed) this.swapFailedListeners.add(config.events.onSwapFailed);
        if (config.events?.onActionExecuted) {
            this.actionExecutedListeners.add(config.events.onActionExecuted);
        }
    }

    /** Wire the money-moving half. Without it the manager only watches. See
     * {@link AvailableRfqSwapManagerCallbacks}. */
    setCallbacks(callbacks: AvailableRfqSwapManagerCallbacks): void {
        this.callbacks = callbacks;
    }

    onSwapUpdate(listener: SwapUpdateListener): () => void {
        this.swapUpdateListeners.add(listener);
        return () => this.swapUpdateListeners.delete(listener);
    }

    onSwapCompleted(listener: SwapCompletedListener): () => void {
        this.swapCompletedListeners.add(listener);
        return () => this.swapCompletedListeners.delete(listener);
    }

    onSwapFailed(listener: SwapFailedListener): () => void {
        this.swapFailedListeners.add(listener);
        return () => this.swapFailedListeners.delete(listener);
    }

    onActionExecuted(listener: ActionExecutedListener): () => void {
        this.actionExecutedListeners.add(listener);
        return () => this.actionExecutedListeners.delete(listener);
    }

    /**
     * Rebuild stored swaps and take over monitoring them. By default only active states
     * are read; terminal history stays stored and a late completion lookup reads one record
     * by key (`includeTerminal` loads everything). Deliberately not part of {@link start},
     * so records can be inspected without driving money. An unrebuildable record lands in
     * {@link RfqRestoreResult.failed}, never fatal to the others.
     */
    async restoreFromRepository(options: RfqRestoreOptions = {}): Promise<RfqRestoreResult> {
        const repository = this.requireRepository("restoreFromRepository");
        const params = options.params ?? this.paramsFromContracts();

        const restored: RfqSwap[] = [];
        const failed: RfqRestoreFailure[] = [];
        const restore = async (record: RfqSwapRecord) => {
            if (!options.includeTerminal && isRfqSwapTerminal(record.state)) return;
            // The live object is at least as fresh as storage: a poll can move it
            // into a later page, or an overlapping restore track it mid-rebuild.
            if (this.monitored.has(record.rfqId)) return;
            const removedAt = this.removed.get(record.rfqId);
            let swap: RfqSwap;
            try {
                swap = rebuildRfqSwap(record, await params(record));
            } catch (error) {
                failed.push({
                    rfqId: record.rfqId,
                    error: error instanceof Error ? error : new Error(errorMessage(error)),
                });
                return;
            }
            if (this.monitored.has(record.rfqId)) return;
            if (this.removed.get(record.rfqId) !== removedAt) return;
            this.removed.delete(record.rfqId);
            if (isRfqSwapTerminal(swap.state)) this.rememberFinished(swap, true);
            else {
                this.origins.set(record.rfqId, rfqSwapOriginOf(record));
                this.track(swap);
            }
            restored.push(swap);
        };

        const states = options.includeTerminal ? [undefined] : RFQ_SWAP_ACTIVE_STATES;
        for (const state of states) {
            for (const record of await collectRfqSwaps(repository, { state }))
                await restore(record);
        }

        if (this.running) {
            await this.pollMany(restored.filter((swap) => this.monitored.has(swap.rfqId)));
        }
        return { restored, failed, pruned: [] };
    }

    /**
     * Drop stored records that are terminal and past `RFQ_SWAP_RETENTION_SECONDS` (per
     * `shouldRetainRfqSwap`), and return their ids. Explicit only: restore keeps history.
     * Loads every stored record; no backend offers indexed deletion.
     */
    async pruneRetiredSwaps(): Promise<string[]> {
        const repository = this.deps.repository;
        if (!repository) return [];
        return this.dropRetired(repository, await collectRfqSwaps(repository));
    }

    private async dropRetired(
        repository: RfqSwapRecordStore,
        records: readonly RfqSwapRecord[],
    ): Promise<string[]> {
        const now = this.config.now();
        const dropped: string[] = [];
        for (const record of records) {
            if (shouldRetainRfqSwap(record, now)) continue;
            await repository.removeRfqSwap(record.rfqId);
            this.forgetRetired(record.rfqId);
            dropped.push(record.rfqId);
        }
        return dropped;
    }

    private forgetRetired(rfqId: string): void {
        // A retained in-memory answer cannot outlive its record.
        this.finished.delete(rfqId);
        // A monitored swap may still need its origin to rewrite a failed secondary save.
        if (!this.monitored.has(rfqId)) this.origins.delete(rfqId);
    }

    private requireRepository(method: string): RfqSwapRecordStore {
        const repository = this.deps.repository;
        if (!repository) {
            throw new Error(
                `${method} needs a record store; pass one as RfqSwapManagerDeps.repository`,
            );
        }
        return repository;
    }

    /** The default covenant source: the wallet's own contract row for each lockup. */
    private paramsFromContracts(): (record: RfqSwapRecord) => Promise<LockupParams> {
        const contracts = this.deps.contracts;
        if (!contracts) {
            throw new Error(
                "restoreFromRepository needs the covenant parameters: wire " +
                    "RfqSwapManagerDeps.contracts so each lockup's contract row can be read, or " +
                    "pass options.params",
            );
        }
        return (record) => lockupContractParams(contracts, record.lockupAddress);
    }

    /**
     * Load records and begin monitoring: one pass immediately (a restart may already be
     * past a deadline), then every `pollIntervalMs`. Terminal outcomes in a repository are
     * read on demand. Calling it again while running loads the records without re-arming,
     * so a double-start never strands a funded swap.
     *
     * With a repository wired, a swap the store has never seen throws
     * {@link RfqSwapOriginRequired} (use {@link addSwap} with its origin, or
     * {@link restoreFromRepository}). Every swap is checked before any is tracked.
     */
    async start(swaps: readonly RfqSwap[] = []): Promise<void> {
        for (const swap of swaps) await this.admit(swap);
        for (const swap of swaps) {
            this.removed.delete(swap.rfqId);
            if (isRfqSwapTerminal(swap.state)) {
                this.rememberFinished(swap);
                this.origins.delete(swap.rfqId);
            } else this.track(swap);
        }
        if (this.running) return;
        this.running = true;
        this.subscribe();
        await this.poll();
        this.arm();
    }

    /**
     * Stop monitoring: clear the timer and drop the contract subscription. In-flight
     * actions run to completion and {@link waitForSwapCompletion} promises stay pending
     * (stop/start is a pause). Contract registrations are NOT undone: they are the
     * wallet's, and dropping them would unwatch a still-funded lockup.
     */
    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.unsubscribeContracts?.();
        this.unsubscribeContracts = null;
    }

    /**
     * Begin monitoring a swap; polled immediately when the manager is running.
     *
     * @param origin - The request-time half a live swap cannot carry, needed to write its
     *   FIRST record. Required with a repository wired unless the store already holds the
     *   record (else {@link RfqSwapOriginRequired}). Inert without a repository.
     */
    async addSwap(swap: RfqSwap, origin?: RfqSwapOrigin): Promise<void> {
        await this.admit(swap, origin);
        this.removed.delete(swap.rfqId);
        if (isRfqSwapTerminal(swap.state)) {
            this.rememberFinished(swap);
            this.origins.delete(swap.rfqId);
            return;
        }
        this.track(swap);
        if (this.running) await this.pollSwap(swap);
    }

    /**
     * Settle where this swap's record will come from, before it is monitored: a passed
     * origin, one remembered from an earlier `addSwap`, or the stored record (one read).
     */
    private async admit(swap: RfqSwap, origin?: RfqSwapOrigin): Promise<void> {
        if (origin) {
            // At the door, not the first write: by then funding is broadcast, and the
            // deterministic throw would recur every poll.
            assertSameSwap(origin, swap);
            this.origins.set(swap.rfqId, origin);
            // Write on the first pass even if unchanged: otherwise a funded lockup has no
            // record for as long as it sits `pending`.
            if (this.deps.repository && !isRfqSwapTerminal(swap.state)) {
                this.dirty.add(swap.rfqId);
            }
            return;
        }
        const repository = this.deps.repository;
        if (!repository || this.origins.has(swap.rfqId)) return;
        // A throwing read is a storage failure, not a miss: propagate rather than admit.
        const stored = await repository.getRfqSwap(swap.rfqId);
        if (!stored) throw new RfqSwapOriginRequired(swap.rfqId);
        this.origins.set(swap.rfqId, rfqSwapOriginOf(stored));
    }

    /** Forget a swap entirely, monitored or finished. Its contract row is left alone: the
     * script may still hold money, and only a terminal swap's row is retired. */
    async removeSwap(rfqId: string): Promise<void> {
        this.removed.set(rfqId, ++this.removalSeq);
        this.untrack(rfqId);
        this.finished.delete(rfqId);
        this.registered.delete(rfqId);
        // Reject, unlike `stop()`: this is a cancellation, and the waiters would hang forever.
        const waiting = this.waiters.get(rfqId);
        if (waiting) {
            const error = new Error(`swap ${rfqId} was removed from monitoring`);
            for (const waiter of waiting) waiter.reject(error);
        }
        this.waiters.delete(rfqId);
        this.dirty.delete(rfqId);
        this.origins.delete(rfqId);
    }

    /** Every swap still being monitored. */
    async getPendingSwaps(): Promise<RfqSwap[]> {
        return [...this.monitored.values()];
    }

    /**
     * Every swap this manager holds: {@link getPendingSwaps} plus the finished ones this
     * process has seen (after {@link restoreFromRepository}, the retained history).
     */
    async getAllSwaps(): Promise<RfqSwap[]> {
        return [...this.monitored.values(), ...this.finished.values()];
    }

    async hasSwap(rfqId: string): Promise<boolean> {
        return this.monitored.has(rfqId);
    }

    /** True while an action for this swap holds the per-swap lock. */
    async isProcessing(rfqId: string): Promise<boolean> {
        return this.inProgress.has(rfqId);
    }

    /** `finishedSwaps` counts terminal swaps cached in memory, not those only in the repository. */
    async getStats(): Promise<{
        isRunning: boolean;
        monitoredSwaps: number;
        finishedSwaps: number;
        inProgress: number;
        pollIntervalMs: number;
    }> {
        return {
            isRunning: this.running,
            monitoredSwaps: this.monitored.size,
            finishedSwaps: this.finished.size,
            inProgress: this.inProgress.size,
            pollIntervalMs: this.config.pollIntervalMs,
        };
    }

    /**
     * Run one monitoring pass over every swap now, e.g. when a mobile app resumes. Passes
     * do not overlap per swap: a concurrent call is a no-op for a swap already in progress.
     */
    async poll(): Promise<void> {
        await this.pollMany([...this.monitored.values()]);
    }

    private async pollMany(swaps: readonly RfqSwap[]): Promise<void> {
        for (let i = 0; i < swaps.length; i += RfqSwapManager.POLL_CONCURRENCY) {
            await Promise.allSettled(
                swaps
                    .slice(i, i + RfqSwapManager.POLL_CONCURRENCY)
                    .map((swap) => this.pollSwap(swap)),
            );
        }
    }

    private async acquirePollSlot(): Promise<() => void> {
        if (this.activePolls < RfqSwapManager.POLL_CONCURRENCY) {
            this.activePolls++;
        } else {
            await new Promise<void>((resolve) => this.pollWaiters.add(resolve));
        }
        return () => {
            const next = this.pollWaiters.values().next().value;
            if (next) {
                this.pollWaiters.delete(next);
                next();
            } else {
                this.activePolls--;
            }
        };
    }

    /**
     * Resolve once this swap's PAYOUT is decided: for onchain-send that is the L1 claim
     * (`claimTxid` set), whatever the record's later label; otherwise `settled`/`refunded`
     * (see {@link isPayoutDecided}).
     *
     * Rejects only on `failed`. `refunded` resolves, and on a receive leg it means the swap
     * was lost — read `state`, do not infer success from resolution.
     */
    async waitForSwapCompletion(rfqId: string): Promise<RfqSwapOutcome> {
        const swap = this.monitored.get(rfqId) ?? this.finished.get(rfqId);
        if (!swap && !this.removed.has(rfqId) && this.deps.repository) {
            const record = await this.deps.repository.getRfqSwap(rfqId);
            if (record && !this.removed.has(rfqId) && isRfqSwapTerminal(record.state)) {
                if (record.state === "failed") {
                    throw new Error(record.failure ?? `swap ${rfqId} failed`);
                }
                return outcomeOfRecord(record);
            }
        }
        if (!swap) throw new Error(`swap ${rfqId} is not monitored`);
        if (swap.state === "failed") throw new Error(swap.failure ?? `swap ${rfqId} failed`);
        if (isPayoutDecided(swap)) return outcomeOf(swap);

        return new Promise<RfqSwapOutcome>((resolve, reject) => {
            const set = this.waiters.get(rfqId) ?? new Set();
            set.add({ resolve, reject });
            this.waiters.set(rfqId, set);
        });
    }

    // ── internals ────────────────────────────────────────────────────────────

    private track(swap: RfqSwap): void {
        this.monitored.set(swap.rfqId, swap);
        this.byLockupScript.set(hex.encode(swap.lockupPkScript), swap);
    }

    /** Drops the swap from BOTH indexes. `pollSwap`'s `monitored` check also stops a late
     * event, deliberately redundant so neither change alone re-drives a removed swap. */
    private untrack(rfqId: string): void {
        const swap = this.monitored.get(rfqId);
        if (swap) this.byLockupScript.delete(hex.encode(swap.lockupPkScript));
        this.monitored.delete(rfqId);
        this.refundRefused.delete(rfqId);
        this.claimedOutpoints.delete(rfqId);
    }

    /**
     * Turn the indexer's push into an extra reason to run a pass — and nothing more.
     *
     * **Deliberately not a source of truth.** The pass re-reads the lockup via
     * {@link readLockupFate}, so a missed, duplicated, reordered or FORGED event only
     * changes latency, never beliefs, and never causes a claim or refund on its own. This
     * must survive future changes: a BELIEVED event turns a relay outage into a correctness
     * bug. The timer stays armed as the failsafe; every money deadline is an absolute
     * timelock.
     */
    private subscribe(): void {
        if (!this.deps.contracts || this.unsubscribeContracts) return;
        this.unsubscribeContracts = this.deps.contracts.onContractEvent((event: ContractEvent) => {
            if (event.type === "connection_reset") {
                // Events may have been missed while the stream was down.
                void this.poll().catch(() => {});
                return;
            }
            if (!isContractVtxoEvent(event)) return;
            const swap = this.byLockupScript.get(event.contractScript);
            // Not one of ours — a wallet's other contracts share this stream.
            if (!swap) return;
            void this.pollSwap(swap).catch(() => {});
        });
    }

    /**
     * Register this swap's lockup with the wallet's contract manager, once. A backstop:
     * the request entrypoints register before funding, and `createContract` is
     * first-writer-wins.
     *
     * Best-effort: a failure is reported and retried next pass, never aborting this one.
     * Failing the pass over bookkeeping would trade a real timelock deadline for it.
     */
    private async ensureRegistered(swap: RfqSwap): Promise<void> {
        const contracts = this.deps.contracts;
        if (!contracts) return;
        if (this.registered.has(swap.rfqId)) return;

        const lockup = swap.lockup;
        if (!lockup) {
            // No covenant to build a row from, but the request path may have written one:
            // ask before complaining. A truly absent row cannot be fixed by retrying.
            try {
                const [existing] = await contracts.getContracts({
                    script: hex.encode(swap.lockupPkScript),
                });
                if (existing) {
                    this.registered.set(swap.rfqId, true);
                    return;
                }
            } catch (error) {
                // Unreadable store: decide nothing, look again next pass.
                this.emitFailed(swap, error);
                return;
            }
            this.registered.set(swap.rfqId, false);
            this.emitFailed(
                swap,
                new Error(
                    `swap ${swap.rfqId} carries no lockup script and has no contract row, so it cannot be registered — pass \`lockup\` to subscribe instead of polling`,
                ),
            );
            return;
        }

        const script = hex.encode(lockup.script.pkScript);
        if (script !== hex.encode(swap.lockupPkScript)) {
            // Registering anything but the FUNDED script would leave the real lockup
            // unwatched while reporting success. Not retryable.
            this.registered.set(swap.rfqId, false);
            this.emitFailed(
                swap,
                new Error(
                    `swap ${swap.rfqId} lockup script ${script} does not match its lockupPkScript ${hex.encode(swap.lockupPkScript)}`,
                ),
            );
            return;
        }

        try {
            await registerLockupContract(contracts, lockup.script, lockup.address);
            this.registered.set(swap.rfqId, true);
        } catch (error) {
            // Left out of `registered` so a transient failure is retried next pass.
            this.emitFailed(swap, error);
        }
    }

    /** Stop watching a finished swap's lockup. `retained`, not deleted: the row keeps the
     * lockup's history readable while leaving the subscription and poll. Best-effort. */
    private retireContract(swap: RfqSwap): void {
        // Only a confirmed row: retiring a nonexistent one would report a spurious failure.
        if (!this.deps.contracts || !this.registered.get(swap.rfqId)) return;
        // Terminal is not spent: `failed` can leave the lockup funded.
        if (!LOCKUP_RETIRABLE.includes(swap.state)) return;
        void this.deps.contracts
            .setContractWatchState(hex.encode(swap.lockupPkScript), "retained")
            .catch((error: unknown) => this.emitFailed(swap, error));
    }

    private arm(): void {
        if (!this.running) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.poll().then(() => this.arm());
        }, this.config.pollIntervalMs);
    }

    /*
     * One serialized monitoring pass for a single swap. The per-swap lock is released only
     * after all async work, so overlapping polls cannot submit duplicate claims or refunds.
     *
     * Safety property: terminal state is not finalized until its record is persisted to
     * every configured sink. A failed save leaves the swap dirty and monitored for retry.
     */
    private async pollSwap(swap: RfqSwap): Promise<void> {
        if (this.inProgress.has(swap.rfqId)) return;
        if (!this.monitored.has(swap.rfqId)) return;
        // Before the slot wait: overlapping sweeps must skip queued swaps too.
        this.inProgress.add(swap.rfqId);
        const release = await this.acquirePollSlot();
        try {
            if (this.monitored.has(swap.rfqId)) await this.runPass(swap);
        } finally {
            // Waiters settle AFTER the write, and only if every sink took it: otherwise a
            // caller sees a completion its storage never recorded, and a restart replays
            // action callbacks for it.
            try {
                const persisted = this.dirty.has(swap.rfqId) ? await this.save(swap) : true;
                if (persisted) {
                    this.dirty.delete(swap.rfqId);
                    this.settleWaiters(swap);
                    if (isRfqSwapTerminal(swap.state)) this.finalize(swap);
                }
            } finally {
                // Release after every write and callback, even when a save fails.
                this.inProgress.delete(swap.rfqId);
                release();
            }
        }
    }

    /*
     * One state-machine pass (steps as in the class doc). Persistence, waiters,
     * finalization and the per-swap lock belong to `pollSwap`.
     */
    private async runPass(swap: RfqSwap): Promise<void> {
        // 0. Register the lockup (no-op after the first pass).
        await this.ensureRegistered(swap);

        // 1. Ask the chain. Anything but a hash-verified claim or fully observed spend is
        //    "nothing learned" and must not end the swap.
        let fate: LockupFate;
        try {
            fate = await readLockupFate(this.deps.indexer, {
                swapPkScript: swap.lockupPkScript,
                paymentHash: swap.paymentHash,
            });
        } catch {
            // Transient by assumption; the remaining steps are gated on absolute timelocks.
            fate = { fate: "unknown" };
        }
        if (fate.fate === "claimed" || fate.fate === "returned") {
            // Before `setState`, so its single write already names the ending transaction.
            this.stampLockupSpends(swap, fate.spends);
            if (fate.fate === "claimed") this.stampSettlementPreimage(swap, fate.preimage);
            this.setState(swap, fate.fate === "claimed" ? "settled" : "refunded");
            return;
        }

        // 2. The trader's claim. The receive leg ends the pass here: step 3 would push a
        //    refund on the solver's leaf, failing forever against a key we do not hold.
        if (swap.kind === "lightning_receive") {
            if (fate.fate === "exited") return this.blockExitedLockup(swap, fate);
            if (fate.fate === "open") return this.driveReceiveClaim(swap);
            if (this.config.now() >= swap.refundLocktime) return this.driveReceiveClaim(swap);
            return;
        }

        //    The L1 half, skipped once claimed.
        if (swap.kind === "onchain_send" && swap.state !== "claimed") {
            if ((await this.driveOnchain(swap)) === "handled") return;
        }

        // 3. The Arkade lockup. An exit is checked here, not at step 1: it says nothing about
        //    the L1 fill, which keeps being driven.
        if (fate.fate === "exited") {
            // Before the window, a live L1 claim keeps its label (the half still actionable).
            const claiming = swap.state === "claimable" || swap.state === "claimed";
            if (this.config.now() < swap.refundLocktime && claiming) return;
            return this.blockExitedLockup(swap, fate);
        }
        await this.driveArkadeRefund(swap);
    }

    /**
     * The lockup was unilaterally exited: its outputs sit onchain, beyond any offchain
     * spend. `needs_counterparty`, not terminal: it can still end either way onchain. Set
     * here, not in `driveArkadeRefund`, whose `unblock` calls would lift it next pass.
     */
    private blockExitedLockup(swap: RfqSwap, fate: Extract<LockupFate, { fate: "exited" }>): void {
        this.block(
            swap,
            `the lockup was unilaterally exited (${fate.outpoints.length} output(s) onchain), ` +
                "so no offchain spend can move it — complete the unroll and spend it onchain",
        );
    }

    /**
     * The receive leg's whole state machine: claim the solver-funded lockup while the
     * window is open, and recognise the shapes in which it can be lost.
     *
     * **The window closes at `refundLocktime`, on wall clock, with no margin.** Publishing
     * `P` into the solver's live refund window risks losing the race. No margin (unlike
     * `ONCHAIN_CLAIM_MARGIN_SECONDS`, which budgets for confirmations): this offchain claim
     * lands in seconds, and the solver's CLTV matures on MTP, which trails wall clock.
     *
     * After the window the trader has no move; the manager only watches.
     */
    private async driveReceiveClaim(swap: LightningReceiveSwap): Promise<void> {
        const now = this.config.now();

        if (now < swap.refundLocktime) {
            let vtxos: readonly LockupVtxo[];
            try {
                vtxos = await findLockupVtxos(this.deps.contracts, swap.lockupPkScript);
            } catch (error) {
                // Reported, unlike step 1: this read is the entire pass, so swallowing it
                // would leave the swap silently idle until its window shut.
                this.emitFailed(swap, error);
                return;
            }
            return this.claimIfFunded(swap, vtxos);
        }

        // Past the window: keep watching so step 1 can end the swap on chain evidence (the
        // solver's MTP-based reclaim lands within the lag).
        if (now < swap.refundLocktime + REFUND_MTP_LAG_SECONDS) {
            // A submitted claim keeps its `claimed` label.
            if (swap.claimTxid) return;
            return this.block(
                swap,
                "the claim window closed with the lockup unclaimed — only the solver can act now",
            );
        }

        // Nothing further to observe: ending here gives up telling "reclaimed" from "never
        // funded".
        const failure = swap.claimFailure;
        if (failure && !swap.claimTxid) {
            // We had a claimable lockup and could not take it: `failed`, so a broken claim
            // callback does not read as a swap that simply did not happen.
            return this.fail(swap, new Error(failure));
        }
        this.setState(swap, "refunded");
    }

    /** Claim what the solver funded, once it is enough (the inner gate that matters is
     * `pushClaim`'s; see {@link RfqSwapManagerCallbacks.claimLockup}). */
    private async claimIfFunded(
        swap: LightningReceiveSwap,
        vtxos: readonly LockupVtxo[],
    ): Promise<void> {
        if (vtxos.length === 0) return this.unblock(swap);

        // `P` is already public, so the value gate has nothing left to protect.
        const partiallyClaimed = swap.claimTxid !== undefined;
        if (partiallyClaimed && !this.hasUnclaimedOutpoint(swap.rfqId, vtxos)) {
            // Indexer lag; re-submitting would fail and report a working swap as broken.
            return;
        }

        if (!partiallyClaimed) {
            if (!Number.isFinite(swap.expectedAmount)) {
                // See LightningReceiveSwap.expectedAmount. Re-checked each pass.
                return this.block(
                    swap,
                    `expectedAmount is not a finite number (${String(swap.expectedAmount)}), so the funded value cannot be checked — refusing to publish the preimage`,
                );
            }
            // Swept outputs count: they are agreed money at the script. `pushClaim` refuses
            // spending them offchain by name, which here would look like dust funding.
            const locked = vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);
            if (!Number.isFinite(locked) || locked < swap.expectedAmount) {
                // Not terminal: a top-up before the window shuts makes it claimable.
                return this.block(
                    swap,
                    `lockup holds ${locked} sats, below the agreed ${swap.expectedAmount} — refusing to publish the preimage`,
                );
            }
        }

        if (!this.callbacks || !this.callbacks.claimLockup) {
            // Before the label: `claimable` would name an action nobody here can take.
            // Lifted once `setCallbacks` supplies it.
            return this.block(
                swap,
                this.callbacks
                    ? RFQ_CONFIGURATION_REFUSAL.noClaimLockupCallback
                    : RFQ_CONFIGURATION_REFUSAL.noCallbacksForClaim,
            );
        }

        this.setState(swap, "claimable");
        if (!this.config.enableAutoActions) return;

        try {
            const { txid } = await this.callbacks.claimLockup(swap, vtxos, { partiallyClaimed });
            delete swap.claimFailure;
            // Only on success: a claim that threw is retried with these outputs.
            this.rememberClaimed(swap.rfqId, vtxos);
            swap.claimTxid = txid;
            // Independently of `setState`, so the txid is persisted even if the label ever
            // stops moving on a re-claim: `P` is public and the txid must be recorded.
            this.touch(swap);
            this.setState(swap, "claimed");
            this.emitAction(swap, "claimLockup");
        } catch (error) {
            // Lost the race to another holder of P (covclaimd): step 1 of the next pass reads that claim and settles.
            const ark = isArkError(error) ? error : maybeArkError(error);
            if (isArkError(ark, ArkErrorName.VTXO_ALREADY_SPENT)) {
                if (swap.claimFailure !== undefined) {
                    delete swap.claimFailure;
                    this.touch(swap);
                }
                return;
            }
            // Retried next pass; recorded so a window that shuts without success ends
            // `failed` with a reason, not a quiet expiry.
            swap.claimFailure = errorMessage(error);
            this.touch(swap);
            this.emitFailed(swap, error);
        }
    }

    /** `handled` ends the pass; `continue` falls through to the refund gate. */
    private async driveOnchain(swap: OnchainSendSwap): Promise<"handled" | "continue"> {
        if (!this.deps.chain) {
            // Blind, the claim window would pass in silence. A wiring mistake, so fail on the
            // first pass while there is still time to configure a chain and re-add the swap.
            this.fail(
                swap,
                new Error(
                    "onchain-send swap monitored without a ChainSource — the L1 fill cannot be seen or claimed",
                ),
            );
            return "handled";
        }

        let phase: OnchainHtlcPhase;
        try {
            phase = await classifyOnchainHtlc(this.deps.chain, {
                htlc: swap.htlc,
                minConfirmations: swap.minConfirmations,
                funding: swap.funding,
            });
        } catch {
            // Fall THROUGH: the refund gate depends on `refundLocktime` alone, so an
            // unreachable esplora must not strand the lockup.
            return "continue";
        }

        // Without the outpoint a SPENT htlc reads back as never funded.
        if ("utxo" in phase && !swap.funding) {
            swap.funding = { txid: phase.utxo.txid, vout: phase.utxo.vout };
            this.touch(swap);
        }

        const action = nextOnchainAction({
            phase,
            htlcLocktime: swap.htlc.refundLocktime,
            now: this.config.now(),
        });

        if (action === "claim" && phase.phase === "claimable") {
            // The txid, not the label, says the claim was made (a blocked swap keeps the
            // txid); re-broadcasting would publish P twice.
            if (swap.claimTxid) return "continue";
            // Before the label: the claim publishes `P`, which is not recallable.
            if (!Number.isSafeInteger(swap.expectedAmount) || swap.expectedAmount <= 0) {
                this.block(
                    swap,
                    `expectedAmount is not a positive number of sats (${String(swap.expectedAmount)}), so the funded value cannot be checked — refusing to publish the preimage`,
                );
                return "handled";
            }
            const filled = Number(phase.utxo.amount);
            if (!Number.isFinite(filled) || filled < swap.expectedAmount) {
                this.block(
                    swap,
                    `fill holds ${filled} sats, below the agreed ${swap.expectedAmount} — refusing to publish the preimage`,
                );
                return "handled";
            }
            // Half-wired: blocked, not failed (unlike a missing `ChainSource`), because a
            // callback can still arrive via `setCallbacks`. Fully unwired keeps reporting
            // `claimable`, the documented manual mode.
            if (this.callbacks && !this.callbacks.claimOnchain) {
                this.block(swap, RFQ_CONFIGURATION_REFUSAL.noClaimOnchainCallback);
                return "handled";
            }
            this.setOnchainState(swap, "claimable");
            if (!this.config.enableAutoActions || !this.callbacks?.claimOnchain) return "handled";
            try {
                const { txid } = await this.callbacks.claimOnchain(swap, phase.utxo);
                swap.claimTxid = txid;
                this.setOnchainState(swap, "claimed");
                this.emitAction(swap, "claimOnchain");
            } catch (error) {
                // Retried next pass; a failed build or broadcast published nothing.
                this.emitFailed(swap, error);
            }
            return "handled";
        }

        if (action === "claimed" && phase.phase === "claimed") {
            // Only the trader holds P, so this claim is ours, perhaps from a previous process.
            if (!swap.claimTxid) {
                swap.claimTxid = phase.txid;
                this.touch(swap);
            }
            this.setOnchainState(swap, "claimed");
        }

        // Everything else falls through to the refund gate, "still waiting" included: an
        // unfunded HTLC at `refundLocktime` means the solver never came.
        return "continue";
    }

    private async driveArkadeRefund(swap: RfqSwap): Promise<void> {
        const now = this.config.now();

        // Every pass: reports "nobody can refund" while the solver can still act, and lifts
        // it once the signing wallet is restored.
        const refusal = await this.probeRefusal(swap);
        if (refusal) {
            // Before the window a live L1 claim keeps its label; after it the refusal wins
            // (see setOnchainState).
            const claiming = swap.state === "claimable" || swap.state === "claimed";
            if (now < swap.refundLocktime && claiming) return;
            return this.block(swap, refusal);
        }
        // Only an answering probe can retract a push-reported refusal.
        if (this.refundRefused.has(swap.rfqId)) {
            if (!this.callbacks?.canRefundArkade) return;
            this.refundRefused.delete(swap.rfqId);
        }

        if (now < swap.refundLocktime) return this.unblock(swap);

        if (!this.config.enableAutoActions || !this.callbacks) {
            // Otherwise it would sit `pending` past its window forever, never reported.
            return this.block(
                swap,
                this.callbacks
                    ? RFQ_CONFIGURATION_REFUSAL.autoActionsDisabled
                    : RFQ_CONFIGURATION_REFUSAL.noCallbacksForRefund,
            );
        }
        this.unblock(swap);

        try {
            const pushed = await this.callbacks.refundArkade(swap);
            if (pushed) {
                swap.refundTxid = pushed.txid;
                this.touch(swap);
            } else if (now < swap.refundLocktime + REFUND_MTP_LAG_SECONDS) {
                // `null` (nothing to return) is not proof the money came home: ending now could
                // record a late settlement as a refund. Wait for step 1 to see the spend.
                return;
            }
            // Past the deadline a settlement that only appears later is recorded as a
            // refund; that is the cost of ending the wait at all.
            this.setState(swap, "refunded");
            this.emitAction(swap, "refundArkade");
        } catch (error) {
            if (error instanceof RefundNotLocallyPossibleError) {
                // A missing capability, not a failure: one call, not a retry storm ending in
                // a `failed` that claims an action failed.
                this.refundRefused.add(swap.rfqId);
                return this.block(swap, error.message);
            }
            // UNWRAPPED, so `instanceof` works: `LockupNeedsRecoveryError` names the
            // outpoints to recover, and after recovery the next pass succeeds.
            this.emitFailed(swap, error);
            // MTP trails wall clock ~1h, so early refusals are expected; this is the deadline.
            if (now >= swap.refundLocktime + REFUND_MTP_LAG_SECONDS) {
                swap.failure = errorMessage(error);
                this.setState(swap, "failed");
            }
        }
    }

    /** Whether any output was never handed to the claim callback (the only reason to
     * claim twice). */
    private hasUnclaimedOutpoint(rfqId: string, vtxos: readonly LockupVtxo[]): boolean {
        const claimed = this.claimedOutpoints.get(rfqId);
        if (!claimed) return true;
        return vtxos.some((vtxo) => !claimed.has(outpointKey(vtxo)));
    }

    private rememberClaimed(rfqId: string, vtxos: readonly LockupVtxo[]): void {
        const claimed = this.claimedOutpoints.get(rfqId) ?? new Set<string>();
        for (const vtxo of vtxos) claimed.add(outpointKey(vtxo));
        this.claimedOutpoints.set(rfqId, claimed);
    }

    /**
     * L1 progress, which past the refund window must not overwrite a refusal: `claimed` is
     * re-asserted from chain every pass, so a blocked swap would flip forever. Only the
     * label defers; the claim itself always runs.
     */
    private setOnchainState(swap: OnchainSendSwap, state: RfqSwapState): void {
        if (swap.state === "needs_counterparty" && this.config.now() >= swap.refundLocktime) return;
        this.setState(swap, state);
    }

    /** The probe's refusal reason, or `undefined`. A throwing probe is a refusal. */
    private async probeRefusal(swap: RfqSwap): Promise<string | undefined> {
        const probe = this.callbacks?.canRefundArkade;
        if (!probe) return undefined;
        try {
            const answer = await probe(swap);
            return answer.ok ? undefined : answer.reason;
        } catch (error) {
            return errorMessage(error);
        }
    }

    /** Report that no local refund will happen, without ending the swap. */
    private block(swap: RfqSwap, reason: string): void {
        if (swap.blockedReason !== reason) {
            swap.blockedReason = reason;
            this.touch(swap);
        }
        this.setState(swap, "needs_counterparty");
    }

    /** The way back out once actionable: to `claimed` if a claim txid exists, else
     * `pending`. */
    private unblock(swap: RfqSwap): void {
        if (swap.state !== "needs_counterparty") return;
        this.setState(swap, traderClaimTxid(swap) ? "claimed" : "pending");
    }

    /**
     * Record which ark transactions ended the lockup. Only named ark txids: a checkpoint
     * txid would name a transaction the wallet's activity never shows. Assigned, not
     * merged: the fate is one complete read, reached once.
     */
    private stampLockupSpends(swap: RfqSwap, spends: readonly LockupSpend[]): void {
        const txids = spends
            .map((spend) => spend.txid)
            .filter((txid): txid is string => txid !== undefined);
        if (txids.length === 0) return;
        swap.lockupSpendTxids = txids;
        this.touch(swap);
    }

    /**
     * Keep the preimage that settled a Lightning send. Only that leg: the others' preimages
     * are the wallet's own secrets, already recoverable from `profile`.
     */
    private stampSettlementPreimage(swap: RfqSwap, preimage: Uint8Array): void {
        if (swap.kind !== "lightning_send") return;
        swap.settlementPreimageHex = hex.encode(preimage);
        this.touch(swap);
    }

    private touch(swap: RfqSwap): void {
        swap.updatedAt = this.config.now();
        this.dirty.add(swap.rfqId);
    }

    private setState(swap: RfqSwap, state: RfqSwapState): void {
        if (swap.state === state) return;
        const previous = swap.state;
        // Every exit clears the reason (e.g. via `settled`), or it reads as a live refusal.
        if (previous === "needs_counterparty") delete swap.blockedReason;
        if (isRfqSwapTerminal(state)) delete swap.claimFailure;
        swap.state = state;
        this.touch(swap);
        notify(this.swapUpdateListeners, (listener) => listener(swap, previous));
    }

    /** Terminal failure. The `onSwapFailed` emission is left to
     * {@link finalize}, so this does not double-report. */
    private fail(swap: RfqSwap, error: Error): void {
        swap.failure = error.message;
        this.setState(swap, "failed");
    }

    private emitFailed(swap: RfqSwap, error: unknown): void {
        const wrapped = error instanceof Error ? error : new Error(errorMessage(error));
        notify(this.swapFailedListeners, (listener) => listener(swap, wrapped));
    }

    private emitAction(swap: RfqSwap, action: RfqSwapActionName): void {
        notify(this.actionExecutedListeners, (listener) => listener(swap, action));
    }

    /**
     * Flush a changed record to every wired sink; true only if all took it (else it stays
     * dirty and unfinalized). The canonical repository write goes FIRST and a failure skips
     * `saveSwap`, so the secondary sink never gets ahead of the primary.
     */
    private async save(swap: RfqSwap): Promise<boolean> {
        if (!(await this.saveRecord(swap))) return false;
        if (!this.callbacks?.saveSwap) return true;
        try {
            await this.callbacks.saveSwap(swap);
            return true;
        } catch (error) {
            // Reported, never passed off as success; `pollSwap` retries the dirty record.
            this.emitFailed(swap, error);
            return false;
        }
    }

    /** The canonical write. True when there is no repository to write to. */
    private async saveRecord(swap: RfqSwap): Promise<boolean> {
        const repository = this.deps.repository;
        if (!repository) return true;
        try {
            // Read-then-write, not cached: see RfqSwapRecordStore.
            const stored = await repository.getRfqSwap(swap.rfqId);
            const record = stored
                ? updateRfqSwapRecord(stored, swap)
                : createRfqSwapRecord(this.originOrThrow(swap), swap);
            await repository.saveRfqSwap(record);
            return true;
        } catch (error) {
            this.emitFailed(swap, error);
            return false;
        }
    }

    private originOrThrow(swap: RfqSwap): RfqSwapOrigin {
        const origin = this.origins.get(swap.rfqId);
        // Reachable only if the store dropped the record after admission.
        if (!origin) throw new RfqSwapOriginRequired(swap.rfqId);
        return origin;
    }

    /** Drop a terminal swap from monitoring and report it exactly once, through either
     * `onSwapCompleted` or `onSwapFailed`. */
    private finalize(swap: RfqSwap): void {
        if (!this.monitored.has(swap.rfqId)) return;
        this.untrack(swap.rfqId);
        this.rememberFinished(swap, true);
        this.retireContract(swap);
        this.registered.delete(swap.rfqId);
        this.origins.delete(swap.rfqId);
        if (swap.state === "failed") {
            notify(this.swapFailedListeners, (listener) =>
                listener(swap, new Error(swap.failure ?? `swap ${swap.rfqId} failed`)),
            );
            return;
        }
        notify(this.swapCompletedListeners, (listener) => listener(swap));
    }

    private rememberFinished(swap: RfqSwap, durable = false): void {
        if (durable && this.deps.repository) this.finished.delete(swap.rfqId);
        else this.finished.set(swap.rfqId, swap);
    }

    private settleWaiters(swap: RfqSwap): void {
        const waiting = this.waiters.get(swap.rfqId);
        if (!waiting) return;
        if (swap.state === "failed") {
            const error = new Error(swap.failure ?? `swap ${swap.rfqId} failed`);
            for (const waiter of waiting) waiter.reject(error);
        } else if (isPayoutDecided(swap)) {
            const outcome = outcomeOf(swap);
            for (const waiter of waiting) waiter.resolve(outcome);
        } else {
            return;
        }
        this.waiters.delete(swap.rfqId);
    }
}

/** What {@link RfqSwapManager.waitForSwapCompletion} reports. `txid` is the trader's own
 * claim or pushed refund, and always names something that landed; solver-side outcomes
 * and a lost receive carry none. Read `state` for whether the swap paid out.
 *
 * @deprecated Use `createSwapClient` and `client.onUpdate()`. Moved off the package root to `@arkade-os/swap/protocol`.
 */
export interface RfqSwapOutcome {
    state: RfqSwapState;
    txid?: string;
}

/** The trader's own claim on this swap, whichever leg it belongs to. */
const traderClaimTxid = (swap: RfqSwap): string | undefined =>
    swap.kind === "onchain_send" || swap.kind === "lightning_receive" ? swap.claimTxid : undefined;

// Keyed on the txid, not the label, which may read `needs_counterparty` after a real L1
// payout. A receive's claim txid deliberately does NOT decide it: an Arkade submission can
// still go `claimed -> refunded`, so it waits for `settled`.
const isPayoutDecided = (swap: RfqSwap): boolean =>
    swap.state === "settled" ||
    swap.state === "refunded" ||
    (swap.kind === "onchain_send" && swap.claimTxid !== undefined);

const outcomeOf = (swap: RfqSwap): RfqSwapOutcome => {
    // A lost receive's `claimTxid` names a submission the chain never took; omitted here,
    // kept on the record for diagnosis.
    const lostReceive = swap.kind === "lightning_receive" && swap.state === "refunded";
    return {
        state: swap.state,
        txid: lostReceive ? swap.refundTxid : (traderClaimTxid(swap) ?? swap.refundTxid),
    };
};

const outcomeOfRecord = (stored: RfqSwapRecord): RfqSwapOutcome => {
    const record = normalizeRfqSwapRecord(stored);
    const profileClaim =
        record.kind === "onchain_send" || record.kind === "lightning_receive"
            ? record.profile.claimTxid
            : undefined;
    const claimTxid = typeof profileClaim === "string" ? profileClaim : undefined;
    return {
        state: record.state,
        txid:
            record.kind === "lightning_receive" && record.state === "refunded"
                ? record.refundTxid
                : (claimTxid ?? record.refundTxid),
    };
};

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const outpointKey = (vtxo: LockupVtxo): string => `${vtxo.txid}:${vtxo.vout}`;
