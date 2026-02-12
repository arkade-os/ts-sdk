import { Wallet } from "../wallet";
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
import { extendVirtualCoin } from "../utils";

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
 * import { InMemoryTaskQueue } from "@arkade-os/sdk/worker/expo";
 *
 * const wallet = await ExpoWallet.setup({
 *     identity: SingleKey.fromHex(privateKey),
 *     arkServerUrl,
 *     esploraUrl,
 *     storage: { walletRepository, contractRepository },
 *     background: {
 *         taskName: "ark-background-poll",
 *         taskQueue: new InMemoryTaskQueue(),
 *         foregroundIntervalMs: 20_000,
 *     },
 * });
 *
 * const balance = await wallet.getBalance();
 * ```
 */
export class ExpoWallet implements IWallet {
    readonly identity: Identity;

    private foregroundIntervalId?: ReturnType<typeof setInterval>;

    private constructor(
        private readonly wallet: Wallet,
        private readonly taskQueue: TaskQueue,
        private readonly processors: TaskProcessor[],
        private readonly deps: TaskDependencies,
        foregroundIntervalMs?: number
    ) {
        this.identity = wallet.identity;

        if (foregroundIntervalMs && foregroundIntervalMs > 0) {
            this.startForegroundPolling(foregroundIntervalMs);
        }
    }

    /**
     * Create an ExpoWallet with background task support.
     *
     * 1. Creates the inner {@link Wallet} via `Wallet.create()`.
     * 2. Wires up processors (defaults to {@link contractPollProcessor}).
     * 3. Seeds the task queue with a `contract-poll` task.
     * 4. Starts foreground polling if `foregroundIntervalMs` is set.
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

        const expoWallet = new ExpoWallet(
            wallet,
            config.background.taskQueue,
            processors,
            deps,
            config.background.foregroundIntervalMs
        );

        // Seed the queue so the first tick (or background wake) has work to do
        await expoWallet.seedContractPollTask();

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
            id: crypto.randomUUID(),
            type: CONTRACT_POLL_TASK_TYPE,
            data: {},
            createdAt: Date.now(),
        };
        await this.taskQueue.addTask(task);
    }

    // ── Background wake (TODO: wire to expo-background-task) ─────────

    // TODO: Register `config.background.taskName` with expo-background-task.
    // On wake: rehydrate providers, load queue, call runTasks(), return.
    // On foreground resume: read outbox, acknowledge results, re-seed.

    // ── Lifecycle ────────────────────────────────────────────────────

    dispose(): void {
        if (this.foregroundIntervalId) {
            clearInterval(this.foregroundIntervalId);
            this.foregroundIntervalId = undefined;
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
