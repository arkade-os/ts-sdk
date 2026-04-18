import { describe, it, expect, vi } from "vitest";
import { InMemoryTaskQueue } from "../../../src/worker/expo/taskQueue";
import {
    runTasks,
    type TaskProcessor,
} from "../../../src/worker/expo/taskRunner";

describe("runTasks", () => {
    it("runs matching processors and persists results", async () => {
        const queue = new InMemoryTaskQueue();
        const item = {
            id: "task-1",
            type: "contract-poll",
            data: { sample: true },
            createdAt: 10,
        };
        await queue.addTask(item);

        const deps = {
            walletRepository: {},
            contractRepository: {},
            indexerProvider: {},
            arkProvider: {},
            extendVtxo: (vtxo: unknown) => vtxo,
        } as any;

        const execute = vi.fn(async () => ({
            taskItemId: item.id,
            type: item.type,
            status: "success" as const,
            data: { updated: 1 },
        }));

        const processor: TaskProcessor = {
            taskType: "contract-poll",
            execute,
        };

        const results = await runTasks(queue, [processor], deps);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            taskItemId: item.id,
            type: item.type,
            status: "success",
            data: { updated: 1 },
        });
        expect(typeof results[0].id).toBe("string");
        expect(typeof results[0].executedAt).toBe("number");
        expect(execute).toHaveBeenCalledWith(item, deps);
        expect(await queue.getTasks()).toEqual([]);
        expect(await queue.getResults()).toEqual(results);
    });

    it("produces a noop result when no processor matches", async () => {
        const queue = new InMemoryTaskQueue();
        const item = {
            id: "task-2",
            type: "unknown-type",
            data: {},
            createdAt: 20,
        };
        await queue.addTask(item);

        const deps = {
            walletRepository: {},
            contractRepository: {},
            indexerProvider: {},
            arkProvider: {},
            extendVtxo: (vtxo: unknown) => vtxo,
        } as any;

        const results = await runTasks(queue, [], deps);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            taskItemId: "task-2",
            type: "unknown-type",
            status: "noop",
        });
        expect(await queue.getTasks()).toEqual([]);
        expect(await queue.getResults()).toEqual(results);
    });

    it("catches processor errors and produces a failed result", async () => {
        const queue = new InMemoryTaskQueue();
        const item = {
            id: "task-3",
            type: "contract-poll",
            data: {},
            createdAt: 30,
        };
        await queue.addTask(item);

        const deps = {
            walletRepository: {},
            contractRepository: {},
            indexerProvider: {},
            arkProvider: {},
            extendVtxo: (vtxo: unknown) => vtxo,
        } as any;

        const processor: TaskProcessor = {
            taskType: "contract-poll",
            execute: vi.fn().mockRejectedValue(new Error("indexer offline")),
        };

        const results = await runTasks(queue, [processor], deps);

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            taskItemId: "task-3",
            type: "contract-poll",
            status: "failed",
            data: { error: "indexer offline" },
        });
        expect(await queue.getTasks()).toEqual([]);
        expect(await queue.getResults()).toEqual(results);
    });
});
