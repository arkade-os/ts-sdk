/**
 * Driving a set of funded RFQ swaps to their end, so a caller does not have to
 * know which function to call when.
 *
 * The corridor is complete as building blocks: `requestLightningSend` /
 * `requestOnchainSend` quote and gate funding, `awaitOnchainFill` /
 * `claimOnchainFill` take the L1 fill, `refundIfUnresolved` /
 * `pushRefundWithoutReceiver` take the lockup back. What is missing is the
 * thing that calls them at the right moment for more than one swap at a time,
 * remembers where each one got to, and tells the caller when something
 * happened. That is this module.
 *
 * The shape is deliberately the one `packages/boltz-swap`'s `SwapManager`
 * arrived at — monitor a set, act automatically through injected callbacks,
 * persist through an injected `saveSwap`, expose events plus a promise-based
 * escape hatch. Three things are different, each for a reason:
 *
 * - **The solver is never asked.** This manager holds no `RfqTransport` at
 *   all: every fact it acts on is read from chain. What became of the
 *   Arkade lockup comes from {@link readLockupFate}, and the L1 half from
 *   {@link classifyOnchainHtlc}. That is strictly better than polling
 *   `status()` on two counts. It removes a liveness dependency — a solver that
 *   stops answering must not be able to degrade the trader's view of its own
 *   swap, and the deadlines that matter here are consensus timelocks the
 *   solver's uptime has no bearing on. And it removes a trust inversion: the
 *   solver's `settled`/`refunded` is self-reported, while the chain fact
 *   underneath it cannot be forged. The lockup's claim leaf can only be spent
 *   by revealing `P`, so a spend witness that HASHES to the quote's
 *   `payment_hash` is proof of settlement, and every other spend is a refund
 *   the trader's own address or own signature is on. `refund.ts` already made
 *   half of this argument — see `RFQ_RESOLVED_STATES`, which lets "the
 *   on-chain VTXO lookup be the authority on whether anything is actually
 *   there"; this finishes the thought for the outcome as well as the balance.
 *
 * - **The onchain corridor's claim is on a consensus deadline, not on the
 *   solver's word.** See {@link nextOnchainAction}: a naive "poll status,
 *   refund on timeout" loop is actively wrong for `arkade:BTC->onchain:BTC`.
 *
 * - **No manager-level retry backoff.** The one long-running action here,
 *   the `refundWithoutReceiver` push, is atomic — one transaction spending
 *   every lockup output into one aggregate output — so there is no partial
 *   success to re-arm, unlike Boltz's per-VTXO `skipped`/`retryAt` outcome.
 *   Retrying it is genuinely needed (median-time-past lags wall clock, so the
 *   first pushes after `refundLocktime` are EXPECTED to be refused), but the
 *   poll interval is already that retry cadence and
 *   {@link REFUND_MTP_LAG_SECONDS} is already that deadline. A second backoff
 *   on top would only fight the first.
 *
 * **The manager owns WHEN, the caller owns HOW.** It holds the observation
 * seams (a {@link LockupSpendIndexer} for the Arkade side, and `ChainSource`
 * for L1) and reads them itself, because it cannot decide correctly without
 * them; the actions that move money are {@link RfqSwapManagerCallbacks}, so no
 * key material ever reaches this class — the same split `onchainHtlc.ts` makes
 * with its `sign` callback.
 *
 * **Push where it helps, poll because it must.** Given a
 * {@link RfqSwapManagerDeps.contracts}, each lockup is registered as a contract
 * and the indexer PUSHES its funding and its spend, which is how a settlement
 * gets noticed the moment it happens instead of up to a poll interval later.
 * That stream is a latency optimization and never a source of truth: an event
 * only causes the ordinary pass to run early, and that pass re-reads the lockup
 * itself. See {@link RfqSwapManager.subscribe} for why that distinction is the
 * whole safety argument, and why {@link RfqSwapManager.poll} stays armed as the
 * failsafe rather than being replaced.
 */
import { hex } from "@scure/base";
import {
    VHTLCV2ContractHandler,
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
    readLockupFate,
    type LockupFate,
    type LockupSpendIndexer,
} from "./refund";

// ── Records ──────────────────────────────────────────────────────────────────

/**
 * Where a monitored swap stands.
 *
 * `claimable` and `claimed` are onchain-send only — the lightning leg has no
 * trader-side claim, the solver claims the lockup itself.
 */
