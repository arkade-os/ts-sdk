/**
 * Driving a set of live RFQ swaps to their end, so a caller does not have to
 * know which function to call when.
 *
 * The corridors are complete as building blocks: `requestLightningSend` /
 * `requestOnchainSend` quote and gate funding, `awaitOnchainFill` /
 * `claimOnchainFill` take the L1 fill, `refundIfUnresolved` /
 * `pushRefundWithoutReceiver` take the lockup back, and on
 * `lightning:BTC->arkade:BTC` `requestLightningReceive` gates the invoice while
 * `claimReceiveLockup` / `pushClaim` take the solver-funded lockup. What is
 * missing is the thing that calls them at the right moment for more than one
 * swap at a time, remembers where each one got to, and tells the caller when
 * something happened. That is this module.
 *
 * TODO: `packages/boltz-swap` is gone. This paragraph and the three bullets
 * under it are framed as a diff against its `SwapManager`, so the rationale
 * needs restating on its own terms.
 *
 * The shape is deliberately the one `packages/boltz-swap`'s `SwapManager`
 * arrived at — monitor a set, act automatically through injected callbacks,
 * persist through an injected `saveSwap` or a repository of its own, expose
 * events plus a promise-based escape hatch. Three things are different, each
 * for a reason:
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
 *   **On the receive leg the same read means the mirror image.** The trader is
 *   the covenant's `receiver`, so the hash-verified spend is the trader's OWN
 *   claim rather than the counterparty's, and the other leaves belong to the
 *   SOLVER — a spend that reveals no matching preimage is the solver taking its
 *   money back, which is a LOSS and not a return. `settled` and `refunded` keep
 *   their names and swap their meanings; see {@link RfqSwapState}. The
 *   chain-only posture is not merely preferable there but required: the
 *   reference solver's `rfq_status_request` consults neither receive store, so
 *   a status poll answers `unknown` for every one of these swaps.
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
 *   TODO: the `skipped`/`retryAt` contrast above points at the removed
 *   boltz-swap — restate why the atomicity matters without it.
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
import { type ContractEvent, type IContractManager, type VHTLC } from "@arkade-os/sdk";

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
import {
    assertSameSwap,
    createRfqSwapRecord,
    rebuildRfqSwap,
    rfqSwapOriginOf,
    shouldRetainRfqSwap,
    updateRfqSwapRecord,
    type LockupParams,
    type RfqSwapOrigin,
    type RfqSwapRecord,
} from "./rfqRecord";
import { RefundNotLocallyPossibleError } from "./refundBlocked";
import { isRfqSwapTerminal, type RfqSwapState } from "./rfqSwapState";

// ── Records ──────────────────────────────────────────────────────────────────

// Re-exported so this module stays the one place a consumer imports the swap
// vocabulary from; the definitions live in `rfqSwapState.ts` because the record
// layer needs them too and must not import the manager at runtime.
export { RFQ_SWAP_TERMINAL_STATES, isRfqSwapTerminal, type RfqSwapState } from "./rfqSwapState";

/**
 * What the manager needs to register a swap's lockup with the wallet, so the
 * indexer pushes its funding and its spend instead of being asked every few
 * seconds.
 *
 * Both fields are things the caller already holds. `script` is the very object
 * `pushRefundWithoutReceiver` and `pushClaim` take, so a caller wired to act has
 * it in hand; `address` is the request entrypoint's own return value. The
 * address is taken rather than re-derived on purpose — the row's address must be
 * the one that was actually funded, and a local re-derivation would silently use
 * the SDK's default network, which is the exact bug `registerOfferContract`
 * guards against.
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
    /** The Arkade lockup's scriptPubKey — `swapPkScript` from any of the four
     * request entrypoints. This is what the manager watches to decide the swap:
     * it is the only handle on the covenant whose spend witness says whether
     * the swap settled or came back. */
    lockupPkScript: Uint8Array;
    /** The covenant behind {@link lockupPkScript}, when the caller wants the
     * lockup registered with a contract manager. Optional: without it the
     * manager still watches the swap on its timer, it just cannot subscribe.
     * See {@link RfqSwapManagerDeps.contracts}. */
    lockup?: RfqSwapLockup;
    /**
     * `sha256(P)`, hex — the quote's `payment_hash`. The claim leaf can only
     * be spent by revealing a value that hashes to this, which is what makes a
     * settlement provable rather than reported. For an onchain send this is
     * the SAME hash the L1 `htlc` carries: one `P` unlocks both legs.
     *
     * True of the three corridors that exist today and only of them: a hashlock
     * belongs to a CORRIDOR, and a banco-style one settles without any. The
     * stored record already says so — the hash lives in `profile.hashlock`, not
     * on `RfqSwapRecord` — and this field follows onto the per-corridor swap
     * types when the first such corridor lands. Do not read the current shape as
     * settled.
     */
    paymentHash: string;
    /**
     * `refund_locktime` from the quote, unix seconds.
     *
     * Whose deadline it is inverts with the direction, and so does what to do
     * about it. On a send leg it is the TRADER's: the lockup is the trader's
     * money and this gates the refund that takes it back, so it is a moment to
     * act AFTER. On a receive leg it is the SOLVER's: the trader has no refund
     * leaf at all, and this is the moment to have claimed BEFORE.
     */
    refundLocktime: number;
    createdAt: number;
    updatedAt: number;
    /** Set once the trader's own `refundWithoutReceiver` push landed. */
    refundTxid?: string;
    /**
     * The ark transactions that SPENT the lockup, stamped from the chain read
     * that ended the swap — `LockupFate.spends`, whichever verdict it reached.
     *
     * The counterparty's move, on every leg but one: a solver claim on a send,
     * a solver reclaim on a receive, and — the exception — the trader's own
     * claim when a receive settles. What they have in common is that no local
     * action produced them, so nothing else on this record can name them:
     * {@link refundTxid} names only a push this wallet made, and
     * `claimTxid` only a submission it made.
     *
     * Stamped so a terminal record answers "which transaction ended this" from
     * storage. Without it the only source is another read of the lockup — a
     * network round trip per terminal swap, which is what activity correlation
     * has to pay on the offline-first path where it is least affordable.
     *
     * Absent when the swap ended without a chain verdict, or when the indexer
     * named the checkpoint but not the ark transaction — the same `txid`
     * `LockupSpend` declares optional, for the same reason.
     */
    lockupSpendTxids?: string[];
    /** Why `state` is `failed`. */
    failure?: string;
    /**
     * Last local claim error while the receive swap is still retryable.
     *
     * Distinct from terminal `failure`: this records a claim attempt that failed
     * before the window closed. If the window later closes without a submitted
     * claim, it becomes the terminal failure reason.
     */
    claimFailure?: string;
    /** Why `state` is `needs_counterparty`. Distinct from {@link failure},
     * which means an action was attempted and did not work. */
    blockedReason?: string;
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
 * `lightning:BTC->arkade:BTC`. The inverted leg: the SOLVER funds the lockup
 * and the TRADER claims it, and that claim is what publishes `P` and lets the
 * solver settle the payer's held Lightning HTLC.
 *
 * Two consequences shape how this record is driven, both of them absent from
 * the send legs:
 *
 * - **There is no trader-side refund.** Every non-claim leaf of this covenant
 *   is the solver's, so the manager never calls
 *   {@link RfqSwapManagerCallbacks.refundArkade} for one of these. A swap that
 *   is not claimed is simply lost — the solver reclaims at
 *   {@link RfqSwapCommon.refundLocktime} and the payer is refunded when the
 *   held HTLC lapses.
 * - **The claim is the whole swap, and it is on a deadline.** The trader must
 *   be online for it: covclaimd cannot claim this covenant today, so the claim
 *   packet's offline path does not run.
 */
