import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVersion, sdkVersion } from "../src/utils/fetch";

/**
 * The Expo SSE providers reach two different origins: `ExpoArkProvider` talks to
 * arkd, whose compatibility guard reads `X-Build-Version`/`X-SDK-VERSION`, and
 * `ExpoIndexerProvider` talks to an indexer that may be deployed on its own
 * origin, where those custom headers fail the CORS preflight and the request is
 * never sent.
 *
 * `getExpoFetch` picks one of two transports, and the headers were once attached
 * inside it — so both transports carried the bug and a fix to either one alone
 * would leave the other broken. Every case below therefore runs against both,
 * from one table, so the two can never drift apart in coverage.
 */

/**
 * The expected headers, rebuilt here from the version constants rather than
 * imported as `ARKADE_VERSION_HEADERS`. Comparing the implementation's own object
 * against itself would pass even if a header were renamed.
 */
const ARKADE_HEADERS: Readonly<Record<string, string | null>> = {
    "X-Build-Version": buildVersion,
    "X-SDK-VERSION": sdkVersion,
};

const NO_ARKADE_HEADERS: Readonly<Record<string, string | null>> = {
    "X-Build-Version": null,
    "X-SDK-VERSION": null,
};

/** The Arkade headers a captured request carried, by name, value or `null`. */
function arkadeHeadersOf(init: RequestInit): Record<string, string | null> {
    const headers = new Headers(init.headers);
    return Object.fromEntries(Object.keys(ARKADE_HEADERS).map((n) => [n, headers.get(n)]));
}

/** A stubbed transport that answers 500 and records every request it received. */
interface Transport {
    install(): void;
    restore(): void;
    requests(): RequestInit[];
}

/** `expo/fetch` resolves — the transport a real Expo app uses. */
function expoFetchTransport(): Transport {
    const spy = vi.fn(async () => new Response(null, { status: 500 }));
    return {
        install: () => vi.doMock("expo/fetch", () => ({ fetch: spy })),
        restore: () => vi.doUnmock("expo/fetch"),
        requests: () => spy.mock.calls.map((call) => call[1] as RequestInit),
    };
}

/**
 * `expo/fetch` is made to fail its import, so `getExpoFetch` falls back to
 * `baseFetch` — which reaches `globalThis.fetch`. This is the branch the
 * original report named.
 *
 * The failure is forced rather than assumed. `expo` is an optional peer that is
 * present in this workspace, and it only fails to load here by accident of the
 * bundler; were it ever to resolve, these cases would silently exercise the
 * expo/fetch branch again and cover nothing new.
 */
function fallbackTransport(): Transport {
    const seen: RequestInit[] = [];
    let real: typeof globalThis.fetch;
    return {
        install: () => {
            vi.doMock("expo/fetch", () => {
                throw new Error("expo/fetch unavailable");
            });
            real = globalThis.fetch;
            globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
                seen.push(init ?? {});
                return new Response(null, { status: 500 });
            }) as typeof globalThis.fetch;
        },
        restore: () => {
            globalThis.fetch = real;
        },
        requests: () => seen,
    };
}

describe.each([
    ["expo/fetch", expoFetchTransport],
    ["baseFetch fallback", fallbackTransport],
])("Expo SSE streams over %s", (_transportName, makeTransport) => {
    let transport: Transport;
    let quiet: { mockRestore(): void }[];

    beforeEach(() => {
        quiet = (["warn", "debug", "error"] as const).map((level) =>
            vi.spyOn(console, level).mockImplementation(() => undefined),
        );
        vi.resetModules();
        transport = makeTransport();
        transport.install();
    });

    afterEach(() => {
        transport.restore();
        for (const spy of quiet) spy.mockRestore();
        vi.doUnmock("expo/fetch");
        vi.resetModules();
    });

    /**
     * Drive one iteration of a stream and return the request it made.
     *
     * The 500 makes `sseStreamIterator` throw on its first read rather than loop
     * forever, and matching that specific message keeps an unrelated failure —
     * a constructor throw, a missing mock — from being mistaken for it. Asserting
     * exactly one request is what stops a "sent no headers" expectation from
     * passing because no request was ever made.
     */
    async function requestFrom(stream: AsyncIterableIterator<unknown>): Promise<RequestInit> {
        await expect(stream.next()).rejects.toThrow(/Unexpected status 500/);
        const requests = transport.requests();
        expect(requests).toHaveLength(1);
        return requests[0];
    }

    async function arkProvider() {
        const { ExpoArkProvider } = await import("../src/providers/expoArk");
        return new ExpoArkProvider("https://ark.test");
    }

    async function indexerProvider() {
        const { ExpoIndexerProvider } = await import("../src/providers/expoIndexer");
        return new ExpoIndexerProvider("https://indexer.test");
    }

    describe("ExpoArkProvider — arkd reads the version headers", () => {
        it("sends them on the batch event stream", async () => {
            const provider = await arkProvider();

            const init = await requestFrom(
                provider.getEventStream(new AbortController().signal, ["topic-a", "topic-b"]),
            );

            expect(arkadeHeadersOf(init)).toEqual(ARKADE_HEADERS);
        });

        it("sends them on the transaction stream", async () => {
            const provider = await arkProvider();

            const init = await requestFrom(
                provider.getTransactionsStream(new AbortController().signal),
            );

            expect(arkadeHeadersOf(init)).toEqual(ARKADE_HEADERS);
            expect(init.signal).toBeInstanceOf(AbortSignal);
        });
    });

    describe("ExpoIndexerProvider — may be its own origin", () => {
        it("sends no Arkade headers on the subscription", async () => {
            const provider = await indexerProvider();

            const init = await requestFrom(
                provider.getSubscription("sub-1", new AbortController().signal),
            );

            expect(arkadeHeadersOf(init)).toEqual(NO_ARKADE_HEADERS);
        });

        it("still sends the headers the subscription does need", async () => {
            const provider = await indexerProvider();

            const init = await requestFrom(
                provider.getSubscription("sub-1", new AbortController().signal),
            );

            const headers = new Headers(init.headers);
            expect(headers.get("Accept")).toBe("text/event-stream");
            expect(headers.get("Content-Type")).toBe("application/json");
        });

        it("keeps the stream's own abort signal, so the read is not deadlined", async () => {
            const provider = await indexerProvider();

            const init = await requestFrom(
                provider.getSubscription("sub-1", new AbortController().signal),
            );

            expect(init.signal).toBeInstanceOf(AbortSignal);
        });
    });
});

describe("getExpoFetch", () => {
    afterEach(() => {
        vi.doUnmock("expo/fetch");
        vi.resetModules();
    });

    it("requires expo/fetch when the caller says so, rather than falling back", async () => {
        // Forced, not assumed: see `fallbackTransport`.
        vi.resetModules();
        vi.doMock("expo/fetch", () => {
            throw new Error("expo/fetch unavailable");
        });
        const { getExpoFetch } = await import("../src/providers/expoUtils");

        await expect(getExpoFetch({ requireExpo: true })).rejects.toThrow(
            /expo\/fetch is unavailable/,
        );
    });
});
