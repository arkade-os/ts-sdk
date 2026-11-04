import { SettlementEvent, SettlementEventType } from "../providers/ark";
import {
    BatchRegistration,
    BatchRegistrationState,
    isTerminalBatchRegistrationState,
} from "../repositories/batchRegistrationRepository";

/**
 * Pure, monotonic reducer: maps a settlement event onto the next registration
 * state. Terminal states are sticky; tree/stream sub-step events and any
 * out-of-order event are no-ops (return the current state unchanged).
 *
 * Only the three batch-boundary events move state:
 *   - BatchStarted    → batch_in_progress
 *   - BatchFinalized  → batch_succeeded
 *   - BatchFailed     → batch_failed
 */
export function reduceRegistrationState(
    current: BatchRegistrationState,
    event: SettlementEvent,
): BatchRegistrationState {
    if (isTerminalBatchRegistrationState(current)) return current;

    switch (event.type) {
        case SettlementEventType.BatchStarted:
            return "batch_in_progress";
        case SettlementEventType.BatchFinalized:
            return "batch_succeeded";
        case SettlementEventType.BatchFailed:
            return "batch_failed";
        default:
            return current;
    }
}

/**
 * Apply a settlement event to one registration, returning the updated registration when
 * the state (or a derived field) changed, or `undefined` for a no-op so the
 * caller can skip the persist.
 */
export function applySettlementEventToRegistration(
    registration: BatchRegistration,
    event: SettlementEvent,
): BatchRegistration | undefined {
    const next = reduceRegistrationState(registration.state, event);
    if (next === registration.state) return undefined;

    const updated: BatchRegistration = { ...registration, state: next };
    // Every settlement event carries the batch/round id.
    if ("id" in event && typeof event.id === "string") {
        updated.batchId = event.id;
    }
    if (event.type === SettlementEventType.BatchFinalized) {
        updated.commitmentTransactionId = event.commitmentTxid;
    }
    if (event.type === SettlementEventType.BatchFailed) {
        updated.cancellationReason = event.reason;
    }
    return updated;
}
