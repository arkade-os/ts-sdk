import type { TaskItem } from "@arkade-os/sdk/worker/expo";
import type { IArkadeSwaps, QuoteSwapOptions } from "../arkade-swaps";
import { ArkadeSwaps } from "../arkade-swaps";
import type { SwapManagerClient } from "../swap-manager";
import type {
    ArkToBtcResponse,
    BtcToArkResponse,
    Chain,
    ChainFeesResponse,
    CreateLightningInvoiceRequest,
    CreateLightningInvoiceResponse,
    FeesResponse,
    LimitsResponse,
    BoltzChainSwap,
    BoltzReverseSwap,
    BoltzSubmarineSwap,
    BoltzSwap,
    SendLightningPaymentRequest,
    SendLightningPaymentResponse,
    SubmarineRecoveryInfo,
    SubmarineRecoveryResult,
    SubmarineRefundOutcome,
} from "../types";
import type { GetSwapStatusResponse } from "../boltz-swap-provider";
import type { ExpoArkadeSwapsConfig, PersistedSwapBackgroundConfig } from "./types";
import { SWAP_POLL_TASK_TYPE } from "./swapsPollProcessor";
import {
    getRandomId,
    type ArkInfo,
    type ArkTxInput,
    type Identity,
    type VHTLC,
} from "@arkade-os/sdk";
import type { TransactionOutput } from "@scure/btc-signer/psbt.js";
import type { VhtlcTimeouts } from "../utils/vhtlc";

/**
 * Catches JS callers still passing the pre-fix-#136 fields: TypeScript
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
        `[boltz-swap] ExpoArkadeSwaps.setup: ignoring removed background field(s): ${removed.join(", ")}. ` +
            'OS-task registration moved to "@arkade-os/boltz-swap/expo/background". ' +
            "See https://github.com/arkade-os/boltz-swap/issues/136",
    );
}

/**
 * Expo/React Native wrapper for ArkadeSwaps with background task support.
 *
 * In the foreground, delegates to a full {@link ArkadeSwaps} instance
 * with SwapManager (WebSocket) for real-time swap monitoring and auto
 * claim/refund.
 *
 * In the background (Expo BackgroundTask), a separate
 * {@link import("./swapsPollProcessor").swapsPollProcessor} handles HTTP-based polling and best-effort
 * claim/refund within the ~30s execution window.
 *
 * The foreground interval does NOT run swap polling — it only
 * acknowledges background outbox results and re-seeds the task queue
 * for the next background wake.
 *
 * OS-level task registration is the consumer's responsibility — call
 * `registerExpoSwapBackgroundTask` from
 * `@arkade-os/boltz-swap/expo/background` after `setup()`. Keeping
 * registration out of `setup()` lets this entrypoint avoid pulling
 * `expo-task-manager` / `expo-background-task` into the `/expo` bundle.
 *
 * @example
 * ```ts
 * import { ExpoArkadeSwaps } from "@arkade-os/boltz-swap/expo";
 * import { registerExpoSwapBackgroundTask } from "@arkade-os/boltz-swap/expo/background";
 *
 * const arkSwaps = await ExpoArkadeSwaps.setup({
 *     wallet,
 *     arkServerUrl: "https://ark.example.com",
 *     swapProvider,
 *     swapManager: true,
 *     background: {
 *         taskQueue: swapTaskQueue,
 *         foregroundIntervalMs: 20_000,
 *     },
 * });
 *
 * // Activate the OS scheduler (Expo Android/iOS only)
 * await registerExpoSwapBackgroundTask("ark-swap-poll", { minimumInterval: 15 });
 *
 * await arkSwaps.createLightningInvoice({ amount: 1000 });
 * ```
 */
export class ExpoArkadeSwaps implements IArkadeSwaps {
    readonly swapRepository: ArkadeSwaps["swapRepository"];

    private foregroundIntervalId?: ReturnType<typeof setInterval>;

    private constructor(
        private readonly inner: ArkadeSwaps,
        private readonly config: ExpoArkadeSwapsConfig,
    ) {
        this.swapRepository = inner.swapRepository;
    }

