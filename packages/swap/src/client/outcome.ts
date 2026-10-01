/**
 * One outcome vocabulary over the protocol's two state machines (`RfqSwapState` for
 * corridors, `AssetSwapStatus` for offers), and the translation that produces it.
 *
 * **The axis is whose lockup the pass reads, not send-versus-receive.** A non-claim spend
 * of the trader's lockup returns the trader's money (`refunded`); the identical spend of
 * the solver's lockup on `lightning -> arkade` means the incoming payment never arrived
 * (`lapsed`). So on the receive leg the wire's `refunded` is a LOSS.
 *
 * Ownership is read off {@link LIGHTNING_DRIVE} and {@link ONCHAIN_DRIVE}, not restated.
 */
import type { AssetSwapStatus } from "../store";
import type { LockupFate } from "../refund";
import type { OnchainHtlcPhase } from "../onchainHtlc";
import type { RfqStatus } from "../rfq";
import type { RfqSwapState } from "../rfqSwapState";
import type { PersistableRfqSwap } from "../rfqRecord";
import type { LockupOwner } from "./corridors/contract";
import { LIGHTNING_DRIVE } from "./corridors/lightning";
import { ONCHAIN_DRIVE } from "./corridors/onchain";
import type { Swap } from "./record";

/** What happened to a swap, trader-centric, in one vocabulary for both families (§3.5). */
export type Outcome =
    /** Persisted, and its funding has not been broadcast. */
    | "accepted"
    /** The funding is broadcast and the drive has not adopted the swap yet. */
    | "funding"
    /** The trader's lockup is funded and the swap is live. */
    | "funded"
    /** Waiting on the counterparty: an unpaid invoice, an unfilled offer. */
    | "open"
    /** An offer covenant was filled. */
    | "filled"
    /** The trader's own claim is confirmed on chain. */
    | "claimed"
    /** A lightning send settled: the solver's hash-verified spend IS the
     * invoice being paid. */
    | "paid"
    | "cancelling"
    | "cancelled"
    /** A send leg past `refundLocktime` with a refund push in flight. */
    | "refunding"
    /** The trader's value came back. Send legs only, ever. */
    | "refunded"
    /** A receive leg the trader never claimed: the solver took the lockup back
     * and the incoming payment never arrived. */
    | "lapsed"
    /** Surfaced, never silently retried, and never terminal. */
    | "needs_recovery"
    /** An action failed and its window closed. */
    | "failed";

/**
 * The untranslated protocol word, for support and audit. Failure reasons are on
 * {@link Swap}, not here.
 *
 * `wire`, `htlc` and `fate` are declared to fix the shape but populated by nothing yet.
 */
export type RawState =
    | {
          readonly family: "rfq";
          readonly state: RfqSwapState;
          readonly wire?: RfqStatus["state"];
          readonly htlc?: OnchainHtlcPhase;
          readonly fate?: LockupFate;
      }
    | { readonly family: "offer"; readonly status: AssetSwapStatus };

/** What `onUpdate` delivers. */
export interface SwapUpdate {
    readonly swap: Swap;
    readonly outcome: Outcome;
    readonly detail: RawState;
}

/** What every listener registration hands back. */
export type Unsubscribe = () => void;

/** The manager's route-pair vocabulary — a route pair, not a corridor. */
export type CorridorKind = PersistableRfqSwap["kind"];

/** Which route side (and so which {@link CorridorPass}) each corridor kind is: the trader
 * TAKES on lightning in `lightning_send` and GIVES on it in `lightning_receive`. */
export const CORRIDOR_PASS = {
    lightning_send: LIGHTNING_DRIVE.take,
    lightning_receive: LIGHTNING_DRIVE.give,
    onchain_send: ONCHAIN_DRIVE.take,
} as const satisfies Record<CorridorKind, unknown>;

/** Whose the arkade lockup is, per corridor kind (`lockups[0]` on every pass). */
export const LOCKUP_OWNER = {
    lightning_send: CORRIDOR_PASS.lightning_send.lockups[0].owner,
    lightning_receive: CORRIDOR_PASS.lightning_receive.lockups[0].owner,
    onchain_send: CORRIDOR_PASS.onchain_send.lockups[0].owner,
} as const satisfies Record<CorridorKind, LockupOwner>;

