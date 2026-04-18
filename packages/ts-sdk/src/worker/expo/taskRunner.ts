import type { TaskItem, TaskResult, TaskQueue } from "./taskQueue";
import type { WalletRepository } from "../../repositories/walletRepository";
import type { ContractRepository } from "../../repositories/contractRepository";
import type { IndexerProvider } from "../../providers/indexer";
import type { ArkProvider } from "../../providers/ark";
import type { ExtendedVirtualCoin, VirtualCoin } from "../../wallet";
import type { Contract } from "../../contracts/types";
import type { ReadonlyWallet } from "../../wallet/wallet";
import {
    getRandomId,
    extendVirtualCoin,
    extendVtxoFromContract,
} from "../../wallet/utils";

/**
 * Shared dependencies injected into every processor at runtime.
 */
export interface TaskDependencies {
    walletRepository: WalletRepository;
    contractRepository: ContractRepository;
    indexerProvider: IndexerProvider;
    arkProvider: ArkProvider;
    extendVtxo: (vtxo: VirtualCoin, contract?: Contract) => ExtendedVirtualCoin;
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
export interface TaskProcessor<TDeps = TaskDependencies> {
    readonly taskType: string;
    execute(
        item: TaskItem,
        deps: TDeps
    ): Promise<Omit<TaskResult, "id" | "executedAt">>;
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
export async function runTasks<TDeps = TaskDependencies>(
    queue: TaskQueue,
    processors: TaskProcessor<TDeps>[],
    deps: TDeps
): Promise<TaskResult[]> {
    const tasks = await queue.getTasks();
    const processorMap = new Map(processors.map((p) => [p.taskType, p]));
    const results: TaskResult[] = [];

    for (const task of tasks) {
        const processor = processorMap.get(task.type);

        let partial: Omit<TaskResult, "id" | "executedAt">;

        if (!processor) {
            partial = {
                taskItemId: task.id,
                type: task.type,
                status: "noop",
            };
        } else {
            try {
                partial = await processor.execute(task, deps);
            } catch (error) {
                partial = {
                    taskItemId: task.id,
                    type: task.type,
                    status: "failed",
                    data: {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                };
            }
        }

        const result: TaskResult = {
            ...partial,
            id: getRandomId(),
            executedAt: Date.now(),
        };

        await queue.pushResult(result);
        await queue.removeTask(task.id);
        results.push(result);
    }

    return results;
}

/**
 * Options for @see createTaskDependencies.
 */
export interface CreateTaskDependenciesOptions {
    walletRepository: WalletRepository;
    contractRepository: ContractRepository;
    indexerProvider: IndexerProvider;
    arkProvider: ArkProvider;
    offchainTapscript: ReadonlyWallet["offchainTapscript"];
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
export function createTaskDependencies(
    options: CreateTaskDependenciesOptions
): TaskDependencies {
    const {
        walletRepository,
        contractRepository,
        indexerProvider,
        arkProvider,
        offchainTapscript,
    } = options;

    return {
        walletRepository,
        contractRepository,
        indexerProvider,
        arkProvider,
        extendVtxo: (vtxo: VirtualCoin, contract?: Contract) => {
            if (contract) {
                return extendVtxoFromContract(vtxo, contract);
            }
            return extendVirtualCoin({ offchainTapscript }, vtxo);
        },
    };
}
