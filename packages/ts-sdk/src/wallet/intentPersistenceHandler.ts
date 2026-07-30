import { SettlementEvent } from "../providers/ark";
import { IntentRepository } from "../repositories/intentRepository";
import { Batch } from "./batch";
import { applySettlementEventToIntent } from "./intentStateReducer";

export interface IntentPersistenceDeps {
    intentRepository?: Pick<IntentRepository, "getIntents" | "saveIntent">;
    intentTxId: string;
}

/**
 * Best-effort intent transition for one settlement event. Repo errors are
 * logged, never thrown — persistence must not break the settlement stream.
 */
async function persistTransition(
    deps: IntentPersistenceDeps,
    event: SettlementEvent,
): Promise<void> {
    const repo = deps.intentRepository;
    if (!repo) return;
    try {
        const cur = (await repo.getIntents({ intentTxIds: [deps.intentTxId] }))[0];
        if (!cur) return;
        const next = applySettlementEventToIntent(cur, event);
        if (next) await repo.saveIntent(next);
    } catch (e) {
        console.error(`Failed to apply settlement event to intent ${deps.intentTxId}`, e);
    }
}

/**
 * Wrap a {@link Batch.Handler} so SDK-owned intent state is persisted from the
 * batch lifecycle hooks that {@link Batch.join} awaits, rather than from the
 * fire-and-forget `eventCallback`. This makes the terminal write ordered: it
 * completes before `Batch.join` returns (finalized) or before the failure
 * propagates (failed), so a later local step can't clobber a committed outcome.
 */
export function wrapHandlerWithIntentPersistence(
    base: Batch.Handler,
    deps: IntentPersistenceDeps,
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
