/**
 * Where a monitored RFQ swap stands, and which of those states end it.
 *
 * Its own module rather than a corner of `swapManager.ts` because the
 * dependency runs the other way: the record layer decides retention from
 * {@link isRfqSwapTerminal}, and the manager persists through the record
 * layer. With the vocabulary here, neither has to import the other at runtime.
 * `swapManager.ts` re-exports all three names, so nothing about the public
 * surface moved.
 */

/**
 * Where a monitored swap stands.
 *
 * `claimable` and `claimed` are the states of a swap the TRADER has something
 * to claim on: the L1 fill on an onchain send, and the solver-funded lockup on
 * a receive. Only `lightning_send` has neither — there the solver claims the
 * lockup, and the trader's only move is the refund.
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
     * The trader's claim has been made — its L1 broadcast on an onchain send,
     * its Arkade submission on a receive.
     *
     * **On a receive this is a local belief and not a chain fact**, which is
     * why it is not terminal: `settled` is the chain's answer, and `refunded`
     * is still reachable from here if the claim never lands and the solver
     * takes the lockup back.
     */
    | "claimed"
    /**
     * This wallet will not act, and only the counterparty can change that.
     *
     * On a send leg: the Arkade refund cannot be pushed from here — no secrets
     * on the record, a descriptor from another seed, or nothing wired to act —
     * so the lockup comes back only if the counterparty claims it or the wallet
     * that can sign it is restored. On a receive leg: the trader holds no
     * refund at all, so this is a lockup that cannot be claimed — funded for
     * less than the swap agreed (publishing `P` for it is the whole attack
     * `LockupAmountMismatchError` exists to refuse), or one whose claim window
     * shut unclaimed. `RfqSwapCommon.blockedReason` says which.
     *
     * **Not terminal, and not a dead end.** The money is still at the lockup,
     * so the counterparty's move is still observable and still ends the swap;
     * and the refusal is re-checked every pass, so restoring the right wallet,
     * wiring the callbacks, or the solver topping the lockup up returns the
     * swap to `pending` and resumes the normal drive. For an onchain-send swap
     * it says nothing about the L1 half, which keeps being driven and claimed.
     */
    | "needs_counterparty"
    /**
     * Terminal: the lockup was spent by a hash-verified claim. Read off chain,
     * never reported.
     *
     * On a send leg that claim is the counterparty's, and it is proof the
     * counterparty completed its side. On a receive leg it is the TRADER's own
     * — matched by the hash and not by our txid, so a claim that lands without
     * us still counts (see `RfqSwapManager`).
     */
    | "settled"
    /**
     * Terminal: the lockup was spent by something other than a claim.
     *
     * On a send leg that is the money coming back, by the solver's hand or the
     * trader's. **On a receive leg it is a LOSS**: the lockup was the solver's
     * money, every non-claim leaf is the solver's, and a swap that ends here
     * ended with the trader's incoming payment never arriving. It is also where
     * a receive swap ends when its window closes with nothing left to observe —
     * see `RfqSwapManager`.
     */
    | "refunded"
    /** Terminal: an action failed and its window closed. */
    | "failed";

/** The states after which the manager stops monitoring a swap. Deliberately
 * without `needs_counterparty`: retiring on it would unwatch a funded lockup
 * whose claim is still the thing that ends the swap. */
export const RFQ_SWAP_TERMINAL_STATES = ["settled", "refunded", "failed"] as const;

export const isRfqSwapTerminal = (state: RfqSwapState): boolean =>
    (RFQ_SWAP_TERMINAL_STATES as readonly string[]).includes(state);