export interface LightningReceiveSwap extends RfqSwapCommon {
    kind: "lightning_receive";
    /**
     * What the lockup must carry — the quote's `to_amount`, captured at REQUEST
     * time and persisted with the record.
     *
     * **Not re-derivable, and not optional.** Captured at claim time it would
     * be whatever the solver funded, which is the dust-funding attack rather
     * than a check on it. A record that reaches the manager without a finite
     * value here is reported `needs_counterparty` and never claimed: a
     * comparison against `undefined` or `NaN` is false, so an unusable
     * comparand does not fail the value gate, it deletes it.
     */
    expectedAmount: number;
    /** Our Arkade claim's txid, once submitted. Set from the callback's return
     * and never from a chain read — the chain's answer is `settled`. */
    claimTxid?: string;
}

/**
 * A monitored swap.
 *
 * This is a live record, not a serialization format: `lockupPkScript` and
 * `htlc` hold derived `Uint8Array`s, and `RfqSwapRecord` is its storable
 * projection. Give the manager a {@link RfqSwapManagerDeps.repository} and it
 * writes and rebuilds these itself, through
 * {@link RfqSwapManager.restoreFromRepository}. A caller keeping its own store
 * projects it in {@link RfqSwapManagerCallbacks.saveSwap} instead, rebuilds it
 * on restart the way it was made — `lightningSendContract` /
 * `lightningReceiveContract` / `onchainHtlcScript` over the quote's binding fields —
 * and hands the result to {@link RfqSwapManager.start}.
 *
 * **`onchain:BTC->arkade:BTC` is deliberately not a member yet.** Its Arkade
 * half is the same solver-funded lockup as {@link LightningReceiveSwap}'s, but
 * it also has an L1 half the trader funds and must take back itself
 * (`buildHtlcRefund` at the HTLC's own `htlc_locktime`), which is a second
 * deadline, a second observation seam and a second action callback. Adding the
 * lockup half alone would produce a manager that silently lets that L1 refund
 * window pass — the one failure mode {@link RfqSwapManager} refuses elsewhere
 * by name (see `driveOnchain`'s missing-`ChainSource` check). Until the L1
 * refund is driven too, that corridor is better served by the request and claim
 * functions directly than by a monitor that covers half of it.
 */
export type RfqSwap = LightningSendSwap | OnchainSendSwap | LightningReceiveSwap;

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
export type ArkadeRefundResult = { txid: string; amount: number } | null;

/**
 * The money-moving half, injected. The manager decides when; these do it.
 *
 * Neither action gets a retry loop of its own here — see the module doc. Take
 * `arkadeRefunder` for `refundArkade` rather than assembling it: it composes
 * the atomic push (`findLockupVtxos` + `senderIdentityForSwapRecord` +
 * `pushRefundWithoutReceiver`) and keeps the three rules below structural.
 *
 * Do NOT wire `refundArkade` to `refundIfUnresolved`: that function is the
 * single-swap version of this whole class and brings its own status polling
 * and its own MTP retry loop, which would nest inside the manager's.
 *
 * Resolve the sender key through `senderIdentityForSwapRecord`: it is
 * what turns "this wallet cannot sign this swap" into
 * {@link RefundNotLocallyPossibleError}, which the manager reports as
 * `needs_counterparty` instead of retrying for the whole refund window.
 */
export interface RfqSwapManagerCallbacks {
    /** Build and broadcast the L1 claim. See `claimOnchainFill`. */
    claimOnchain: (swap: OnchainSendSwap, utxo: ChainUtxo) => Promise<{ txid: string }>;
    /**
     * Claim the solver-funded lockup on a receive leg, revealing `P`. Wire it
     * to `pushClaim` — the outputs are supplied, so `findLockupVtxos` has
     * already been called and `claimReceiveLockup`'s wait would only sit on a
     * lockup the manager has just seen.
     *
     * **Pass `expectedAmount` and `partiallyClaimed` straight through.** The
     * manager checks the funded value before calling this, but that check
     * decides WHEN to act; `pushClaim`'s decides whether `P` is published, and
     * it is the one that runs with nothing between it and the signature. Two
     * checks, one of which is load-bearing — do not drop the inner one because
     * the outer one exists.
     *
     * Required here, like {@link claimOnchain}: a receive swap monitored with
     * nothing wired to claim it is a swap that quietly expires, and a compile
     * error is the right way to learn that. A consumer that drives only the
     * kinds needing neither installs
     * {@link AvailableRfqSwapManagerCallbacks} instead and takes the runtime
     * refusal in its place.
     */
    claimLockup: (
        swap: LightningReceiveSwap,
        vtxos: readonly LockupVtxo[],
        options: {
            /** A claim of ours is already out, so `P` is public and the value
             * gate has nothing left to protect — pass this to `pushClaim` so a
             * funding that arrived piecemeal can still be swept. */
            partiallyClaimed: boolean;
        },
    ) => Promise<{ txid: string; amount: number }>;
    /**
     * Push `refundWithoutReceiver` for every output at the lockup. See
     * `pushRefundWithoutReceiver`; return `null` for an empty lockup. Never
     * called for a {@link LightningReceiveSwap} — that leg's refund leaf is the
     * solver's.
     *
     * Only {@link RefundNotLocallyPossibleError} is read as permanent. Every
     * other throw is treated as transient and RETRIED once a poll: each attempt
     * reports through `onSwapFailed` unwrapped, and the swap ends `failed` only
     * past `refundLocktime + REFUND_MTP_LAG_SECONDS`. That is deliberate for a
     * genuinely transient failure — `LockupNeedsRecoveryError` is the
     * case it is built for, since recovery is something the caller can perform
     * while the window is still open — but it means a wiring mistake that
     * throws unconditionally does not read as `needs_counterparty`. It reports
     * once a poll for the rest of the refund window and then ends `failed`.
     * Throw {@link RefundNotLocallyPossibleError} for anything this wallet will
     * never be able to do.
     */
    refundArkade: (swap: RfqSwap) => Promise<ArkadeRefundResult>;
    /**
     * Whether a local refund is possible at all — the record's secrets, against
     * this wallet. Called every pass, including *before* the refund window
     * opens, so a swap nobody can refund says so while the solver can still
     * act, instead of at the deadline; and so restoring the right wallet lifts
     * the state again. Never called for a receive swap: there is no local
     * refund there to probe for.
     *
     * Optional: omit to answer "yes" and learn at push time, from
     * {@link RefundNotLocallyPossibleError}. Local by contract — no network
     * call belongs here.
     */
    canRefundArkade?: (swap: RfqSwap) => Promise<{ ok: true } | { ok: false; reason: string }>;
    /**
     * Persist the record. Called after any pass that changed it.
     *
     * With {@link RfqSwapManagerDeps.repository} wired this is the SECOND
     * write of the pass, not the only one: the manager writes the canonical
     * `RfqSwapRecord` itself and then calls this. Both must succeed for the
     * pass to count as persisted, so a rejection here still holds waiters and
     * finalization back exactly as it does without a repository. A consumer
     * whose `saveSwap` writes that same repository by hand should
     * drop the duplicate when it wires the dep, and keep this for genuinely
     * secondary sinks: metrics, a cache, a second store.
     */
    saveSwap: (swap: RfqSwap) => Promise<void>;
}

