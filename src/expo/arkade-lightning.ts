import type { TaskItem } from "@arkade-os/sdk/worker/expo";
import type { IArkadeSwaps } from "../arkade-swaps";
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
} from "../types";
import type { GetSwapStatusResponse } from "../boltz-swap-provider";
import type {
    ExpoArkadeSwapsConfig,
    PersistedSwapBackgroundConfig,
} from "./types";
import { SWAP_POLL_TASK_TYPE } from "./swapsPollProcessor";
import type { ArkInfo, ArkTxInput, Identity, VHTLC } from "@arkade-os/sdk";
import type { TransactionOutput } from "@scure/btc-signer/psbt.js";

function getRandomId(): string {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
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
 * @example
 * ```ts
 * const arkSwaps = await ExpoArkadeSwaps.setup({
 *     wallet,
 *     arkServerUrl: "https://ark.example.com",
 *     swapProvider,
 *     swapManager: true,
 *     background: {
 *         taskName: "ark-swap-poll",
 *         taskQueue: swapTaskQueue,
 *         foregroundIntervalMs: 20_000,
 *         minimumBackgroundInterval: 15,
 *     },
 * });
 *
 * await arkSwaps.createLightningInvoice({ amount: 1000 });
 * ```
 */
export class ExpoArkadeSwaps implements IArkadeSwaps {
    readonly swapRepository: ArkadeSwaps["swapRepository"];

    private foregroundIntervalId?: ReturnType<typeof setInterval>;
    private readonly taskName: string;

    private constructor(
        private readonly inner: ArkadeSwaps,
        private readonly config: ExpoArkadeSwapsConfig
    ) {
        this.taskName = config.background.taskName;
        this.swapRepository = inner.swapRepository;
    }

    /**
     * Create an ExpoArkadeSwaps with background task support.
     *
     * 1. Creates the inner {@link ArkadeSwaps} with SwapManager enabled.
     * 2. Persists {@link PersistedSwapBackgroundConfig} for background rehydration.
     * 3. Seeds the task queue with a swap-poll task.
     * 4. Registers the background task with the OS scheduler (if configured).
     * 5. Starts foreground interval (if configured).
     */
    static async setup(
        config: ExpoArkadeSwapsConfig
    ): Promise<ExpoArkadeSwaps> {
        // Create inner ArkadeSwaps with swapManager enabled for foreground
        const inner = new ArkadeSwaps({
            ...config,
            swapManager: config.swapManager ?? true,
        });

        const { taskQueue } = config.background;

        const derivedArkServerUrl = (
            inner.arkProvider as unknown as { serverUrl?: string }
        ).serverUrl;
        const arkServerUrl = config.arkServerUrl ?? derivedArkServerUrl;
        if (!arkServerUrl) {
            throw new Error(
                "Ark server URL is required for Expo background rehydration. " +
                    "Pass `arkServerUrl` to ExpoArkadeSwaps.setup()."
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

        // Activate OS-level background scheduling
        if (config.background.minimumBackgroundInterval) {
            try {
                const { registerExpoSwapBackgroundTask } = await import(
                    "./background"
                );
                await registerExpoSwapBackgroundTask(
                    config.background.taskName,
                    {
                        minimumInterval:
                            config.background.minimumBackgroundInterval,
                    }
                );
            } catch (err) {
                const message =
                    err instanceof Error ? err.message : String(err);
                const code =
                    typeof err === "object" && err !== null && "code" in err
                        ? (err as { code?: unknown }).code
                        : undefined;
                const codeString = typeof code === "string" ? code : undefined;

                const isModuleNotFound =
                    codeString === "MODULE_NOT_FOUND" ||
                    /cannot find module/i.test(message) ||
                    /module not found/i.test(message);

                if (!isModuleNotFound) {
                    console.warn(
                        `[boltz-swap] Failed to register background task "${config.background.taskName}":`,
                        err
                    );
                }
            }
        }

        // Start foreground interval
        if (
            config.background.foregroundIntervalMs &&
            config.background.foregroundIntervalMs > 0
        ) {
            instance.startForegroundPolling(
                config.background.foregroundIntervalMs
            );
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
            await taskQueue.acknowledgeResults(
                results.map((r: { id: string }) => r.id)
            );
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

        try {
            const { unregisterExpoSwapBackgroundTask } = await import(
                "./background"
            );
            await unregisterExpoSwapBackgroundTask(this.taskName);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const code =
                typeof err === "object" && err !== null && "code" in err
                    ? (err as { code?: unknown }).code
                    : undefined;
            const codeString = typeof code === "string" ? code : undefined;

            const isModuleNotFound =
                codeString === "MODULE_NOT_FOUND" ||
                /cannot find module/i.test(message) ||
                /module not found/i.test(message);

            if (!isModuleNotFound) {
                console.warn(
                    `[boltz-swap] Failed to unregister background task "${this.taskName}":`,
                    err
                );
            }
        }
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
        args: CreateLightningInvoiceRequest
    ): Promise<CreateLightningInvoiceResponse> {
        return this.inner.createLightningInvoice(args);
    }

    sendLightningPayment(
        args: SendLightningPaymentRequest
    ): Promise<SendLightningPaymentResponse> {
        return this.inner.sendLightningPayment(args);
    }

    createSubmarineSwap(
        args: SendLightningPaymentRequest
    ): Promise<BoltzSubmarineSwap> {
        return this.inner.createSubmarineSwap(args);
    }

    createReverseSwap(
        args: CreateLightningInvoiceRequest
    ): Promise<BoltzReverseSwap> {
        return this.inner.createReverseSwap(args);
    }

    claimVHTLC(pendingSwap: BoltzReverseSwap): Promise<void> {
        return this.inner.claimVHTLC(pendingSwap);
    }

    refundVHTLC(pendingSwap: BoltzSubmarineSwap): Promise<void> {
        return this.inner.refundVHTLC(pendingSwap);
    }

    waitAndClaim(pendingSwap: BoltzReverseSwap): Promise<{ txid: string }> {
        return this.inner.waitAndClaim(pendingSwap);
    }

    waitForSwapSettlement(
        pendingSwap: BoltzSubmarineSwap
    ): Promise<{ preimage: string }> {
        return this.inner.waitForSwapSettlement(pendingSwap);
    }

    restoreSwaps(boltzFees?: FeesResponse): Promise<{
        chainSwaps: BoltzChainSwap[];
        reverseSwaps: BoltzReverseSwap[];
        submarineSwaps: BoltzSubmarineSwap[];
    }> {
        return this.inner.restoreSwaps(boltzFees);
    }

    enrichReverseSwapPreimage(
        swap: BoltzReverseSwap,
        preimage: string
    ): BoltzReverseSwap {
        return this.inner.enrichReverseSwapPreimage(swap, preimage);
    }

    enrichSubmarineSwapInvoice(
        swap: BoltzSubmarineSwap,
        invoice: string
    ): BoltzSubmarineSwap {
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

    signCooperativeClaimForServer(
        pendingSwap: BoltzChainSwap
    ): Promise<void> {
        return this.inner.signCooperativeClaimForServer(pendingSwap);
    }

    waitAndClaimChain(
        pendingSwap: BoltzChainSwap
    ): Promise<{ txid: string }> {
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

    quoteSwap(swapId: string): Promise<number> {
        return this.inner.quoteSwap(swapId);
    }

    joinBatch(
        identity: Identity,
        input: ArkTxInput,
        output: TransactionOutput,
        arkInfo: ArkInfo,
        isRecoverable?: boolean
    ): Promise<string> {
        return this.inner.joinBatch(
            identity,
            input,
            output,
            arkInfo,
            isRecoverable
        );
    }

    createVHTLCScript(params: {
        network: string;
        preimageHash: Uint8Array;
        receiverPubkey: string;
        senderPubkey: string;
        serverPubkey: string;
        timeoutBlockHeights: {
            refund: number;
            unilateralClaim: number;
            unilateralRefund: number;
            unilateralRefundWithoutReceiver: number;
        };
    }): { vhtlcScript: VHTLC.Script; vhtlcAddress: string } {
        return this.inner.createVHTLCScript(params);
    }

    getFees(): Promise<FeesResponse>;
    getFees(from: Chain, to: Chain): Promise<ChainFeesResponse>;
    getFees(
        from?: Chain,
        to?: Chain
    ): Promise<FeesResponse | ChainFeesResponse> {
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
