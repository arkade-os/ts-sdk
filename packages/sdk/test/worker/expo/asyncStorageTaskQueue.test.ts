import { describe, it, expect } from "vitest";
import {
    AsyncStorageTaskQueue,
    type AsyncStorageLike,
} from "../../../src/worker/expo/asyncStorageTaskQueue";
import type { TaskItem, TaskResult } from "../../../src/worker/expo/taskQueue";

class FakeAsyncStorage implements AsyncStorageLike {
    readonly values = new Map<string, string>();

    async getItem(key: string): Promise<string | null> {
        return this.values.get(key) ?? null;
    }

    async setItem(key: string, value: string): Promise<void> {
        this.values.set(key, value);
    }

    async removeItem(key: string): Promise<void> {
        this.values.delete(key);
    }
}

describe("AsyncStorageTaskQueue", () => {
    it("supports inbox, outbox, and config happy paths", async () => {
        const storage = new FakeAsyncStorage();
        const queue = new AsyncStorageTaskQueue(storage, "queue:test");

        const task: TaskItem = {
            id: "task-1",
            type: "contract-poll",
            data: {},
            createdAt: 10,
        };

        await queue.addTask(task);
        expect(await queue.getTasks()).toEqual([task]);
        expect(await queue.getTasks("contract-poll")).toEqual([task]);
        expect(storage.values.has("queue:test:inbox")).toBe(true);

        await queue.removeTask(task.id);
        expect(await queue.getTasks()).toEqual([]);

        await queue.addTask(task);
        await queue.clearTasks();
        expect(await queue.getTasks()).toEqual([]);

        const result: TaskResult = {
            id: "result-1",
            taskItemId: task.id,
            type: task.type,
            status: "success",
            executedAt: 11,
        };
        await queue.pushResult(result);
        expect(await queue.getResults()).toEqual([result]);

        await queue.acknowledgeResults([result.id]);
        expect(await queue.getResults()).toEqual([]);

        const config = { arkServerUrl: "https://ark.example", version: 1 };
        await queue.persistConfig(config);
        expect(await queue.loadConfig()).toEqual(config);
    });

    it("isolates data by prefix", async () => {
        const storage = new FakeAsyncStorage();
        const queueA = new AsyncStorageTaskQueue(storage, "queue:a");
        const queueB = new AsyncStorageTaskQueue(storage, "queue:b");

        await queueA.addTask({
            id: "task-a",
            type: "contract-poll",
            data: {},
            createdAt: 1,
        });
        await queueB.addTask({
            id: "task-b",
            type: "contract-poll",
            data: {},
            createdAt: 2,
        });

        expect((await queueA.getTasks()).map((t) => t.id)).toEqual(["task-a"]);
        expect((await queueB.getTasks()).map((t) => t.id)).toEqual(["task-b"]);
    });
});