    /**
     * Create an ExpoArkadeSwaps with foreground/background queue handoff.
     *
     * 1. Creates the inner {@link ArkadeSwaps} with SwapManager enabled.
     * 2. Persists {@link PersistedSwapBackgroundConfig} for background rehydration.
     * 3. Seeds the task queue with a swap-poll task.
     * 4. Starts the foreground interval (if configured).
     *
     * OS-level scheduling lives in
     * `@arkade-os/boltz-swap/expo/background` and is invoked separately
     * by the consumer.
     */
    static async setup(config: ExpoArkadeSwapsConfig): Promise<ExpoArkadeSwaps> {
        warnOnRemovedBackgroundFields(config.background);

        // Create inner ArkadeSwaps with swapManager enabled for foreground
        const inner = new ArkadeSwaps({
            ...config,
            swapManager: config.swapManager ?? true,
        });

        const { taskQueue } = config.background;

        const derivedArkServerUrl = (inner.arkProvider as unknown as { serverUrl?: string })
            .serverUrl;
        const arkServerUrl = config.arkServerUrl ?? derivedArkServerUrl;
        if (!arkServerUrl) {
            throw new Error(
                "Ark server URL is required for Expo background rehydration. " +
                    "Pass `arkServerUrl` to ExpoArkadeSwaps.setup().",
            );
        }

        // Persist config for background handler rehydration
        const bgConfig: PersistedSwapBackgroundConfig = {
            boltzApiUrl: config.swapProvider.getApiUrl(),
            arkServerUrl,
            network: config.swapProvider.getNetwork(),
        };
        await taskQueue.persistConfig(bgConfig);

        const instance = new ExpoArkadeSwaps(inner, config);

        // Seed the queue so the first background wake has work
        await instance.seedSwapPollTask();

        // Start foreground interval
        if (config.background.foregroundIntervalMs && config.background.foregroundIntervalMs > 0) {
            instance.startForegroundPolling(config.background.foregroundIntervalMs);
        }

        return instance;
    }

    // ── Foreground polling ───────────────────────────────────────────

    private startForegroundPolling(intervalMs: number): void {
        this.foregroundIntervalId = setInterval(() => {
            this.runForegroundPoll().catch(console.error);
        }, intervalMs);
    }

    private async runForegroundPoll(): Promise<void> {
        const { taskQueue } = this.config.background;

        // Acknowledge background outbox results
        const results = await taskQueue.getResults();
        if (results.length > 0) {
            await taskQueue.acknowledgeResults(results.map((r: { id: string }) => r.id));
        }

        // Re-seed for the next background wake
        await this.seedSwapPollTask();
    }

    private async seedSwapPollTask(): Promise<void> {
        const { taskQueue } = this.config.background;
        const existing = await taskQueue.getTasks(SWAP_POLL_TASK_TYPE);
        if (existing.length > 0) return;

        const task: TaskItem = {
            id: getRandomId(),
            type: SWAP_POLL_TASK_TYPE,
            data: {},
            createdAt: Date.now(),
        };
        await taskQueue.addTask(task);
    }

    // ── Lifecycle ────────────────────────────────────────────────────

    /**
     * Reset all swap state: stops polling and clears the swap repository.
     *
     * **Destructive** — any swap in a non-terminal state will lose its
     * refund/claim path. Intended for wallet-reset / dev / test scenarios only.
     */
    async reset(): Promise<void> {
        await this.dispose();
        await this.inner.swapRepository.clear();
    }

    async dispose(): Promise<void> {
        if (this.foregroundIntervalId) {
            clearInterval(this.foregroundIntervalId);
            this.foregroundIntervalId = undefined;
        }

        await this.inner.dispose();
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.dispose();
    }

    // ── IArkadeSwaps delegation ──────────────────────────────────────

    startSwapManager(): Promise<void> {
        return this.inner.startSwapManager();
    }

    stopSwapManager(): Promise<void> {
        return this.inner.stopSwapManager();
    }