export type RfqSwapState =
    /** Funded; nothing actionable yet. */
    | "pending"
    /** onchain-send: the L1 fill is confirmed and the claim window is open. */
    | "claimable"
    /** onchain-send: our L1 claim is broadcast — the trader has the coins. */
    | "claimed"
    /** Terminal: the lockup was spent by a hash-verified claim — the
     * counterparty completed its side. Read off chain, never reported. */
    | "settled"
    /** Terminal: the lockup came back, by the solver's hand or the trader's. */
    | "refunded"
    /** Terminal: an action failed and its window closed. */
    | "failed";

/** The states after which the manager stops monitoring a swap. */
export const RFQ_SWAP_TERMINAL_STATES = ["settled", "refunded", "failed"] as const;

export const isRfqSwapTerminal = (state: RfqSwapState): boolean =>
    (RFQ_SWAP_TERMINAL_STATES as readonly string[]).includes(state);

/**
 * What the manager needs to register a swap's lockup with the wallet, so the
 * indexer pushes its funding and its spend instead of being asked every few
 * seconds.
 *
 * Both fields are things the caller already holds. `script` is the very object
 * `pushRefundWithoutReceiver` takes, so a caller wired for refunds has it in
 * hand; `address` is `requestLightningSend` / `requestOnchainSend`'s own return
 * value. The address is taken rather than re-derived on purpose — the row's
 * address must be the one the trader actually funded, and a local re-derivation
 * would silently use the SDK's default network, which is the exact bug
 * `registerOfferContract` guards against.
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
    /** The Arkade lockup's scriptPubKey — `swapPkScript` from
     * `requestLightningSend` / `requestOnchainSend`. This is what the manager
     * watches to decide the swap: it is the only handle on the covenant whose
     * spend witness says whether the swap settled or came back. */
    lockupPkScript: Uint8Array;
    /** The covenant behind {@link lockupPkScript}, when the caller wants the
     * lockup registered with a contract manager. Optional: without it the
     * manager still watches the swap on its timer, it just cannot subscribe.
     * See {@link RfqSwapManagerDeps.contracts}. */
    lockup?: RfqSwapLockup;
    /** `sha256(P)`, hex — the quote's `payment_hash`. The claim leaf can only
     * be spent by revealing a value that hashes to this, which is what makes a
     * settlement provable rather than reported. For an onchain send this is
     * the SAME hash the L1 `htlc` carries: one `P` unlocks both legs. */
    paymentHash: string;
    /** `refund_locktime` from the quote, unix seconds. Gates the Arkade refund. */
    refundLocktime: number;
    createdAt: number;
    updatedAt: number;
    /** Set once the trader's own `refundWithoutReceiver` push landed. */
    refundArkTxid?: string;
    /** Why `state` is `failed`. */
    failure?: string;
}

/** `arkade:BTC->lightning:BTC`. Nothing for the trader to claim: the solver
 * claims the lockup with the preimage it learns by paying the invoice — which
 * is exactly why that spend's witness is proof the payment landed. */
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
    /** The fill's outpoint, learned on first sighting. Without it a SPENT
     * HTLC reads as never funded — see {@link classifyOnchainHtlc}. */
    funding?: { txid: string; vout: number };
    /** Our L1 claim's txid. */
    claimTxid?: string;
}

/**
 * A monitored swap.
 *
 * This is a live record, not a serialization format: `lockupPkScript` and
 * `htlc` hold derived `Uint8Array`s, and
 * {@link RfqSwapManagerCallbacks.saveSwap} is where a caller projects it into
 * whatever it stores. Rebuild it on restart the way it was made —
 * `lightningSendVtxoScript` / `onchainHtlcScript` over the quote's binding
 * fields — and hand the result to {@link RfqSwapManager.start}.
 */
export type RfqSwap = LightningSendSwap | OnchainSendSwap;

// ── The onchain state machine ───────────────────────────────────────────────

/** What the manager should do next about an onchain-send swap's L1 half. */
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
 * {@link OnchainHtlcPhase} runs `unfunded -> awaiting_confirmations ->
 * claimable -> (refundable | claimed | swept)`, and `refundable` does NOT mean
 * "time to refund the L1 HTLC" — the trader has no key on that leaf; it is the
 * SOLVER's refund, and reaching it means the trader's claim was missed. So the
 * L1 claim has to be driven before it, and from it the only remaining move is
 * the Arkade-side refund.
 *
 * There is a second, quieter trap between those two functions:
 * `classifyOnchainHtlc` reports `claimable` right up until median-time-past
 * reaches `refundLocktime`, while `claimOnchainFill` refuses from
 * {@link ONCHAIN_CLAIM_MARGIN_SECONDS} before it — because broadcasting
 * publishes P, and doing that into the counterparty's live refund window risks
 * losing the race AND giving away the preimage. Driving straight off the phase
 * would therefore spend that whole margin throwing `claim_window_closed` at
 * every poll and never fall back. This function applies the margin, so
 * "claimable" here means claimable by `claimOnchainFill` too.
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
 * the lockup held nothing to return. */
