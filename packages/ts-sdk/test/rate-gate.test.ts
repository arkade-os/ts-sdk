import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { RestIndexerProvider, RestArkProvider } from "../src";
import {
    OriginRateGate,
    parseRetryAfterMs,
    rateGate,
    requestOrigin,
} from "../src/providers/rateGate";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock("../src/utils/fetch", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/utils/fetch")>();
    return { ...actual, fetch: mockFetch, baseFetch: mockFetch };
});

/** A `429` carrying `Retry-After`, shaped like the Cloudflare response in the HAR. */
function rateLimited(retryAfter = "10") {
    return {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({ "retry-after": retryAfter }),
        clone: () => ({ text: async () => "" }),
        text: async () => "",
    };
}

function ok(body: unknown) {
    return { ok: true, headers: new Headers(), json: async () => body };
}

describe("parseRetryAfterMs", () => {
    it("parses delta-seconds", () => {
        expect(parseRetryAfterMs("10")).toBe(10_000);
        expect(parseRetryAfterMs(" 2 ")).toBe(2_000);
        expect(parseRetryAfterMs("0")).toBe(0);
    });

    it("parses an HTTP-date relative to now", () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date("2026-07-20T20:00:00Z"));
            expect(parseRetryAfterMs("Mon, 20 Jul 2026 20:00:30 GMT")).toBe(30_000);
            // A date already in the past clamps to zero rather than going negative.
            expect(parseRetryAfterMs("Mon, 20 Jul 2026 19:59:00 GMT")).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("returns undefined for absent / unparseable values", () => {
        expect(parseRetryAfterMs(null)).toBeUndefined();
        expect(parseRetryAfterMs(undefined)).toBeUndefined();
        expect(parseRetryAfterMs("")).toBeUndefined();
        expect(parseRetryAfterMs("soon")).toBeUndefined();
        // Malformed rather than "retry now": clamping to 0 would read as no
        // cooldown, so these must fall back to the caller's default.
        expect(parseRetryAfterMs("-5")).toBeUndefined();
        expect(parseRetryAfterMs("Infinity")).toBeUndefined();
    });

    it("a negative Retry-After still applies the default cooldown", () => {
        const gate = new OriginRateGate({ defaultCooldownMs: 5_000 });
        gate.reportRateLimited("https://a.example/x", "-5");
        expect(gate.cooldownRemainingMs("https://a.example/x")).toBeGreaterThan(4_000);
    });
});

describe("requestOrigin", () => {
    it("collapses paths on the same host to one key", () => {
        // /v1/info and /v1/indexer/* share a limiter, so a 429 on one must
        // pause the other.
        expect(requestOrigin("https://arkade.computer/v1/info")).toBe("https://arkade.computer");
        expect(requestOrigin("https://arkade.computer/v1/indexer/vtxos?a=b")).toBe(
            "https://arkade.computer",
        );
    });

    it("keeps distinct hosts distinct", () => {
        expect(requestOrigin("https://a.example/x")).not.toBe(requestOrigin("https://b.example/x"));
    });

    it("falls back to the raw string when unparseable", () => {
        expect(requestOrigin("/relative/path")).toBe("/relative/path");
    });
});

