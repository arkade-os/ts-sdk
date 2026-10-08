export const MESSAGE_BUS_NOT_INITIALIZED = "MessageBus not initialized";

/**
 * Message for the "an init is in flight" variant.
 * It is a superset of MESSAGE_BUS_NOT_INITIALIZED so the existing consumers
 * keeps classifying it as "not initialized".
 */
export const MESSAGE_BUS_INITIALIZING = `${MESSAGE_BUS_NOT_INITIALIZED}: initializing`;

export class MessageBusNotInitializedError extends Error {
    constructor(message: string = MESSAGE_BUS_NOT_INITIALIZED) {
        super(message);
    }
}

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

// Match by message rather than instanceof: postMessage's structured clone strips
// the prototype chain, so the page receives a plain Error.
export function isMessageBusNotInitializedError(error: unknown): boolean {
    return error instanceof Error && error.message.includes(MESSAGE_BUS_NOT_INITIALIZED);
}

// Callers must test this before isMessageBusNotInitializedError: the message is a
// superset, so the broader check also matches an in-flight init.
export function isMessageBusInitializingError(error: unknown): boolean {
    return error instanceof Error && error.message.includes(MESSAGE_BUS_INITIALIZING);
}