/**
 * What {@link RfqSwapManager.setCallbacks} accepts: the full contract, minus
 * the two claims that are already kind-gated at dispatch, and minus
 * `saveSwap`. A consumer driving only lightning sends reaches neither claim,
 * and stubbing them to throw is not a contract — it is a lie the compiler
 * waves through.
 *
 * `saveSwap` is optional for the same reason one step removed: with
 * {@link RfqSwapManagerDeps.repository} wired the manager writes the record
 * itself, so a consumer with no second sink has nothing to put here, and a
 * no-op stub would be that same lie. Omitting BOTH is the documented
 * process-local mode: state is kept in memory and dies with the process,
 * which is what a manager with no callbacks at all already does today.
 *
 * The strict {@link RfqSwapManagerCallbacks} is untouched and still means
 * "fully wired", so a helper that takes one and calls `claimOnchain` keeps its
 * guarantee. Only the parameter widens, which every existing caller satisfies.
 *
 * The compile-time guarantee this trades away is bought back at runtime: a
 * kind whose claim is missing blocks — non-terminal, re-evaluated every pass,
 * and lifted the moment `setCallbacks` supplies it.
 */
export type AvailableRfqSwapManagerCallbacks = Omit<
    RfqSwapManagerCallbacks,
    "claimOnchain" | "claimLockup" | "saveSwap"
> &
    Partial<Pick<RfqSwapManagerCallbacks, "claimOnchain" | "claimLockup" | "saveSwap">>;

/** The actions the manager executes on a caller's behalf. */
export type RfqSwapActionName = "claimOnchain" | "claimLockup" | "refundArkade";

export interface RfqSwapManagerEvents {
    /** Every state change, including ones that read as going backwards.
     * `claimed -> claimable` is legal and expected on a receive swap the solver
     * funds piecemeal: a lockup topped up after a claim is a new claimable
     * event, and the label says so before the sweep goes out. Treat these
     * states as a description of what to do next, not as a progress bar. */
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
 * `RefundIndexer`, and satisfied structurally by a real
 * `ContractManager` (`await wallet.getContractManager()`). */
export type SwapContractRegistry = Pick<
    IContractManager,
    "createContract" | "getContracts" | "onContractEvent" | "setContractWatchState"
>;

/**
 * The record store the manager writes to, narrowed to the four RFQ methods —
 * the same seam style as {@link LockupSpendIndexer} and
 * {@link SwapContractRegistry}, and satisfied structurally by a real
 * `AssetSwapRepository`.
 *
 * Narrowed rather than imported whole so this module keeps no runtime edge to
 * `repository.ts`, and so a caller with a different backing store — a server
 * process holding many wallets' records in one table — can satisfy it without
 * implementing the offer-swap and markets halves it has no use for.
 *
 * Expect TWO calls per dirty swap per poll: `getRfqSwap` then `saveRfqSwap`.
 * The read is deliberate — the store is the system of record, so a consumer's
 * own edit to a record's origin half must not be overwritten by a copy the
 * manager took at boot — but a backend where a keyed read is expensive should
 * know it is on the write path, not just the restore path.
 */
export interface RfqSwapRecordStore {
    saveRfqSwap(record: RfqSwapRecord): Promise<void>;
    getRfqSwap(rfqId: string): Promise<RfqSwapRecord | undefined>;
    getAllRfqSwaps(): Promise<RfqSwapRecord[]>;
    removeRfqSwap(rfqId: string): Promise<void>;
}

/**
 * A swap was handed to the manager with a repository wired, no origin, and no
 * record already in the store.
 *
 * Thrown at the door rather than at the first write, because the write happens
 * a pass later and by then the funding is broadcast: a swap admitted here and
 * refused at `save` would be monitored, acted on, and unwritable — the record
 * would exist only in memory while its lockup held money, and a restart would
 * lose it. The remedy is to pass the origin, which the caller has: it is what
 * the request entrypoint returned.
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

/** One stored record that could not be turned back into a live swap. */
export interface RfqRestoreFailure {
    rfqId: string;
    /** Why — a covenant that does not derive the funded address, a lockup with
     * no contract row, a corridor with no handler registered. */
    error: Error;
}

export interface RfqRestoreOptions {
    /**
     * Where each record's covenant parameters come from. Defaults to the
     * lockup's own contract row, read through
     * {@link RfqSwapManagerDeps.contracts}.
     *
     * Override it when the covenant lives somewhere else — a consumer keeping
     * its own copy of `VHTLCV2ContractHandler.serializeParams(...)`, or a
     * process with no contract manager at all. Whatever it returns is still
     * checked against the record's funded address by `rebuildRfqSwap`, so an
     * override cannot produce a swap watching the wrong covenant.
     */
    params?: (record: RfqSwapRecord) => Promise<LockupParams>;
}

/** What {@link RfqSwapManager.restoreFromRepository} did. Every stored record
 * is in exactly one of the three lists. */
export interface RfqRestoreResult {
    /** Rebuilt: monitored, or kept as finished when already terminal. */
    restored: RfqSwap[];
    /** Kept in the store, but not rebuildable right now. */
    failed: RfqRestoreFailure[];
    /** Removed: terminal and past `RFQ_SWAP_RETENTION_SECONDS`. */
    pruned: string[];
}

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
     * Where the manager persists RFQ swap records, when a caller wants it to.
     *
     * Wiring it makes the repository the CANONICAL sink: every pass that
     * changed a swap is written here as an {@link RfqSwapRecord}, and
     * {@link RfqSwapManager.restoreFromRepository} reads it back. That removes
     * the origin trap a caller otherwise hits assembling the write by hand —
     * `updateRfqSwapRecord` needs the existing record and
     * `createRfqSwapRecord` needs request-time facts the live swap does not
     * carry, so the first write of a swap cannot be composed from the swap
     * alone. The manager resolves that itself, which is what
     * {@link RfqSwapManager.addSwap}'s `origin` parameter is for.
     *
     * Optional, like every other dep here: without it the manager persists
     * through {@link RfqSwapManagerCallbacks.saveSwap} exactly as before, and
     * without either it keeps its state in memory.
     */
    repository?: RfqSwapRecordStore;
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
 * Watches a set of live RFQ swaps and drives each to its end.
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
 *    `settled`; a lockup fully spent by anything else ends it `refunded`.
 *    Anything the indexer could not answer is `unknown`, which is NOT an
 *    answer: the pass carries on to the steps below, whose deadlines an indexer
 *    outage has no bearing on. `exited` — an output unilaterally taken onchain
 *    — ends neither the swap nor the pass: it blocks the Arkade half below,
 *    with the L1 half left running.
 * 2. **Drive the trader's claim.** On an onchain send that is the L1 fill — see
 *    {@link nextOnchainAction}. On a receive it is the lockup itself, and it
 *    ends the pass: that leg has no step 3.
 * 3. **Take the lockup back**, send legs only, once `refundLocktime` has passed
 *    and step 1 has not ended the swap. This runs for onchain-send too,
 *    including after a successful claim: the trader's lockup is still funded and
 *    still theirs to recover if the solver never comes for it. When no local
 *    refund is possible at all — no secrets, another wallet's descriptor,
 *    nothing wired — the swap reports `needs_counterparty` instead of retrying
 *    a push that cannot work.
 *
 * **What step 1 proves depends on the direction.** On a send leg every non-claim
 * leaf pays the trader's own committed address or needs the trader's own
 * signature, so "spent, but not by a hash-verified claim" means the money came
 * back. On a receive leg those leaves are the SOLVER's and the claim leaf is the
 * trader's, so the same two readings mean the opposite things — `settled` is the
 * trader's own claim landing, `refunded` is the solver taking back a lockup the
 * trader failed to claim. The read is identical; only the state docs differ.
 *
 * Two things about the receive arm that are easy to get wrong, and are asserted
 * in the tests rather than left to be inferred:
 *
 * - **A claim is matched by its preimage, never by our txid.** The covenant's
 *   `nonInteractiveClaim` leaf is pinned to the trader's own payout script, so a
 *   claim that lands without us — covclaimd, the day it works — still pays the
 *   trader and is still `settled`. Matching on the txid we submitted would turn
 *   that success into an anomaly.
 * - **`LockupFate.fate === "claimed"` maps to the state `settled`, never to the
 *   state `claimed`.** The two words live one layer apart: the fate is the
 *   chain's, the state is ours, and the state `claimed` means only that we
 *   submitted something.
 */
export class RfqSwapManager {
    private readonly deps: RfqSwapManagerDeps;
    private readonly config: Required<Omit<RfqSwapManagerConfig, "events">>;
    private callbacks: AvailableRfqSwapManagerCallbacks | null = null;

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
    /**
     * Swaps whose `refundArkade` answered {@link RefundNotLocallyPossibleError}
     * in this process. Membership stops the push from being re-issued every
     * pass — it cannot start working on its own, and re-issuing it is the
     * grind `needs_counterparty` exists to remove. Only
     * {@link RfqSwapManagerCallbacks.canRefundArkade} clears it, so a caller
     * with no probe learns again on the next start, when the wallet that can
     * sign may well have been restored.
     */
    private readonly refundRefused = new Set<string>();
    /**
     * The lockup outpoints a receive swap's claim callback has already been
     * handed, by rfqId.
     *
     * What this exists to prevent: a claim SUCCEEDS, and for the next few
     * passes the indexer still lists those outputs as unspent. Without a
     * record of what was already claimed, every one of those passes would
     * re-submit the same spend, fail against the server, and report a swap
     * that in fact worked as failing. With one, a re-claim happens only when
     * an outpoint appears that was never claimed — a lockup funded piecemeal,
     * which is legitimate and which `partiallyClaimed` exists for.
     *
     * Process-local: after a restart a swap with a live claim tries once more.
     * That is the recovery case rather than the spam one — a claim that never
     * landed leaves its outputs unspent, and one that did leaves a single
     * rejection.
     */
    private readonly claimedOutpoints = new Map<string, Set<string>>();
    /** Live `onContractEvent` subscription, held so `stop()` can drop it. */
    private unsubscribeContracts: (() => void) | null = null;
    /** Terminal records, kept so a late {@link waitForSwapCompletion} still
     * answers instead of throwing "not found". Cleared by {@link removeSwap}. */
    private readonly finished = new Map<string, RfqSwap>();
    private readonly waiters = new Map<
        string,
        Set<{ resolve: (v: RfqSwapOutcome) => void; reject: (e: Error) => void }>
    >();
    /**
     * The request-time origin of each swap the manager may have to CREATE a
     * record for, by rfqId.
     *
     * Needed only for a swap the store has never seen: once a record exists,
     * `updateRfqSwapRecord` carries the origin half through and the map is
     * redundant. It is kept anyway for the swap's whole life, so a record the
     * store loses between passes is rewritten rather than lost — and dropped
     * by {@link removeSwap} and by retention, which are the two places a swap
     * stops being this manager's business.
     */
    private readonly origins = new Map<string, RfqSwapOrigin>();
    /** Records changed during the current pass, flushed to the repository and
     * through `saveSwap`. */
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

