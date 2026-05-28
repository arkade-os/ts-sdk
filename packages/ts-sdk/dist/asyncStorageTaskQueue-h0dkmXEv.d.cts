import { c as TaskQueue, b as TaskItem, d as TaskResult } from './taskRunner--xNlod--.cjs';

/**
 * Minimal async key-value storage interface.
 *
 * Compatible with `@react-native-async-storage/async-storage` and
 * any other storage that exposes the same three methods.
 */
interface AsyncStorageLike {
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
declare class AsyncStorageTaskQueue implements TaskQueue {
    private readonly storage;
    private readonly inboxKey;
    private readonly outboxKey;
    private readonly configKey;
    constructor(storage: AsyncStorageLike, prefix?: string);
    addTask(task: TaskItem): Promise<void>;
    removeTask(id: string): Promise<void>;
    getTasks(type?: string): Promise<TaskItem[]>;
    clearTasks(): Promise<void>;
    pushResult(result: TaskResult): Promise<void>;
    getResults(): Promise<TaskResult[]>;
    acknowledgeResults(ids: string[]): Promise<void>;
    /**
     * Persist a config blob alongside the queue data.
     * Used by @see ExpoWallet.setup to store the wallet parameters
     * that the background handler needs to reconstruct providers.
     */
    persistConfig(config: Record<string, unknown> | object): Promise<void>;
    /**
     * Load the persisted config blob.
     * Used by the background handler to rehydrate wallet dependencies.
     */
    loadConfig<T = Record<string, unknown>>(): Promise<T | null>;
    private readList;
    private writeList;
}

export { type AsyncStorageLike as A, AsyncStorageTaskQueue as a };
