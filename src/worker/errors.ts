export class MessageBusNotInitializedError extends Error {
    constructor() {
        super("MessageBus not initialized");
        this.name = "MessageBusNotInitializedError";
    }
}

export class ServiceWorkerTimeoutError extends Error {
    constructor(detail: string) {
        super(detail);
        this.name = "ServiceWorkerTimeoutError";
    }
}
