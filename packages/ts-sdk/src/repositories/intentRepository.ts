import { Outpoint } from "../wallet";

export type ArkIntentState =
    | "waiting_to_submit"
    | "waiting_for_batch"
    | "batch_in_progress"
    | "batch_failed"
    | "batch_succeeded"
    | "cancelled";

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
