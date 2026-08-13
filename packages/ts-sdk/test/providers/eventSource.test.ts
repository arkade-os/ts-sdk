/**
 * Where the SDK gets its `EventSource`, and what it does when there is none.
 *
 * The environment this file runs in HAS a global (test/polyfill.js assigns one
 * from the `eventsource` package), so every "absent" case here removes it
 * deliberately — which is also the only honest way to reproduce plain Node.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    EventSourceUnavailableError,
    RestArkProvider,
    RestIndexerProvider,
    configureEventSource,
    getConfiguredEventSource,
    isEventSourceUnavailableError,
    resolveEventSource,
    type EventSourceFactory,
} from "../../src";

/** A factory that records its calls and returns something inert. */
const fakeFactory = (): EventSourceFactory & { urls: string[] } => {
    const urls: string[] = [];
    const factory = ((url: string) => {
        urls.push(url);
        return {
            addEventListener: () => {},
            removeEventListener: () => {},
            close: () => {},
        };
    }) as EventSourceFactory & { urls: string[] };
    factory.urls = urls;
    return factory;
};

/** Run `fn` with no global EventSource — plain Node, in other words. */
const withoutGlobal = async (fn: () => Promise<void> | void): Promise<void> => {
    const saved = globalThis.EventSource;
    // @ts-expect-error deleting an optional global for the duration of a test
    delete globalThis.EventSource;
    try {
        await fn();
    } finally {
        globalThis.EventSource = saved;
    }
};

afterEach(() => configureEventSource(undefined));

describe("resolveEventSource", () => {
    it("prefers the explicit override over everything else", () => {
        const configured = fakeFactory();
        const override = fakeFactory();
        configureEventSource(configured);

        resolveEventSource(override)("http://a");
        expect(override.urls).toEqual(["http://a"]);
        expect(configured.urls).toEqual([]);
    });

    it("prefers the configured factory over the global", async () => {
        const configured = fakeFactory();
        configureEventSource(configured);
        expect(getConfiguredEventSource()).toBe(configured);

        resolveEventSource()("http://b");
        expect(configured.urls).toEqual(["http://b"]);
    });

    it("falls back to the global, read at call time not import time", async () => {
        // The SDK is imported long before a polyfill assigns the global, so a
        // factory captured at module load would never see one. Resolving with
        // the global gone and then installing a different one — both after this
        // module was imported — is what tells the two apart.
        await withoutGlobal(() => {
            expect(() => resolveEventSource()).toThrow(EventSourceUnavailableError);

            const opened: string[] = [];
            class LateGlobal {
                constructor(url: string) {
                    opened.push(url);
                }
                addEventListener() {}
                removeEventListener() {}
                close() {}
            }
            globalThis.EventSource = LateGlobal as unknown as typeof EventSource;

            resolveEventSource()("http://late");
            expect(opened).toEqual(["http://late"]);
        });
    });

    it("throws a typed, actionable error when nothing answers", async () => {
        await withoutGlobal(() => {
            expect(() => resolveEventSource()).toThrow(EventSourceUnavailableError);
            try {
                resolveEventSource();
            } catch (error) {
                // The message is the whole remedy: it has to name both routes.
                expect((error as Error).message).toContain("configureEventSource");
                expect((error as Error).message).toContain("--experimental-eventsource");
            }
        });
    });

    it("goes back to the global when configured with undefined", async () => {
        configureEventSource(fakeFactory());
        configureEventSource(undefined);
        expect(getConfiguredEventSource()).toBeUndefined();
        expect(typeof resolveEventSource()).toBe("function");
    });
});

describe("isEventSourceUnavailableError", () => {
    it("recognizes the error", () => {
        expect(isEventSourceUnavailableError(new EventSourceUnavailableError())).toBe(true);
        expect(isEventSourceUnavailableError(new Error("boom"))).toBe(false);
        expect(isEventSourceUnavailableError(undefined)).toBe(false);
    });

    it("still recognizes it after a structured-clone round trip", () => {
        // A custom Error crossing the service-worker boundary arrives as a
        // plain Error carrying the name — `instanceof` alone would miss it.
        const clone = new Error(new EventSourceUnavailableError().message);
        clone.name = "EventSourceUnavailableError";
        expect(isEventSourceUnavailableError(clone)).toBe(true);
    });
});

describe("providers take a factory", () => {
    it("RestIndexerProvider opens its subscription with the injected one", async () => {
        const factory = fakeFactory();
        const provider = new RestIndexerProvider("http://ark", { eventSource: factory });

        const iterator = provider.getSubscription("sub-1", new AbortController().signal);
        // The connection is opened on the first pull, not at call time.
        expect(factory.urls).toEqual([]);
        const pending = iterator.next();
        await Promise.resolve();
        expect(factory.urls).toEqual(["http://ark/v1/indexer/script/subscription/sub-1"]);

        await iterator.return?.(undefined);
        await pending.catch(() => {});
    });

    it("RestArkProvider opens its event stream with the injected one", async () => {
        const factory = fakeFactory();
        const provider = new RestArkProvider("http://ark", { eventSource: factory });

        const iterator = provider.getEventStream(new AbortController().signal, []);
        const pending = iterator.next();
        await Promise.resolve();
        expect(factory.urls).toEqual(["http://ark/v1/batch/events"]);

        await iterator.return?.(undefined);
        await pending.catch(() => {});
    });

    it("fails the stream with the typed error when there is nothing to open it with", async () => {
        await withoutGlobal(async () => {
            const provider = new RestIndexerProvider("http://ark");
            const iterator = provider.getSubscription("sub-1", new AbortController().signal);
            await expect(iterator.next()).rejects.toThrow(EventSourceUnavailableError);
        });
    });

    it("keeps resolving lazily, so a factory configured after construction still applies", async () => {
        await withoutGlobal(async () => {
            const provider = new RestIndexerProvider("http://ark");
            const factory = fakeFactory();
            configureEventSource(factory);

            const iterator = provider.getSubscription("sub-2", new AbortController().signal);
            const pending = iterator.next();
            await Promise.resolve();
            expect(factory.urls).toEqual(["http://ark/v1/indexer/script/subscription/sub-2"]);

            await iterator.return?.(undefined);
            await pending.catch(() => {});
        });
    });
});

describe("the default resolution path is unchanged", () => {
    it("uses the global when nothing is configured", () => {
        const spy = vi.spyOn(globalThis, "EventSource" as never);
        expect(spy).toBeDefined();
        expect(getConfiguredEventSource()).toBeUndefined();
        expect(typeof resolveEventSource()).toBe("function");
    });
});
