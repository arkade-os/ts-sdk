import { Outpoint } from "../wallet";

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

export interface ArkIntent {
    /** Intent proof tx id. Primary key. */
    intentTxId: string;
    /** Server-assigned; unique when present. */
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
    states?: ArkIntentState[];
    /** Intents valid at this ms-epoch instant (null bounds = open). */
    validAt?: number;
    /** Substring match over intentId, batchId, commitmentTransactionId. */
    searchText?: string;
    skip?: number;
    take?: number;
}

export interface IntentRepository extends AsyncDisposable {
    readonly version: 1;
    clear(): Promise<void>;
    /** Upsert by `intentTxId`; implementation sets `updatedAt = Date.now()`. */
    saveIntent(intent: ArkIntent): Promise<void>;
    getIntents(filter?: IntentFilter): Promise<ArkIntent[]>;
    /** Outpoints held by NON-terminal intents (for spendable-balance exclusion). */
    getLockedVtxoOutpoints(): Promise<Outpoint[]>;
}

/**
 * Backend-agnostic {@link IntentFilter} predicate shared by every repository
 * that filters in memory (InMemory, Realm). Lives here so backends depend on
 * this interface module rather than on each other.
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

/**
 * Clamp {@link IntentFilter} pagination to a concrete `[skip, end]` slice
 * window over `total` rows, treating missing/negative values as 0 (`take`
 * defaults to "all remaining"). Keeps backends off JS's relative-to-end
 * `slice` behavior for negative bounds.
 */
export function intentPageBounds(
    filter: IntentFilter | undefined,
    total: number,
): { skip: number; end: number } {
    const skip = Math.max(0, filter?.skip ?? 0);
    const take = filter?.take === undefined ? total : Math.max(0, filter.take);
    return { skip, end: skip + take };
}
