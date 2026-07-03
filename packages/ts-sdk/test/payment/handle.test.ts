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
});
