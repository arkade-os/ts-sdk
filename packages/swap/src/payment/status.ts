/**
 * Fourteen outcomes onto four payment statuses — the only artefact M7 mints.
 *
 * Declared **total** even though a send rail cannot reach every member, because
 * a partial map is where the collapse hides: an outcome with no row does not
 * fail loudly, it renders as whatever the lookup happens to return.
 *
 * The projection is lossy by construction and the loss is recoverable, which is
 * the whole design. `refunded` and `lapsed` both land on `failed` — P6 exists so
 * those two never become one word, and the difference survives on the update's
 * `error`, which core's `PaymentHandle` docblock already reserves for it. No
 * fifth `PaymentStatus` is proposed: a status is what a payment UI branches on,
 * and "the trader's value came back" versus "the incoming payment never arrived"
 * is a sentence, not a branch.
 *
 * **Where the rail goes terminal is a decision, not a rounding.** It goes
 * terminal at `refunding`, not at `refunded`: `makeHandle` clears its subscriber
 * set on a terminal update and replays-without-registering afterwards, so the
 * `refunded` that follows could not reach that handle anyway — and holding
 * terminality back until the refund resolves would hang every
 * `settled({ timeoutMs })` caller for a whole refund window. The refund is
 * observed through `client.onUpdate` and `swaps()`, keyed by the tagged
 * `RouteResult.swapId`.
 *
 * The same rule answers the `unblock` backslide. `needs_recovery -> funded` is
 * a legal re-entry that crosses the terminality boundary the rail just drew; it
 * is emitted rather than swallowed, because the drive's idempotence key is the
 * DERIVED outcome and the second `funded` is a new key — delivered on
 * `client.onUpdate`, never through the handle, which stays terminal. A handle
 * observes a payment up to and including its first terminal outcome; every
 * recovery past that point is observed on the client's update stream.
 */
import type { PaymentStatus } from "@arkade-os/sdk";
import type { Outcome } from "../client/outcome";

/**
 * The projection, total over {@link Outcome}.
 *
 * The `on the rail` column of M7's table is not encoded here: a send rail
 * cannot reach `open`, `filled`, `cancelling`, `cancelled` or `lapsed`, but a
 * map that refused them would be a map with holes, and the point of totality is
 * that there are none.
 */
export const PAYMENT_STATUS = {
    /** Persisted, funding not broadcast. */
    accepted: "pending",
    funding: "pending",
    /** The lockup is funded. Nothing has emitted `"sent"` in core since the
     *  `onchain-swap` rail left with `packages/boltz-swap`. */
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
