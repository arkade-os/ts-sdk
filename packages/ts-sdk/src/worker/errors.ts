export const MESSAGE_BUS_NOT_INITIALIZED = "MessageBus not initialized";

/**
 * Message for the "an init is in flight" variant. It is a superset of
 * MESSAGE_BUS_NOT_INITIALIZED so the existing substring detector keeps
 * classifying it as "not initialized" — older callers (and third-party
 * embedders) treat it as retryable exactly as before, while updated callers
 * can match the more specific marker to wait instead of forcing a re-init.
 */
export const MESSAGE_BUS_INITIALIZING = `${MESSAGE_BUS_NOT_INITIALIZED}: initializing`;

export class MessageBusNotInitializedError extends Error {
    // Default keeps existing no-arg call sites unchanged.
    constructor(message: string = MESSAGE_BUS_NOT_INITIALIZED) {
        super(message);
    }
}

/**
 * Thrown when a wallet message arrives while an `INITIALIZE_MESSAGE_BUS` is
 * still queued or running. Distinct from {@link MessageBusNotInitializedError}
 * (worker never initialized / was killed) so the caller can wait for the
 * in-flight init rather than enqueuing a redundant one. Subclasses
 * `MessageBusNotInitializedError` so `instanceof` checks stay true.
 */
export class MessageBusInitializingError extends MessageBusNotInitializedError {
    constructor() {
        super(MESSAGE_BUS_INITIALIZING);
    }
}

export class ServiceWorkerTimeoutError extends Error {
    constructor(detail: string) {
        super(detail);
    }
}
