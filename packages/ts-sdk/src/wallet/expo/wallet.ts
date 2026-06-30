import { hex } from "@scure/base";
import { Wallet } from "../wallet";
import { RestArkProvider } from "../../providers/ark";
import type {
    IWallet,
    IAssetManager,
    WalletBalance,
    WalletConfig,
    SendBitcoinParams,
    SettleParams,
    GetVtxosFilter,
    ArkTransaction,
    ExtendedCoin,
    ExtendedVirtualCoin,
    Recipient,
} from "..";
import type { SettlementEvent } from "../../providers/ark";
import type { Identity } from "../../identity";
import type { IContractManager } from "../../contracts/contractManager";
import type { IDelegateManager } from "../delegate";
import type { TaskQueue, TaskItem } from "../../worker/expo/taskQueue";
import type { TaskProcessor, TaskDependencies } from "../../worker/expo/taskRunner";
import { runTasks } from "../../worker/expo/taskRunner";
import { contractPollProcessor, CONTRACT_POLL_TASK_TYPE } from "../../worker/expo/processors";
import { extendVirtualCoinForContract, getRandomId } from "../utils";
import type { PersistedBackgroundConfig } from "./background";
import type { AsyncStorageTaskQueue } from "../../worker/expo/asyncStorageTaskQueue";

/**
 * Background processing configuration for @see ExpoWallet.
 *
 * OS-level task registration is **not** part of this config — call
 * `registerExpoBackgroundTask` from `@arkade-os/sdk/wallet/expo/background`
 * explicitly. Splitting that step out keeps `/wallet/expo` free of the
 * `expo-task-manager` / `expo-background-task` dependencies, so
 * react-native-web and Node consumers can use `ExpoWallet` without
 * those native packages. See
 * https://github.com/arkade-os/ts-sdk/issues/486 for details.
 */
export interface ExpoBackgroundConfig {
    /** Persistence layer for foreground ↔ background handoff. */
    taskQueue: TaskQueue;
    /** Processors to run on each tick. Defaults to `[contractPollProcessor]`. */
    processors?: TaskProcessor[];
    /** If set, automatically polls at this interval (ms) while the app is in the foreground. */
    foregroundIntervalMs?: number;
}

/**
 * Configuration for @see ExpoWallet.setup.
 */
export interface ExpoWalletConfig extends WalletConfig {
    background: ExpoBackgroundConfig;
}

/**
 * Catches JS callers still passing the pre-fix-#486 fields: TypeScript
 * blocks these at compile time, but compiled JS silently dropped them
 * and consumers would never realize the OS task wasn't scheduled.
 *
 * @internal Exported for tests; not part of the public API surface.
 */
export function warnOnRemovedBackgroundFields(bg: unknown): void {
    if (!bg || typeof bg !== "object") return;
    const removed: string[] = [];
    if ("taskName" in bg) removed.push("taskName");
    if ("minimumBackgroundInterval" in bg) {
        removed.push("minimumBackgroundInterval");
    }
    if (removed.length === 0) return;
    console.warn(
        `[ark-sdk] ExpoWallet.setup: ignoring removed background field(s): ${removed.join(", ")}. ` +
            'OS-task registration moved to "@arkade-os/sdk/wallet/expo/background". ' +
            "See https://github.com/arkade-os/ts-sdk/issues/486",
    );
}

/**
 * Expo/React Native wallet with built-in background task processing.
 *
 * Wraps a standard @see Wallet and adds a lightweight task queue
 * for keeping contract/VTXO state fresh while the app is active and
 * across Expo BackgroundTask wakes.
 *
 * OS-level task registration is the consumer's responsibility — call
 * `registerExpoBackgroundTask` from
 * `@arkade-os/sdk/wallet/expo/background` after `setup()`. Keeping
 * registration out of `setup()` lets this entrypoint avoid pulling
 * `expo-task-manager` / `expo-background-task` into the `/wallet/expo`
 * bundle.
 *
 * @example
 * ```ts
 * import { ExpoWallet } from "@arkade-os/sdk/wallet/expo";
 * import { registerExpoBackgroundTask } from "@arkade-os/sdk/wallet/expo/background";
 * import { AsyncStorageTaskQueue } from "@arkade-os/sdk/worker/expo";
 *
 * const wallet = await ExpoWallet.setup({
 *     identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *     arkProvider: new RestArkProvider(),
 *     onchainProvider: new EsploraProvider(),
 *     storage: { ... },
 *     background: {
 *         taskQueue: new AsyncStorageTaskQueue(AsyncStorage),
 *         foregroundIntervalMs: 20_000,
 *     },
 * });
 *
 * // Activate the OS scheduler (Expo Android/iOS only)
 * await registerExpoBackgroundTask("ark-background-poll", { minimumInterval: 15 });
 *
 * const balance = await wallet.getBalance();
 * ```
 */
