import { W as WalletRepository, C as ContractRepository, n as IndexerProvider, m as ArkProvider, q as VirtualCoin, r as Contract, E as ExtendedVirtualCoin } from './ark-BCdDnaIQ.js';

/**
 * A task item represents a unit of work in the inbox.
 */
interface TaskItem {
    id: string;
    type: string;
    data: Record<string, unknown>;
    createdAt: number;
}
/**
 * A task result represents the outcome of processing a task item.
 */
interface TaskResult {
    id: string;
    taskItemId: string;
    type: string;
    status: "success" | "failed" | "noop";
    data?: Record<string, unknown>;
    executedAt: number;
}
/**
 * Persistence layer for handing off work between foreground and background.
 *
 * - **Inbox**: tasks waiting to be processed.
 * - **Outbox**: results produced by processors, waiting to be consumed.
 */
interface TaskQueue {
    addTask(task: TaskItem): Promise<void>;
    removeTask(id: string): Promise<void>;
    getTasks(type?: string): Promise<TaskItem[]>;
    clearTasks(): Promise<void>;
    pushResult(result: TaskResult): Promise<void>;
    getResults(): Promise<TaskResult[]>;
    acknowledgeResults(ids: string[]): Promise<void>;
}
/**
 * In-memory TaskQueue for testing and lightweight use.
 * State is lost when the process exits.
 */
declare class InMemoryTaskQueue implements TaskQueue {
    private inbox;
    private outbox;
    addTask(task: TaskItem): Promise<void>;
    removeTask(id: string): Promise<void>;
    getTasks(type?: string): Promise<TaskItem[]>;
    clearTasks(): Promise<void>;
    pushResult(result: TaskResult): Promise<void>;
    getResults(): Promise<TaskResult[]>;
    acknowledgeResults(ids: string[]): Promise<void>;
}

/**
 * Shared dependencies injected into every processor at runtime.
 *
 * `extendVtxo` requires the owning contract — processors must resolve each
 * vtxo's `script` to a known contract (via the contract repository) before
 * calling this. The strict signature prevents the footgun where a missing
 * contract silently falls back to the wallet's default tapscript.
 */
interface TaskDependencies {
    walletRepository: WalletRepository;
    contractRepository: ContractRepository;
    indexerProvider: IndexerProvider;
    arkProvider: ArkProvider;
    extendVtxo: (vtxo: VirtualCoin, contract: Contract) => ExtendedVirtualCoin;
}
/**
 * A stateless unit that handles one type of task item.
 *
 * Processors must not keep in-memory state across invocations —
 * all coordination lives in the @see TaskQueue and repositories.
 *
 * The `TDeps` parameter defaults to @see TaskDependencies but
 * can be overridden for domain-specific processors (e.g. swap processing).
 */
interface TaskProcessor<TDeps = TaskDependencies> {
    readonly taskType: string;
    execute(item: TaskItem, deps: TDeps): Promise<Omit<TaskResult, "id" | "executedAt">>;
}
/**
 * Run all pending tasks from the queue through matching processors.
 *
 * For each task in the inbox:
 * 1. Find the processor whose `taskType` matches `task.type`.
 * 2. Execute it, producing a @see TaskResult.
 * 3. Push the result to the outbox and remove the task from the inbox.
 *
 * Tasks with no matching processor produce a `"noop"` result.
 * Processor errors produce a `"failed"` result with the error message.
 */
declare function runTasks<TDeps = TaskDependencies>(queue: TaskQueue, processors: TaskProcessor<TDeps>[], deps: TDeps): Promise<TaskResult[]>;
/**
 * Options for @see createTaskDependencies.
 */
interface CreateTaskDependenciesOptions {
    walletRepository: WalletRepository;
    contractRepository: ContractRepository;
    indexerProvider: IndexerProvider;
    arkProvider: ArkProvider;
}
/**
 * Build the @see TaskDependencies needed by task processors
 * (e.g. `src/worker/expo/processors/contractPollProcessor.ts`)
 *
 * This is the same construction that `defineExpoBackgroundTask` does
 * internally, extracted so that consumers with custom schedulers
 * (e.g. bare React Native with `react-native-background-fetch`)
 * can build deps without depending on Expo.
 */
declare function createTaskDependencies(options: CreateTaskDependenciesOptions): TaskDependencies;

export { type CreateTaskDependenciesOptions as C, InMemoryTaskQueue as I, type TaskProcessor as T, type TaskQueue as a, type TaskDependencies as b, type TaskItem as c, type TaskResult as d, createTaskDependencies as e, runTasks as r };
