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
    RestOperatorProvider,
    RestIndexerProvider,
    configureEventSource,
    getConfiguredEventSource,
    isEventSourceUnavailableError,
    resolveEventSource,
    type EventSourceFactory,
} from "../../src";
import { FetchEventSource } from "../../src/providers/eventSource";
import { ARKADE_VERSION_HEADERS } from "../../src/utils/fetch";

/** A factory that records its calls and returns something inert. */
const fakeFactory = (): EventSourceFactory & {
    urls: string[];
    headers: (Record<string, string> | undefined)[];
} => {
    const urls: string[] = [];
    const headers: (Record<string, string> | undefined)[] = [];
    const factory = ((url: string, h?: Record<string, string>) => {
        urls.push(url);
        headers.push(h);
        return {
            addEventListener: () => {},
            removeEventListener: () => {},
            close: () => {},
        };
    }) as unknown as EventSourceFactory & {
        urls: string[];
        headers: (Record<string, string> | undefined)[];
    };
    factory.urls = urls;
    factory.headers = headers;
    return factory;
};

/** Run `fn` with neither `fetch` nor a global EventSource. */
const withoutTransport = async (fn: () => Promise<void> | void): Promise<void> => {
    const saved = globalThis.EventSource;
    // @ts-expect-error deleting an optional global for the duration of a test
    delete globalThis.EventSource;
    vi.stubGlobal("fetch", undefined);
    try {
        await fn();
    } finally {
        globalThis.EventSource = saved;
        vi.unstubAllGlobals();
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

    it("defaults to FetchEventSource, which sends the headers it is given", async () => {
        const calls: RequestInit[] = [];
        vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
            calls.push(init);
            return new Response(null, { status: 204 });
        });
        try {
            const source = resolveEventSource()("http://default", { "X-Build-Version": "1.2.3" });
            expect(source).toBeInstanceOf(FetchEventSource);
            source.close();
            expect(calls[0].headers).toMatchObject({ "X-Build-Version": "1.2.3" });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it("falls back to the global without fetch, read at call time not import time", async () => {
        // The SDK is imported long before a polyfill assigns the global, so a
        // factory captured at module load would never see one. Resolving with
        // the global gone and then installing a different one — both after this
        // module was imported — is what tells the two apart.
        await withoutTransport(() => {
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
        await withoutTransport(() => {
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

    it("goes back to the default when configured with undefined", async () => {
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
        expect(factory.headers).toEqual([undefined]);

        await iterator.return?.(undefined);
        await pending.catch(() => {});
    });

    it("RestOperatorProvider opens its event stream with the injected one", async () => {
        const factory = fakeFactory();
        const provider = new RestOperatorProvider("http://ark", { eventSource: factory });

        const iterator = provider.getEventStream(new AbortController().signal, []);
        const pending = iterator.next();
        await Promise.resolve();
        expect(factory.urls).toEqual(["http://ark/v1/batch/events"]);
        expect(factory.headers).toEqual([ARKADE_VERSION_HEADERS]);

        await iterator.return?.(undefined);
        await pending.catch(() => {});
    });

    it("RestOperatorProvider opens its transaction stream with the version headers", async () => {
        const factory = fakeFactory();
        const provider = new RestOperatorProvider("http://ark", { eventSource: factory });

        const iterator = provider.getTransactionsStream(new AbortController().signal);
        const pending = iterator.next();
        await Promise.resolve();
        expect(factory.urls).toEqual(["http://ark/v1/txs"]);
        expect(factory.headers).toEqual([ARKADE_VERSION_HEADERS]);

        await iterator.return?.(undefined);
        await pending.catch(() => {});
    });

    it("fails the stream with the typed error when there is nothing to open it with", async () => {
        await withoutTransport(async () => {
            const provider = new RestIndexerProvider("http://ark");
            const iterator = provider.getSubscription("sub-1", new AbortController().signal);
            await expect(iterator.next()).rejects.toThrow(EventSourceUnavailableError);
        });
    });

    it("keeps resolving lazily, so a factory configured after construction still applies", async () => {
        await withoutTransport(async () => {
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
