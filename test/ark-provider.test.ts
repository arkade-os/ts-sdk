import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RestArkProvider } from "../src/providers/ark";

class MockEventSource {
    static instances: MockEventSource[] = [];
    static reset() {
        MockEventSource.instances = [];
    }

    url: string;
    closed = false;
    private listeners = new Map<string, Set<(e: unknown) => void>>();

    constructor(url: string) {
        this.url = url;
        MockEventSource.instances.push(this);
    }

    addEventListener(type: string, handler: (e: unknown) => void) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
        }
        this.listeners.get(type)!.add(handler);
    }

    removeEventListener(type: string, handler: (e: unknown) => void) {
        this.listeners.get(type)?.delete(handler);
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        // Mirror real EventSource behavior so that consumers suspended on
        // `await` inside the iterator unblock instead of parking forever.
        const handlers = this.listeners.get("error");
        if (handlers) {
            for (const handler of handlers) handler(new Event("error"));
        }
    }
}

describe("RestArkProvider.getEventStream", () => {
    beforeEach(() => {
        MockEventSource.reset();
        vi.stubGlobal("EventSource", MockEventSource);
        // Silence the informational console.error from the generator's
        // error branch when the mock's close() emits a synthetic error.
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("does not open an EventSource until the first iteration", () => {
        const provider = new RestArkProvider("http://localhost:7070");
        const ac = new AbortController();
        provider.getEventStream(ac.signal, []);
        expect(MockEventSource.instances).toHaveLength(0);
    });

    it("does not leak an EventSource when the iterator is abandoned before iteration", async () => {
        const provider = new RestArkProvider("http://localhost:7070");
        const ac = new AbortController();
        const stream = provider.getEventStream(ac.signal, []);

        // Mirror the _settleImpl finally path: abort, then force generator cleanup.
        ac.abort();
        await stream.return?.();

        expect(MockEventSource.instances).toHaveLength(0);
    });

    it("closes the EventSource when return() is called during iteration", async () => {
        const provider = new RestArkProvider("http://localhost:7070");
        const ac = new AbortController();
        const stream = provider.getEventStream(ac.signal, []);

        const pending = stream.next();
        // Yield to let the generator body construct the EventSource and
        // suspend inside the for-await.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(MockEventSource.instances).toHaveLength(1);
        expect(MockEventSource.instances[0].closed).toBe(false);

        await stream.return?.();
        expect(MockEventSource.instances[0].closed).toBe(true);

        // Prevent an unhandled promise warning if the generator rejected.
        await pending.catch(() => {});
    });

    it("closes the EventSource when the signal is aborted during iteration", async () => {
        const provider = new RestArkProvider("http://localhost:7070");
        const ac = new AbortController();
        const stream = provider.getEventStream(ac.signal, []);

        const pending = stream.next();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(MockEventSource.instances).toHaveLength(1);
        expect(MockEventSource.instances[0].closed).toBe(false);

        ac.abort();
        expect(MockEventSource.instances[0].closed).toBe(true);

        // Drain the generator so the test does not leave a dangling promise;
        // return() unwinds the for-await and resolves the pending next().
        await stream.return?.();
        await pending.catch(() => {});
    });
});
