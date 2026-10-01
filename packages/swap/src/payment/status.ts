/**
 * Fourteen outcomes onto four payment statuses.
 *
 * Total even where a send rail cannot reach a member: a partial map fails silently, rendering a
 * missing outcome as whatever the lookup returns. `refunded` and `lapsed` both become `failed`;
 * the difference survives on the update's `error`, not a fifth status.
 *
 * The rail goes terminal at `refunding`, not `refunded`: `makeHandle` drops subscribers on a
 * terminal update, so `refunded` could not reach the handle anyway, and waiting would hang
 * `settled({ timeoutMs })` for a whole refund window. Later updates (the refund, or an `unblock`
 * `needs_recovery -> funded` re-entry) arrive on `client.onUpdate`, keyed by `RouteResult.swapId`.
 */
import type { PaymentStatus } from "@arkade-os/sdk";
import type { Outcome } from "../client/outcome";

/** The projection, total over {@link Outcome}. */
export const PAYMENT_STATUS = {
    /** Persisted, funding not broadcast. */
    accepted: "pending",
    funding: "pending",
    /** The lockup is funded. */
    funded: "sent",
    /** Asset swaps only: an unfilled offer. */
    open: "pending",
    /** Asset swaps only. */
    filled: "settled",
    /** The trader's L1 claim on `arkade -> onchain`. */
    claimed: "settled",
    /** Terminal success on `arkade -> lightning`: the solver's hash-verified
     *  spend IS the invoice being paid. */
    paid: "settled",
    cancelling: "pending",
    /** Value returned, and the router has no non-loss terminal to say so with. */
    cancelled: "failed",
    /** Terminal HERE, not at `refunded` — see the module docblock. */
    refunding: "failed",
    /** The trader's value came back. Reaches `onUpdate`, not the handle. */
    refunded: "failed",
    /** The solver reclaimed a receive-leg lockup: a loss, and not `refunded`. */
    lapsed: "failed",
    /** Never retried silently; `client.recover` drives it. */
    needs_recovery: "failed",
    failed: "failed",
} as const satisfies Record<Outcome, PaymentStatus>;

/** Where a payment stands, in core's four-state vocabulary. */
export const paymentStatusOf = (outcome: Outcome): PaymentStatus => PAYMENT_STATUS[outcome];

/** Whether this status ends the handle's observation. Core's own rule. */
export const isTerminalStatus = (status: PaymentStatus): boolean =>
    status === "settled" || status === "failed";