    getSwapManager(): SwapManagerClient | null {
        return this.inner.getSwapManager();
    }

    createLightningInvoice(
        args: CreateLightningInvoiceRequest,
    ): Promise<CreateLightningInvoiceResponse> {
        return this.inner.createLightningInvoice(args);
    }

    sendLightningPayment(args: SendLightningPaymentRequest): Promise<SendLightningPaymentResponse> {
        return this.inner.sendLightningPayment(args);
    }

    createSubmarineSwap(args: SendLightningPaymentRequest): Promise<BoltzSubmarineSwap> {
        return this.inner.createSubmarineSwap(args);
    }

    createReverseSwap(args: CreateLightningInvoiceRequest): Promise<BoltzReverseSwap> {
        return this.inner.createReverseSwap(args);
    }

    claimVHTLC(pendingSwap: BoltzReverseSwap): Promise<void> {
        return this.inner.claimVHTLC(pendingSwap);
    }

    refundVHTLC(pendingSwap: BoltzSubmarineSwap): Promise<SubmarineRefundOutcome> {
        return this.inner.refundVHTLC(pendingSwap);
    }

    inspectSubmarineRecovery(swap: BoltzSubmarineSwap): Promise<SubmarineRecoveryInfo> {
        return this.inner.inspectSubmarineRecovery(swap);
    }

    scanRecoverableSubmarineSwaps(): Promise<SubmarineRecoveryInfo[]> {
        return this.inner.scanRecoverableSubmarineSwaps();
    }

    recoverSubmarineFunds(swap: BoltzSubmarineSwap): Promise<SubmarineRefundOutcome> {
        return this.inner.recoverSubmarineFunds(swap);
    }

    recoverAllSubmarineFunds(swaps: BoltzSubmarineSwap[]): Promise<SubmarineRecoveryResult[]> {
        return this.inner.recoverAllSubmarineFunds(swaps);
    }

    waitAndClaim(pendingSwap: BoltzReverseSwap): Promise<{ txid: string }> {
        return this.inner.waitAndClaim(pendingSwap);
    }

    waitForSwapSettlement(pendingSwap: BoltzSubmarineSwap): Promise<{ preimage: string }> {
        return this.inner.waitForSwapSettlement(pendingSwap);
    }

    restoreSwaps(boltzFees?: FeesResponse): Promise<{
        chainSwaps: BoltzChainSwap[];
        reverseSwaps: BoltzReverseSwap[];
        submarineSwaps: BoltzSubmarineSwap[];
    }> {
        return this.inner.restoreSwaps(boltzFees);
    }

    enrichReverseSwapPreimage(swap: BoltzReverseSwap, preimage: string): BoltzReverseSwap {
        return this.inner.enrichReverseSwapPreimage(swap, preimage);
    }

    enrichSubmarineSwapInvoice(swap: BoltzSubmarineSwap, invoice: string): BoltzSubmarineSwap {
        return this.inner.enrichSubmarineSwapInvoice(swap, invoice);
    }

    // ── Chain swap delegation ────────────────────────────────────────

    arkToBtc(args: {
        btcAddress: string;
        senderLockAmount?: number;
        receiverLockAmount?: number;
        feeSatsPerByte?: number;
    }): Promise<ArkToBtcResponse> {
        return this.inner.arkToBtc(args);
    }

    waitAndClaimBtc(pendingSwap: BoltzChainSwap): Promise<{ txid: string }> {
        return this.inner.waitAndClaimBtc(pendingSwap);
    }

    claimBtc(pendingSwap: BoltzChainSwap): Promise<void> {
        return this.inner.claimBtc(pendingSwap);
    }

    refundArk(pendingSwap: BoltzChainSwap): Promise<void> {
        return this.inner.refundArk(pendingSwap);
    }

    btcToArk(args: {
        feeSatsPerByte?: number;
        senderLockAmount?: number;
        receiverLockAmount?: number;
    }): Promise<BtcToArkResponse> {
        return this.inner.btcToArk(args);
    }

