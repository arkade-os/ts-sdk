import { collectBatchRegistrations } from "../repositories/batchRegistrationRepository";
import { IndexerProvider } from "../providers/indexer";
import { ArkErrorName, isArkError } from "../providers/errors";
import type { Proof } from "../proof";
import type { SignedProof } from "../providers/ark";
import {
    ALL_BATCH_REGISTRATION_STATES,
    BatchRegistration,
    BatchRegistrationState,
    BatchRegistrationRepository,
    isTerminalBatchRegistrationState,
} from "../repositories/batchRegistrationRepository";
import type { Outpoint, VirtualCoin } from ".";
import { getNormalizedVtxos, isVtxoSpent } from "./vtxo";

/**
 * States a persisted registration can be stuck in after a crash: none of
 * these is terminal, so on their own they hide the registration's input VTXOs from
 * spendable balance forever (see {@link BatchRegistrationRepository.getLockedVtxoOutpoints}).
 *
 * Derived from {@link ALL_BATCH_REGISTRATION_STATES} so a newly added state only has to be
 * classified terminal-or-not in one place ({@link isTerminalBatchRegistrationState}).
 */
export const NON_TERMINAL_BATCH_REGISTRATION_STATES: readonly BatchRegistrationState[] =
    ALL_BATCH_REGISTRATION_STATES.filter((s) => !isTerminalBatchRegistrationState(s));

/** Minimal indexer surface the reconciler needs. */
export type RegistrationReconcilerIndexer = Pick<IndexerProvider, "getVtxos">;

