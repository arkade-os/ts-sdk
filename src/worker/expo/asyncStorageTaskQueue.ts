import type { TaskItem, TaskResult, TaskQueue } from "./taskQueue";

/**
 * Minimal async key-value storage interface.
 *
 * Compatible with `@react-native-async-storage/async-storage` and
 * any other storage that exposes the same three methods.
 */
export interface AsyncStorageLike {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

/**
 * AsyncStorage-backed TaskQueue for Expo/React Native.
 *
 * Persists inbox, outbox, and an optional config blob to AsyncStorage
 * so that data survives process restarts and can be shared between
 * foreground and background execution contexts.
 */
export class AsyncStorageTaskQueue implements TaskQueue {
    private readonly inboxKey: string;
    private readonly outboxKey: string;
    private readonly configKey: string;

    constructor(
        private readonly storage: AsyncStorageLike,
        prefix = "ark:task-queue"
    ) {
        this.inboxKey = `${prefix}:inbox`;
        this.outboxKey = `${prefix}:outbox`;
        this.configKey = `${prefix}:config`;
    }

    // ── Inbox ────────────────────────────────────────────────────────

    async addTask(task: TaskItem): Promise<void> {
        const tasks = await this.readList<TaskItem>(this.inboxKey);
        tasks.push(task);
        await this.writeList(this.inboxKey, tasks);
    }

    async removeTask(id: string): Promise<void> {
        const tasks = await this.readList<TaskItem>(this.inboxKey);
        await this.writeList(
            this.inboxKey,
            tasks.filter((t) => t.id !== id)
        );
    }

    async getTasks(type?: string): Promise<TaskItem[]> {
        const tasks = await this.readList<TaskItem>(this.inboxKey);
        if (type) {
            return tasks.filter((t) => t.type === type);
        }
        return tasks;
    }

    async clearTasks(): Promise<void> {
        await this.storage.removeItem(this.inboxKey);
    }

    // ── Outbox ───────────────────────────────────────────────────────

    async pushResult(result: TaskResult): Promise<void> {
        const results = await this.readList<TaskResult>(this.outboxKey);
        results.push(result);
        await this.writeList(this.outboxKey, results);
    }

    async getResults(): Promise<TaskResult[]> {
        return this.readList<TaskResult>(this.outboxKey);
    }

    async acknowledgeResults(ids: string[]): Promise<void> {
        const idSet = new Set(ids);
        const results = await this.readList<TaskResult>(this.outboxKey);
        await this.writeList(
            this.outboxKey,
            results.filter((r) => !idSet.has(r.id))
        );
    }

    // ── Config persistence (for background handler rehydration) ──────

    /**
     * Persist a config blob alongside the queue data.
     * Used by {@link ExpoWallet.setup} to store the wallet parameters
     * that the background handler needs to reconstruct providers.
     */
    async persistConfig(
        config: Record<string, unknown> | object
    ): Promise<void> {
        await this.storage.setItem(this.configKey, JSON.stringify(config));
    }

    /**
     * Load the persisted config blob.
     * Used by the background handler to rehydrate wallet dependencies.
     */
    async loadConfig<T = Record<string, unknown>>(): Promise<T | null> {
        const raw = await this.storage.getItem(this.configKey);
        return raw ? JSON.parse(raw) : null;
    }

    // ── Helpers ──────────────────────────────────────────────────────

    private async readList<T>(key: string): Promise<T[]> {
        const raw = await this.storage.getItem(key);
        return raw ? JSON.parse(raw) : [];
    }

    private async writeList<T>(key: string, list: T[]): Promise<void> {
        await this.storage.setItem(key, JSON.stringify(list));
    }
}
