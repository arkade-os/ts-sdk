import { collectBatchRegistrations } from "../repositories/batchRegistrationRepository";
import { SettlementEvent } from "../providers/ark";
import { BatchRegistrationRepository } from "../repositories/batchRegistrationRepository";
import { Batch } from "./batch";
import { applySettlementEventToRegistration } from "./batchRegistrationStateReducer";

export interface RegistrationPersistenceDeps {
    batchRegistrationRepository?: Pick<
        BatchRegistrationRepository,
        "getRegistrationsPage" | "saveRegistration"
    >;
    proofTxId: string;
}

/**
 * Best-effort registration transition for one settlement event. Repo errors are
 * logged, never thrown — persistence must not break the settlement stream.
 */
async function persistTransition(
    deps: RegistrationPersistenceDeps,
    event: SettlementEvent,
): Promise<void> {
    const repo = deps.batchRegistrationRepository;
    if (!repo) return;
    try {
        const cur = (await collectBatchRegistrations(repo, { proofTxIds: [deps.proofTxId] }))[0];
        if (!cur) return;
        const next = applySettlementEventToRegistration(cur, event);
        if (next) await repo.saveRegistration(next);
    } catch (e) {
        console.error(`Failed to apply settlement event to registration ${deps.proofTxId}`, e);
    }
}

/**
 * Wrap a {@link Batch.Handler} so SDK-owned registration state is persisted from the
 * batch lifecycle hooks that {@link Batch.join} awaits, rather than from the
 * fire-and-forget `eventCallback`. This makes the terminal write ordered: it
 * completes before `Batch.join` returns (finalized) or before the failure
 * propagates (failed), so a later local step can't clobber a committed outcome.
 */
export function wrapHandlerWithRegistrationPersistence(
    base: Batch.Handler,
    deps: RegistrationPersistenceDeps,
): Batch.Handler {
    return {
        ...base,
        onBatchStarted: async (event) => {
            const result = await base.onBatchStarted(event);
            if (!result.skip) await persistTransition(deps, event);
            return result;
        },
        onBatchFinalized: async (event) => {
            if (base.onBatchFinalized) await base.onBatchFinalized(event);
            await persistTransition(deps, event);
        },
        onBatchFailed: async (event) => {
            await persistTransition(deps, event);
            // Reproduce the semantics Batch.join would have applied to `base`:
            // its own onBatchFailed handles-and-continues; otherwise the reason
            // is thrown (our added hook must not swallow that default).
            if (base.onBatchFailed) {
                await base.onBatchFailed(event);
                return;
            }
            throw new Error(event.reason);
        },
    };
}