/** Whether this kind's drive pass reads L1, i.e. needs the onchain corridor's deps. */
export const readsChain = (kind: CorridorKind): boolean =>
    (CORRIDOR_PASS[kind].seams as readonly string[]).includes("chain");

/** One cell of the corridor table; a function of the kind only for trader `settled`. */
type CorridorCell = (kind: CorridorKind) => Outcome;

const at =
    (outcome: Outcome): CorridorCell =>
    () =>
        outcome;

/**
 * The corridor states, keyed by whose lockup the pass reads. Total, so an upstream state
 * addition is a compile error.
 *
 * The manager's `claimed` is a local submission (which may legally backslide to
 * `claimable`), while `Outcome`'s `claimed` is a chain fact; so a submitted claim
 * projects to `funded` and the stream stays monotone.
 */
const CORRIDOR_OUTCOME: Record<LockupOwner, Record<RfqSwapState, CorridorCell>> = {
    trader: {
        pending: at("funded"),
        claimable: at("funded"),
        claimed: at("funded"),
        needs_counterparty: at("needs_recovery"),
        settled: (kind) => (kind === "onchain_send" ? "claimed" : "paid"),
        refunded: at("refunded"),
        failed: at("failed"),
    },
    solver: {
        // The solver has funded nothing yet: the invoice is shown and unpaid.
        pending: at("open"),
        claimable: at("funded"),
        claimed: at("funded"),
        needs_counterparty: at("needs_recovery"),
        // Matched by the hash, not our txid, so a claim that lands without us counts.
        settled: at("claimed"),
        // The inversion: a receive lockup's non-claim leaves are all the solver's.
        refunded: at("lapsed"),
        failed: at("failed"),
    },
};

/** The corridor family's translation. */
export const corridorOutcome = (kind: CorridorKind, state: RfqSwapState): Outcome =>
    CORRIDOR_OUTCOME[LOCKUP_OWNER[kind]][state](kind);

/**
 * The offer family's translation.
 *
 * `awaiting_fill`, `claimable`, `claimed` and `refunded_l1` are onchain-corridor phases
 * never written onto an offer record; one appearing is not understood, so it is
 * SURFACED as `needs_recovery` rather than reported as progress.
 */
const OFFER_OUTCOME: Record<AssetSwapStatus, Outcome> = {
    pending: "open",
    cancelling: "cancelling",
    cancelled: "cancelled",
    fulfilled: "filled",
    // A swept deposit: still the trader's money, unreachable until recovered into a batch.
    recoverable: "needs_recovery",
    awaiting_fill: "needs_recovery",
    claimable: "needs_recovery",
    claimed: "needs_recovery",
    refunded_l1: "needs_recovery",
};

export const offerOutcome = (status: AssetSwapStatus): Outcome => OFFER_OUTCOME[status];

/**
 * What a record reports when nothing live stands behind it: `accepted` until funding is
 * broadcast, then `funding` until the drive adopts it (the manager writes nothing until
 * its first pass). An offer has no live object, so past funding its record IS the state.
 */
export const recordOutcome = (record: {
    family: "offer" | "rfq";
    fundingTxid?: string;
    status?: AssetSwapStatus;
}): Outcome => {
    if (record.fundingTxid === undefined) return "accepted";
    if (record.family === "rfq") return "funding";
    return record.status === undefined ? "funding" : offerOutcome(record.status);
};

/** `Outcome` projected onto `activity.ts`'s coarser, opaque history-row token. */
export const ACTIVITY_TOKEN: Record<Outcome, string> = {
    accepted: "pending",
    funding: "pending",
    funded: "pending",
    open: "pending",
    // `needs_recovery` (BLOCKED) collapses to pending deliberately, as in v1; apps map
    // tokens themselves.
    needs_recovery: "pending",
    refunding: "pending",
    cancelling: "pending",
    cancelled: "cancelled",
    filled: "settled",
    claimed: "settled",
    paid: "settled",
    refunded: "refunded",
    lapsed: "lost",
    failed: "failed",
};
