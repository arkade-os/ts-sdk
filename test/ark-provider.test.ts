import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RestArkProvider } from "../src/providers/ark";

describe("RestArkProvider - getEventStream EventSource lifecycle", () => {
    let eventSources: Array<{ url: string; close: ReturnType<typeof vi.fn> }>;
    let originalEventSource: typeof globalThis.EventSource | undefined;

    beforeEach(() => {
        eventSources = [];
        originalEventSource = globalThis.EventSource;
        // Record every EventSource construction so we can verify the fix
        // against the listener-leak path documented in client-audit.md T1.0.
        (globalThis as any).EventSource = vi
            .fn()
            .mockImplementation((url: string) => {
                const mock = {
                    url,
                    close: vi.fn(),
                    addEventListener: vi.fn(),
                    removeEventListener: vi.fn(),
                    readyState: 1,
                };
                eventSources.push(mock);
                return mock;
            });
    });

    afterEach(() => {
        if (originalEventSource) {
            (globalThis as any).EventSource = originalEventSource;
        } else {
            delete (globalThis as any).EventSource;
        }
    });

    it("does NOT open an EventSource until the consumer iterates", () => {
        // The core of the T1.0 fix. Prior to this change the provider
        // eagerly instantiated `new EventSource(...)` *before* returning
        // the async generator. If the caller then threw before iterating
        // (e.g. safeRegisterIntent rejecting before Batch.join runs), no
        // abort listener was registered and the connection was leaked
        // forever — the server's SSE listener count grew unbounded.
        // Post-fix, the EventSource lives inside the generator body, so
        // `.next()` is the only way to open it.
        const provider = new RestArkProvider("https://example.test");
        const controller = new AbortController();

        provider.getEventStream(controller.signal, ["topic-a"]);

        // Generator returned, no iteration yet → no socket should have been
        // opened. The pre-fix implementation would have produced 1 here.
        expect(eventSources).toHaveLength(0);
    });

    it("does NOT open an EventSource even when the signal is pre-aborted before iteration", () => {
        // Extra belt-and-braces: if the caller hands in an already-aborted
        // signal and never calls .next(), we still must not leak a socket.
        const provider = new RestArkProvider("https://example.test");
        const controller = new AbortController();
        controller.abort();

        provider.getEventStream(controller.signal, []);

        expect(eventSources).toHaveLength(0);
    });
});
