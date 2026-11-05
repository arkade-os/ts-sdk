import { Outpoint } from "../wallet";
import { collectPages, type PageRequest, type PageResult } from "./page";

export type ArkIntentState =
    | "waiting_to_submit"
    | "waiting_for_batch"
    | "batch_in_progress"
    | "batch_failed"
    | "batch_succeeded"
    | "cancelled";

/** Every intent state, in lifecycle order. Single source of truth so a new
 *  state is handled by every state-derived helper (terminal/non-terminal). */
export const ALL_INTENT_STATES: readonly ArkIntentState[] = [
    "waiting_to_submit",
    "waiting_for_batch",
    "batch_in_progress",
    "batch_failed",
    "batch_succeeded",
    "cancelled",
];

export const INTENT_TERMINAL_STATES: ReadonlySet<ArkIntentState> = new Set([
    "batch_failed",
    "batch_succeeded",
    "cancelled",
]);

export function isTerminalIntentState(s: ArkIntentState): boolean {
    return INTENT_TERMINAL_STATES.has(s);
}

/**
 * A wallet's request to join a batch, tracked from signing to its terminal state.
 * Backends keep their older column and key names on disk and map them here. No data
 * migration runs, so an in-flight lock survives an upgrade or a rollback.
 */
export interface BatchRegistration {
    /** Register proof tx id. Primary key. */
    proofTxId: string;
    /**
     * Operator-assigned registration id. Unique when present: saving a *different*
     * proofTxId that reuses a live registrationId is rejected (NArk parity). Absent
     * until the proof is registered with the operator.
     */
    registrationId?: string;
    state: ArkIntentState;
    validFrom?: number;
    validUntil?: number;
    createdAt: number;
    updatedAt: number;
    /** hex PSBT. */
    registerProof: string;
    /** canonical JSON signed by the register proof. */
    registerProofMessage: string;
    /** hex PSBT. */
    deleteProof: string;
    deleteProofMessage: string;
    batchId?: string;
    commitmentTransactionId?: string;
    cancellationReason?: string;
    partialForfeits: string[];
    signerDescriptor?: string;
    /** Inputs locked by this registration. */
    inputs: Outpoint[];
}

export interface BatchRegistrationFilter {
    proofTxIds?: string[];
    registrationIds?: string[];
    /** Registrations whose `inputs` intersect any of these outpoints. */
    containingInputs?: Outpoint[];
    states?: ArkIntentState[];
    /** Intents valid at this ms-epoch instant (null bounds = open). */
    validAt?: number;
    /** Substring match over registrationId, batchId, commitmentTransactionId. */
    searchText?: string;
}

export type BatchRegistrationPageFilter = BatchRegistrationFilter;

/** @deprecated Use {@link BatchRegistration}. */
export type ArkIntent = BatchRegistration;
/** @deprecated Use {@link BatchRegistrationFilter}. */
export type IntentFilter = BatchRegistrationFilter;
/** @deprecated Use {@link BatchRegistrationPageFilter}. */
export type IntentPageFilter = BatchRegistrationPageFilter;

export interface IntentRepository extends AsyncDisposable {
    readonly version: 1;
    clear(): Promise<void>;
    /** Upsert by `intentTxId`; implementation sets `updatedAt = Date.now()`. */
    saveIntent(intent: ArkIntent): Promise<void>;
    /** Bounded intents in `intentTxId` order, not chronological order; `after` is exclusive. */
    getIntentsPage(
        filter: IntentPageFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<ArkIntent>>;
    /**
     * Outpoints held by NON-terminal intents — `waiting_to_submit`,
     * `waiting_for_batch`, and `batch_in_progress` — to exclude from spendable
     * balance. Terminal states never lock.
     *
     * Deliberate divergence from NArk EF storage, whose `GetLockedVtxoOutpoints`
     * locks only `WaitingToSubmit`/`WaitingForBatch`: the TS wallet balance is
     * offline-first and reads this set as its single source of coin locking, so
     * it must also hold inputs already committed to an in-progress batch. NArk
     * excludes `BatchInProgress` here but protects those inputs through its
     * active-intent services instead.
     */
    getLockedVtxoOutpoints(): Promise<Outpoint[]>;
}

/** Collects in `intentTxId` order; sort by `createdAt` for chronological display. */
export const collectIntents = (
    repository: Pick<IntentRepository, "getIntentsPage">,
    filter?: IntentPageFilter,
) => collectPages((page: PageRequest) => repository.getIntentsPage(filter, page));

/**
 * Enforce the "registrationId unique when present" contract for backends without a
 * native partial-unique index (in-memory, Realm). Throws if `intent` carries a
 * registrationId already held by a *different* proofTxId. SQLite/IndexedDB enforce
 * the same invariant at the storage layer.
 */
export function assertIntentIdUnique(
    intent: BatchRegistration,
    existing: Iterable<BatchRegistration>,
): void {
    if (intent.registrationId === undefined) return;
    for (const e of existing) {
        if (e.proofTxId !== intent.proofTxId && e.registrationId === intent.registrationId) {
            throw new Error(
                `registrationId "${intent.registrationId}" is already used by ${e.proofTxId}`,
            );
        }
    }
}

/**
 * Backend-agnostic {@link BatchRegistrationFilter} predicate shared by every repository.
 * Lives here so backends depend on this interface module, not on each other.
 */
export function intentMatchesFilter(i: BatchRegistration, f: BatchRegistrationFilter): boolean {
    if (f.proofTxIds && !f.proofTxIds.includes(i.proofTxId)) return false;
    if (f.registrationIds && (!i.registrationId || !f.registrationIds.includes(i.registrationId)))
        return false;
    if (f.states && !f.states.includes(i.state)) return false;
    if (f.containingInputs) {
        const keys = new Set(i.inputs.map((o) => `${o.txid}:${o.vout}`));
        if (!f.containingInputs.some((o) => keys.has(`${o.txid}:${o.vout}`))) return false;
    }
    if (f.validAt !== undefined) {
        if (i.validFrom !== undefined && f.validAt < i.validFrom) return false;
        if (i.validUntil !== undefined && f.validAt > i.validUntil) return false;
    }
    if (f.searchText) {
        const hay = [i.registrationId, i.batchId, i.commitmentTransactionId]
            .filter(Boolean)
            .join(" ");
        if (!hay.includes(f.searchText)) return false;
    }
    return true;
}
