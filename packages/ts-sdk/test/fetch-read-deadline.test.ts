import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseFetch, FetchError, READ_TIMEOUT_MS } from "../src/utils/fetch";
import { isRetryableProviderError } from "../src/providers/availability";
import { sseStreamIterator } from "../src/providers/expoUtils";

describe("baseFetch read deadline", () => {
    let seen: RequestInit | undefined;
    const original = globalThis.fetch;

    beforeEach(() => {
        seen = undefined;
        globalThis.fetch = vi.fn(async (_input: any, init?: RequestInit) => {
            seen = init;
            return new Response("{}", { status: 200 });
        }) as any;
    });

    afterEach(() => {
        globalThis.fetch = original;
        vi.restoreAllMocks();
    });

    it("bounds a GET that carries no signal of its own", async () => {
        await baseFetch("https://example.test/v1/thing");
        expect(seen?.signal).toBeInstanceOf(AbortSignal);
        expect(seen?.signal?.aborted).toBe(false);
    });

    it("bounds a HEAD too", async () => {
        await baseFetch("https://example.test/v1/thing", { method: "HEAD" });
        expect(seen?.signal).toBeInstanceOf(AbortSignal);
    });

    it("leaves a POST unbounded — an aborted write has an unknown outcome", async () => {
        await baseFetch("https://example.test/v1/thing", { method: "POST", body: "{}" });
        expect(seen?.signal).toBeUndefined();
    });

    it("never overrides a caller's own signal", async () => {
        const controller = new AbortController();
        await baseFetch("https://example.test/v1/thing", { signal: controller.signal });
        expect(seen?.signal).toBe(controller.signal);
    });

    // Every Request has a `signal` whether or not its author supplied one, so a
    // Request input is left to its own lifetime rather than guessed at.
    it("leaves a Request input unbounded, GET or not", async () => {
        await baseFetch(new Request("https://example.test/a"));
        expect(seen?.signal).toBeUndefined();
        await baseFetch(new Request("https://example.test/b", { method: "POST", body: "{}" }));
        expect(seen?.signal).toBeUndefined();
    });

    it("issues a fresh deadline per call, so a retry is not born expired", async () => {
        await baseFetch("https://example.test/a");
        const first = seen?.signal;
        await baseFetch("https://example.test/b");
        expect(seen?.signal).not.toBe(first);
    });

    it("surfaces a fired deadline as a retryable failure, so the retry ladder is reachable", async () => {
        globalThis.fetch = vi.fn(async () => {
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }) as any;

        const err = await baseFetch("https://example.test/v1/thing").catch((e) => e);

        expect(err).toBeInstanceOf(FetchError);
        expect(isRetryableProviderError(err)).toBe(true);
    });

    it("states a deadline rather than leaving it implicit", () => {
        expect(READ_TIMEOUT_MS).toBeGreaterThan(0);
    });

    // On Expo, `getExpoFetch` falls back to `baseFetch`, so this signal is what
    // keeps the deadline off a long-lived stream. Guard it against removal.
    it("sseStreamIterator supplies a signal, which is what opts a stream out", async () => {
        let received: RequestInit | undefined;
        const fetchFn = (async (_url: string, init?: RequestInit) => {
            received = init;
            return new Response(null, { status: 500 });
        }) as unknown as typeof globalThis.fetch;

        const stream = sseStreamIterator(
            "https://example.test/stream",
            new AbortController().signal,
            fetchFn,
            {},
            (d) => d,
        );
        await stream.next().catch(() => undefined);

        expect(received?.signal).toBeInstanceOf(AbortSignal);
    });
});