export type ArkadeRefundResult = { arkTxid: string; amount: number } | null;

/**
 * The money-moving half, injected. The manager decides when; these do it.
 *
 * Neither action gets a retry loop of its own here — see the module doc. Do
 * NOT wire `refundArkade` to `refundIfUnresolved`: that function is the
 * single-swap version of this whole class and brings its own status polling
 * and its own MTP retry loop, which would nest inside the manager's. Wire it
 * to `findLockupVtxos` + `pushRefundWithoutReceiver`, which is the atomic push
 * `refundIfUnresolved` itself calls.
 */
export interface RfqSwapManagerCallbacks {
    /** Build and broadcast the L1 claim. See `claimOnchainFill`. */
    claimOnchain: (swap: OnchainSendSwap, utxo: ChainUtxo) => Promise<{ txid: string }>;
    /** Push `refundWithoutReceiver` for every output at the lockup. See
     * `pushRefundWithoutReceiver`; return `null` for an empty lockup. */
    refundArkade: (swap: RfqSwap) => Promise<ArkadeRefundResult>;
    /** Persist the record. Called after any pass that changed it. */
    saveSwap: (swap: RfqSwap) => Promise<void>;
}

/** The actions the manager executes on a caller's behalf. */
export type RfqSwapActionName = "claimOnchain" | "refundArkade";

export interface RfqSwapManagerEvents {
    onSwapUpdate?: (swap: RfqSwap, previous: RfqSwapState) => void;
    /** Fired once, when a swap leaves monitoring `settled` or `refunded`.
     * A swap that ends `failed` reports through `onSwapFailed` instead — the
     * two are mutually exclusive. */
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

export interface RfqSwapManagerConfig {
    /** Drive claims and refunds automatically (default: true). With this off
     * the manager still watches and reports, so a caller can act by hand off
     * `claimable`. */
    enableAutoActions?: boolean;
    /** How often to run a pass, ms. Default 5000 — the same interval
     * `awaitOnchainFill` and `refundIfUnresolved` poll at. */
    pollIntervalMs?: number;
    /** Injected for tests; defaults to wall clock, in unix seconds — the same
     * convention `refundIfUnresolved` uses. */
    now?: () => number;
    events?: RfqSwapManagerEvents;
}

/** The contract-manager surface this needs, narrowed for injection — the same
 * seam style as {@link LockupSpendIndexer} and `refund.ts`'s
 * {@link RefundArkProvider}, and satisfied structurally by a real
 * `ContractManager` (`await wallet.getContractManager()`). */
export type SwapContractRegistry = Pick<
    IContractManager,
    "createContract" | "onContractEvent" | "setContractWatchState"
>;

/** The contract type a swap lockup registers under. `@arkade-os/sdk`'s handler
 * for `VHTLC.ScriptV2` — the covenant script this corridor builds. */
export const SWAP_LOCKUP_CONTRACT_TYPE = "vhtlc-v2";

export const SWAP_LOCKUP_CONTRACT_LABEL = "Arkade RFQ swap lockup";
export const SWAP_LOCKUP_CONTRACT_KIND = "rfq-swap-lockup";

/** The observation seams. None is owned by the manager, and none holds keys —
 * same philosophy as `onchainHtlc.ts`'s `ChainSource`. There is no
 * `RfqTransport` here on purpose: nothing this manager decides depends on the
 * solver answering (see the module doc). */
export interface RfqSwapManagerDeps {
    /** Arkade access. Required: this is how a swap's resolution is determined,
     * for both legs. */
    indexer: LockupSpendIndexer;
    /** L1 access. Required to monitor onchain-send swaps; a lightning-only
     * caller can leave it out. */
    chain?: ChainSource;
    /**
     * The wallet's contract manager, when there is one. Optional in the same
     * way {@link chain} is: a caller with no wallet, or one that only wants the
     * timer, still gets a fully working manager — the subscription is a
     * LATENCY optimization and nothing depends on it.
     *
     * Supplying it buys two things. The lockup gets REGISTERED, which is what
     * puts it in the wallet's own contract set at all — a prerequisite for
     * anything that has to act on the lockup before its batch expires, since an
     * expired lockup is swept and loses every cooperative path. And the indexer
     * PUSHES its funding and its spend, so a settlement is noticed when it
     * happens rather than up to `pollIntervalMs` later.
     *
     * Prefer `await wallet.getContractManager()` over constructing one, the way
     * `createOffer` does.
     */
    contracts?: SwapContractRegistry;
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
 * Watches a set of funded RFQ swaps and drives each to its end.
 *
 * One pass per swap, in this order, every
 * {@link RfqSwapManagerConfig.pollIntervalMs} — and additionally the moment a
 * contract event names that swap's lockup, which changes only WHEN a pass runs,
 * never what it concludes (see {@link subscribe}):
 *
 * 0. **Register the lockup**, if a contract manager was supplied and it is not
 *    registered yet. Best-effort; never blocks the steps below.
 * 1. **Ask the chain what became of the lockup** — {@link readLockupFate}. A
 *    spend whose witness HASHES to the quote's `payment_hash` ends the swap
 *    `settled`; a lockup fully spent by anything else ends it `refunded`,
 *    because every other leaf pays the trader's own committed address or needs
 *    the trader's own signature. Anything the indexer could not answer is
 *    `unknown`, which is NOT an answer: the pass carries on to steps 2 and 3,
 *    whose deadlines an indexer outage has no bearing on.
 * 2. **Drive the L1 half**, onchain-send only — see {@link nextOnchainAction}.
 * 3. **Take the lockup back**, once `refundLocktime` has passed and step 1 has
 *    not ended the swap. This runs for onchain-send too, including after a
 *    successful claim: the trader's lockup is still funded and still theirs to
 *    recover if the solver never comes for it.
 */
export class RfqSwapManager {
    private readonly deps: RfqSwapManagerDeps;
    private readonly config: Required<Omit<RfqSwapManagerConfig, "events">>;
    private callbacks: RfqSwapManagerCallbacks | null = null;

