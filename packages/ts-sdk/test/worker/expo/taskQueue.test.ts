import { describe, it, expect } from "vitest";
import {
    InMemoryTaskQueue,
    type TaskItem,
    type TaskResult,
} from "../../../src/worker/expo/taskQueue";

describe("InMemoryTaskQueue", () => {
    it("supports inbox and outbox happy paths", async () => {
        const queue = new InMemoryTaskQueue();
        const taskA: TaskItem = {
            id: "task-a",
            type: "contract-poll",
            data: {},
            createdAt: 1,
        };
        const taskB: TaskItem = {
            id: "task-b",
            type: "other",
            data: { value: 1 },
            createdAt: 2,
        };

        await queue.addTask(taskA);
        await queue.addTask(taskB);

        expect(await queue.getTasks()).toEqual([taskA, taskB]);
        expect(await queue.getTasks("contract-poll")).toEqual([taskA]);

        await queue.removeTask(taskA.id);
        expect(await queue.getTasks()).toEqual([taskB]);

        await queue.clearTasks();
        expect(await queue.getTasks()).toEqual([]);

        const resultA: TaskResult = {
            id: "result-a",
            taskItemId: "task-a",
            type: "contract-poll",
            status: "success",
            data: { ok: true },
            executedAt: 3,
        };
        const resultB: TaskResult = {
            id: "result-b",
            taskItemId: "task-b",
            type: "other",
            status: "noop",
            executedAt: 4,
        };

        await queue.pushResult(resultA);
        await queue.pushResult(resultB);
        expect(await queue.getResults()).toEqual([resultA, resultB]);

        await queue.acknowledgeResults([resultA.id]);
        expect(await queue.getResults()).toEqual([resultB]);
    });
});
