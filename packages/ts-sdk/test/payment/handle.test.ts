import { describe, it, expect } from "vitest";
import { makeHandle } from "../../src/payment/handle";
import type { RouteResult } from "../../src/payment/types";

describe("makeHandle", () => {
    it("subscribe sees updates; settled resolves with the run's result", async () => {
        let finish!: () => void;
        const h = makeHandle(
            "op1",
            (emit) =>
                new Promise<RouteResult>((resolve) => {
                    finish = () => {
                        emit({ status: "settled", result: { railId: "ark", txid: "tx" } });
                        resolve({ railId: "ark", txid: "tx" });
                    };
                }),
        );
        const seen: string[] = [];
        h.subscribe((u) => seen.push(u.status));
        finish();
        expect(await h.settled()).toEqual({ railId: "ark", txid: "tx" });
        expect(seen).toContain("settled");
    });

    it("settled rejects on timeout for a never-resolving run", async () => {
        const h = makeHandle("op2", () => new Promise<RouteResult>(() => {}));
        await expect(h.settled({ timeoutMs: 20 })).rejects.toThrow(/timeout/i);
    });

    it("isolates a subscriber that throws on the initial replay", () => {
        const h = makeHandle("op3", () => new Promise<RouteResult>(() => {}));
        const thrower = () => {
            throw new Error("boom");
        };
        // The replay call inside subscribe() must not propagate the error, and a
        // later subscriber must still receive the replay.
        expect(() => h.subscribe(thrower)).not.toThrow();
        const seen: string[] = [];
        h.subscribe((u) => seen.push(u.status));
        expect(seen).toEqual(["pending"]);
    });

    it("emits a terminal failed update carrying the error when the run rejects", async () => {
        const boom = new Error("send failed");
        const h = makeHandle("op4", () => Promise.reject(boom));
        const seen: { status: string; error?: unknown }[] = [];
        h.subscribe((u) => seen.push({ status: u.status, error: u.error }));

        // settled() surfaces the original rejection to awaiters ...
        await expect(h.settled()).rejects.toThrow("send failed");
        // ... and the observable stream reaches "failed" with the error attached,
        // so a subscribe-only consumer also learns the payment failed.
        expect(h.status).toBe("failed");
        const failed = seen.find((u) => u.status === "failed");
        expect(failed?.error).toBe(boom);
    });

    it("keeps the settled status when the run rejects after emitting settled", async () => {
        const h = makeHandle("op5", (emit) => {
            emit({ status: "settled", result: { railId: "ark", txid: "tx" } });
            return Promise.reject(new Error("late boom"));
        });
        const seen: string[] = [];
        h.subscribe((u) => seen.push(u.status));
        // flush the rejection + catch microtasks
        await Promise.resolve();
        await Promise.resolve();
        expect(h.status).toBe("settled");
        expect(seen).not.toContain("failed");
    });
});