    /** Wire the money-moving half. Without it the manager only watches. The
     * two claims may be omitted for a consumer that drives no kind reaching
     * them — see {@link AvailableRfqSwapManagerCallbacks}. */
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
     * Rebuild every stored swap and take over monitoring them.
     *
     * The composition a consumer otherwise writes by hand, and the one place
     * all four pieces meet: retention decides what to keep
     * (`shouldRetainRfqSwap`), the lockup's contract row supplies the covenant
     * (`lockupContractParams`), `rebuildRfqSwap` turns a record back into a
     * live swap, and each rebuilt swap arrives with its own origin, so nothing
     * is asked of the caller.
     *
     * **Deliberately not part of {@link start}.** A consumer that wants to
     * look at its records — count them, show them, prune and stop — is not
     * forced to start driving money to do it. Call this first and `start()`
     * after; a manager already running polls the restored swaps at once.
     *
     * Retention runs BEFORE the rebuild, so a record past
     * `RFQ_SWAP_RETENTION_SECONDS` costs no contract lookup on its way to being
     * dropped.
     *
     * **A record that cannot be rebuilt is reported, never swallowed and never
     * fatal.** `rebuildRfqSwap` throws by design when the covenant params do
     * not derive the funded address, and `lockupContractParams` throws
     * `LockupContractMissing` when the wallet has no row for the lockup — both
     * say something true about that one record, and neither is a reason to
     * strand the others. They come back in {@link RfqRestoreResult.failed}.
     */
    async restoreFromRepository(options: RfqRestoreOptions = {}): Promise<RfqRestoreResult> {
        const repository = this.requireRepository("restoreFromRepository");
        const params = options.params ?? this.paramsFromContracts();

        // One read for both halves: retention and the rebuild want the same
        // records, and asking twice would let a write between the two reads
        // hand the rebuild a record retention had already dropped.
        const records = await repository.getAllRfqSwaps();
        const pruned = await this.dropRetired(repository, records);
        const retired = new Set(pruned);

        const restored: RfqSwap[] = [];
        const failed: RfqRestoreFailure[] = [];
        for (const record of records) {
            if (retired.has(record.rfqId)) continue;
            let swap: RfqSwap;
            try {
                swap = rebuildRfqSwap(record, await params(record));
            } catch (error) {
                failed.push({
                    rfqId: record.rfqId,
                    error: error instanceof Error ? error : new Error(errorMessage(error)),
                });
                continue;
            }
            this.origins.set(record.rfqId, rfqSwapOriginOf(record));
            if (isRfqSwapTerminal(swap.state)) this.finished.set(swap.rfqId, swap);
            else this.track(swap);
            restored.push(swap);
        }

        // One concurrent sweep rather than a poll per swap as they are added:
        // a restore is the case with the most swaps and the most already past a
        // deadline, and serialising it would make the last one wait out all the
        // others' network round trips.
        if (this.running) {
            await Promise.allSettled(
                restored
                    .filter((swap) => this.monitored.has(swap.rfqId))
                    .map((swap) => this.pollSwap(swap)),
            );
        }
        return { restored, failed, pruned };
    }

