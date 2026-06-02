import { W as Wallet } from '../../wallet-yHtSQP1d.cjs';
import { I as IWallet, a as Identity, b as WalletConfig, c as WalletBalance, G as GetVtxosFilter, E as ExtendedVirtualCoin, d as ExtendedCoin, A as ArkTransaction, e as IContractManager, f as IDelegateManager, S as SendBitcoinParams, g as SettleParams, h as SettlementEvent, R as Recipient, i as IAssetManager } from '../../ark-BCdDnaIQ.cjs';
import { a as TaskQueue, T as TaskProcessor } from '../../taskRunner-Uk49nx0v.cjs';
import '@scure/btc-signer/utils.js';
import '@scure/btc-signer/psbt.js';
import '../../delegate-DUiPM4O6.cjs';
import '@scure/btc-signer/transaction.js';
import '@scure/btc-signer';

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
interface ExpoBackgroundConfig {
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
interface ExpoWalletConfig extends WalletConfig {
    background: ExpoBackgroundConfig;
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
declare class ExpoWallet implements IWallet {
    private readonly wallet;
    private readonly taskQueue;
    private readonly processors;
    private readonly deps;
    readonly identity: Identity;
    readonly arkProvider: Wallet["arkProvider"];
    readonly indexerProvider: Wallet["indexerProvider"];
    private foregroundIntervalId?;
    private constructor();
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
    static setup(config: ExpoWalletConfig): Promise<ExpoWallet>;
    private startForegroundPolling;
    private runForegroundPoll;
    private seedContractPollTask;
    /**
     * Stop foreground polling and dispose the inner wallet.
     *
     * Does **not** unregister the OS background task — call
     * `unregisterExpoBackgroundTask` from
     * `@arkade-os/sdk/wallet/expo/background` yourself, matching the
     * explicit `register` step.
     */
    dispose(): Promise<void>;
    getAddress(): Promise<string>;
    getBoardingAddress(): Promise<string>;
    getBalance(): Promise<WalletBalance>;
    getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]>;
    getBoardingUtxos(): Promise<ExtendedCoin[]>;
    getTransactionHistory(): Promise<ArkTransaction[]>;
    getContractManager(): Promise<IContractManager>;
    getDelegateManager(): Promise<IDelegateManager | undefined>;
    /** @deprecated alias for @see ExpoWallet.getDelegateManager */
    getDelegatorManager(): Promise<IDelegateManager | undefined>;
    sendBitcoin(params: SendBitcoinParams): Promise<string>;
    settle(params?: SettleParams, eventCallback?: (event: SettlementEvent) => void): Promise<string>;
    send(...recipients: [Recipient, ...Recipient[]]): Promise<string>;
    get assetManager(): IAssetManager;
}

export { type ExpoBackgroundConfig, ExpoWallet, type ExpoWalletConfig };