    private readonly swapUpdateListeners = new Set<SwapUpdateListener>();
    private readonly swapCompletedListeners = new Set<SwapCompletedListener>();
    private readonly swapFailedListeners = new Set<SwapFailedListener>();
    private readonly actionExecutedListeners = new Set<ActionExecutedListener>();

    private readonly monitored = new Map<string, RfqSwap>();
    /** Monitored swaps by lockup script hex, so a contract event — which names
     * a script and nothing else — can find the swap it belongs to. */
    private readonly byLockupScript = new Map<string, RfqSwap>();
    /**
     * Swaps whose lockup registration has been SETTLED one way or another,
     * mapped to whether a contract row actually resulted. Membership is what
     * stops a per-pass retry from becoming a per-pass round trip; the value is
     * what keeps a swap that could never be registered from later trying to
     * retire a row that does not exist, which would report a spurious failure
     * on a swap that in fact succeeded.
     */
    private readonly registered = new Map<string, boolean>();
    /** Live `onContractEvent` subscription, held so `stop()` can drop it. */
    private unsubscribeContracts: (() => void) | null = null;
    /** Terminal records, kept so a late {@link waitForSwapCompletion} still
     * answers instead of throwing "not found". Cleared by {@link removeSwap}. */
    private readonly finished = new Map<string, RfqSwap>();
    private readonly waiters = new Map<
        string,
        Set<{ resolve: (v: RfqSwapOutcome) => void; reject: (e: Error) => void }>
    >();
    /** Records changed during the current pass, flushed through `saveSwap`. */
    private readonly dirty = new Set<string>();
    /** Race guard: one action at a time per swap. */
    private readonly inProgress = new Set<string>();

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

