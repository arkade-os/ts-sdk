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

    // Bounded both ways: a dropped zero makes reads fail on a slow-but-alive
    // server, an extra zero makes the deadline decorative.
    it("keeps the deadline inside a defensible range", () => {
        expect(READ_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
        expect(READ_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
    });

    // Without `AbortSignal.timeout` (some React Native runtimes) the bound has
    // to come from `AbortController` + a timer, and this proves it actually
    // fires rather than merely being attached.
    it("still bounds the read when only AbortController is available", async () => {
        vi.useFakeTimers();
        const realTimeout = AbortSignal.timeout;
        // @ts-expect-error simulating a runtime without AbortSignal.timeout
        AbortSignal.timeout = undefined;
        globalThis.fetch = vi.fn(
            (_input: any, init?: RequestInit) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener("abort", () =>
                        reject(new DOMException("aborted", "AbortError")),
                    );
                }),
        ) as any;

        try {
            const pending = baseFetch("https://example.test/slow").catch((e) => e);
            await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
            const err = await pending;

            expect(err).toBeInstanceOf(FetchError);
            expect(isRetryableProviderError(err)).toBe(true);
        } finally {
            AbortSignal.timeout = realTimeout;
            vi.useRealTimers();
        }
    });

    it("says so loudly when the runtime cannot bound a read at all — and only once", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const realTimeout = AbortSignal.timeout;
        const realController = globalThis.AbortController;
        // @ts-expect-error simulating a runtime with neither primitive
        AbortSignal.timeout = undefined;
        // @ts-expect-error same
        globalThis.AbortController = undefined;
        try {
            // Fresh module: the "warned once" flag is module-level, so asserting
            // it from a shared instance would depend on nothing else having
            // tripped it first.
            vi.resetModules();
            const fresh = await import("../src/utils/fetch");
            await fresh.baseFetch("https://example.test/a");
            await fresh.baseFetch("https://example.test/b");
        } finally {
            AbortSignal.timeout = realTimeout;
            globalThis.AbortController = realController;
        }

        expect(seen?.signal).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain("UNBOUNDED");
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