export interface RegistrationReconciliationDeps {
    batchRegistrationRepository: BatchRegistrationRepository;
    indexerProvider: RegistrationReconcilerIndexer;
    /**
     * Replays a registration's stored delete proof against arkd. Absent ⇒ an unresolved, unexpired
     * registration stays locked, since arkd never expires a queued registration on its own.
     */
    deleteRegistration?: (registration: SignedProof<Proof.DeleteMessage>) => Promise<void>;
    /**
     * Whether a live settlement in this wallet is spending the outpoint. A registration with an
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
 * Classify one non-terminal registration against authoritative indexer VTXO state,
 * returning the registration to persist (with a terminal state) or `undefined` to
 * leave it untouched (still-live / unprovable).
 *
 * Mirrors NArk's stale-registration handling. The classification is deliberately
 * conservative — a registration is only forced terminal when the outcome is
 * provable, because cancelling a row whose inputs arkd still holds would
 * *unhide* VTXOs that are not actually spendable:
 *
 *   - all inputs consumed by a batch  → `batch_succeeded` (the money moved;
 *     the crash lost only the local record, not the funds);
 *   - any input unilaterally exited → `cancelled` (an onchain output cannot be
 *     an input to a batch, so the registration is dead however the server records it);
 *   - past `validUntil`, inputs still unspent → `cancelled` (expired);
 *   - otherwise (unspent, unexpired) → left non-terminal: it may
 *     still be a live server-held registration, so its inputs stay locked until
 *     {@link reconcileRegistrations} releases it from the server.
 */
export async function classifyRegistration(
    registration: BatchRegistration,
    vtxosByOutpoint: Map<string, VirtualCoin>,
    now: number,
): Promise<BatchRegistration | undefined> {
    if (isTerminalBatchRegistrationState(registration.state)) return undefined;

    const inputs = registration.inputs;
    const consumed = inputs.map((o) => vtxosByOutpoint.get(outpointKey(o)));

    // All inputs consumed by a completed batch: the settlement succeeded even
    // though the process died before the event reducer recorded it. Recover the
    // commitment id from the settling VTXO when the local record lacks it.
    if (inputs.length > 0 && consumed.every(isConsumed)) {
        const commitmentTransactionId =
            registration.commitmentTransactionId ??
            consumed.map((v) => v?.settledBy).find((s): s is string => !!s);
        return terminal(registration, "batch_succeeded", now, { commitmentTransactionId });
    }

    // An exited input can never be batched, so the registration is dead — and unlike
    // the cases below, waiting does not help. Tested after `batch_succeeded`, so
    // an input that settled AND unrolled still reports the settlement.
    //
    // Bare `isUnrolled`, not `canSweepOnchain`: the question here is whether the
    // input can still join a batch, and an exited output cannot whether or not
    // its onchain spend has happened yet.
    if (consumed.some((vtxo) => vtxo?.isUnrolled)) {
        return terminal(registration, "cancelled", now, {
            cancellationReason: "reconciliation: an input was unilaterally exited",
        });
    }

    if (registration.validUntil !== undefined && registration.validUntil < now) {
        return terminal(registration, "cancelled", now, {
            cancellationReason: "reconciliation: registration expired",
        });
    }

    // Even waiting_to_submit may have lost a successful registration response.
    return undefined;
}

/**
 * Reconcile every persisted non-terminal registration against authoritative indexer
 * state, persisting a terminal result for those that are provably done or dead.
 * An unresolved registration is deleted from arkd with its stored proof
 * and cancelled once the server confirms it holds no such registration. Registrations with
 * an input in flight in this wallet are skipped.
 *
 * Belongs to the online sync path — {@link ContractManager} drives it on boot,
 * on subscription reconnect, and on delta sync. It is **not** called from
 * `getBalance()`, which stays offline-first. Best-effort throughout: a failure
 * to read the registration store or reconcile a single registration is logged and skipped
 * so it can never break sync. Never runs when no registration store is configured.
 */
export async function reconcileRegistrations(deps: RegistrationReconciliationDeps): Promise<void> {
    const now = deps.now ?? Date.now;
    let registrations: BatchRegistration[];
    try {
        registrations = await collectBatchRegistrations(deps.batchRegistrationRepository, {
            states: [...NON_TERMINAL_BATCH_REGISTRATION_STATES],
        });
    } catch (e) {
        console.error("reconcileRegistrations: failed to read non-terminal registrations", e);
        return;
    }
    if (registrations.length === 0) return;

    // One indexer round-trip covering every locked input across all registrations.
    const outpoints: Outpoint[] = dedupeOutpoints(registrations.flatMap((i) => i.inputs));
    let vtxosByOutpoint = new Map<string, VirtualCoin>();
    if (outpoints.length > 0) {
        try {
            const { vtxos } = await getNormalizedVtxos(deps.indexerProvider, { outpoints });
            vtxosByOutpoint = new Map(vtxos.map((v) => [outpointKey(v), v]));
        } catch (e) {
            console.error("reconcileRegistrations: failed to fetch input VTXO state", e);
            return;
        }
    }

    const nowMs = now();
    for (const registration of registrations) {
        try {
            if (isInFlight(registration, deps)) continue;
            const next =
                (await classifyRegistration(registration, vtxosByOutpoint, nowMs)) ??
                (await releaseFromServer(registration, deps, nowMs));
            if (!next) continue;
            // Freshness guard: reconciliation runs on reconnect, alongside
            // in-flight settlements. Re-read and only persist if the registration is
            // still in the state we classified, so a live settle() that has
            // since advanced it is never overwritten.
            const [fresh] = await collectBatchRegistrations(deps.batchRegistrationRepository, {
                proofTxIds: [registration.proofTxId],
            });
            if (!fresh || fresh.state !== registration.state) continue;
            await deps.batchRegistrationRepository.saveRegistration(next);
        } catch (e) {
            console.error(
                `reconcileRegistrations: failed to reconcile registration ${registration.proofTxId}`,
                e,
            );
        }
    }
}

type ReleaseDeps = Pick<
    RegistrationReconciliationDeps,
    "batchRegistrationRepository" | "deleteRegistration" | "isOutpointInFlight" | "now"
>;

/**
 * Delete every non-terminal registration from arkd before its store is wiped, so no proof the server
 * still needs is lost. True only when each is confirmed gone; without `deleteRegistration`, only when
 * there is nothing to release.
 */
export async function releaseRegistrations(deps: ReleaseDeps): Promise<boolean> {
    let registrations: BatchRegistration[];
    try {
        registrations = await collectBatchRegistrations(deps.batchRegistrationRepository, {
            states: [...NON_TERMINAL_BATCH_REGISTRATION_STATES],
        });
    } catch (e) {
        console.error("releaseRegistrations: failed to read non-terminal registrations", e);
        return false;
    }
    const now = deps.now ?? Date.now;
    let released = true;
    for (const registration of registrations) {
        if (!(await releaseFromServer(registration, deps, now()))) released = false;
    }
    return released;
}

function isInFlight(registration: BatchRegistration, deps: ReleaseDeps): boolean {
    const inFlight = deps.isOutpointInFlight;
    return inFlight !== undefined && registration.inputs.some((o) => inFlight(o));
}

/**
 * Delete a submitted registration from arkd with its stored proof (`expire_at: 0`, so it needs no
 * signer). Only a confirmed removal cancels it: any other failure leaves the inputs locked.
 */
async function releaseFromServer(
    registration: BatchRegistration,
    deps: ReleaseDeps,
    now: number,
): Promise<BatchRegistration | undefined> {
    // Re-checked: a settle may have claimed these inputs since the loop's check.
    if (!deps.deleteRegistration || isInFlight(registration, deps)) return undefined;
    try {
        const message = JSON.parse(registration.deleteProofMessage) as Proof.DeleteMessage;
        await deps.deleteRegistration({ proof: registration.deleteProof, message });
    } catch (e) {
        if (!isNoMatchingRegistrationsError(e)) {
            console.warn(
                `failed to delete registration ${registration.proofTxId} from the server`,
                e,
            );
            return undefined;
        }
    }
    return terminal(registration, "cancelled", now, {
        cancellationReason: "reconciliation: registration released from the server",
    });
}

/**
 * arkd's answer when no queued registration spends the proof's inputs. The name alone is not enough:
 * arkd also returns it for a proof that fails verification.
 */
export function isNoMatchingRegistrationsError(e: unknown): boolean {
    return (
        isArkError(e, ArkErrorName.INVALID_INTENT_PROOF) &&
        e.message.includes("no matching intents found")
    );
}

function terminal(
    registration: BatchRegistration,
    state: BatchRegistrationState,
    now: number,
    patch: Partial<BatchRegistration>,
): BatchRegistration {
    return { ...registration, ...patch, state, updatedAt: now };
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
