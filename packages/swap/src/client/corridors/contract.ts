/**
 * One contract, three implementations.
 *
 * A corridor module owns four things: its parse claim over destination strings
 * and the {@link Instrument} that claim produces, the deps it closes over, the
 * observation seams a drive pass reads, and the lockup-owner axis the outcome
 * table keys on. Not the table itself — the module declares the axis, and the
 * drive layer writes the table against it.
 *
 * The key is the **corridor**, not v1's `RfqSwap["kind"]`. That union —
 * `lightning_send | onchain_send | lightning_receive` — is a route pair, and two
 * of its three members are the lightning corridor seen from opposite ends. The
 * kind-keyed `RfqCorridorHandler` in `../../rfqCorridor.ts` is untouched and
 * stays: `project`/`hydrate` are per-route facts about a *stored record*, and
 * folding them in here would make this module own a persistence schema it does
 * not decide.
 *
 * Registration is internal, exactly as `rfqCorridor.ts` argues for its own
 * registry: a corridor registered from outside would parse and quote and then
 * sit undriven, which is worse than not being registrable at all.
 */
import type { RfqSwapActionName } from "../../swapManager";
import type { Corridor } from "../corridor";
import type { Instrument } from "../route";

/**
 * A module's answer about one destination string. Three outcomes, not two.
 *
 * "An {@link Instrument} or nothing" cannot say *mine, and wrong* — a `tb1…` on
 * a mainnet wallet, another operator's Arkade address, a bolt11 the shape-only
 * classifier admits and the decoder then refuses. Collapsing those into *not
 * mine* hands a well-formed destination to `UnsupportedRoute`, which names the
 * wrong fault, so the refusal is its own arm and the registry turns it into
 * `AmbiguousDestination` with the reason attached.
 *
 * The two object arms are mutually exclusive by construction (`refused?: never`
 * / `claimed?: never`), so the registry's count over them is total.
 */
export type CorridorClaim =
    | { claimed: Instrument; refused?: never }
    | { refused: string; claimed?: never }
    | undefined;

/** What a drive pass reads. Two, and a solver status read is not one of them. */
export type ObservationSeam =
    /** Arkade access — `RfqSwapManagerDeps.indexer`. */
    | "indexer"
    /** L1 access — `RfqSwapManagerDeps.chain`. */
    | "chain";

/** A covenant a pass reads. */
export type CorridorCovenant =
    /** The Arkade-side VHTLC every corridor route has exactly one of. */
    | "arkade_lockup"
    /** The L1 HTLC, which only `arkade -> onchain` adds. */
    | "onchain_htlc";

/**
 * Whose covenant it is — the axis the outcome table keys on.
 *
 * *Which* lockup a pass reads does not discriminate: every route reads the same
 * Arkade lockup and only `arkade -> onchain` reads a second. What inverts is
 * ownership, and with it what to do about the deadline: on a give-side leg the
 * lockup is the TRADER's and the deadline is a moment to act after, on a
 * take-side leg it is the SOLVER's and the deadline is a moment to have acted
 * before.
 */
export type LockupOwner = "trader" | "solver";

/** The deadlines the code already fixes. Margins belong to the drive layer. */
export type CorridorDeadline =
    /** `RfqSwapCommon.refundLocktime`, on every kind. */
    | "refund_locktime"
    /** `OnchainSendSwap.htlc.refundLocktime`, on `arkade -> onchain` alone. */
    | "htlc_refund_locktime";

/** One covenant a pass reads, with its owner and the deadline it runs against. */
export interface CorridorLockup {
    readonly covenant: CorridorCovenant;
    readonly owner: LockupOwner;
    readonly deadline: CorridorDeadline;
}

/**
 * Which side of a route this corridor is on: the trader gives on it, or takes
 * on it. The direction is what inverts every ownership answer below.
 */
export type RouteSide = "give" | "take";

/** What a drive pass does about a route whose non-arkade leg is this corridor. */
export interface CorridorPass {
    /** Every covenant the pass reads, in the order it reads them. */
    readonly lockups: readonly CorridorLockup[];
    /** The actions the manager may execute; a subset of v1's own union. */
    readonly actions: readonly RfqSwapActionName[];
    /** The seams the pass reads. */
    readonly seams: readonly ObservationSeam[];
}

/**
 * A corridor's drive facts, per side of the route it serves.
 *
 * Partial on purpose, and each absence is a decision: `onchain` has no `give`
 * entry because `onchain -> arkade` is outside the `Route` union — covering its
 * Arkade half alone would produce a manager that silently lets the trader's L1
 * refund window pass — and `arkade` has neither, because `arkade -> arkade` is
 * an offer covenant with no lockup, no RFQ deadline and no manager action. On
 * every corridor route the arkade leg's lockup IS the route's lockup, and it is
 * declared once, by the counter-corridor's entry.
 */
export type CorridorDrive = Partial<Record<RouteSide, CorridorPass>>;

/**
 * One corridor.
 *
 * `deps` are closed over at construction rather than passed per call: the
 * network, the operator's signer set and the decoder are all needed at the
 * parse, and none of them is in the destination string.
 */
export interface CorridorModule<D = unknown> {
    readonly corridor: Corridor;

    /**
     * This corridor's claim over `raw` — a bare destination or a BIP21 URI.
     *
     * **Sync, non-throwing and amount-blind**, and none of the three is this
     * module's to reopen: core's rail contract is `match(req, ctx): boolean`,
     * "classification only — amount-blind", and core's router calls it bare
     * inside `options()`. A plain Arkade destination stays core's own `ark` rail
     * and is wrapped by nothing, but one shape across all three beats a second
     * one for the corridor that happens not to be wrapped.
     */
    matches(raw: string): CorridorClaim;

    readonly deps: D;
    readonly drive: CorridorDrive;
}

/**
 * A module's factory, plus the one question that can be asked without deps.
 *
 * `target` is core's classifier for this corridor's destination class — the
 * same one `matches` extracts with, named once so there is no second spelling
 * to drift. The registry asks it FIRST, and that is what keeps
 * `MissingCorridorDep`'s contract: a bolt11 arriving while the onchain chain
 * source is overridden to `null` must not resolve the onchain corridor's deps,
 * because a missing dep for a corridor nobody uses is not an error.
 */
export interface CorridorFactory<D> {
    (deps: D): CorridorModule<D>;
    /** The destination class this corridor speaks for. Dep-free by
     * construction: core's classifiers read the string and nothing else. */
    readonly target: (raw: string) => string | undefined;
}
