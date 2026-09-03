export class MockEventSource {
    static instances: MockEventSource[] = [];

    static reset() {
        MockEventSource.instances = [];
    }

    readonly url: string;
    readyState = 1;
    closed = false;
    private listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor(url = "") {
        this.url = url;
        MockEventSource.instances.push(this);
    }

    addEventListener(type: string, handler: (event: unknown) => void) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
        }
        this.listeners.get(type)!.add(handler);
    }

    removeEventListener(type: string, handler: (event: unknown) => void) {
        this.listeners.get(type)?.delete(handler);
    }

    listenerCount(type: string) {
        return this.listeners.get(type)?.size ?? 0;
    }

    close() {
        this.closed = true;
    }

    emitMessage(data: string) {
        this.emit("message", { data });
    }

    emitError(readyState: number) {
        this.readyState = readyState;
        this.emit("error", new Event("error"));
    }

    private emit(type: string, event: unknown) {
        for (const handler of this.listeners.get(type) ?? []) {
            handler(event);
        }
    }
}
