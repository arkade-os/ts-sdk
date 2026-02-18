import { hex } from "@scure/base";
import { Wallet } from "../wallet";
import { RestArkProvider } from "../../providers/ark";
import type {
    IWallet,
    WalletBalance,
    WalletConfig,
    SendBitcoinParams,
    SettleParams,
    GetVtxosFilter,
    ArkTransaction,
    ExtendedCoin,
    ExtendedVirtualCoin,
} from "..";
import type { VirtualCoin } from "..";
import type { SettlementEvent } from "../../providers/ark";
import type { Identity } from "../../identity";
import type { IContractManager } from "../../contracts/contractManager";
import type { TaskQueue, TaskItem } from "../../worker/expo/taskQueue";
import type {
    TaskProcessor,
    TaskDependencies,
} from "../../worker/expo/taskRunner";
import { runTasks } from "../../worker/expo/taskRunner";
import {
    contractPollProcessor,
    CONTRACT_POLL_TASK_TYPE,
} from "../../worker/expo/processors";
import { extendVirtualCoin, getRandomId } from "../utils";
import { DefaultVtxo } from "../../script/default";
import type { PersistedBackgroundConfig } from "./background";
import type { AsyncStorageTaskQueue } from "../../worker/expo/asyncStorageTaskQueue";

/**
 * Background processing configuration for {@link ExpoWallet}.
 */
export interface ExpoBackgroundConfig {
    /** Identifier registered with expo-background-task. */
    taskName: string;
    /** Persistence layer for foreground ↔ background handoff. */
    taskQueue: TaskQueue;
    /** Processors to run on each tick. Defaults to `[contractPollProcessor]`. */
    processors?: TaskProcessor[];
    /** If set, automatically polls at this interval (ms) while the app is in the foreground. */
    foregroundIntervalMs?: number;
    /** If set, registers the background task with the OS at this interval (minutes, min 15). */
    minimumBackgroundInterval?: number;
}

/**
 * Configuration for {@link ExpoWallet.setup}.
 */
export interface ExpoWalletConfig extends WalletConfig {
    background: ExpoBackgroundConfig;
}

/**
 * Expo/React Native wallet with built-in background task processing.
 *
 * Wraps a standard {@link Wallet} and adds a lightweight task queue
 * for keeping contract/VTXO state fresh while the app is active and
 * across Expo BackgroundTask wakes.
 *
 * @example
 * ```ts
 * import { ExpoWallet } from "@arkade-os/sdk/wallet/expo";
 * import { AsyncStorageTaskQueue } from "@arkade-os/sdk/worker/expo";
 *
 * const wallet = await ExpoWallet.setup({
 *     identity: SingleKey.fromHex(privateKey),
 *     arkServerUrl,
 *     esploraUrl,
 *     storage: { walletRepository, contractRepository },
 *     background: {
 *         taskName: "ark-background-poll",
 *         taskQueue: new AsyncStorageTaskQueue(AsyncStorage),
 *         foregroundIntervalMs: 20_000,
 *         minimumBackgroundInterval: 15,
 *     },
 * });
 *
 * const balance = await wallet.getBalance();
 * ```
 */
export class ExpoWallet implements IWallet {
    readonly identity: Identity;
    readonly arkProvider: Wallet["arkProvider"];
    readonly indexerProvider: Wallet["indexerProvider"];

    private foregroundIntervalId?: ReturnType<typeof setInterval>;
    private readonly taskName: string;

    private constructor(
        private readonly wallet: Wallet,
        private readonly taskQueue: TaskQueue,
        private readonly processors: TaskProcessor[],
        private readonly deps: TaskDependencies,
        taskName: string,
        foregroundIntervalMs?: number
    ) {
        this.identity = wallet.identity;
        this.arkProvider = wallet.arkProvider;
        this.indexerProvider = wallet.indexerProvider;
        this.taskName = taskName;

        if (foregroundIntervalMs && foregroundIntervalMs > 0) {
            this.startForegroundPolling(foregroundIntervalMs);
        }
    }

