/**
 * One outcome vocabulary, and the translation that produces it.
 *
 * The protocol keeps two state machines — `RfqSwapState` for the corridors and
 * `AssetSwapStatus` for offers — and v1 handed both to every consumer, who then
 * wrote `family === "offer" ? swap.status : swap.state` and decided what each
 * word meant. {@link Outcome} is that decision, made once.
 *
 * **The axis is not send-versus-receive: it is whose lockup the pass reads.**
 * On `arkade -> lightning` and `arkade -> onchain` the arkade lockup is the
 * trader's, so a non-claim spend of it returns the trader's money. On
 * `lightning -> arkade` it is the solver's, so the identical chain read means
 * the trader's incoming payment never arrived. `refunded` and `lapsed` are that
 * one difference, and the reason this enum refuses to inherit the protocol's
 * word: on the receive leg the state the wire calls `refunded` is a LOSS.
 *
 * The ownership is not restated here. {@link LIGHTNING_DRIVE} and
 * {@link ONCHAIN_DRIVE} already declare it per route side — that is what M2
 * minted `CorridorPass` for — so this module reads it off them and a corridor
 * that changes its mind is a compile error rather than a second table to keep
 * in step.
 *
 * Three outcomes come from neither machine, and they are the record's and the
 * clock's: `accepted` and `funding` describe a record the drive holds no live
 * state for, and `refunding` a send leg past its deadline with a push in
 * flight. All three still carry the raw word their machine holds, because
 * {@link SwapUpdate.detail} is `RawState` and `RawState` is the raw word.
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

/**
 * What happened to a swap, in one vocabulary for both families.
 *
 * Trader-centric by definition. Fourteen members, §3.5's, and the two that
 * carry the whole point are `refunded` — the trader's value came back — and
 * `lapsed`, the solver reclaiming a lockup the trader failed to claim.
 */
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
 * The untranslated protocol word, for support and audit.
 *
 * A tagged union over the two families rather than a bare string, so M6's
 * cancel path reads the family split off the update one lookup earlier than a
 * repository read. The reason strings are deliberately NOT here: `failure` and
 * `blockedReason` arrive on the record as fields, not as vocabulary, and
 * {@link Swap} is where a consumer reads them.
 *
 * `wire`, `htlc` and `fate` are the supporting vocabularies a pass consults.
 * They are declared because the shape is fixed here rather than left to the
 * first consumer that wants one, and populated by nothing today: the manager
 * surfaces neither the L1 phase nor the lockup fate on its update callback, and
 * the solver's own `RfqStatus` is a self-report no drive pass reads at all.
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

/**
 * Which route side each corridor kind is, and so which {@link CorridorPass}
 * describes its drive.
 *
 * `lightning_send` is `arkade -> lightning`: the trader TAKES on lightning.
 * `lightning_receive` is `lightning -> arkade`: the trader GIVES on it.
 */
export const CORRIDOR_PASS = {
    lightning_send: LIGHTNING_DRIVE.take,
    lightning_receive: LIGHTNING_DRIVE.give,
    onchain_send: ONCHAIN_DRIVE.take,
} as const satisfies Record<CorridorKind, unknown>;

/**
 * Whose the arkade lockup is, per corridor kind — read off the corridor
 * modules' own declarations rather than restated.
 *
 * The arkade lockup is `lockups[0]` on all three, which is the order
 * `CorridorPass.lockups` documents: "every covenant the pass reads, in the
 * order it reads them", and step 1 of every pass is the arkade lockup.
 */
export const LOCKUP_OWNER = {
    lightning_send: CORRIDOR_PASS.lightning_send.lockups[0].owner,
    lightning_receive: CORRIDOR_PASS.lightning_receive.lockups[0].owner,
    onchain_send: CORRIDOR_PASS.onchain_send.lockups[0].owner,
} as const satisfies Record<CorridorKind, LockupOwner>;

/** Whether this kind's drive pass reads L1 — the seam that decides whether the
 * onchain corridor's deps have to be resolved at all. */
export const readsChain = (kind: CorridorKind): boolean =>
    (CORRIDOR_PASS[kind].seams as readonly string[]).includes("chain");

