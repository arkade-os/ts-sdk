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
 * - **No WebSocket.** `RfqTransport` already abstracts "how do I get status":
 *   `httpTransport` polls, `relayTransport` round-trips over a socket it owns.
 *   There is no unsolicited push to hook into even if this manager wanted one
 *   — `relayTransport`'s message handler correlates strictly by `rfq_id`
 *   against its `pending` map and drops any frame with no pending entry. So
 *   this manager calls `transport.status()` on an interval and lets the
 *   transport be whatever the caller configured. There is nothing to
 *   reconnect, hence no connection events and no reconnect backoff.
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
 * seams (`RfqTransport`, and `ChainSource` for L1) and reads them itself,
 * because it cannot decide correctly without them; the actions that move money
 * are {@link RfqSwapManagerCallbacks}, so no key material ever reaches this
 * class — the same split `onchainHtlc.ts` makes with its `sign` callback.
 */
import {
    ONCHAIN_CLAIM_MARGIN_SECONDS,
    classifyOnchainHtlc,
    type ChainSource,
    type ChainUtxo,
    type OnchainHtlc,
    type OnchainHtlcPhase,
} from "./onchainHtlc";
import { REFUND_MTP_LAG_SECONDS, RFQ_RESOLVED_STATES } from "./refund";
import type { RfqStatus, RfqTransport } from "./rfq";

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
    /** Terminal: the solver reported `settled`. */
    | "settled"
    /** Terminal: the lockup came back, by the solver's hand or the trader's. */
    | "refunded"
    /** Terminal: an action failed and its window closed. */
    | "failed";

/** The states after which the manager stops monitoring a swap. */
export const RFQ_SWAP_TERMINAL_STATES = ["settled", "refunded", "failed"] as const;

export const isRfqSwapTerminal = (state: RfqSwapState): boolean =>
    (RFQ_SWAP_TERMINAL_STATES as readonly string[]).includes(state);

interface RfqSwapCommon {
    /** The negotiation id — this record's identity, and what `status()` takes. */
    rfqId: string;
    state: RfqSwapState;
    /** `refund_locktime` from the quote, unix seconds. Gates the Arkade refund. */
    refundLocktime: number;
    createdAt: number;
    updatedAt: number;
    /** The last state the solver reported. Diagnostics only — the manager acts
     * on `state`, and deliberately does not treat `refused`/`expired`/`stuck`
     * as an ending (see {@link RFQ_RESOLVED_STATES}). */
    rfqState?: string;
    /** Set once the trader's own `refundWithoutReceiver` push landed. */
    refundArkTxid?: string;
    /** Why `state` is `failed`. */
    failure?: string;
}

/** `arkade:BTC->lightning:BTC`. Nothing for the trader to claim: the solver
 * claims the lockup with the preimage it learns by paying the invoice. */
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
 * This is a live record, not a serialization format: `htlc` holds derived
 * `Uint8Array`s, and {@link RfqSwapManagerCallbacks.saveSwap} is where a
 * caller projects it into whatever it stores. Rebuild it on restart the way it
 * was made — `onchainHtlcScript` over the quote's binding fields — and hand
 * the result to {@link RfqSwapManager.start}.
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

/** The observation seams. Neither is owned by the manager, and neither holds
 * keys — same philosophy as `onchainHtlc.ts`'s `ChainSource`. */
export interface RfqSwapManagerDeps {
    transport: RfqTransport;
    /** L1 access. Required to monitor onchain-send swaps; a lightning-only
     * caller can leave it out. */
    chain?: ChainSource;
}

const isResolved = (state: string): boolean =>
    (RFQ_RESOLVED_STATES as readonly string[]).includes(state);

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
 * One pass per swap, in this order, every {@link RfqSwapManagerConfig.pollIntervalMs}:
 *
 * 1. **Ask the solver.** `settled` and `refunded` are the only two states that
 *    end a swap — `refused`, `expired` and `stuck` are terminal for the
 *    NEGOTIATION but say nothing about whether the trader's sats are still at
 *    the lockup, and a trader that funded just as the quote expired is exactly
 *    the one who needs the refund most (see {@link RFQ_RESOLVED_STATES}).
 *    A status read that FAILS is not an answer either: the pass carries on to
 *    step 2, whose deadline the solver's uptime has no bearing on.
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
            else this.monitored.set(swap.rfqId, swap);
        }
        if (this.running) return;
        this.running = true;
        await this.poll();
        this.arm();
    }

    /**
     * Stop monitoring and clear the timer. In-flight actions are not
     * cancellable and run to completion; outstanding
     * {@link waitForSwapCompletion} promises are left pending, since
     * stop/start is a pause rather than a cancellation.
     */
    async stop(): Promise<void> {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** Begin monitoring a swap. Polled immediately when the manager is running,
     * so a just-funded swap does not wait out a whole interval. */
    async addSwap(swap: RfqSwap): Promise<void> {
        if (isRfqSwapTerminal(swap.state)) {
            this.finished.set(swap.rfqId, swap);
            return;
        }
        this.monitored.set(swap.rfqId, swap);
        if (this.running) await this.pollSwap(swap);
    }

    /** Forget a swap entirely, monitored or finished. */
    async removeSwap(rfqId: string): Promise<void> {
        this.monitored.delete(rfqId);
        this.finished.delete(rfqId);
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
            this.inProgress.delete(swap.rfqId);
            if (this.dirty.delete(swap.rfqId)) await this.save(swap);
            // Waiters settle AFTER the write, not from `setState`: a caller
            // that awaits completion and then reads its own storage must not
            // find the record still saying `pending`.
            this.settleWaiters(swap);
            if (isRfqSwapTerminal(swap.state)) this.finalize(swap);
        }
    }

    private async runPass(swap: RfqSwap): Promise<void> {
        // 1. Ask the solver. A failed read is not an answer — carry on.
        let status: RfqStatus | null = null;
        try {
            status = await this.deps.transport.status(swap.rfqId);
        } catch {
            // Transient by assumption: nothing is lost by asking again next
            // pass, and both remaining steps are gated on absolute timelocks
            // that do not care whether the solver's status route is up.
        }
        if (status && status.state !== swap.rfqState) {
            swap.rfqState = status.state;
            this.touch(swap);
        }
        if (status && isResolved(status.state)) {
            this.setState(swap, status.state === "settled" ? "settled" : "refunded");
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
            // An empty lockup lands here too. Step 1 ends the swap on `settled`
            // before this gate is ever reached, so a lockup already spent by
            // the time we look was spent by something that is not a settlement
            // — the solver's own `nonInteractiveRefund` racing us is the
            // ordinary cause. Either way there is nothing left to recover and
            // nothing further to do, which is what `refunded` means here.
            this.setState(swap, "refunded");
            this.emitAction(swap, "refundArkade");
        } catch (error) {
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

    private async save(swap: RfqSwap): Promise<void> {
        if (!this.callbacks) return;
        try {
            await this.callbacks.saveSwap(swap);
        } catch (error) {
            // By the time a record is saved the funding is long broadcast and
            // every deadline that matters is on chain, so a failed write must
            // not abort the pass that was about to act on it.
            this.emitFailed(swap, error);
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
        if (!this.monitored.delete(swap.rfqId)) return;
        this.finished.set(swap.rfqId, swap);
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
