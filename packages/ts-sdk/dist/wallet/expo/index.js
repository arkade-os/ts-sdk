import { contractPollProcessor, runTasks, CONTRACT_POLL_TASK_TYPE } from '../../chunk-7QO5L3KE.js';
import { Wallet, getRandomId, extendVirtualCoinForContract } from '../../chunk-MORTWGDE.js';
import { RestArkProvider } from '../../chunk-DODG3PG2.js';
import { DefaultVtxo } from '../../chunk-BUGGGM2S.js';
import '../../chunk-HAYJZIA4.js';
import '../../chunk-NSBPE2FW.js';
import { hex } from '@scure/base';

function warnOnRemovedBackgroundFields(bg) {
  if (!bg || typeof bg !== "object") return;
  const removed = [];
  if ("taskName" in bg) removed.push("taskName");
  if ("minimumBackgroundInterval" in bg) {
    removed.push("minimumBackgroundInterval");
  }
  if (removed.length === 0) return;
  console.warn(
    `[ark-sdk] ExpoWallet.setup: ignoring removed background field(s): ${removed.join(", ")}. OS-task registration moved to "@arkade-os/sdk/wallet/expo/background". See https://github.com/arkade-os/ts-sdk/issues/486`
  );
}
var ExpoWallet = class _ExpoWallet {
  constructor(wallet, taskQueue, processors, deps, foregroundIntervalMs) {
    this.wallet = wallet;
    this.taskQueue = taskQueue;
    this.processors = processors;
    this.deps = deps;
    this.identity = wallet.identity;
    this.arkProvider = wallet.arkProvider;
    this.indexerProvider = wallet.indexerProvider;
    if (foregroundIntervalMs && foregroundIntervalMs > 0) {
      this.startForegroundPolling(foregroundIntervalMs);
    }
  }
  identity;
  arkProvider;
  indexerProvider;
  foregroundIntervalId;
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
  static async setup(config) {
    warnOnRemovedBackgroundFields(config.background);
    const wallet = await Wallet.create(config);
    const processors = config.background.processors ?? [contractPollProcessor];
    const deps = {
      walletRepository: wallet.walletRepository,
      contractRepository: wallet.contractRepository,
      indexerProvider: wallet.indexerProvider,
      arkProvider: wallet.arkProvider,
      extendVtxo: (vtxo, contract) => extendVirtualCoinForContract(vtxo, contract)
    };
    const { taskQueue } = config.background;
    if ("persistConfig" in taskQueue) {
      const arkServerUrl = config.arkServerUrl || (wallet.arkProvider instanceof RestArkProvider ? wallet.arkProvider.serverUrl : void 0);
      if (arkServerUrl) {
        const timelock = wallet.offchainTapscript.options.csvTimelock ?? DefaultVtxo.Script.DEFAULT_TIMELOCK;
        const bgConfig = {
          arkServerUrl,
          pubkeyHex: hex.encode(wallet.offchainTapscript.options.pubKey),
          serverPubKeyHex: hex.encode(wallet.offchainTapscript.options.serverPubKey),
          exitTimelockValue: timelock.value.toString(),
          exitTimelockType: timelock.type
        };
        await taskQueue.persistConfig(bgConfig);
      }
    }
    const expoWallet = new _ExpoWallet(
      wallet,
      taskQueue,
      processors,
      deps,
      config.background.foregroundIntervalMs
    );
    await expoWallet.seedContractPollTask();
    return expoWallet;
  }
  // ── Foreground polling ───────────────────────────────────────────
  startForegroundPolling(intervalMs) {
    this.foregroundIntervalId = setInterval(() => {
      this.runForegroundPoll().catch(console.error);
    }, intervalMs);
  }
  async runForegroundPoll() {
    await runTasks(this.taskQueue, this.processors, this.deps);
    const results = await this.taskQueue.getResults();
    if (results.length > 0) {
      await this.taskQueue.acknowledgeResults(results.map((r) => r.id));
    }
    await this.seedContractPollTask();
  }
  async seedContractPollTask() {
    const existing = await this.taskQueue.getTasks(CONTRACT_POLL_TASK_TYPE);
    if (existing.length > 0) return;
    const task = {
      id: getRandomId(),
      type: CONTRACT_POLL_TASK_TYPE,
      data: {},
      createdAt: Date.now()
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
  async dispose() {
    if (this.foregroundIntervalId) {
      clearInterval(this.foregroundIntervalId);
      this.foregroundIntervalId = void 0;
    }
    await this.wallet.dispose();
  }
  // ── IWallet delegation ───────────────────────────────────────────
  getAddress() {
    return this.wallet.getAddress();
  }
  getBoardingAddress() {
    return this.wallet.getBoardingAddress();
  }
  getBalance() {
    return this.wallet.getBalance();
  }
  getVtxos(filter) {
    return this.wallet.getVtxos(filter);
  }
  getBoardingUtxos() {
    return this.wallet.getBoardingUtxos();
  }
  getTransactionHistory() {
    return this.wallet.getTransactionHistory();
  }
  getContractManager() {
    return this.wallet.getContractManager();
  }
  getDelegateManager() {
    return this.wallet.getDelegateManager();
  }
  /** @deprecated alias for @see ExpoWallet.getDelegateManager */
  getDelegatorManager() {
    return this.wallet.getDelegateManager();
  }
  sendBitcoin(params) {
    return this.wallet.sendBitcoin(params);
  }
  settle(params, eventCallback) {
    return this.wallet.settle(params, eventCallback);
  }
  send(...recipients) {
    return this.wallet.send(...recipients);
  }
  get assetManager() {
    return this.wallet.assetManager;
  }
};

export { ExpoWallet };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map