    /**
     * Drop stored records that are terminal and past
     * `RFQ_SWAP_RETENTION_SECONDS`, and return their ids.
     *
     * `needs_counterparty` is never dropped, however old: the money is still at
     * the lockup and the counterparty's move still ends the swap. That rule
     * lives in `shouldRetainRfqSwap`, which this defers to rather than
     * restating.
     *
     * Public because retention is a caller's cadence, not the manager's: a
     * long-lived process wants it on a timer of its own, a mobile app wants it
     * at boot. {@link restoreFromRepository} runs it first, so the boot path
     * needs no separate call.
     */
    async pruneRetiredSwaps(): Promise<string[]> {
        const repository = this.deps.repository;
        if (!repository) return [];
        return this.dropRetired(repository, await repository.getAllRfqSwaps());
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
            // The in-memory copies go with it. `finished` is only there so a
            // late `waitForSwapCompletion` can answer, and answering from a
            // record the store has just dropped is the one thing retention is
            // meant to stop growing.
            this.finished.delete(record.rfqId);
            // The origin outlives the record for a swap still being monitored.
            // A stored record can be terminal and retention-aged while its swap
            // is still tracked: `save` counts a pass as persisted only when
            // BOTH sinks took it, so a canonical write that landed alongside a
            // `saveSwap` that keeps rejecting leaves the swap dirty and
            // monitored with a terminal record ageing behind it. Dropping the
            // origin there would leave the next pass unable to recreate the
            // record it just deleted — `originOrThrow` throwing
            // `RfqSwapOriginRequired` every poll, for a swap the manager is
            // otherwise driving correctly.
            if (!this.monitored.has(record.rfqId)) this.origins.delete(record.rfqId);
            dropped.push(record.rfqId);
        }
        return dropped;
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