    /**
     * Create an ExpoWallet with background task support.
     *
     * 1. Creates the inner {@link Wallet} via `Wallet.create()`.
     * 2. Wires up processors (defaults to {@link contractPollProcessor}).
     * 3. Persists background config for the background handler (if the queue supports it).
     * 4. Seeds the task queue with a `contract-poll` task.
     * 5. Registers the background task with the OS scheduler (if `minimumBackgroundInterval` is set).
     * 6. Starts foreground polling if `foregroundIntervalMs` is set.
     */
    static async setup(config: ExpoWalletConfig): Promise<ExpoWallet> {
        const wallet = await Wallet.create(config);

        const processors = config.background.processors ?? [
            contractPollProcessor,
        ];

        const deps: TaskDependencies = {
            walletRepository: wallet.walletRepository,
            contractRepository: wallet.contractRepository,
            indexerProvider: wallet.indexerProvider,
            arkProvider: wallet.arkProvider,
            extendVtxo: (vtxo: VirtualCoin) => extendVirtualCoin(wallet, vtxo),
        };

        const { taskQueue } = config.background;

        // Persist wallet params so the background handler can rehydrate
        // without a network call. Only works with AsyncStorageTaskQueue.
        if ("persistConfig" in taskQueue) {
            const arkServerUrl =
                config.arkServerUrl ??
                (wallet.arkProvider instanceof RestArkProvider
                    ? wallet.arkProvider.serverUrl
                    : undefined);

            if (arkServerUrl) {
                const timelock =
                    wallet.offchainTapscript.options.csvTimelock ??
                    DefaultVtxo.Script.DEFAULT_TIMELOCK;

                const bgConfig: PersistedBackgroundConfig = {
                    arkServerUrl,
                    pubkeyHex: hex.encode(
                        wallet.offchainTapscript.options.pubKey
                    ),
                    serverPubKeyHex: hex.encode(
                        wallet.offchainTapscript.options.serverPubKey
                    ),
                    exitTimelockValue: timelock.value.toString(),
                    exitTimelockType: timelock.type,
                };

                await (taskQueue as AsyncStorageTaskQueue).persistConfig(
                    bgConfig
                );
            }
        }

        const expoWallet = new ExpoWallet(
            wallet,
            taskQueue,
            processors,
            deps,
            config.background.taskName,
            config.background.foregroundIntervalMs
        );

        // Seed the queue so the first tick (or background wake) has work to do
        await expoWallet.seedContractPollTask();

        // Activate OS-level background scheduling
        if (config.background.minimumBackgroundInterval) {
            try {
                const { registerExpoBackgroundTask } = await import(
                    "./background"
                );
                await registerExpoBackgroundTask(config.background.taskName, {
                    minimumInterval:
                        config.background.minimumBackgroundInterval,
                });
            } catch {
                // expo-background-task not installed — foreground-only mode
            }
        }

        return expoWallet;
    }

    // ── Foreground polling ───────────────────────────────────────────

    private startForegroundPolling(intervalMs: number): void {
        this.foregroundIntervalId = setInterval(() => {
            this.runForegroundPoll().catch(console.error);
        }, intervalMs);
    }

    private async runForegroundPoll(): Promise<void> {
        await runTasks(this.taskQueue, this.processors, this.deps);

        // Consume results immediately (no background handoff needed)
        const results = await this.taskQueue.getResults();
        if (results.length > 0) {
            await this.taskQueue.acknowledgeResults(results.map((r) => r.id));
        }

        // Re-seed for the next tick
        await this.seedContractPollTask();
    }

    private async seedContractPollTask(): Promise<void> {
        const existing = await this.taskQueue.getTasks(CONTRACT_POLL_TASK_TYPE);
        if (existing.length > 0) return;

        const task: TaskItem = {
            id: getRandomId(),
            type: CONTRACT_POLL_TASK_TYPE,
            data: {},
            createdAt: Date.now(),
        };
        await this.taskQueue.addTask(task);
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    /**
     * Stop foreground polling and unregister the background task.
     */
    async dispose(): Promise<void> {
        if (this.foregroundIntervalId) {
            clearInterval(this.foregroundIntervalId);
            this.foregroundIntervalId = undefined;
        }

        try {
            const { unregisterExpoBackgroundTask } = await import(
                "./background"
            );
            await unregisterExpoBackgroundTask(this.taskName);
        } catch {
            // expo-background-task not installed — nothing to unregister
        }
    }

    // ── IWallet delegation ───────────────────────────────────────────

    getAddress(): Promise<string> {
        return this.wallet.getAddress();
    }

    getBoardingAddress(): Promise<string> {
        return this.wallet.getBoardingAddress();
    }

    getBalance(): Promise<WalletBalance> {
        return this.wallet.getBalance();
    }

    getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]> {
        return this.wallet.getVtxos(filter);
    }

    getBoardingUtxos(): Promise<ExtendedCoin[]> {
        return this.wallet.getBoardingUtxos();
    }

    getTransactionHistory(): Promise<ArkTransaction[]> {
        return this.wallet.getTransactionHistory();
    }

    getContractManager(): Promise<IContractManager> {
        return this.wallet.getContractManager();
    }

    sendBitcoin(params: SendBitcoinParams): Promise<string> {
        return this.wallet.sendBitcoin(params);
    }

    settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string> {
        return this.wallet.settle(params, eventCallback);
    }
}
