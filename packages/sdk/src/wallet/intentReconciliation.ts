import { collectIntents } from "../repositories/intentRepository";
import { IndexerProvider } from "../providers/indexer";
import { ArkErrorName, isArkError } from "../providers/errors";
import type { Intent } from "../intent";
import type { SignedIntent } from "../providers/ark";
import {
    ALL_INTENT_STATES,
    ArkIntent,
    ArkIntentState,
    IntentRepository,
    isTerminalIntentState,
} from "../repositories/intentRepository";
import type { Outpoint, VirtualCoin } from ".";
import { getNormalizedVtxos, isVtxoSpent } from "./vtxo";

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
    /**
     * Replays an intent's stored delete proof against arkd. Absent ⇒ a submitted, unexpired
     * intent stays locked, since arkd never expires a queued intent on its own.
     */
    deleteIntent?: (intent: SignedIntent<Intent.DeleteMessage>) => Promise<void>;
    /**
     * Whether a live settlement in this wallet is spending the outpoint. An intent with an
     * in-flight input belongs to that settlement and is skipped.
     */
    isOutpointInFlight?: (outpoint: Outpoint) => boolean;
    /** Injectable clock (tests). Defaults to `Date.now`. */
    now?: () => number;
}

/** A VTXO is consumed once the indexer reports it spent (offchain) or settled onchain. */
function isConsumed(vtxo: VirtualCoin | undefined): boolean {
    return vtxo !== undefined && isVtxoSpent(vtxo);
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
 *   - any input unilaterally exited → `cancelled` (an onchain output cannot be
 *     an input to a batch, so the intent is dead however the server records it);
 *   - never submitted (`waiting_to_submit`), inputs still unspent → `cancelled`
 *     (arkd never saw it, so the inputs are safe to unlock);
 *   - past `validUntil`, inputs still unspent → `cancelled` (expired);
 *   - otherwise (submitted, unspent, unexpired) → left non-terminal: it may
 *     still be a live server-held intent, so its inputs stay locked until
 *     {@link reconcileIntents} releases it from the server.
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

    // An exited input can never be batched, so the intent is dead — and unlike
    // the cases below, waiting does not help. Tested after `batch_succeeded`, so
    // an input that settled AND unrolled still reports the settlement.
    //
    // Bare `isUnrolled`, not `canSweepOnchain`: the question here is whether the
    // input can still join a batch, and an exited output cannot whether or not
    // its onchain spend has happened yet.
    if (consumed.some((vtxo) => vtxo?.isUnrolled)) {
        return terminal(intent, "cancelled", now, {
            cancellationReason: "reconciliation: an input was unilaterally exited",
        });
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
 * A submitted intent that is neither is deleted from arkd with its stored proof
 * and cancelled once the server confirms it holds no such intent. Intents with
 * an input in flight in this wallet are skipped.
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
        intents = await collectIntents(deps.intentRepository, {
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
            const { vtxos } = await getNormalizedVtxos(deps.indexerProvider, { outpoints });
            vtxosByOutpoint = new Map(vtxos.map((v) => [outpointKey(v), v]));
        } catch (e) {
            console.error("reconcileIntents: failed to fetch input VTXO state", e);
            return;
        }
    }

    const nowMs = now();
    for (const intent of intents) {
        try {
            if (isInFlight(intent, deps)) continue;
            const next =
                (await classifyIntent(intent, vtxosByOutpoint, nowMs)) ??
                (await releaseFromServer(intent, deps, nowMs));
            if (!next) continue;
            // Freshness guard: reconciliation runs on reconnect, alongside
            // in-flight settlements. Re-read and only persist if the intent is
            // still in the state we classified, so a live settle() that has
            // since advanced it is never overwritten.
            const [fresh] = await collectIntents(deps.intentRepository, {
                intentTxIds: [intent.intentTxId],
            });
            if (!fresh || fresh.state !== intent.state) continue;
            await deps.intentRepository.saveIntent(next);
        } catch (e) {
            console.error(`reconcileIntents: failed to reconcile intent ${intent.intentTxId}`, e);
        }
    }
}

type ReleaseDeps = Pick<
    IntentReconciliationDeps,
    "intentRepository" | "deleteIntent" | "isOutpointInFlight" | "now"
>;

/**
 * Delete every non-terminal intent from arkd before its store is wiped, so no proof the server
 * still needs is lost. True only when each is confirmed gone; without `deleteIntent`, only when
 * there is nothing to release.
 */
export async function releaseIntents(deps: ReleaseDeps): Promise<boolean> {
    let intents: ArkIntent[];
    try {
        intents = await collectIntents(deps.intentRepository, {
            states: [...NON_TERMINAL_INTENT_STATES],
        });
    } catch (e) {
        console.error("releaseIntents: failed to read non-terminal intents", e);
        return false;
    }
    const now = deps.now ?? Date.now;
    let released = true;
    for (const intent of intents) {
        if (!(await releaseFromServer(intent, deps, now()))) released = false;
    }
    return released;
}

function isInFlight(intent: ArkIntent, deps: ReleaseDeps): boolean {
    const inFlight = deps.isOutpointInFlight;
    return inFlight !== undefined && intent.intentVtxos.some((o) => inFlight(o));
}

/**
 * Delete a submitted intent from arkd with its stored proof (`expire_at: 0`, so it needs no
 * signer). Only a confirmed removal cancels it: any other failure leaves the inputs locked.
 */
async function releaseFromServer(
    intent: ArkIntent,
    deps: ReleaseDeps,
    now: number,
): Promise<ArkIntent | undefined> {
    // Re-checked: a settle may have claimed these inputs since the loop's check.
    if (!deps.deleteIntent || isInFlight(intent, deps)) return undefined;
    try {
        const message = JSON.parse(intent.deleteProofMessage) as Intent.DeleteMessage;
        await deps.deleteIntent({ proof: intent.deleteProof, message });
    } catch (e) {
        if (!isNoMatchingIntentsError(e)) {
            console.warn(`failed to delete intent ${intent.intentTxId} from the server`, e);
            return undefined;
        }
    }
    return terminal(intent, "cancelled", now, {
        cancellationReason: "reconciliation: intent released from the server",
    });
}

/**
 * arkd's answer when no queued intent spends the proof's inputs. The name alone is not enough:
 * arkd also returns it for a proof that fails verification.
 */
export function isNoMatchingIntentsError(e: unknown): boolean {
    return (
        isArkError(e, ArkErrorName.INVALID_INTENT_PROOF) &&
        e.message.includes("no matching intents found")
    );
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
