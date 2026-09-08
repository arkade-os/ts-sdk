import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoltzSwapProvider, BOLTZ_READ_TIMEOUT_MS } from "../src/boltz-swap-provider";

describe("BoltzSwapProvider read deadline", () => {
    let seen: RequestInit[] = [];
    const original = globalThis.fetch;

    beforeEach(() => {
        seen = [];
        globalThis.fetch = vi.fn(async (_input: any, init?: RequestInit) => {
            seen.push(init ?? {});
            return new Response(JSON.stringify({}), {
                status: 200,
                headers: { "content-type": "application/json", "content-length": "2" },
            });
        }) as any;
    });

    afterEach(() => {
        globalThis.fetch = original;
        vi.restoreAllMocks();
    });

    const provider = () =>
        new BoltzSwapProvider({ network: "regtest", apiUrl: "http://localhost:9090" });

    it("bounds a GET", async () => {
        await (provider() as any).request("/v2/anything", "GET").catch(() => undefined);

        expect(seen).toHaveLength(1);
        expect(seen[0].signal).toBeInstanceOf(AbortSignal);
        expect(seen[0].signal?.aborted).toBe(false);
    });

    it("leaves a POST unbounded — an aborted write may already have made a swap", async () => {
        await (provider() as any).request("/v2/anything", "POST", { a: 1 }).catch(() => undefined);

        expect(seen).toHaveLength(1);
        expect(seen[0].signal).toBeUndefined();
    });

    it("issues a fresh deadline per request, so a later read is not born expired", async () => {
        const p = provider();
        await (p as any).request("/v2/a", "GET").catch(() => undefined);
        await (p as any).request("/v2/b", "GET").catch(() => undefined);

        expect(seen[1].signal).not.toBe(seen[0].signal);
    });

    // Bounded both ways: a dropped zero fails reads against a slow-but-alive
    // API, an extra zero makes the deadline decorative.
    it("keeps the deadline inside a defensible range", () => {
        expect(BOLTZ_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
        expect(BOLTZ_READ_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
    });

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
            const p = provider() as any;
            const pending = p.request("/v2/slow", "GET").catch((e: unknown) => e);
            await vi.advanceTimersByTimeAsync(BOLTZ_READ_TIMEOUT_MS);

            expect(await pending).toBeInstanceOf(Error);
        } finally {
            AbortSignal.timeout = realTimeout;
            vi.useRealTimers();
        }
    });

    it("says so loudly when the runtime cannot bound a read at all — and only once", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const realTimeout = AbortSignal.timeout;
        const realController = globalThis.AbortController;
        // @ts-expect-error simulating a runtime without AbortSignal.timeout
        AbortSignal.timeout = undefined;
        // @ts-expect-error same
        globalThis.AbortController = undefined;
        try {
            // Fresh module: the "warned once" flag is module-level, so asserting
            // it from a shared instance would depend on nothing else having
            // tripped it first.
            vi.resetModules();
            const fresh = await import("../src/boltz-swap-provider");
            const p = new fresh.BoltzSwapProvider({
                network: "regtest",
                apiUrl: "http://localhost:9090",
            }) as any;
            await p.request("/v2/a", "GET").catch(() => undefined);
            await p.request("/v2/b", "GET").catch(() => undefined);
        } finally {
            AbortSignal.timeout = realTimeout;
            globalThis.AbortController = realController;
        }

        expect(seen).toHaveLength(2);
        expect(seen[0].signal).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain("UNBOUNDED");
    });
});
