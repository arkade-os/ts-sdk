import { describe, expect, it } from "vitest";
import { createSolverHealth } from "../../src/client/solverHealth";

const scope = { network: "regtest", direction: "give>take" };

describe("solver reliability", () => {
    it("demotes repeated failures, backs off, forgets old streaks and recovers on success", async () => {
        let now = 1_000_000;
        let changes = 0;
        const health = createSolverHealth({
            now: () => now,
            onChange: () => {
                changes += 1;
            },
        });
        await health.record(scope, "a", "failure");
        expect(await health.deprioritized(scope)).toEqual([]);
        expect(changes).toBe(0);
        await health.record(scope, "a", "failure");
        expect(await health.deprioritized(scope)).toEqual(["a"]);
        expect(changes).toBe(1);
        now += 60_000;
        expect(await health.deprioritized(scope)).toEqual([]);
        await health.record(scope, "a", "failure");
        now += 60_000;
        expect(await health.deprioritized(scope)).toEqual(["a"]);
        await health.record(scope, "a", "success");
        expect(await health.deprioritized(scope)).toEqual([]);
        await health.record(scope, "a", "failure");
        now += 30 * 60_000;
        await health.record(scope, "a", "failure");
        expect(await health.deprioritized(scope)).toEqual([]);
    });

    it("serializes shared storage updates and separates networks and directions", async () => {
        let stored = {};
        const storage = {
            load: async () => structuredClone(stored),
            save: async (_scope: unknown, next: object) => {
                stored = structuredClone(next);
            },
        };
        const health = createSolverHealth({ storage, now: () => 1_000_000 });
        await Promise.all([
            health.record(scope, "a", "failure"),
            health.record(scope, "a", "failure"),
        ]);
        expect(await health.deprioritized(scope)).toEqual(["a"]);
        const restored = createSolverHealth({ storage, now: () => 1_000_000 });
        expect(await restored.deprioritized(scope)).toEqual(["a"]);
        const isolated = createSolverHealth({ now: () => 1_000_000 });
        await isolated.record(scope, "a", "failure");
        await isolated.record(scope, "a", "failure");
        expect(await isolated.deprioritized({ ...scope, network: "bitcoin" })).toEqual([]);
        expect(await isolated.deprioritized({ ...scope, direction: "take>give" })).toEqual([]);
    });

    it("bounds cooldowns, ignores corrupt history and keeps storage failures advisory", async () => {
        let now = 1_000_000;
        const health = createSolverHealth({ now: () => now });
        for (let i = 0; i < 20; i++) await health.record(scope, "a", "failure");
        now += 15 * 60_000;
        expect(await health.deprioritized(scope)).toEqual([]);
        const broken = createSolverHealth({
            storage: {
                load: () => {
                    throw Error("offline");
                },
                save: () => {
                    throw Error("quota");
                },
            },
        });
        await expect(broken.record(scope, "a", "failure")).resolves.toBeUndefined();
        expect(await broken.deprioritized(scope)).toEqual([]);
        const corrupt = createSolverHealth({
            now: () => now,
            storage: {
                load: () => ({ bad: { failures: -2, lastFailureAt: Infinity } }),
                save: () => {},
            },
        });
        expect(await corrupt.deprioritized(scope)).toEqual([]);
    });
});
