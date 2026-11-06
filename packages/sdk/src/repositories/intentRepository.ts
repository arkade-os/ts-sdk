import { Outpoint } from "../wallet";
import { collectPages, type PageRequest, type PageResult } from "./page";

export type BatchRegistrationState =
    | "waiting_to_submit"
    | "waiting_for_batch"
    | "batch_in_progress"
    | "batch_failed"
    | "batch_succeeded"
    | "cancelled";

/** Every registration state, in lifecycle order. Single source of truth so a new
 *  state is handled by every state-derived helper (terminal/non-terminal). */
export const ALL_INTENT_STATES: readonly BatchRegistrationState[] = [
    "waiting_to_submit",
    "waiting_for_batch",
    "batch_in_progress",
    "batch_failed",
    "batch_succeeded",
    "cancelled",
];

export const BATCH_REGISTRATION_TERMINAL_STATES: ReadonlySet<BatchRegistrationState> = new Set([
    "batch_failed",
    "batch_succeeded",
    "cancelled",
]);

export function isTerminalBatchRegistrationState(s: BatchRegistrationState): boolean {
    return BATCH_REGISTRATION_TERMINAL_STATES.has(s);
}

export interface ArkIntent {
    /** Intent proof tx id. Primary key. */
    intentTxId: string;
    /**
     * Server-assigned batch intent id. Unique when present: saving a *different*
     * intentTxId that reuses a live intentId is rejected (NArk parity). Absent
     * until the intent is registered with arkd.
     */
    intentId?: string;
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
    /** Input VTXOs locked by this intent. */
    intentVtxos: Outpoint[];
}

export interface IntentFilter {
    intentTxIds?: string[];
    intentIds?: string[];
    /** Intents whose `intentVtxos` intersect any of these outpoints. */
    containingInputs?: Outpoint[];
    states?: BatchRegistrationState[];
    /** Intents valid at this ms-epoch instant (null bounds = open). */
    validAt?: number;
    /** Substring match over intentId, batchId, commitmentTransactionId. */
    searchText?: string;
}

export type IntentPageFilter = IntentFilter;

export interface BatchRegistrationRepository extends AsyncDisposable {
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
     * Outpoints held by NON-terminal registrations — `waiting_to_submit`,
     * `waiting_for_batch`, and `batch_in_progress` — to exclude from spendable
     * balance. Terminal states never lock.
     *
     * Deliberate divergence from NArk EF storage, whose `GetLockedVtxoOutpoints`
     * locks only `WaitingToSubmit`/`WaitingForBatch`: the TS wallet balance is
     * offline-first and reads this set as its single source of coin locking, so
     * it must also hold inputs already committed to an in-progress batch. NArk
     * excludes `BatchInProgress` here but protects those inputs through its
     * own services instead.
     */
    getLockedVtxoOutpoints(): Promise<Outpoint[]>;
}

/** @deprecated Use {@link collectBatchRegistrations}. */
export const collectIntents = (
    repository: Pick<IntentRepository, "getIntentsPage">,
    filter?: IntentPageFilter,
) => collectPages((page: PageRequest) => repository.getIntentsPage(filter, page));

/**
 * Enforce the "intentId unique when present" contract for backends without a
 * native partial-unique index (in-memory, Realm). Throws if `intent` carries an
 * intentId already held by a *different* intentTxId. SQLite/IndexedDB enforce
 * the same invariant at the storage layer.
 */
export function assertIntentIdUnique(intent: ArkIntent, existing: Iterable<ArkIntent>): void {
    if (intent.intentId === undefined) return;
    for (const e of existing) {
        if (e.intentTxId !== intent.intentTxId && e.intentId === intent.intentId) {
            throw new Error(
                `intentId "${intent.intentId}" is already used by intent ${e.intentTxId}`,
            );
        }
    }
}

/**
 * Backend-agnostic {@link IntentFilter} predicate shared by every repository.
 * Lives here so backends depend on this interface module, not on each other.
 */
export function intentMatchesFilter(i: ArkIntent, f: IntentFilter): boolean {
    if (f.intentTxIds && !f.intentTxIds.includes(i.intentTxId)) return false;
    if (f.intentIds && (!i.intentId || !f.intentIds.includes(i.intentId))) return false;
    if (f.states && !f.states.includes(i.state)) return false;
    if (f.containingInputs) {
        const keys = new Set(i.intentVtxos.map((o) => `${o.txid}:${o.vout}`));
        if (!f.containingInputs.some((o) => keys.has(`${o.txid}:${o.vout}`))) return false;
    }
    if (f.validAt !== undefined) {
        if (i.validFrom !== undefined && f.validAt < i.validFrom) return false;
        if (i.validUntil !== undefined && f.validAt > i.validUntil) return false;
    }
    if (f.searchText) {
        const hay = [i.intentId, i.batchId, i.commitmentTransactionId].filter(Boolean).join(" ");
        if (!hay.includes(f.searchText)) return false;
    }
    return true;
}

/** @deprecated Use {@link BatchRegistrationState}. */
export type ArkIntentState = BatchRegistrationState;
/** @deprecated Use {@link BatchRegistrationRepository}. */
export type IntentRepository = BatchRegistrationRepository;
/** @deprecated Use {@link isTerminalBatchRegistrationState}. */
export const isTerminalIntentState = isTerminalBatchRegistrationState;
/** @deprecated Use {@link BATCH_REGISTRATION_TERMINAL_STATES}. */
export const INTENT_TERMINAL_STATES = BATCH_REGISTRATION_TERMINAL_STATES;
/** Collects in primary key order; sort by `createdAt` for chronological display. */
export const collectBatchRegistrations = collectIntents;