    /** Wire the money-moving half. Without it the manager only watches. */
    setCallbacks(callbacks: RfqSwapManagerCallbacks): void {
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
     * Load records and begin monitoring. Runs one pass immediately — a caller
     * resuming after a restart may be well past a deadline already — then
     * every `pollIntervalMs`. Records that are already terminal are kept only
     * so {@link waitForSwapCompletion} can answer for them.
     *
     * Calling it again while running loads the records and returns rather than
     * re-arming — dropping them silently would strand a funded swap on a
     * caller's harmless double-start.
     */
    async start(swaps: readonly RfqSwap[] = []): Promise<void> {
        for (const swap of swaps) {
            if (isRfqSwapTerminal(swap.state)) this.finished.set(swap.rfqId, swap);
            else this.track(swap);
        }
        if (this.running) return;
        this.running = true;
        this.subscribe();
        await this.poll();
        this.arm();
    }

    /**
     * Stop monitoring and clear the timer. In-flight actions are not
     * cancellable and run to completion; outstanding
     * {@link waitForSwapCompletion} promises are left pending, since
     * stop/start is a pause rather than a cancellation.
     *
     * The contract subscription is dropped too — an open stream with nothing
     * reacting to it is a leak, and {@link start} puts it back. What is NOT
     * undone is the contract registration: those rows are the wallet's, they
     * outlive this manager's lifecycle, and dropping them would unwatch a
     * lockup that is still funded.
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

    /** Begin monitoring a swap. Polled immediately when the manager is running,
     * so a just-funded swap does not wait out a whole interval. */
    async addSwap(swap: RfqSwap): Promise<void> {
        if (isRfqSwapTerminal(swap.state)) {
            this.finished.set(swap.rfqId, swap);
            return;
        }
        this.track(swap);
        if (this.running) await this.pollSwap(swap);
    }

    /** Forget a swap entirely, monitored or finished.
     *
     * Its contract row is left alone: registration is a wallet-level fact about
     * a script that may still hold money, and this call says only that THIS
     * manager stops driving the swap. Retiring the row is reserved for a swap
     * that reached a terminal state, where the lockup is provably done. */
    async removeSwap(rfqId: string): Promise<void> {
        this.untrack(rfqId);
        this.finished.delete(rfqId);
        this.registered.delete(rfqId);
        // Reject the waiters rather than dropping them: nothing will ever
        // settle this swap once it stops being monitored, so a pending
        // `waitForSwapCompletion` would hang for the life of the process.
        // Deliberately NOT the `stop()` behaviour, which leaves waiters
        // pending because stop/start is a pause — this is a cancellation.
        const waiting = this.waiters.get(rfqId);
        if (waiting) {
            const error = new Error(`swap ${rfqId} was removed from monitoring`);
            for (const waiter of waiting) waiter.reject(error);
        }
        this.waiters.delete(rfqId);
        this.dirty.delete(rfqId);
    }

    /** Every swap still being monitored. */
    async getPendingSwaps(): Promise<RfqSwap[]> {
        return [...this.monitored.values()];
    }

    async hasSwap(rfqId: string): Promise<boolean> {
        return this.monitored.has(rfqId);
    }

    /** True while an action for this swap holds the per-swap lock. */
    async isProcessing(rfqId: string): Promise<boolean> {
        return this.inProgress.has(rfqId);
    }

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
     * Run one monitoring pass over every swap now.
     *
     * {@link start} calls this on an interval, but it is public on purpose: a
     * caller that sleeps its process (a mobile app resuming, a service worker
     * waking) wants a pass on that event rather than at the next tick. Passes
     * do not overlap per swap — the in-progress lock makes a concurrent call a
     * no-op for any swap already being worked on.
     */
    async poll(): Promise<void> {
        await Promise.allSettled([...this.monitored.values()].map((swap) => this.pollSwap(swap)));
    }

    /**
     * Resolve once this swap's PAYOUT is decided — which for onchain-send is
     * the L1 claim, not the end of the record's life: at `claimed` the trader
     * has the coins it swapped for, and what remains is the manager watching
     * the Arkade lockup close. Lightning-send has no such split and resolves at
     * `settled`/`refunded`.
     *
     * Rejects only on `failed`. `refunded` resolves: a refund is an outcome the
     * caller asked this manager to drive, not an exception.
     */
    async waitForSwapCompletion(rfqId: string): Promise<RfqSwapOutcome> {
        const swap = this.monitored.get(rfqId) ?? this.finished.get(rfqId);
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

    /** Drops the swap from BOTH indexes. The event index is the one that stops
     * a late event finding a swap that is gone; `pollSwap`'s own
     * `monitored` check would also catch it, and deliberately still does —
     * either alone is sufficient, which is what keeps a future change to one of
     * them from silently re-driving a cancelled swap. */
    private untrack(rfqId: string): void {
        const swap = this.monitored.get(rfqId);
        if (swap) this.byLockupScript.delete(hex.encode(swap.lockupPkScript));
        this.monitored.delete(rfqId);
    }

    /**
     * Turn the indexer's push into an extra reason to run a pass — and nothing
     * more.
     *
     * **This is deliberately not a source of truth.** An event names a script;
     * the reaction is to run the ordinary pass for the swap at that script, and
     * that pass re-reads the lockup through {@link readLockupFate} exactly as
     * the timer's pass does. So an event that is missed, duplicated, reordered
     * or outright FORGED can only cost or save latency — it can never change
     * what this manager believes about a swap, and it can never on its own
     * cause a claim or a refund. That property is what makes it safe to bolt a
     * best-effort stream onto a money path, and it must survive any future
     * change here: the moment an event is BELIEVED rather than merely acted on,
     * a relay outage becomes a correctness problem instead of a latency one.
     *
     * The timer stays armed regardless, and is the failsafe. Every deadline
     * that moves money — `refundLocktime`, the L1 claim window — is an absolute
     * timelock that passes whether or not a single event ever arrives.
     */
    private subscribe(): void {
        if (!this.deps.contracts || this.unsubscribeContracts) return;
        this.unsubscribeContracts = this.deps.contracts.onContractEvent((event: ContractEvent) => {
            if (event.type === "connection_reset") {
                // The stream dropped, so events may have been missed while it
                // was down. One pass over everything costs less than waiting
                // out the interval on a view that could be stale.
                void this.poll().catch(() => {});
                return;
            }
            const swap = this.byLockupScript.get(event.contractScript);
            // Not one of ours — a wallet's other contracts share this stream.
            if (!swap) return;
            void this.pollSwap(swap).catch(() => {});
        });
    }

    /**
     * Register this swap's lockup with the wallet's contract manager, once.
     *
     * Best-effort by design: a failure here is reported and retried on the next
     * pass, and never aborts the pass it is part of. Registration buys latency
     * and puts the lockup in the wallet's contract set; it decides nothing. The
     * money path below it reads the indexer directly and is gated on timelocks
     * that a missing contract row has no bearing on, so failing the pass over
     * this would trade a real deadline for a bookkeeping one.
     */
    private async ensureRegistered(swap: RfqSwap): Promise<void> {
        if (!this.deps.contracts) return;
        if (this.registered.has(swap.rfqId)) return;

        const lockup = swap.lockup;
        if (!lockup) {
            // A caller that wired a contract manager but no covenant asked for
            // something that cannot be delivered. Said once — marking it
            // settled — rather than every pass, because no retry can fix a
            // missing field.
            this.registered.set(swap.rfqId, false);
            this.emitFailed(
                swap,
                new Error(
                    `swap ${swap.rfqId} carries no lockup script, so it cannot be registered as a contract — pass \`lockup\` to subscribe instead of polling`,
                ),
            );
            return;
        }

        const script = hex.encode(lockup.script.pkScript);
        if (script !== hex.encode(swap.lockupPkScript)) {
            // Contract rows are keyed by script, so registering anything but
            // the script that was FUNDED would leave the real lockup unwatched
            // while reporting success — the same failure `registerOfferContract`
            // refuses. Not retryable: the record disagrees with itself.
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
            await this.deps.contracts.createContract({
                type: SWAP_LOCKUP_CONTRACT_TYPE,
                params: VHTLCV2ContractHandler.serializeParams(lockup.script.options),
                script,
                address: lockup.address,
                label: SWAP_LOCKUP_CONTRACT_LABEL,
                metadata: { genericallySpendable: false, kind: SWAP_LOCKUP_CONTRACT_KIND },
            });
            this.registered.set(swap.rfqId, true);
        } catch (error) {
            // Left out of `registered` so the next pass tries again — a
            // transient repository or indexer failure must not cost the swap
            // its subscription for good.
            this.emitFailed(swap, error);
        }
    }

    /** Stop watching a finished swap's lockup. Retained, not deleted: the row
     * is what keeps the lockup's own VTXOs annotatable and its history
     * readable, while `retained` is what drops it from the subscription and
     * the poll — a settled swap that stayed watched would cost the wallet a
     * script for its whole life. Best-effort — the swap is over either way. */
    private retireContract(swap: RfqSwap): void {
        // Only a swap that actually got a row: retiring one that was never
        // written would throw "not found" and report a failure on a swap that
        // had in fact just succeeded.
        if (!this.deps.contracts || !this.registered.get(swap.rfqId)) return;
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

    private async pollSwap(swap: RfqSwap): Promise<void> {
        if (this.inProgress.has(swap.rfqId)) return;
        if (!this.monitored.has(swap.rfqId)) return;
        this.inProgress.add(swap.rfqId);
        try {
            await this.runPass(swap);
        } finally {
            // Waiters settle AFTER the write, not from `setState`: a caller
            // that awaits completion and then reads its own storage must not
            // find the record still saying `pending`.
            //
            // And nothing observable happens unless that write SUCCEEDED. A
            // rejected `saveSwap` used to settle waiters and finalize anyway,
            // so a caller saw a swap complete that its own storage had never
            // recorded — and on restart the manager re-drove the stale record,
            // replaying action callbacks for a swap the caller already treated
            // as done. Leaving it dirty and monitored makes the next pass
            // retry the write instead.
            const persisted = this.dirty.has(swap.rfqId) ? await this.save(swap) : true;
            if (persisted) {
                this.dirty.delete(swap.rfqId);
                this.settleWaiters(swap);
                if (isRfqSwapTerminal(swap.state)) this.finalize(swap);
            }
            // Released LAST, after every await above. Dropped before the
            // `save` yield, it let a direct `poll()` — the timer path is
            // serialised by `arm()`, explicit calls are not — clear the
            // in-progress guard and re-enter `runPass` for this same swap,
            // firing `claimOnchain`/`refundArkade` a second time before
            // `finalize` had taken it out of `monitored`.
            this.inProgress.delete(swap.rfqId);
        }
    }

    private async runPass(swap: RfqSwap): Promise<void> {
        // 0. Make sure the lockup is registered and pushing events. A no-op
        //    after the first pass, and never a reason to skip the rest — see
        //    `ensureRegistered`.
        await this.ensureRegistered(swap);

        // 1. Ask the chain. Only a hash-verified claim is a settlement, and
        //    only a fully observed spend is a refund; everything else is
        //    "nothing learned" and must not end the swap.
        let fate: LockupFate;
        try {
            fate = await readLockupFate(this.deps.indexer, {
                swapPkScript: swap.lockupPkScript,
                paymentHash: swap.paymentHash,
            });
        } catch {
            // Transient by assumption: nothing is lost by asking again next
            // pass, and both remaining steps are gated on absolute timelocks
            // that do not care whether the indexer is up.
            fate = { fate: "unknown" };
        }
        if (fate.fate === "claimed" || fate.fate === "returned") {
            this.setState(swap, fate.fate === "claimed" ? "settled" : "refunded");
            return;
        }

        // 2. The L1 half. Skipped once claimed — there is nothing further to
        //    learn from chain, and the record already carries the txid.
        if (swap.kind === "onchain_send" && swap.state !== "claimed") {
            if ((await this.driveOnchain(swap)) === "handled") return;
        }

        // 3. The Arkade lockup.
        await this.driveArkadeRefund(swap);
    }

    /** `handled` ends the pass; `continue` falls through to the refund gate. */
    private async driveOnchain(swap: OnchainSendSwap): Promise<"handled" | "continue"> {
        if (!this.deps.chain) {
            // Watching an onchain-send swap blind would let the claim window
            // pass in silence, which is the one failure this corridor cannot
            // afford. This is a wiring mistake rather than an outage, so fail
            // it on the first pass — long before any deadline — while there is
            // still time to configure a chain and re-add the swap.
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
            // Transient, same reasoning as the status read — but fall THROUGH
            // rather than ending the pass. The refund gate below depends on
            // `refundLocktime` alone, and `assertFundable`'s timelock order
            // puts that a clear margin after the L1 window shuts, so an
            // unreachable esplora must not be able to strand the lockup.
            return "continue";
        }

        // Remember the outpoint: without it a SPENT htlc reads back as never
        // funded, and a restart would sit waiting for a fill that already came
        // and went.
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
            this.setState(swap, "claimable");
            if (!this.config.enableAutoActions || !this.callbacks) return "handled";
            try {
                const { txid } = await this.callbacks.claimOnchain(swap, phase.utxo);
                swap.claimTxid = txid;
                this.setState(swap, "claimed");
                this.emitAction(swap, "claimOnchain");
            } catch (error) {
                // The window is still open, so the next pass tries again; no
                // separate backoff. A build or broadcast that failed published
                // nothing, so nothing was given away either.
                this.emitFailed(swap, error);
            }
            return "handled";
        }

        if (action === "claimed" && phase.phase === "claimed") {
            // Read back off chain — only the trader holds P, so a claim spend
            // here is ours, whether this process made it or a previous one did
            // before dying.
            if (!swap.claimTxid) {
                swap.claimTxid = phase.txid;
                this.touch(swap);
            }
            this.setState(swap, "claimed");
        }

        // Everything else — still waiting for the fill, the window closed
        // unclaimed, the solver swept it, or the claim we just recovered —
        // falls through to the refund gate. Never claim past the window:
        // `claimOnchainFill` refuses by design, because broadcasting into the
        // counterparty's live refund window can lose the race with P already
        // published. And "still waiting" must fall through too: an unfunded
        // HTLC at `refundLocktime` means the solver never came, which is
        // exactly when the lockup has to come back.
        return "continue";
    }

    private async driveArkadeRefund(swap: RfqSwap): Promise<void> {
        const now = this.config.now();
        if (now < swap.refundLocktime) return;
        if (!this.config.enableAutoActions || !this.callbacks) return;

        try {
            const pushed = await this.callbacks.refundArkade(swap);
            if (pushed) {
                swap.refundArkTxid = pushed.arkTxid;
                this.touch(swap);
            }
            // An empty lockup lands here too, and this is the ONE place the
            // manager settles for less than proof. Step 1 already ended the
            // swap `settled` on a hash-verified claim and `refunded` on a spend
            // it could fully see, so a lockup that reads empty this far down is
            // one step 1 came back `unknown` for — the indexer produced no
            // outputs, or no transaction for the spend. There is nothing left
            // to recover and no further move available, so the swap ends
            // `refunded`. A settlement that only becomes observable after this
            // point will therefore have been recorded as a refund; that is the
            // cost of ending the wait at all, and it takes an indexer that
            // cannot answer for the whole span past `refundLocktime`.
            this.setState(swap, "refunded");
            this.emitAction(swap, "refundArkade");
        } catch (error) {
            // Reported UNWRAPPED, so a caller can tell the failures apart with
            // `instanceof`. That matters most for `LockupNeedsRecoveryError`: a
            // swept lockup cannot be taken back by any offchain spend until it
            // is recovered into a fresh batch, and the error names exactly
            // which outpoints. Unlike `refundIfUnresolved` — a one-shot call,
            // which returns `needs_recovery` rather than retrying — the manager
            // deliberately DOES keep retrying, because recovery is something
            // the caller can perform while the window is still open, after
            // which the next pass simply succeeds. What it must never do is
            // flatten that failure into an indistinguishable one.
            this.emitFailed(swap, error);
            // Median-time-past trails wall clock by about an hour, so refusals
            // in the first stretch past `refundLocktime` are expected rather
            // than final. The poll interval is the retry; this is the deadline,
            // the same one `refundIfUnresolved` gives up at.
            if (now >= swap.refundLocktime + REFUND_MTP_LAG_SECONDS) {
                swap.failure = errorMessage(error);
                this.setState(swap, "failed");
            }
        }
    }

    private touch(swap: RfqSwap): void {
        swap.updatedAt = this.config.now();
        this.dirty.add(swap.rfqId);
    }

    private setState(swap: RfqSwap, state: RfqSwapState): void {
        if (swap.state === state) return;
        const previous = swap.state;
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

    /** Whether the record is now persisted — false only when `saveSwap` threw. */
    private async save(swap: RfqSwap): Promise<boolean> {
        if (!this.callbacks) return true;
        try {
            await this.callbacks.saveSwap(swap);
            return true;
        } catch (error) {
            // By the time a record is saved the funding is long broadcast and
            // every deadline that matters is on chain, so a failed write must
            // not abort the pass that was about to act on it — it is reported
            // and the pass continues. What it must NOT do is let the failure
            // pass for success: the caller learns via `onSwapFailed`, and
            // `pollSwap` keeps the record dirty so the next pass retries.
            this.emitFailed(swap, error);
            return false;
        }
    }

    /**
     * Drop a terminal swap from monitoring and report it exactly once.
     *
     * `onSwapCompleted` and `onSwapFailed` are mutually exclusive here, unlike
     * Boltz's manager, which fires completion for every swap that leaves
     * monitoring including the failed ones — a listener named "completed" that
     * also fires on failure is a trap worth not inheriting.
     */
    private finalize(swap: RfqSwap): void {
        if (!this.monitored.has(swap.rfqId)) return;
        this.untrack(swap.rfqId);
        this.finished.set(swap.rfqId, swap);
        this.retireContract(swap);
        if (swap.state === "failed") {
            notify(this.swapFailedListeners, (listener) =>
                listener(swap, new Error(swap.failure ?? `swap ${swap.rfqId} failed`)),
            );
            return;
        }
        notify(this.swapCompletedListeners, (listener) => listener(swap));
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

/** What {@link RfqSwapManager.waitForSwapCompletion} reports. `txid` is the L1
 * claim for a claimed onchain send and the ark txid for a refund the trader
 * pushed; a solver-side settlement or refund carries none. */
export interface RfqSwapOutcome {
    state: RfqSwapState;
    txid?: string;
}

const isPayoutDecided = (swap: RfqSwap): boolean =>
    swap.state === "settled" ||
    swap.state === "refunded" ||
    (swap.kind === "onchain_send" && swap.state === "claimed");

const outcomeOf = (swap: RfqSwap): RfqSwapOutcome => ({
    state: swap.state,
    txid:
        swap.kind === "onchain_send" && swap.state === "claimed"
            ? swap.claimTxid
            : swap.refundArkTxid,
});

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