export class ExpoWallet implements IWallet {
    readonly identity: Identity;
    readonly arkProvider: Wallet["arkProvider"];
    readonly indexerProvider: Wallet["indexerProvider"];

    private foregroundIntervalId?: ReturnType<typeof setInterval>;

    private constructor(
        private readonly wallet: Wallet,
        private readonly taskQueue: TaskQueue,
        private readonly processors: TaskProcessor[],
        private readonly deps: TaskDependencies,
        foregroundIntervalMs?: number,
    ) {
        this.identity = wallet.identity;
        this.arkProvider = wallet.arkProvider;
        this.indexerProvider = wallet.indexerProvider;

        if (foregroundIntervalMs && foregroundIntervalMs > 0) {
            this.startForegroundPolling(foregroundIntervalMs);
        }
    }

    /**
     * Create an ExpoWallet with foreground/background queue handoff.
     *
     * 1. Creates the inner @see Wallet via `Wallet.create()`.
     * 2. Wires up processors (defaults to @see contractPollProcessor).
     * 3. Persists background config for the background handler (if the queue supports it).
     * 4. Seeds the task queue with a `contract-poll` task.
     * 5. Starts the foreground interval if `foregroundIntervalMs` is set.
     *
     * OS-level scheduling lives in
     * `@arkade-os/sdk/wallet/expo/background` and is invoked separately
     * by the consumer.
     */
    static async setup(config: ExpoWalletConfig): Promise<ExpoWallet> {
        warnOnRemovedBackgroundFields(config.background);

        const wallet = await Wallet.create(config);

        const processors = config.background.processors ?? [contractPollProcessor];

        const deps: TaskDependencies = {
            walletRepository: wallet.walletRepository,
            contractRepository: wallet.contractRepository,
            indexerProvider: wallet.indexerProvider,
            arkProvider: wallet.arkProvider,
            extendVtxo: (vtxo, contract) => extendVirtualCoinForContract(vtxo, contract),
        };

        const { taskQueue } = config.background;

        // Persist wallet params so the background handler can rehydrate
        // without a network call. Only works with AsyncStorageTaskQueue.
        if ("persistConfig" in taskQueue) {
            const arkServerUrl =
                config.arkServerUrl ||
                (wallet.arkProvider instanceof RestArkProvider
                    ? wallet.arkProvider.serverUrl
                    : undefined);

            if (arkServerUrl) {
                const timelock = wallet.offchainTapscript.options.csvTimelock;

                const bgConfig: PersistedBackgroundConfig = {
                    arkServerUrl,
                    pubkeyHex: hex.encode(wallet.offchainTapscript.options.pubKey),
                    serverPubKeyHex: hex.encode(wallet.offchainTapscript.options.serverPubKey),
                    exitTimelockValue: timelock.value.toString(),
                    exitTimelockType: timelock.type,
                };

                await (taskQueue as AsyncStorageTaskQueue).persistConfig(bgConfig);
            }
        }

        const expoWallet = new ExpoWallet(
            wallet,
            taskQueue,
            processors,
            deps,
            config.background.foregroundIntervalMs,
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
            id: getRandomId(),
            type: CONTRACT_POLL_TASK_TYPE,
            data: {},
            createdAt: Date.now(),
        };
        await this.taskQueue.addTask(task);
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    /**
     * Stop foreground polling and dispose the inner wallet.
     *
     * Does **not** unregister the OS background task — call
     * `unregisterExpoBackgroundTask` from
     * `@arkade-os/sdk/wallet/expo/background` yourself, matching the
     * explicit `register` step.
     */
    async dispose(): Promise<void> {
        if (this.foregroundIntervalId) {
            clearInterval(this.foregroundIntervalId);
            this.foregroundIntervalId = undefined;
        }

        await this.wallet.dispose();
    }

    /**
     * Stop foreground polling and wipe all locally persisted wallet data.
     * Does not unregister the OS background task or persisted queue config.
     */
    async clear(): Promise<void> {
        if (this.foregroundIntervalId) {
            clearInterval(this.foregroundIntervalId);
            this.foregroundIntervalId = undefined;
        }

        await this.wallet.clear();
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

    getDelegateManager(): Promise<IDelegateManager | undefined> {
        return this.wallet.getDelegateManager();
    }

    /** @deprecated alias for @see ExpoWallet.getDelegateManager */
    getDelegatorManager(): Promise<IDelegateManager | undefined> {
        return this.wallet.getDelegateManager();
    }

    sendBitcoin(params: SendBitcoinParams): Promise<string> {
        return this.wallet.sendBitcoin(params);
    }

    settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void,
    ): Promise<string> {
        return this.wallet.settle(params, eventCallback);
    }

    send(...recipients: [Recipient, ...Recipient[]]): Promise<string> {
        return this.wallet.send(...recipients);
    }

    get assetManager(): IAssetManager {
        return this.wallet.assetManager;
    }
}
