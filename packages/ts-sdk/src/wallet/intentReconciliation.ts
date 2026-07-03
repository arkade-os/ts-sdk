import { IndexerProvider } from "../providers/indexer";
import {
    ALL_INTENT_STATES,
    ArkIntent,
    ArkIntentState,
    IntentRepository,
    isTerminalIntentState,
} from "../repositories/intentRepository";
import type { Outpoint, VirtualCoin } from ".";

/**
 * Intent states a persisted intent can be stuck in after a crash: none of
 * these is terminal, so on their own they hide the intent's input VTXOs from
 * spendable balance forever (see {@link IntentRepository.getLockedVtxoOutpoints}).
 *
 * Derived from {@link ALL_INTENT_STATES} so a newly added state only has to be
 * classified terminal-or-not in one place ({@link isTerminalIntentState}).
 */
export const NON_TERMINAL_INTENT_STATES: readonly ArkIntentState[] = ALL_INTENT_STATES.filter(
    (s) => !isTerminalIntentState(s),
);

/** Minimal indexer surface the reconciler needs. */
export type IntentReconcilerIndexer = Pick<IndexerProvider, "getVtxos">;

export interface IntentReconciliationDeps {
    intentRepository: IntentRepository;
    indexerProvider: IntentReconcilerIndexer;
    /** Injectable clock (tests). Defaults to `Date.now`. */
    now?: () => number;
}

/** A VTXO is consumed once the indexer reports it spent (offchain) or settled onchain. */
function isConsumed(vtxo: VirtualCoin | undefined): boolean {
    return vtxo !== undefined && (vtxo.isSpent === true || vtxo.settledBy !== undefined);
}

/**
 * Classify one non-terminal intent against authoritative indexer VTXO state,
 * returning the intent to persist (with a terminal state) or `undefined` to
 * leave it untouched (still-live / unprovable).
 *
 * Mirrors NArk's stale-intent handling. The classification is deliberately
 * conservative — an intent is only forced terminal when the outcome is
 * provable, because cancelling a row whose inputs arkd still holds would
 * *unhide* VTXOs that are not actually spendable:
 *
 *   - all inputs consumed by a batch  → `batch_succeeded` (the money moved;
 *     the crash lost only the local record, not the funds);
 *   - never submitted (`waiting_to_submit`), inputs still unspent → `cancelled`
 *     (arkd never saw it, so the inputs are safe to unlock);
 *   - past `validUntil`, inputs still unspent → `cancelled` (expired);
 *   - otherwise (submitted, unspent, unexpired) → left non-terminal: it may
 *     still be a live server-held intent, so its inputs stay locked.
 */
export async function classifyIntent(
    intent: ArkIntent,
    vtxosByOutpoint: Map<string, VirtualCoin>,
    now: number,
): Promise<ArkIntent | undefined> {
    if (isTerminalIntentState(intent.state)) return undefined;

    const inputs = intent.intentVtxos;
    const consumed = inputs.map((o) => vtxosByOutpoint.get(outpointKey(o)));

    // All inputs consumed by a completed batch: the settlement succeeded even
    // though the process died before the event reducer recorded it. Recover the
    // commitment id from the settling VTXO when the local record lacks it.
    if (inputs.length > 0 && consumed.every(isConsumed)) {
        const commitmentTransactionId =
            intent.commitmentTransactionId ??
            consumed.map((v) => v?.settledBy).find((s): s is string => !!s);
        return terminal(intent, "batch_succeeded", now, { commitmentTransactionId });
    }

    // From here the inputs are (at least partly) still unspent.
    if (intent.state === "waiting_to_submit") {
        return terminal(intent, "cancelled", now, {
            cancellationReason: "reconciliation: intent was never submitted before restart",
        });
    }

    if (intent.validUntil !== undefined && intent.validUntil < now) {
        return terminal(intent, "cancelled", now, {
            cancellationReason: "reconciliation: intent expired",
        });
    }

    // Submitted, inputs unspent, not expired: cannot prove the intent is dead.
    // It may still be a live server-held intent, so leave it locked.
    return undefined;
}

/**
 * Reconcile every persisted non-terminal intent against authoritative indexer
 * state, persisting a terminal result for those that are provably done or dead.
 *
 * Belongs to the online sync path — {@link ContractManager} drives it on boot,
 * on subscription reconnect, and on delta sync. It is **not** called from
 * `getBalance()`, which stays offline-first. Best-effort throughout: a failure
 * to read the intent store or reconcile a single intent is logged and skipped
 * so it can never break sync. Never runs when no intent store is configured.
 */
export async function reconcileIntents(deps: IntentReconciliationDeps): Promise<void> {
    const now = deps.now ?? Date.now;
    let intents: ArkIntent[];
    try {
        intents = await deps.intentRepository.getIntents({
            states: [...NON_TERMINAL_INTENT_STATES],
        });
    } catch (e) {
        console.error("reconcileIntents: failed to read non-terminal intents", e);
        return;
    }
    if (intents.length === 0) return;

    // One indexer round-trip covering every locked input across all intents.
    const outpoints: Outpoint[] = dedupeOutpoints(intents.flatMap((i) => i.intentVtxos));
    let vtxosByOutpoint = new Map<string, VirtualCoin>();
    if (outpoints.length > 0) {
        try {
            const { vtxos } = await deps.indexerProvider.getVtxos({ outpoints });
            vtxosByOutpoint = new Map(vtxos.map((v) => [outpointKey(v), v]));
        } catch (e) {
            console.error("reconcileIntents: failed to fetch input VTXO state", e);
            return;
        }
    }

    const nowMs = now();
    for (const intent of intents) {
        try {
            const next = await classifyIntent(intent, vtxosByOutpoint, nowMs);
            if (!next) continue;
            // Freshness guard: a live settle() can advance this intent
            // (e.g. waiting_to_submit → waiting_for_batch) between the snapshot
            // read above and this write — reconciliation runs on reconnect,
            // concurrently with in-flight settlements. Re-read and only persist
            // the terminal result if the intent is still in the state we
            // classified, so we never overwrite a live in-process outcome.
            const [fresh] = await deps.intentRepository.getIntents({
                intentTxIds: [intent.intentTxId],
            });
            if (!fresh || fresh.state !== intent.state) continue;
            await deps.intentRepository.saveIntent(next);
        } catch (e) {
            console.error(`reconcileIntents: failed to reconcile intent ${intent.intentTxId}`, e);
        }
    }
}

function terminal(
    intent: ArkIntent,
    state: ArkIntentState,
    now: number,
    patch: Partial<ArkIntent>,
): ArkIntent {
    return { ...intent, ...patch, state, updatedAt: now };
}

function outpointKey(o: Outpoint): string {
    return `${o.txid}:${o.vout}`;
}

function dedupeOutpoints(outpoints: Outpoint[]): Outpoint[] {
    const seen = new Set<string>();
    const out: Outpoint[] = [];
    for (const o of outpoints) {
        const k = outpointKey(o);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(o);
    }
    return out;
}