describe("OriginRateGate", () => {
    it("caps concurrency per origin", async () => {
        const gate = new OriginRateGate({ maxConcurrent: 2 });
        let inFlight = 0;
        let peak = 0;
        const release: (() => void)[] = [];

        const runs = Array.from({ length: 6 }, () =>
            gate.run("https://a.example/x", () => {
                inFlight += 1;
                peak = Math.max(peak, inFlight);
                return new Promise<void>((resolve) =>
                    release.push(() => {
                        inFlight -= 1;
                        resolve();
                    }),
                );
            }),
        );

        // Let the first cohort start, then drain one at a time.
        await Promise.resolve();
        expect(peak).toBe(2);
        while (release.length > 0) {
            release.shift()!();
            await Promise.resolve();
            await Promise.resolve();
        }
        await Promise.all(runs);
        expect(peak).toBe(2);
    });

    it("does not let one origin's cooldown block another", async () => {
        const gate = new OriginRateGate();
        gate.reportRateLimited("https://a.example/x", "10");
        expect(gate.cooldownRemainingMs("https://a.example/y")).toBeGreaterThan(0);
        expect(gate.cooldownRemainingMs("https://b.example/y")).toBe(0);
        await expect(gate.run("https://b.example/y", async () => "ran")).resolves.toBe("ran");
    });

    it("takes the longest cooldown, never a shorter one", () => {
        const gate = new OriginRateGate();
        gate.reportRateLimited("https://a.example/x", "30");
        const long = gate.cooldownRemainingMs("https://a.example/x");
        gate.reportRateLimited("https://a.example/x", "1");
        expect(gate.cooldownRemainingMs("https://a.example/x")).toBe(long);
    });

    it("clamps an absurd Retry-After", () => {
        const gate = new OriginRateGate({ maxCooldownMs: 60_000 });
        gate.reportRateLimited("https://a.example/x", "999999");
        expect(gate.cooldownRemainingMs("https://a.example/x")).toBeLessThanOrEqual(60_000);
    });

    it("applies a default cooldown when Retry-After is missing", () => {
        const gate = new OriginRateGate({ defaultCooldownMs: 5_000 });
        gate.reportRateLimited("https://a.example/x", null);
        expect(gate.cooldownRemainingMs("https://a.example/x")).toBeGreaterThan(4_000);
    });

    it("a queued waiter does not send into the cooldown the released request just earned", async () => {
        // `release()` hands the slot on inside run()'s finally. Reporting the
        // 429 after run() resolves is too late: the waiter resumes first, sees
        // blockedUntil === 0, and sends. runHttp reports before releasing.
        vi.useFakeTimers();
        try {
            const gate = new OriginRateGate({ maxConcurrent: 1, jitterMs: 0 });
            const url = "https://a.example/x";
            const sent: string[] = [];

            const first = gate.runHttp(url, async () => {
                sent.push("first");
                return { status: 429, headers: new Headers({ "retry-after": "30" }) } as Response;
            });
            const second = gate.runHttp(url, async () => {
                sent.push("second");
                return { status: 200, headers: new Headers() } as Response;
            });

            await first;
            await Promise.resolve();
            await Promise.resolve();

            expect(sent).toEqual(["first"]);
            expect(gate.cooldownRemainingMs(url)).toBeGreaterThan(29_000);

            await vi.advanceTimersByTimeAsync(31_000);
            await second;
            expect(sent).toEqual(["first", "second"]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("shared cooldown across requests (herd regression)", () => {
    beforeEach(() => {
        mockFetch.mockReset();
        rateGate.reset();
    });
    afterEach(() => {
        vi.useRealTimers();
        rateGate.reset();
    });

    it("one observed 429 pauses requests that never saw it", async () => {
        // The regression this gate exists for: per-request backoff leaves every
        // other request ignorant of the 429, so they fire into the cooldown.
        vi.useFakeTimers();
        const indexer = new RestIndexerProvider("http://localhost:7070");

        mockFetch.mockResolvedValueOnce(rateLimited("10"));
        const first = indexer.getVtxos({ scripts: ["a"] }).catch((e) => e);
        await vi.advanceTimersByTimeAsync(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // A request that never saw a 429 itself must not reach the network.
        mockFetch.mockResolvedValue(ok({ vtxos: [] }));
        const newcomer = indexer.getVtxos({ scripts: ["b"] });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // ...until the cooldown plus jitter expires.
        await vi.advanceTimersByTimeAsync(6_000);
        await expect(newcomer).resolves.toMatchObject({ vtxos: [] });
        expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
        await first;
    });

    it("a herd released by one cooldown resumes staggered, not in lockstep", async () => {
        vi.useFakeTimers();
        const indexer = new RestIndexerProvider("http://localhost:7070");

        mockFetch.mockResolvedValueOnce(rateLimited("10"));
        const first = indexer.getVtxos({ scripts: ["a"] }).catch((e) => e);
        await vi.advanceTimersByTimeAsync(1);

        const sendTimes: number[] = [];
        mockFetch.mockImplementation(async () => {
            sendTimes.push(Date.now());
            return ok({ vtxos: [] });
        });

        const herd = Array.from({ length: 5 }, (_, i) => indexer.getVtxos({ scripts: [`h${i}`] }));
        await vi.advanceTimersByTimeAsync(20_000);
        await Promise.all(herd);
        await first;

        expect(sendTimes.length).toBeGreaterThanOrEqual(5);
        // Leaving at one instant is what re-trips the limiter.
        expect(new Set(sendTimes).size).toBeGreaterThan(1);
    });

    it("an indexer 429 also gates an ark-provider read on the same origin", async () => {
        vi.useFakeTimers();
        const indexer = new RestIndexerProvider("http://localhost:7070");
        const ark = new RestArkProvider("http://localhost:7070");

        mockFetch.mockResolvedValueOnce(rateLimited("10"));
        const first = indexer.getVtxos({ scripts: ["a"] }).catch((e) => e);
        await vi.advanceTimersByTimeAsync(1);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Different provider class, same host, same limiter.
        mockFetch.mockResolvedValue(ok({}));
        const info = ark.getInfo().catch((e) => e);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(20_000);
        await info;
        await first;
        expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    });

    it("a settlement POST is sent during a cooldown, and reports its own 429 without retrying", async () => {
        vi.useFakeTimers();
        const indexer = new RestIndexerProvider("http://localhost:7070");
        const ark = new RestArkProvider("http://localhost:7070");

        mockFetch.mockResolvedValueOnce(rateLimited("10"));
        const first = indexer.getVtxos({ scripts: ["a"] }).catch((e) => e);
        await vi.advanceTimersByTimeAsync(1);
        const beforePost = mockFetch.mock.calls.length;
        const cooldownBefore = rateGate.cooldownRemainingMs("http://localhost:7070");

        mockFetch.mockResolvedValueOnce(rateLimited("30"));
        const submitted = ark.submitTx("tx", []).catch((e) => e);
        await vi.advanceTimersByTimeAsync(1);
        expect(mockFetch).toHaveBeenCalledTimes(beforePost + 1);

        await submitted;
        // Sent once, never retried — but its 429 still extended the cooldown.
        expect(mockFetch).toHaveBeenCalledTimes(beforePost + 1);
        expect(rateGate.cooldownRemainingMs("http://localhost:7070")).toBeGreaterThan(
            cooldownBefore,
        );

        await vi.advanceTimersByTimeAsync(60_000);
        await first;
    });

    it("retries a 429 and succeeds once the cooldown lifts", async () => {
        vi.useFakeTimers();
        const indexer = new RestIndexerProvider("http://localhost:7070");
        mockFetch.mockResolvedValueOnce(rateLimited("1")).mockResolvedValue(ok({ vtxos: [] }));

        const pending = indexer.getVtxos({ scripts: ["a"] });
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(pending).resolves.toMatchObject({ vtxos: [] });
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });
});