/**
 * One cell of the corridor table.
 *
 * A function of the kind because exactly one cell needs it: `settled` on the
 * trader's lockup is `paid` when the counterparty's hash-verified spend IS the
 * invoice being paid, and `claimed` when the trader already holds the L1 coins
 * its own claim took.
 */
type CorridorCell = (kind: CorridorKind) => Outcome;

const at =
    (outcome: Outcome): CorridorCell =>
    () =>
        outcome;

/**
 * The seven corridor states, keyed by whose lockup the pass reads.
 *
 * Total over `RfqSwapState` × `LockupOwner`, so a state added upstream is a
 * compile error here rather than a swap silently rendering as something
 * misleading — which is the guarantee `activity.ts`'s exhaustive `OUTCOME`
 * already bought for one of the two axes.
 *
 * `claimed` is the sub-decision. The manager's `claimed` is a LOCAL BELIEF — a
 * submission, from which `claimable` is a documented legal backslide — while
 * this vocabulary's `claimed` is a chain fact. So a submitted claim projects to
 * `funded` and the stream stays monotone; a UI wanting a "claim submitted"
 * spinner reads `detail`.
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
        // The solver has funded nothing yet: the invoice is shown and unpaid,
        // which is what makes this `open` where the trader's side is `funded`.
        pending: at("open"),
        claimable: at("funded"),
        claimed: at("funded"),
        needs_counterparty: at("needs_recovery"),
        // The trader's OWN claim, matched by the hash and not by our txid — so
        // a claim that lands without us still counts.
        settled: at("claimed"),
        // The one inversion this whole module exists for: every non-claim leaf
        // of a receive covenant is the solver's, so a lockup spent by one is
        // the trader's incoming payment never arriving.
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
 * Five of the nine `AssetSwapStatus` words are live; the other four —
 * `awaiting_fill`, `claimable`, `claimed`, `refunded_l1` — are onchain-corridor
 * phases nothing writes onto an offer record, and in v2 that corridor is family
 * `rfq`. They are unreachable rather than meaningful, and the cell exists only
 * to keep the map total: a record carrying one is a record this drive does not
 * understand, so it is SURFACED rather than reported as progress.
 *
 * Two of the five live rows are not the drive's to produce. Nothing in M5's
 * loop writes `cancelling` or `cancelled`; both come from the awaited cancel
 * call M6 owns. The mapping is declared here; M6 supplies the transitions.
 */
const OFFER_OUTCOME: Record<AssetSwapStatus, Outcome> = {
    pending: "open",
    cancelling: "cancelling",
    cancelled: "cancelled",
    fulfilled: "filled",
    // A swept deposit: still the trader's money, at a script no offchain spend
    // can reach until it is recovered into a fresh batch.
    recoverable: "needs_recovery",
    awaiting_fill: "needs_recovery",
    claimable: "needs_recovery",
    claimed: "needs_recovery",
    refunded_l1: "needs_recovery",
};

export const offerOutcome = (status: AssetSwapStatus): Outcome => OFFER_OUTCOME[status];

/**
 * What a record reports when nothing live stands behind it.
 *
 * Two of the three record-and-clock projections, and the reason they are a
 * projection at all: nothing is written when a swap is handed to the manager,
 * so the first write is the first pass, and until then the record and the
 * funding txid are the whole answer. A corridor record therefore reads
 * `accepted` until its funding is broadcast and `funding` until the drive
 * adopts it — including the receive leg, whose `accepted -> open` arrow is
 * exactly the durable invoice becoming a watched one.
 *
 * The offer family has no live object of its own — its watcher is event-driven
 * over the store — so past the funding the record IS the state.
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

/**
 * `Outcome`, as `activity.ts`'s opaque grouping token.
 *
 * The resolver's vocabulary is deliberately coarser than this one — it labels a
 * history row, not a swap's state — so this is a projection and not a rename.
 * `lost` is what `lapsed` projects to, which is the token that file already
 * emitted by hand for a receive leg's `refunded`.
 */
export const ACTIVITY_TOKEN: Record<Outcome, string> = {
    accepted: "pending",
    funding: "pending",
    funded: "pending",
    open: "pending",
    // The drive's in-flight states have no user-visible phase distinct from
    // "pending"; `needs_recovery` is different in kind — the swap is BLOCKED —
    // and collapsing it here is the same deliberate choice v1 made, which the
    // opaque-token design permits because apps map tokens themselves.
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
