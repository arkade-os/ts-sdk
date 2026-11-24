import { describe, it, expect } from "vitest";
import {
    AsyncStorageTaskQueue,
    type AsyncStorageLike,
} from "../../../src/worker/expo/asyncStorageTaskQueue";
import { testTaskQueueContract } from "./taskQueue.contract";

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

testTaskQueueContract("AsyncStorageTaskQueue", () => {
    return new AsyncStorageTaskQueue(new FakeAsyncStorage(), "queue:contract");
});

describe("AsyncStorageTaskQueue", () => {
    it("uses prefix-scoped storage keys", async () => {
        const storage = new FakeAsyncStorage();
        const queue = new AsyncStorageTaskQueue(storage, "queue:test");

        await queue.addTask({
            id: "task-1",
            type: "contract-poll",
            data: {},
            createdAt: 1,
        });
        expect(storage.values.has("queue:test:inbox")).toBe(true);

        await queue.pushResult({
            id: "result-1",
            taskItemId: "task-1",
            type: "contract-poll",
            status: "noop",
            executedAt: 2,
        });
        expect(storage.values.has("queue:test:outbox")).toBe(true);
    });

    it("persists config", async () => {
        const queue = new AsyncStorageTaskQueue(new FakeAsyncStorage(), "queue:test");
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
