/**
 * One contract, three implementations: a corridor module owns its destination parse, deps,
 * observation seams, and the lockup-owner axis the drive's outcome table keys on. Keyed by
 * **corridor**, not v1's `RfqSwap["kind"]` route pair. Registration is internal: an externally
 * registered corridor would parse and quote and then sit undriven.
 */
import type { RfqSwapActionName } from "../../swapManager";
import type { Corridor } from "../corridor";
import type { Instrument } from "../route";

/** A module's answer about one destination — three outcomes: *mine, and wrong* (a `tb1…` on
 * mainnet) must surface as `AmbiguousDestination` with the reason, not collapse into *not mine*. */
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

/** Whose covenant it is. Ownership inverts the deadline: a TRADER lockup's deadline is a moment to
 * act after, a SOLVER lockup's a moment to have acted before. */
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

/** Which side of a route this corridor is on; it inverts every ownership answer. */
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
 * A corridor's drive facts, per side. Partial on purpose: `onchain` has no `give` entry because
 * `onchain -> arkade` is outside the `Route` union (covering only its Arkade half would silently let
 * the trader's L1 refund window pass); `arkade` has neither, since `arkade -> arkade` is an offer
 * covenant with no lockup. The arkade leg's lockup is declared by the counter-corridor's entry.
 */
export type CorridorDrive = Partial<Record<RouteSide, CorridorPass>>;

/** One corridor. `deps` are closed over at construction because the parse needs them (network,
 * signer set, decoder) and none is in the destination string. */
export interface CorridorModule<D = unknown> {
    readonly corridor: Corridor;

    /**
     * This corridor's claim over `raw` — a bare destination or a BIP21 URI. **Sync, non-throwing and
     * amount-blind**, matching core's rail contract (`match(req, ctx): boolean`, called bare inside
     * the router's `options()`).
     */
    matches(raw: string): CorridorClaim;

    readonly deps: D;
    readonly drive: CorridorDrive;
}

/** A module's factory, plus `target`: core's dep-free classifier, asked FIRST so a bolt11 never
 * resolves the onchain corridor's deps. */
export interface CorridorFactory<D> {
    (deps: D): CorridorModule<D>;
    /** The destination class this corridor speaks for. Dep-free by
     * construction: core's classifiers read the string and nothing else. */
    readonly target: (raw: string) => string | undefined;
}
