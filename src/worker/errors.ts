export const MESSAGE_BUS_NOT_INITIALIZED = "MessageBus not initialized";

export class MessageBusNotInitializedError extends Error {
    constructor() {
        super(MESSAGE_BUS_NOT_INITIALIZED);
    }
}

export class ServiceWorkerTimeoutError extends Error {
    constructor(detail: string) {
        super(detail);
    }
}