    waitAndClaimArk(pendingSwap: BoltzChainSwap): Promise<{ txid: string }> {
        return this.inner.waitAndClaimArk(pendingSwap);
    }

    claimArk(pendingSwap: BoltzChainSwap): Promise<void> {
        return this.inner.claimArk(pendingSwap);
    }

    signCooperativeClaimForServer(pendingSwap: BoltzChainSwap): Promise<void> {
        return this.inner.signCooperativeClaimForServer(pendingSwap);
    }

    waitAndClaimChain(pendingSwap: BoltzChainSwap): Promise<{ txid: string }> {
        return this.inner.waitAndClaimChain(pendingSwap);
    }

    createChainSwap(args: {
        to: Chain;
        from: Chain;
        toAddress: string;
        feeSatsPerByte?: number;
        senderLockAmount?: number;
        receiverLockAmount?: number;
    }): Promise<BoltzChainSwap> {
        return this.inner.createChainSwap(args);
    }

    verifyChainSwap(args: {
        to: Chain;
        from: Chain;
        swap: BoltzChainSwap;
        arkInfo: ArkInfo;
    }): Promise<boolean> {
        return this.inner.verifyChainSwap(args);
    }

    quoteSwap(swapId: string, options?: QuoteSwapOptions): Promise<number> {
        return this.inner.quoteSwap(swapId, options);
    }

    getSwapQuote(swapId: string): Promise<number> {
        return this.inner.getSwapQuote(swapId);
    }

    acceptSwapQuote(swapId: string, amount: number, options?: QuoteSwapOptions): Promise<number> {
        return this.inner.acceptSwapQuote(swapId, amount, options);
    }

    joinBatch(
        identity: Identity,
        input: ArkTxInput,
        output: TransactionOutput,
        arkInfo: ArkInfo,
        isRecoverable?: boolean,
    ): Promise<string> {
        return this.inner.joinBatch(identity, input, output, arkInfo, isRecoverable);
    }

    createVHTLCScript(params: {
        network: string;
        preimageHash: Uint8Array;
        receiverPubkey: string;
        senderPubkey: string;
        serverPubkey: string;
        timeoutBlockHeights: VhtlcTimeouts;
    }): { vhtlcScript: VHTLC.Script; vhtlcAddress: string } {
        return this.inner.createVHTLCScript(params);
    }

    getFees(): Promise<FeesResponse>;
    getFees(from: Chain, to: Chain): Promise<ChainFeesResponse>;
    getFees(from?: Chain, to?: Chain): Promise<FeesResponse | ChainFeesResponse> {
        if (from !== undefined && to !== undefined) {
            return this.inner.getFees(from, to);
        }
        return this.inner.getFees();
    }

    getLimits(): Promise<LimitsResponse>;
    getLimits(from: Chain, to: Chain): Promise<LimitsResponse>;
    getLimits(from?: Chain, to?: Chain): Promise<LimitsResponse> {
        if (from !== undefined && to !== undefined) {
            return this.inner.getLimits(from, to);
        }
        return this.inner.getLimits();
    }

    getSwapStatus(swapId: string): Promise<GetSwapStatusResponse> {
        return this.inner.getSwapStatus(swapId);
    }

    getPendingSubmarineSwaps(): Promise<BoltzSubmarineSwap[]> {
        return this.inner.getPendingSubmarineSwaps();
    }

    getPendingReverseSwaps(): Promise<BoltzReverseSwap[]> {
        return this.inner.getPendingReverseSwaps();
    }

    getPendingChainSwaps(): Promise<BoltzChainSwap[]> {
        return this.inner.getPendingChainSwaps();
    }

    getSwapHistory(): Promise<BoltzSwap[]> {
        return this.inner.getSwapHistory();
    }

    refreshSwapsStatus(): Promise<void> {
        return this.inner.refreshSwapsStatus();
    }
}

/** @deprecated Use ExpoArkadeSwaps instead */
export const ExpoArkadeLightning = ExpoArkadeSwaps;