    /** The default covenant source: the wallet's own contract row for each
     * lockup, which is where registration put it before the address could be
     * funded. */
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
     * Load records and begin monitoring. Runs one pass immediately — a caller
     * resuming after a restart may be well past a deadline already — then
     * every `pollIntervalMs`. Records that are already terminal are kept only
     * so {@link waitForSwapCompletion} can answer for them.
     *
     * Calling it again while running loads the records and returns rather than
     * re-arming — dropping them silently would strand a funded swap on a
     * caller's harmless double-start.
     *
     * The signature is unchanged with a {@link RfqSwapManagerDeps.repository}
     * wired; the origins are resolved from the store instead, by the same rule
     * {@link addSwap} applies. A swap the store has never seen throws
     * {@link RfqSwapOriginRequired} — hand that one to `addSwap` with its
     * origin, or restore the whole set with {@link restoreFromRepository},
     * which needs no caller input at all. Every swap is checked before any is
     * tracked, so a bad one in the list does not leave a half-loaded manager.
     */
    async start(swaps: readonly RfqSwap[] = []): Promise<void> {
        for (const swap of swaps) await this.admit(swap);
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

    /**
     * Begin monitoring a swap. Polled immediately when the manager is running,
     * so a just-funded swap does not wait out a whole interval.
     *
     * `origin` is the request-time half a live swap cannot carry — the corridor,
     * the funded address, the corridor's profile, the funding txid — and it is
     * what lets the manager write this swap's FIRST record. Supply it whenever
     * a {@link RfqSwapManagerDeps.repository} is wired and the swap is new. It
     * may be omitted for a swap the store already holds a record for, which is
     * then read to confirm it; omitting it for one the store has never seen
     * throws {@link RfqSwapOriginRequired} rather than admitting a swap whose
     * record could never be written. With no repository wired the parameter is
     * inert.
     */
    async addSwap(swap: RfqSwap, origin?: RfqSwapOrigin): Promise<void> {
        await this.admit(swap, origin);
        if (isRfqSwapTerminal(swap.state)) {
            this.finished.set(swap.rfqId, swap);
            return;
        }
        this.track(swap);
        if (this.running) await this.pollSwap(swap);
    }

    /**
     * Settle where this swap's record will come from, before it is monitored.
     *
     * Three ways it can be answered, in order: the caller passed an origin, one
     * is already remembered from an earlier `addSwap`, or the store holds a
     * record — which is the origin, already written. Only the last costs a read,
     * and only when the first two are absent.
     */
    private async admit(swap: RfqSwap, origin?: RfqSwapOrigin): Promise<void> {
        if (origin) {
            // Checked here, not left to the first write. A `kind` or
            // `lockupAddress` that disagrees is a programming error either way,
            // but at the write it surfaces a pass later — the swap monitored,
            // the funding broadcast — and then keeps surfacing, since the write
            // path retries a dirty record every poll and this throw is
            // deterministic. Refusing at the door is the same trade
            // `RfqSwapOriginRequired` already makes for the missing-origin case.
            assertSameSwap(origin, swap);
            this.origins.set(swap.rfqId, origin);
            // An origin means a swap the caller is introducing, so the first
            // pass writes it whether or not anything changed. Waiting for a
            // change would leave a funded lockup with no record at all for as
            // long as it sat `pending` — which is most of a swap's life, and
            // exactly the stretch a restart has to survive.
            if (this.deps.repository && !isRfqSwapTerminal(swap.state)) {
                this.dirty.add(swap.rfqId);
            }
            return;
        }
        const repository = this.deps.repository;
        if (!repository || this.origins.has(swap.rfqId)) return;
        // A read that THROWS is a storage failure, not a miss, and is left to
        // propagate: admitting the swap would monitor something whose record
        // may or may not exist, and the caller can retry — or pass the origin,
        // which skips this read entirely.
        const stored = await repository.getRfqSwap(swap.rfqId);
        if (!stored) throw new RfqSwapOriginRequired(swap.rfqId);
        this.origins.set(swap.rfqId, rfqSwapOriginOf(stored));
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
        this.origins.delete(rfqId);
    }

    /** Every swap still being monitored. */
    async getPendingSwaps(): Promise<RfqSwap[]> {
        return [...this.monitored.values()];
    }

    /**
     * Every swap this manager holds — {@link getPendingSwaps} plus the ones
     * that already ended. The two sets are disjoint: a swap leaves `monitored`
     * as it enters `finished`.
     *
     * The finished half is what this process has seen, which after
     * {@link restoreFromRepository} is the stored history minus what retention
     * pruned. A manager that has restored nothing answers with the live swaps
     * alone.
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
     * the L1 claim, not the end of the record's life: once `claimTxid` is set
     * the trader has the coins it swapped for, and what remains is the manager
     * watching the Arkade lockup close. That holds however the record is
     * labelled afterwards, `needs_counterparty` included. Lightning-send has no
     * such split and resolves at `settled`/`refunded`, and so does lightning
     * receive — see {@link isPayoutDecided} for why its own claim txid does not
     * decide it.
     *
     * Rejects only on `failed`. `refunded` resolves: on a send leg a refund is
     * an outcome the caller asked this manager to drive, not an exception. On a
     * receive leg it is the swap being lost, which is still an answer and not
     * an error — read `state`, do not infer success from resolution.
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
        this.refundRefused.delete(rfqId);
        this.claimedOutpoints.delete(rfqId);
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
     * The backstop, not the primary site: `requestLightningSend` /
     * `requestOnchainSend` register before the caller can fund, so this covers
     * swaps whose records predate that — and costs nothing when it does not,
     * since `createContract` is first-writer-wins.
     *
     * Best-effort by design: a failure here is reported and retried on the next
     * pass, and never aborts the pass it is part of. Registration buys latency
     * and puts the lockup in the wallet's contract set; it decides nothing. The
     * money path below it reads the indexer directly and is gated on timelocks
     * that a missing contract row has no bearing on, so failing the pass over
     * this would trade a real deadline for a bookkeeping one.
     */
    private async ensureRegistered(swap: RfqSwap): Promise<void> {
        const contracts = this.deps.contracts;
        if (!contracts) return;
        if (this.registered.has(swap.rfqId)) return;

        const lockup = swap.lockup;
        if (!lockup) {
            // No covenant to build a row from — but `requestLightningSend` /
            // `requestOnchainSend` already wrote one before the caller could
            // fund, so ASK before complaining. A row that exists is a row this
            // manager can still retire; only a genuinely absent one is worth
            // reporting, and no retry can conjure the missing field that would
            // fix it.
            try {
                const [existing] = await contracts.getContracts({
                    script: hex.encode(swap.lockupPkScript),
                });
                if (existing) {
                    this.registered.set(swap.rfqId, true);
                    return;
                }
            } catch (error) {
                // Unreadable store: nothing was learned, so decide nothing and
                // look again next pass — reporting a missing covenant here
                // would be a guess.
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
            await registerLockupContract(contracts, lockup.script, lockup.address);
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
        // Only a swap this manager has confirmed a row for — whether it wrote
        // that row or found one the request path had already written. Retiring
        // one that never existed would throw "not found" and report a failure
        // on a swap that had in fact just succeeded.
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
            // And nothing observable happens unless that write SUCCEEDED —
            // every write of it, the canonical record and `saveSwap` alike
            // (see `save`). A rejected `saveSwap` used to settle waiters and
            // finalize anyway, so a caller saw a swap complete that its own
            // storage had never recorded — and on restart the manager re-drove
            // the stale record, replaying action callbacks for a swap the
            // caller already treated as done. Leaving it dirty and monitored
            // makes the next pass retry the write instead.
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
            // Stamped before the state change, so the write that `setState`
            // makes dirty carries the spend with it — one write, not two, and
            // no window in which a terminal record names no ending transaction.
            this.stampLockupSpends(swap, fate.spends);
            this.setState(swap, fate.fate === "claimed" ? "settled" : "refunded");
            return;
        }

        // 2. The trader's claim.
        //
        //    The receive leg ends the pass here rather than falling through:
        //    step 3 would push `refundWithoutReceiver` on a leaf that belongs
        //    to the solver, so the best case is a wasted callback every pass
        //    and the worst is a caller who wired it generically watching that
        //    push fail forever against a key this wallet does not hold.
        if (swap.kind === "lightning_receive") {
            return fate.fate === "exited"
                ? this.blockExitedLockup(swap, fate)
                : this.driveReceiveClaim(swap);
        }

        //    The L1 half. Skipped once claimed — there is nothing further to
        //    learn from chain, and the record already carries the txid.
        if (swap.kind === "onchain_send" && swap.state !== "claimed") {
            if ((await this.driveOnchain(swap)) === "handled") return;
        }

        // 3. The Arkade lockup. An exit is checked per-half rather than up at
        //    step 1 on purpose: it says nothing about the L1 fill above, which
        //    is a different output under a different key and keeps being driven
        //    and claimed — the same split `setOnchainState` maintains.
        if (fate.fate === "exited") {
            // And deferred the same way `driveArkadeRefund` defers a probe
            // refusal: before the window an onchain-send swap's live claim keeps
            // the label, because that is the half the trader can still act on.
            // Relabelling it here would un-say a claim the record can prove.
            const claiming = swap.state === "claimable" || swap.state === "claimed";
            if (this.config.now() < swap.refundLocktime && claiming) return;
            return this.blockExitedLockup(swap, fate);
        }
        await this.driveArkadeRefund(swap);
    }

    /**
     * The lockup was unilaterally exited: its outputs sit onchain under the
     * VHTLC script, where no offchain claim or refund can reach them.
     *
     * `needs_counterparty` rather than a terminal state, because the money still
     * needs action and the swap can still end either way — an onchain claim can
     * reveal the preimage, an onchain refund can return it — and that state is
     * documented as re-checked every pass. It must be set from HERE and not from
     * inside `driveArkadeRefund`, whose two `unblock` calls would lift it again
     * on the very next pass.
     */
    private blockExitedLockup(swap: RfqSwap, fate: Extract<LockupFate, { fate: "exited" }>): void {
        this.block(
            swap,
            `the lockup was unilaterally exited (${fate.outpoints.length} output(s) onchain), ` +
                "so no offchain spend can move it — complete the unroll and spend it onchain",
        );
    }

    /**
     * The receive leg's whole state machine: claim the solver-funded lockup
     * while the window is open, and recognise the shapes in which it can be
     * lost.
     *
     * **The window closes at `refundLocktime`, on wall clock, with no margin.**
     * Both halves of that are deliberate. It closes there because publishing
     * `P` into the solver's live refund window risks losing the race and
     * handing over the preimage anyway — the hazard `ONCHAIN_CLAIM_MARGIN_SECONDS`
     * guards on the L1 side. It takes no margin because the two situations are
     * not alike: that one budgets for confirmation depth, while this claim is an
     * offchain spend that lands in seconds. Wall clock is already the
     * conservative reading — the solver's leaf is a CLTV, which matures against
     * median-time-past, and MTP trails wall clock — so the real window extends
     * PAST this deadline rather than ending before it. Every second of margin
     * subtracted here is a second of live claim window given away for nothing.
     *
     * **The trader has no move after it.** Nothing here can take the lockup
     * back, so once the window shuts the swap is the solver's to resolve and
     * this manager's job is to watch it happen and then stop.
     */
    private async driveReceiveClaim(swap: LightningReceiveSwap): Promise<void> {
        const now = this.config.now();

        if (now < swap.refundLocktime) {
            let vtxos: readonly LockupVtxo[];
            try {
                vtxos = await findLockupVtxos(this.deps.indexer, swap.lockupPkScript);
            } catch (error) {
                // Transient by assumption, as in step 1 — but REPORTED, unlike
                // step 1's. There the failure is absorbed because the pass
                // carries on to deadlines an indexer outage cannot move; here
                // this read is the entire pass, so swallowing it would leave a
                // receive swap silently doing nothing until its window shut.
                this.emitFailed(swap, error);
                return;
            }
            return this.claimIfFunded(swap, vtxos);
        }

        // Past the window and still unresolved. Keep watching for a while: the
        // solver's own CLTV matures against median-time-past, so its reclaim
        // lands somewhere in the couple of hours after `refundLocktime` — and
        // when it does, step 1 sees it and ends the swap on chain evidence
        // rather than on this deadline.
        if (now < swap.refundLocktime + REFUND_MTP_LAG_SECONDS) {
            // A submitted claim keeps its label: `claimed` is still the truest
            // thing the record knows, and replacing it with a refusal would
            // un-say it. Only a swap that never got one is reported blocked.
            if (swap.claimTxid) return;
            return this.block(
                swap,
                "the claim window closed with the lockup unclaimed — only the solver can act now",
            );
        }

        // The deadline. This is the receive leg's counterpart to the send
        // leg's "settle for less than proof": a lockup the solver funded is
        // long since reclaimed, one it never funded will never be, and either
        // way there is nothing further to observe and no move left to make.
        // Ending the wait at all costs the distinction between them.
        const failure = swap.claimFailure;
        if (failure && !swap.claimTxid) {
            // The one shape that is not an ordinary unwind: this wallet had a
            // claimable lockup and could not take it. `failed` rather than
            // `refunded` so an awaiting caller is told, instead of reading a
            // broken claim callback as a swap that simply did not happen.
            return this.fail(swap, new Error(failure));
        }
        this.setState(swap, "refunded");
    }

    /**
     * Claim what the solver funded, once it is enough.
     *
     * The value gate here decides WHEN to act. `pushClaim`'s decides whether
     * `P` is published, and runs with nothing between it and the signature —
     * the check that matters is the inner one, and this is not a reason to
     * relax it.
     */
    private async claimIfFunded(
        swap: LightningReceiveSwap,
        vtxos: readonly LockupVtxo[],
    ): Promise<void> {
        if (vtxos.length === 0) return this.unblock(swap);

        // A claim of ours is already out, so `P` is public: the value gate has
        // nothing left to protect, and holding the remainder back over it would
        // strand the trader's own money.
        const partiallyClaimed = swap.claimTxid !== undefined;
        if (partiallyClaimed && !this.hasUnclaimedOutpoint(swap.rfqId, vtxos)) {
            // Everything here has already been through the callback. The
            // indexer simply has not caught up with the spend yet, and
            // re-submitting it would fail against the server and report a
            // working swap as broken.
            return;
        }

        if (!partiallyClaimed) {
            if (!Number.isFinite(swap.expectedAmount)) {
                // `locked < undefined` and `locked < NaN` are both false, so an
                // unusable comparand does not fail the gate below — it deletes
                // it, and `P` goes out for whatever the solver funded. Refused
                // rather than defaulted, and re-checked every pass so a fixed
                // record resumes.
                return this.block(
                    swap,
                    `expectedAmount is not a finite number (${String(swap.expectedAmount)}), so the funded value cannot be checked — refusing to publish the preimage`,
                );
            }
            // Swept outputs count toward the sum on purpose: they are still the
            // agreed money sitting at the script, and treating them as missing
            // would report a fully funded lockup as underfunded. What cannot be
            // done with them is spend them offchain, and `pushClaim` is where
            // that is refused — by name, with the outpoints to recover — rather
            // than here, where it would be indistinguishable from dust funding.
            const locked = vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0);
            if (!Number.isFinite(locked) || locked < swap.expectedAmount) {
                // Not terminal: a solver that tops the lockup up before the
                // window shuts makes this claimable, and the next pass takes it.
                return this.block(
                    swap,
                    `lockup holds ${locked} sats, below the agreed ${swap.expectedAmount} — refusing to publish the preimage`,
                );
            }
        }

        if (!this.callbacks || !this.callbacks.claimLockup) {
            // Checked BEFORE the label, unlike the auto-actions case below: a
            // wallet with nothing wired cannot claim by hand off `claimable`
            // either, so reporting the lockup as claimable would name an action
            // nobody here can take, and the swap would sit at it until the
            // window shut. Reported the way `driveArkadeRefund` reports the
            // same wiring gap, and lifted the moment `setCallbacks` runs.
            return this.block(
                swap,
                this.callbacks
                    ? "no claimLockup callback is wired, so this wallet cannot claim the lockup"
                    : "no callbacks are wired, so this wallet cannot claim the lockup",
            );
        }

        this.setState(swap, "claimable");
        // With auto-actions off the manager watches and reports only, which is
        // the documented way to claim by hand off `claimable`.
        if (!this.config.enableAutoActions) return;

        try {
            const { txid } = await this.callbacks.claimLockup(swap, vtxos, { partiallyClaimed });
            delete swap.claimFailure;
            // Recorded only on success: a claim that threw must be retried, and
            // these outputs are still there to retry with.
            this.rememberClaimed(swap.rfqId, vtxos);
            swap.claimTxid = txid;
            // Touched independently of the label below, which today does the
            // persisting on its own — a re-claim comes back through
            // `claimable`, so `claimed` is a real transition either way. What
            // this covers is the txid outliving that coupling: a crash between
            // here and `setState`, and any later change that stops the label
            // from moving on a re-claim, both leave a submitted claim recorded
            // rather than a swap whose preimage is public and whose txid is not.
            this.touch(swap);
            this.setState(swap, "claimed");
            this.emitAction(swap, "claimLockup");
        } catch (error) {
            // The window is still open — `driveReceiveClaim` only reaches here
            // while it is — so the next pass retries. Recorded so that, if the
            // window shuts having never succeeded, the swap can end `failed`
            // with a reason rather than looking like a quiet expiry.
            swap.claimFailure = errorMessage(error);
            this.touch(swap);
            this.emitFailed(swap, error);
        }
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
            // The txid, not the label, is what says the claim was made. Until
            // `needs_counterparty` existed the `claimed` state carried both, and
            // step 2 skipped this branch on it; a blocked swap keeps the txid
            // while the label defers, and re-broadcasting would publish P twice.
            if (swap.claimTxid) return "continue";
            // Half-wired: callbacks installed, this one absent. Blocked rather
            // than labelled `claimable`, for the reason `claimIfFunded` gives —
            // and NOT failed, unlike the missing-`ChainSource` case above:
            // `chain` is constructor-injected and can never arrive late, while
            // `setCallbacks` exists precisely so a callback can, and a terminal
            // state would foreclose the wiring this whole relaxation is for.
            // Fully unwired keeps reporting `claimable`, which is the
            // documented manual mode.
            if (this.callbacks && !this.callbacks.claimOnchain) {
                this.block(
                    swap,
                    "no claimOnchain callback is wired, so this wallet cannot claim the L1 fill",
                );
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
            this.setOnchainState(swap, "claimed");
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

        // Ask first, and ask on every pass. Before the window opens this is
        // what makes "nobody here can refund this" reportable while the solver
        // can still act; after it, it is what lifts the state again when the
        // wallet that can sign is restored.
        const refusal = await this.probeRefusal(swap);
        if (refusal) {
            // Before the window, an onchain-send swap's live claim keeps the
            // label — it is a different half with a different key, and it is
            // the half the trader can still act on. After the window the
            // refusal wins, which {@link setOnchainState} is the other side of.
            const claiming = swap.state === "claimable" || swap.state === "claimed";
            if (now < swap.refundLocktime && claiming) return;
            return this.block(swap, refusal);
        }
        // A probe that answered is the only thing that can retract a refusal
        // the push itself reported; without one there is nothing new to learn,
        // and re-issuing a push that cannot work is the grind this state
        // removes. Step 1 still ends the swap if the counterparty acts.
        if (this.refundRefused.has(swap.rfqId)) {
            if (!this.callbacks?.canRefundArkade) return;
            this.refundRefused.delete(swap.rfqId);
        }

        if (now < swap.refundLocktime) return this.unblock(swap);

        if (!this.config.enableAutoActions || !this.callbacks) {
            // The loudest gap this state closes: with nothing wired to act, the
            // swap would otherwise sit `pending` past its window forever —
            // monitored, never acted on, never reported.
            return this.block(
                swap,
                this.callbacks
                    ? "automatic actions are disabled, so this wallet will not push the refund"
                    : "no callbacks are wired, so this wallet cannot push the refund",
            );
        }
        this.unblock(swap);

        try {
            const pushed = await this.callbacks.refundArkade(swap);
            if (pushed) {
                swap.refundTxid = pushed.txid;
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
            if (error instanceof RefundNotLocallyPossibleError) {
                // Not a failure to retry: a capability this wallet does not
                // have. Caught before the retry branch, so it costs one call
                // rather than a pass-per-poll storm of `onSwapFailed` ending in
                // `failed` — a label that would claim an action failed when the
                // truth is that none was ever possible here.
                this.refundRefused.add(swap.rfqId);
                return this.block(swap, error.message);
            }
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

    /** Whether any of these outputs has never been handed to the claim
     * callback — the only reason to claim a lockup a second time. */
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
     * L1 progress, which past the refund window must not overwrite a refusal.
     * The two halves are independent — a claimed fill says nothing about
     * whether this wallet can take the Arkade lockup back — and `claimed` is
     * re-asserted from chain on every pass, so without this a blocked swap
     * would flip between the two states forever. The claim itself always runs;
     * only the label defers, and only once the refund is the live half.
     */
    private setOnchainState(swap: OnchainSendSwap, state: RfqSwapState): void {
        if (swap.state === "needs_counterparty" && this.config.now() >= swap.refundLocktime) return;
        this.setState(swap, state);
    }

    /** The probe's refusal reason, or `undefined` when a local refund is
     * possible as far as anyone here can tell. A probe that throws is treated
     * as a refusal: a capability check that cannot answer is not a yes. */
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

    /** The way back out, taken as soon as the swap becomes actionable again.
     * Back to what the record can prove, not to `pending` unconditionally: a
     * swap that already made its claim has a txid for it, and reporting that
     * swap as `pending` would un-say something true. */
    private unblock(swap: RfqSwap): void {
        if (swap.state !== "needs_counterparty") return;
        this.setState(swap, traderClaimTxid(swap) ? "claimed" : "pending");
    }

    /**
     * Record which ark transactions ended the lockup.
     *
     * Only the ones the indexer actually named: `LockupSpend.txid` is
     * optional, and a checkpoint txid is not what history correlates on — a
     * record carrying one would name a transaction the wallet's own activity
     * never shows. Fewer txids is the right failure here.
     *
     * Assigned rather than merged: the fate is one read of the whole lockup,
     * so it is the complete answer for this swap, and a swap only reaches a
     * verdict once.
     */
    private stampLockupSpends(swap: RfqSwap, spends: readonly LockupSpend[]): void {
        const txids = spends
            .map((spend) => spend.txid)
            .filter((txid): txid is string => txid !== undefined);
        if (txids.length === 0) return;
        swap.lockupSpendTxids = txids;
        this.touch(swap);
    }

    private touch(swap: RfqSwap): void {
        swap.updatedAt = this.config.now();
        this.dirty.add(swap.rfqId);
    }

    private setState(swap: RfqSwap, state: RfqSwapState): void {
        if (swap.state === state) return;
        const previous = swap.state;
        // Every exit from the refusal clears its reason, not just `unblock`'s:
        // a swap the counterparty finally claimed leaves through `settled`, and
        // a stale `blockedReason` there reads as a live refusal.
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
     * Flush a changed record to every sink that is wired, and say whether all
     * of them took it.
     *
     * Up to two writes, in this order: the canonical `RfqSwapRecord` to
     * {@link RfqSwapManagerDeps.repository}, then
     * {@link RfqSwapManagerCallbacks.saveSwap}. Both gate — a rejection from
     * either leaves the record dirty and monitored, so waiters stay unsettled
     * and a terminal swap is not finalized until the write it claims lands.
     * That is exactly today's rule for `saveSwap`, applied to whichever sinks
     * exist; wiring the repository does not weaken it.
     *
     * The canonical write goes FIRST and a failure there skips the second.
     * `saveSwap` is a projection of the record, and projecting a state the
     * record of record has just refused would leave the secondary sink ahead
     * of the primary — the one ordering that survives no restart.
     *
     * With neither wired the state is process-local, which is what a manager
     * with no callbacks has always done.
     */
    private async save(swap: RfqSwap): Promise<boolean> {
        if (!(await this.saveRecord(swap))) return false;
        if (!this.callbacks?.saveSwap) return true;
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

    /** The canonical write. True when there is no repository to write to. */
    private async saveRecord(swap: RfqSwap): Promise<boolean> {
        const repository = this.deps.repository;
        if (!repository) return true;
        try {
            // Read-then-write per pass rather than caching the record: the
            // store is the system of record, and a consumer that edited a
            // record's origin half — a `fundingTxid` learned late, a
            // corridor field its own code owns — must not have that edit
            // overwritten by a copy this manager took at boot.
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
        // Unreachable through `addSwap`/`start`/`restoreFromRepository`, all of
        // which settle the origin before the swap is tracked. Reachable if the
        // store dropped the record after admission, which is why the write path
        // says so instead of assuming.
        if (!origin) throw new RfqSwapOriginRequired(swap.rfqId);
        return origin;
    }

    /**
     * Drop a terminal swap from monitoring and report it exactly once.
     *
     * `onSwapCompleted` and `onSwapFailed` are mutually exclusive here: a
     * listener named "completed" that also fires on failure is a trap, so a
     * swap that leaves monitoring reports through exactly one of them.
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

/** What {@link RfqSwapManager.waitForSwapCompletion} reports. `txid` is the
 * trader's own claim — L1 for a claimed onchain send, Arkade for a claimed
 * receive — or the ark txid for a refund the trader pushed; a solver-side
 * settlement or refund carries none, and a receive swap that ended `refunded`
 * carries none either, however far its claim got (see {@link outcomeOf}). So
 * a `txid` here always names something that happened, and `state` remains the
 * only thing to read for whether the swap paid out. */
export interface RfqSwapOutcome {
    state: RfqSwapState;
    txid?: string;
}

/** The trader's own claim on this swap, whichever leg it belongs to. */
const traderClaimTxid = (swap: RfqSwap): string | undefined => {
    switch (swap.kind) {
        case "onchain_send":
            return swap.claimTxid;
        case "lightning_receive":
            return swap.claimTxid;
        default:
            return undefined;
    }
};

// The txid, not the label — same reason `driveOnchain` guards on it. The label
// moves on: a claimed onchain send whose Arkade half is refused past the window
// reads `needs_counterparty`, and keying on `claimed` would hang a waiter on a
// payout that already happened and that the record can prove.
//
// A receive swap is deliberately NOT decided by its claim txid, though it has
// one. An L1 broadcast is a chain fact the trader holds coins from; an Arkade
// submission is a submission, and `claimed -> refunded` is a legal transition
// from it. Resolving a waiter there would report a payout that can still be
// lost — so this leg waits for `settled`, which is the chain's answer.
const isPayoutDecided = (swap: RfqSwap): boolean =>
    swap.state === "settled" ||
    swap.state === "refunded" ||
    (swap.kind === "onchain_send" && swap.claimTxid !== undefined);

const outcomeOf = (swap: RfqSwap): RfqSwapOutcome => {
    // A receive swap that ended `refunded` was lost: the solver took the lockup
    // back, so a `claimTxid` on it names a submission the chain never took.
    // Reporting it would put a claim txid on the one outcome where the trader
    // has nothing — the single combination in which `txid` present would not
    // mean an action that landed. The record still carries it for diagnosis.
    const lostReceive = swap.kind === "lightning_receive" && swap.state === "refunded";
    return {
        state: swap.state,
        txid: lostReceive ? swap.refundTxid : (traderClaimTxid(swap) ?? swap.refundTxid),
    };
};

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const outpointKey = (vtxo: LockupVtxo): string => `${vtxo.txid}:${vtxo.vout}`;
