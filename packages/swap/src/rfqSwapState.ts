/**
 * Where a monitored RFQ swap stands, and which of those states end it. Its own module so the
 * record layer (retention via {@link isRfqSwapTerminal}) and the manager need not import each
 * other at runtime; `swapManager.ts` re-exports all three names.
 */

/**
 * Where a monitored swap stands; the vocabulary of `CorridorSwapRecord.state`. `Outcome`, from
 * `client.onUpdate()`, is the client-level projection over it.
 *
 * `claimable`/`claimed` apply when the TRADER has something to claim: the L1 fill on an onchain
 * send, the solver-funded lockup on a receive. `lightning_send` has neither; the trader's only
 * move there is the refund.
 */
export type RfqSwapState =
    /** Live; nothing actionable yet. On a receive leg this covers the whole
     * stretch before the solver funds anything. */
    | "pending"
    /** There is something for the trader to take, and the window to take it is
     * open: the confirmed L1 fill on an onchain send, or a lockup funded for at
     * least `expectedAmount` on a receive. */
    | "claimable"
    /**
     * The trader's claim has been made (L1 broadcast on an onchain send, Arkade submission on a
     * receive). **On a receive this is a local belief, not a chain fact**, hence not terminal:
     * `refunded` is still reachable if the claim never lands.
     */
    | "claimed"
    /**
     * This wallet will not act, and only the counterparty can change that
     * (`RfqSwapCommon.blockedReason` says why).
     *
     * Send leg: the Arkade refund cannot be pushed from here (no secrets, foreign descriptor, or
     * nothing wired). Receive leg: the lockup cannot be claimed — underfunded (publishing `P`
     * for it is the attack `LockupAmountMismatchError` refuses) or its claim window shut.
     *
     * **Not terminal.** The money is still at the lockup and the refusal is re-checked every
     * pass, so fixing the cause returns the swap to `pending`. On an onchain send the L1 half
     * keeps being driven regardless.
     */
    | "needs_counterparty"
    /**
     * Terminal: the lockup was spent by a hash-verified claim, read off chain, never reported.
     * On a send leg it is the counterparty's claim; on a receive leg the TRADER's own, matched by
     * hash rather than our txid so a claim that lands without us still counts.
     */
    | "settled"
    /**
     * Terminal: the lockup was spent by something other than a claim. On a send leg that is the
     * money coming back. **On a receive leg it is a LOSS**: every non-claim leaf is the
     * solver's. Also where a receive swap ends when its window closes with nothing to observe.
     */
    | "refunded"
    /** Terminal: an action failed and its window closed. */
    | "failed";

/** The states after which the manager stops monitoring a swap. Deliberately
 * without `needs_counterparty`: retiring on it would unwatch a funded lockup
 * whose claim is still the thing that ends the swap. */
export const RFQ_SWAP_TERMINAL_STATES = ["settled", "refunded", "failed"] as const;

/** Whether `CorridorSwapRecord.state` ends the swap. */
export const isRfqSwapTerminal = (state: RfqSwapState): boolean =>
    (RFQ_SWAP_TERMINAL_STATES as readonly string[]).includes(state);
