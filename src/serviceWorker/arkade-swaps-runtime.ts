import { GetSwapStatusResponse, BoltzSwapStatus } from "../boltz-swap-provider";
import {
    ArkToBtcResponse,
    ArkadeSwapsConfig,
    BtcToArkResponse,
    Chain,
    ChainFeesResponse,
    CreateLightningInvoiceRequest,
    CreateLightningInvoiceResponse,
    FeesResponse,
    LimitsResponse,
    Network,
    PendingChainSwap,
    PendingReverseSwap,
    PendingSubmarineSwap,
    SendLightningPaymentRequest,
    SendLightningPaymentResponse,
} from "../types";
import { SwapRepository } from "../repositories/swap-repository";
import {
    ArkadeSwapsUpdaterRequest,
    ArkadeSwapsUpdaterResponse,
    DEFAULT_MESSAGE_TAG,
    RequestInitArkSwaps,
} from "./arkade-swaps-message-handler";
import type {
    ResponseArkToBtc,
    ResponseBtcToArk,
    ResponseCreateChainSwap,
    ResponseCreateLightningInvoice,
    ResponseCreateReverseSwap,
    ResponseCreateSubmarineSwap,
    ResponseGetFees,
    ResponseGetPendingChainSwaps,
    ResponseGetLimits,
    ResponseGetPendingReverseSwaps,
    ResponseGetPendingSubmarineSwaps,
    ResponseQuoteSwap,
    ResponseGetSwapHistory,
    ResponseGetSwapStatus,
    ResponseRestoreSwaps,
    ResponseSendLightningPayment,
    ResponseVerifyChainSwap,
    ResponseWaitAndClaimArk,
    ResponseWaitAndClaimBtc,
    ResponseWaitAndClaimChain,
    ResponseWaitAndClaim,
    ResponseWaitForSwapSettlement,
} from "./arkade-swaps-message-handler";
import {
    MESSAGE_BUS_NOT_INITIALIZED,
    ServiceWorkerTimeoutError,
    type ArkInfo,
    type ArkTxInput,
    type Identity,
    type VHTLC,
} from "@arkade-os/sdk";
import type { TransactionOutput } from "@scure/btc-signer/psbt.js";
import { IArkadeSwaps } from "../arkade-swaps";
import { IndexedDbSwapRepository } from "../repositories/IndexedDb/swap-repository";
import {
    enrichReverseSwapPreimage as _enrichReverseSwapPreimage,
    enrichSubmarineSwapInvoice as _enrichSubmarineSwapInvoice,
} from "../utils/swap-helpers";
import type { Actions, SwapManagerClient } from "../swap-manager";

// Check by error message content instead of instanceof because postMessage uses the
// structured clone algorithm which strips the prototype chain — the page
// receives a plain Error, not the original MessageBusNotInitializedError.
function isMessageBusNotInitializedError(error: unknown): boolean {
    return (
        error instanceof Error &&
        error.message.includes(MESSAGE_BUS_NOT_INITIALIZED)
    );
}

const DEDUPABLE_REQUEST_TYPES: ReadonlySet<string> = new Set([
    "GET_FEES",
    "GET_LIMITS",
    "GET_SWAP_STATUS",
    "GET_PENDING_SUBMARINE_SWAPS",
    "GET_PENDING_REVERSE_SWAPS",
    "GET_PENDING_CHAIN_SWAPS",
    "GET_SWAP_HISTORY",
    "QUOTE_SWAP",
    "SM-GET_PENDING_SWAPS",
    "SM-HAS_SWAP",
    "SM-IS_PROCESSING",
    "SM-GET_STATS",
]);

function getRequestDedupKey(request: ArkadeSwapsUpdaterRequest): string {
    const { id, tag, ...rest } = request;
    return JSON.stringify(rest);
}

export type SvcWrkArkadeSwapsConfig = Pick<
    ArkadeSwapsConfig,
    "swapManager" | "swapProvider" | "swapRepository"
> & {
    serviceWorker: ServiceWorker;
    messageTag?: string;
    network: Network;
    arkServerUrl: string;
};

export class ServiceWorkerArkadeSwaps implements IArkadeSwaps {
    private eventListenerInitialized = false;
    private swapUpdateListeners = new Set<
        (
            swap: PendingReverseSwap | PendingSubmarineSwap | PendingChainSwap,
            oldStatus: BoltzSwapStatus
        ) => void
    >();
    private swapCompletedListeners = new Set<
        (
            swap: PendingReverseSwap | PendingSubmarineSwap | PendingChainSwap
        ) => void
    >();
    private swapFailedListeners = new Set<
        (
            swap: PendingReverseSwap | PendingSubmarineSwap | PendingChainSwap,
            error: Error
        ) => void
    >();
    private actionExecutedListeners = new Set<
        (
            swap: PendingReverseSwap | PendingSubmarineSwap | PendingChainSwap,
            action: Actions
        ) => void
    >();
    private wsConnectedListeners = new Set<() => void>();
    private wsDisconnectedListeners = new Set<(error?: Error) => void>();

    private initPayload: RequestInitArkSwaps["payload"] | null = null;
    private reinitPromise: Promise<void> | null = null;
    private pingPromise: Promise<void> | null = null;
    private inflightRequests = new Map<
        string,
        Promise<ArkadeSwapsUpdaterResponse>
    >();

    private constructor(
        private readonly messageTag: string,
        public readonly serviceWorker: ServiceWorker,
        public readonly swapRepository: SwapRepository, // expose methods, not the repo
        private readonly withSwapManager: boolean
    ) {}

    static async create(config: SvcWrkArkadeSwapsConfig) {
        const messageTag = config.messageTag ?? DEFAULT_MESSAGE_TAG;

        const swapRepository =
            config.swapRepository ?? new IndexedDbSwapRepository();

        const svcArkadeSwaps = new ServiceWorkerArkadeSwaps(
            messageTag,
            config.serviceWorker,
            swapRepository,
            Boolean(config.swapManager)
        );

        const initPayload: RequestInitArkSwaps["payload"] = {
            network: config.network,
            arkServerUrl: config.arkServerUrl,
            swapProvider: { baseUrl: config.swapProvider.getApiUrl() },
            swapManager: config.swapManager,
        };

        const initMessage: RequestInitArkSwaps = {
            tag: messageTag,
            id: getRandomId(),
            type: "INIT_ARKADE_SWAPS",
            payload: initPayload,
        };

        await svcArkadeSwaps.sendMessage(initMessage);
        svcArkadeSwaps.initPayload = initPayload;

        return svcArkadeSwaps;
    }

    async startSwapManager(): Promise<void> {
        if (!this.withSwapManager) {
            throw new Error("SwapManager is not enabled.");
        }

        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "SM-START",
        });
    }

    async stopSwapManager(): Promise<void> {
        if (!this.withSwapManager) return;

        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "SM-STOP",
        });
    }

    getSwapManager(): SwapManagerClient | null {
        if (!this.withSwapManager) {
            return null;
        }

        this.initEventStream();

        const send = this.sendMessage.bind(this);
        const tag = this.messageTag;

        const proxy = {
            start: async () => {
                await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-START",
                });
            },
            stop: async () => {
                await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-STOP",
                });
            },
            addSwap: async (
                swap:
                    | PendingReverseSwap
                    | PendingSubmarineSwap
                    | PendingChainSwap
            ) => {
                await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-ADD_SWAP",
                    payload: swap,
                });
            },
            removeSwap: async (swapId: string) => {
                await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-REMOVE_SWAP",
                    payload: { swapId },
                });
            },
            getPendingSwaps: async () => {
                const res = await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-GET_PENDING_SWAPS",
                });
                return (
                    res as ArkadeSwapsUpdaterResponse & {
                        payload: (
                            | PendingReverseSwap
                            | PendingSubmarineSwap
                            | PendingChainSwap
                        )[];
                    }
                ).payload;
            },
            hasSwap: async (swapId: string) => {
                const res = await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-HAS_SWAP",
                    payload: { swapId },
                });
                return (
                    res as ArkadeSwapsUpdaterResponse & {
                        payload: { has: boolean };
                    }
                ).payload.has;
            },
            isProcessing: async (swapId: string) => {
                const res = await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-IS_PROCESSING",
                    payload: { swapId },
                });
                return (
                    res as ArkadeSwapsUpdaterResponse & {
                        payload: { processing: boolean };
                    }
                ).payload.processing;
            },
            getStats: async () => {
                const res = await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-GET_STATS",
                });
                return (
                    res as ArkadeSwapsUpdaterResponse & {
                        payload: {
                            isRunning: boolean;
                            monitoredSwaps: number;
                            websocketConnected: boolean;
                            usePollingFallback: boolean;
                            currentReconnectDelay: number;
                            currentPollRetryDelay: number;
                        };
                    }
                ).payload;
            },
            waitForSwapCompletion: async (swapId: string) => {
                const res = await send({
                    id: getRandomId(),
                    tag,
                    type: "SM-WAIT_FOR_COMPLETION",
                    payload: { swapId },
                });
                return (
                    res as ArkadeSwapsUpdaterResponse & {
                        payload: { txid: string };
                    }
                ).payload;
            },
            subscribeToSwapUpdates: async (
                swapId: string,
                callback: (
                    swap:
                        | PendingReverseSwap
                        | PendingSubmarineSwap
                        | PendingChainSwap,
                    oldStatus: BoltzSwapStatus
                ) => void
            ) => {
                const filteredListener = (
                    swap:
                        | PendingReverseSwap
                        | PendingSubmarineSwap
                        | PendingChainSwap,
                    oldStatus: BoltzSwapStatus
                ) => {
                    if (swap.id === swapId) {
                        callback(swap, oldStatus);
                    }
                };
                this.swapUpdateListeners.add(filteredListener);
                return () => this.swapUpdateListeners.delete(filteredListener);
            },
            onSwapUpdate: async (
                listener: (
                    swap:
                        | PendingReverseSwap
                        | PendingSubmarineSwap
                        | PendingChainSwap,
                    oldStatus: BoltzSwapStatus
                ) => void
            ) => {
                this.swapUpdateListeners.add(listener);
                return () => this.swapUpdateListeners.delete(listener);
            },
            onSwapCompleted: async (
                listener: (
                    swap:
                        | PendingReverseSwap
                        | PendingSubmarineSwap
                        | PendingChainSwap
                ) => void
            ) => {
                this.swapCompletedListeners.add(listener);
                return () => this.swapCompletedListeners.delete(listener);
            },
            onSwapFailed: async (
                listener: (
                    swap:
                        | PendingReverseSwap
                        | PendingSubmarineSwap
                        | PendingChainSwap,
                    error: Error
                ) => void
            ) => {
                this.swapFailedListeners.add(listener);
                return () => this.swapFailedListeners.delete(listener);
            },
            onActionExecuted: async (
                listener: (
                    swap:
                        | PendingReverseSwap
                        | PendingSubmarineSwap
                        | PendingChainSwap,
                    action: Actions
                ) => void
            ) => {
                this.actionExecutedListeners.add(listener);
                return () => this.actionExecutedListeners.delete(listener);
            },
            onWebSocketConnected: async (listener: () => void) => {
                this.wsConnectedListeners.add(listener);
                return () => this.wsConnectedListeners.delete(listener);
            },
            onWebSocketDisconnected: async (
                listener: (error?: Error) => void
            ) => {
                this.wsDisconnectedListeners.add(listener);
                return () => this.wsDisconnectedListeners.delete(listener);
            },
            offSwapUpdate: (
                listener: (
                    swap:
                        | PendingReverseSwap
                        | PendingSubmarineSwap
                        | PendingChainSwap,
                    oldStatus: BoltzSwapStatus
                ) => void
            ) => {
                this.swapUpdateListeners.delete(listener);
            },
            offSwapCompleted: (
                listener: (
                    swap:
                        | PendingReverseSwap
                        | PendingSubmarineSwap
                        | PendingChainSwap
                ) => void
            ) => {
                this.swapCompletedListeners.delete(listener);
            },
            offSwapFailed: (
                listener: (
                    swap:
                        | PendingReverseSwap
                        | PendingSubmarineSwap
                        | PendingChainSwap,
                    error: Error
                ) => void
            ) => {
                this.swapFailedListeners.delete(listener);
            },
            offActionExecuted: (
                listener: (
                    swap:
                        | PendingReverseSwap
                        | PendingSubmarineSwap
                        | PendingChainSwap,
                    action: Actions
                ) => void
            ) => {
                this.actionExecutedListeners.delete(listener);
            },
            offWebSocketConnected: (listener: () => void) => {
                this.wsConnectedListeners.delete(listener);
            },
            offWebSocketDisconnected: (listener: (error?: Error) => void) => {
                this.wsDisconnectedListeners.delete(listener);
            },
        };

        return proxy as SwapManagerClient;
    }

    async createLightningInvoice(
        args: CreateLightningInvoiceRequest
    ): Promise<CreateLightningInvoiceResponse> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "CREATE_LIGHTNING_INVOICE",
                payload: args,
            });
            return (res as ResponseCreateLightningInvoice).payload;
        } catch (e) {
            throw new Error("Cannot create Lightning Invoice", { cause: e });
        }
    }

    async sendLightningPayment(
        args: SendLightningPaymentRequest
    ): Promise<SendLightningPaymentResponse> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "SEND_LIGHTNING_PAYMENT",
                payload: args,
            });
            return (res as ResponseSendLightningPayment).payload;
        } catch (e) {
            throw new Error("Cannot send Lightning payment", { cause: e });
        }
    }

    async createSubmarineSwap(
        args: SendLightningPaymentRequest
    ): Promise<PendingSubmarineSwap> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "CREATE_SUBMARINE_SWAP",
                payload: args,
            });
            return (res as ResponseCreateSubmarineSwap).payload;
        } catch (e) {
            throw new Error("Cannot create submarine swap", { cause: e });
        }
    }

    async createReverseSwap(
        args: CreateLightningInvoiceRequest
    ): Promise<PendingReverseSwap> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "CREATE_REVERSE_SWAP",
                payload: args,
            });
            return (res as ResponseCreateReverseSwap).payload;
        } catch (e) {
            throw new Error("Cannot create reverse swap", { cause: e });
        }
    }

    async claimVHTLC(pendingSwap: PendingReverseSwap): Promise<void> {
        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "CLAIM_VHTLC",
            payload: pendingSwap,
        });
    }

    async refundVHTLC(pendingSwap: PendingSubmarineSwap): Promise<void> {
        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "REFUND_VHTLC",
            payload: pendingSwap,
        });
    }

    async waitAndClaim(
        pendingSwap: PendingReverseSwap
    ): Promise<{ txid: string }> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "WAIT_AND_CLAIM",
                payload: pendingSwap,
            });
            return (res as ResponseWaitAndClaim).payload;
        } catch (e) {
            throw new Error("Cannot wait and claim reverse swap", {
                cause: e,
            });
        }
    }

    async waitForSwapSettlement(
        pendingSwap: PendingSubmarineSwap
    ): Promise<{ preimage: string }> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "WAIT_FOR_SWAP_SETTLEMENT",
                payload: pendingSwap,
            });
            return (res as ResponseWaitForSwapSettlement).payload;
        } catch (e) {
            throw new Error("Cannot wait for swap settlement", { cause: e });
        }
    }

    async restoreSwaps(boltzFees?: FeesResponse): Promise<{
        chainSwaps: PendingChainSwap[];
        reverseSwaps: PendingReverseSwap[];
        submarineSwaps: PendingSubmarineSwap[];
    }> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "RESTORE_SWAPS",
                payload: boltzFees,
            });
            return (res as ResponseRestoreSwaps).payload;
        } catch (e) {
            throw new Error("Cannot restore swaps", { cause: e });
        }
    }

    async arkToBtc(args: {
        btcAddress: string;
        senderLockAmount?: number;
        receiverLockAmount?: number;
        feeSatsPerByte?: number;
    }): Promise<ArkToBtcResponse> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "ARK_TO_BTC",
                payload: args,
            });
            return (res as ResponseArkToBtc).payload;
        } catch (e) {
            throw new Error("Cannot create ARK -> BTC chain swap", {
                cause: e,
            });
        }
    }

    async btcToArk(args: {
        feeSatsPerByte?: number;
        senderLockAmount?: number;
        receiverLockAmount?: number;
    }): Promise<BtcToArkResponse> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "BTC_TO_ARK",
                payload: args,
            });
            return (res as ResponseBtcToArk).payload;
        } catch (e) {
            throw new Error("Cannot create BTC -> ARK chain swap", {
                cause: e,
            });
        }
    }

    async createChainSwap(args: {
        to: Chain;
        from: Chain;
        toAddress: string;
        feeSatsPerByte?: number;
        senderLockAmount?: number;
        receiverLockAmount?: number;
    }): Promise<PendingChainSwap> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "CREATE_CHAIN_SWAP",
                payload: args,
            });
            return (res as ResponseCreateChainSwap).payload;
        } catch (e) {
            throw new Error("Cannot create chain swap", { cause: e });
        }
    }

    async waitAndClaimChain(
        pendingSwap: PendingChainSwap
    ): Promise<{ txid: string }> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "WAIT_AND_CLAIM_CHAIN",
                payload: pendingSwap,
            });
            return (res as ResponseWaitAndClaimChain).payload;
        } catch (e) {
            throw new Error("Cannot wait and claim chain swap", {
                cause: e,
            });
        }
    }

    async waitAndClaimArk(
        pendingSwap: PendingChainSwap
    ): Promise<{ txid: string }> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "WAIT_AND_CLAIM_ARK",
                payload: pendingSwap,
            });
            return (res as ResponseWaitAndClaimArk).payload;
        } catch (e) {
            throw new Error("Cannot wait and claim ARK", {
                cause: e,
            });
        }
    }

    async waitAndClaimBtc(
        pendingSwap: PendingChainSwap
    ): Promise<{ txid: string }> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "WAIT_AND_CLAIM_BTC",
                payload: pendingSwap,
            });
            return (res as ResponseWaitAndClaimBtc).payload;
        } catch (e) {
            throw new Error("Cannot wait and claim BTC", {
                cause: e,
            });
        }
    }

    async claimArk(pendingSwap: PendingChainSwap): Promise<void> {
        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "CLAIM_ARK",
            payload: pendingSwap,
        });
    }

    async claimBtc(pendingSwap: PendingChainSwap): Promise<void> {
        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "CLAIM_BTC",
            payload: pendingSwap,
        });
    }

    async refundArk(pendingSwap: PendingChainSwap): Promise<void> {
        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "REFUND_ARK",
            payload: pendingSwap,
        });
    }

    async signCooperativeClaimForServer(
        pendingSwap: PendingChainSwap
    ): Promise<void> {
        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "SIGN_SERVER_CLAIM",
            payload: pendingSwap,
        });
    }

    async verifyChainSwap(args: {
        to: Chain;
        from: Chain;
        swap: PendingChainSwap;
        arkInfo: ArkInfo;
    }): Promise<boolean> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "VERIFY_CHAIN_SWAP",
                payload: {
                    to: args.to,
                    from: args.from,
                    swap: args.swap,
                    arkInfo: args.arkInfo,
                },
            });
            return (res as ResponseVerifyChainSwap).payload.verified;
        } catch (e) {
            throw new Error("Cannot verify chain swap", { cause: e });
        }
    }

    async quoteSwap(swapId: string): Promise<number> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "QUOTE_SWAP",
                payload: { swapId },
            });
            return (res as ResponseQuoteSwap).payload.amount;
        } catch (e) {
            throw new Error("Cannot quote swap", { cause: e });
        }
    }

    enrichReverseSwapPreimage(
        swap: PendingReverseSwap,
        preimage: string
    ): PendingReverseSwap {
        return _enrichReverseSwapPreimage(swap, preimage);
    }

    enrichSubmarineSwapInvoice(
        swap: PendingSubmarineSwap,
        invoice: string
    ): PendingSubmarineSwap {
        return _enrichSubmarineSwapInvoice(swap, invoice);
    }

    createVHTLCScript(_args: {
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
        throw new Error(
            "createVHTLCScript is not supported via service worker"
        );
    }

    async joinBatch(
        _identity: Identity,
        _input: ArkTxInput,
        _output: TransactionOutput,
        _arkInfo: ArkInfo,
        _isRecoverable = true
    ): Promise<string> {
        throw new Error("joinBatch is not supported via service worker");
    }

    async getFees(): Promise<FeesResponse>;
    async getFees(from: Chain, to: Chain): Promise<ChainFeesResponse>;
    async getFees(
        from?: Chain,
        to?: Chain
    ): Promise<FeesResponse | ChainFeesResponse> {
        if ((from === undefined) !== (to === undefined)) {
            throw new Error("Both 'from' and 'to' must be provided together");
        }
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "GET_FEES",
                ...(from !== undefined && to !== undefined
                    ? { payload: { from, to } }
                    : {}),
            });
            return (res as ResponseGetFees).payload;
        } catch (e) {
            throw new Error("Cannot get fees", { cause: e });
        }
    }

    async getLimits(): Promise<LimitsResponse>;
    async getLimits(from: Chain, to: Chain): Promise<LimitsResponse>;
    async getLimits(from?: Chain, to?: Chain): Promise<LimitsResponse> {
        if ((from === undefined) !== (to === undefined)) {
            throw new Error("Both 'from' and 'to' must be provided together");
        }
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "GET_LIMITS",
                ...(from !== undefined && to !== undefined
                    ? { payload: { from, to } }
                    : {}),
            });
            return (res as ResponseGetLimits).payload;
        } catch (e) {
            throw new Error("Cannot get limits", { cause: e });
        }
    }

    async getSwapStatus(swapId: string): Promise<GetSwapStatusResponse> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "GET_SWAP_STATUS",
                payload: { swapId },
            });
            return (res as ResponseGetSwapStatus).payload;
        } catch (e) {
            throw new Error("Cannot get swap status", { cause: e });
        }
    }

    async getPendingSubmarineSwaps(): Promise<PendingSubmarineSwap[]> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "GET_PENDING_SUBMARINE_SWAPS",
            });
            return (res as ResponseGetPendingSubmarineSwaps).payload;
        } catch (e) {
            throw new Error("Cannot get pending submarine swaps", {
                cause: e,
            });
        }
    }

    async getPendingReverseSwaps(): Promise<PendingReverseSwap[]> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "GET_PENDING_REVERSE_SWAPS",
            });
            return (res as ResponseGetPendingReverseSwaps).payload;
        } catch (e) {
            throw new Error("Cannot get pending reverse swaps", { cause: e });
        }
    }

    async getPendingChainSwaps(): Promise<PendingChainSwap[]> {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "GET_PENDING_CHAIN_SWAPS",
            });
            return (res as ResponseGetPendingChainSwaps).payload;
        } catch (e) {
            throw new Error("Cannot get pending chain swaps", { cause: e });
        }
    }

    async getSwapHistory(): Promise<
        (PendingReverseSwap | PendingSubmarineSwap | PendingChainSwap)[]
    > {
        try {
            const res = await this.sendMessage({
                id: getRandomId(),
                tag: this.messageTag,
                type: "GET_SWAP_HISTORY",
            });
            return (res as ResponseGetSwapHistory).payload;
        } catch (e) {
            throw new Error("Cannot get swap history", { cause: e });
        }
    }

    async refreshSwapsStatus(): Promise<void> {
        await this.sendMessage({
            id: getRandomId(),
            tag: this.messageTag,
            type: "REFRESH_SWAPS_STATUS",
        });
    }

    /**
     * Reset all swap state: stops the SwapManager and clears the swap repository.
     *
     * **Destructive** — any swap in a non-terminal state will lose its
     * refund/claim path. Intended for wallet-reset / dev / test scenarios only.
     */
    async reset(): Promise<void> {
        await this.dispose();
        await this.swapRepository.clear();
    }

    async dispose(): Promise<void> {
        if (this.withSwapManager) {
            await this.stopSwapManager().catch(() => {});
        }
    }

    async [Symbol.asyncDispose](): Promise<void> {
        return this.dispose();
    }

    private sendMessageDirect(
        request: ArkadeSwapsUpdaterRequest
    ): Promise<ArkadeSwapsUpdaterResponse> {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeoutId);
                navigator.serviceWorker.removeEventListener(
                    "message",
                    messageHandler
                );
            };

            const timeoutId = setTimeout(() => {
                cleanup();
                reject(
                    new ServiceWorkerTimeoutError(
                        `Service worker message timed out (${request.type})`
                    )
                );
            }, 30_000);

            const messageHandler = (event: MessageEvent) => {
                const response = event.data as
                    | Partial<ArkadeSwapsUpdaterResponse>
                    | undefined;
                if (
                    !response ||
                    response.tag !== this.messageTag ||
                    response.id !== request.id
                ) {
                    return;
                }

                cleanup();
                if (response.error) {
                    reject(response.error);
                } else {
                    resolve(response as ArkadeSwapsUpdaterResponse);
                }
            };

            navigator.serviceWorker.addEventListener("message", messageHandler);
            this.serviceWorker.postMessage(request);
        });
    }

    private async sendMessage(
        request: ArkadeSwapsUpdaterRequest
    ): Promise<ArkadeSwapsUpdaterResponse> {
        if (!DEDUPABLE_REQUEST_TYPES.has(request.type)) {
            return this.sendMessageWithRetry(request);
        }

        const key = getRequestDedupKey(request);
        const existing = this.inflightRequests.get(key);
        if (existing) return existing;

        const promise = this.sendMessageWithRetry(request).finally(() => {
            this.inflightRequests.delete(key);
        });
        this.inflightRequests.set(key, promise);
        return promise;
    }

    private pingServiceWorker(): Promise<void> {
        if (this.pingPromise) return this.pingPromise;

        this.pingPromise = new Promise<void>((resolve, reject) => {
            const pingId = getRandomId();

            const cleanup = () => {
                clearTimeout(timeoutId);
                navigator.serviceWorker.removeEventListener(
                    "message",
                    onMessage
                );
            };

            const timeoutId = setTimeout(() => {
                cleanup();
                reject(
                    new ServiceWorkerTimeoutError(
                        "Service worker ping timed out"
                    )
                );
            }, 2_000);

            const onMessage = (event: MessageEvent) => {
                if (event.data?.id === pingId && event.data?.tag === "PONG") {
                    cleanup();
                    resolve();
                }
            };

            navigator.serviceWorker.addEventListener("message", onMessage);
            this.serviceWorker.postMessage({
                id: pingId,
                tag: "PING",
            });
        }).finally(() => {
            this.pingPromise = null;
        });

        return this.pingPromise;
    }

    // Send a message, retrying up to 2 times if the service worker was
    // killed and restarted by the OS (mobile browsers do this aggressively).
    private async sendMessageWithRetry(
        request: ArkadeSwapsUpdaterRequest
    ): Promise<ArkadeSwapsUpdaterResponse> {
        // Skip the preflight ping during the initial INIT_ARKADE_SWAPS call:
        // create() hasn't set initPayload yet, so reinitialize() would throw.
        if (this.initPayload) {
            try {
                await this.pingServiceWorker();
            } catch {
                await this.reinitialize();
            }
        }

        const maxRetries = 2;
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.sendMessageDirect(request);
            } catch (error: any) {
                if (
                    !isMessageBusNotInitializedError(error) ||
                    attempt >= maxRetries
                ) {
                    throw error;
                }

                await this.reinitialize();
            }
        }
    }

    private async reinitialize(): Promise<void> {
        if (this.reinitPromise) return this.reinitPromise;

        this.reinitPromise = (async () => {
            if (!this.initPayload) {
                throw new Error("Cannot re-initialize: missing configuration");
            }

            const initMessage: RequestInitArkSwaps = {
                tag: this.messageTag,
                type: "INIT_ARKADE_SWAPS",
                id: getRandomId(),
                payload: this.initPayload,
            };

            await this.sendMessageDirect(initMessage);
        })().finally(() => {
            this.reinitPromise = null;
        });

        return this.reinitPromise;
    }

    private initEventStream() {
        if (this.eventListenerInitialized) return;
        this.eventListenerInitialized = true;
        navigator.serviceWorker.addEventListener(
            "message",
            this.handleEventMessage
        );
    }

    private handleEventMessage = (event: MessageEvent) => {
        const data = event.data;
        if (!data || data.tag !== this.messageTag) return;
        if (typeof data.type !== "string") return;
        if (!data.type.startsWith("SM-EVENT-")) return;

        switch (data.type) {
            case "SM-EVENT-SWAP_UPDATE":
                this.swapUpdateListeners.forEach((cb) => {
                    cb(data.payload.swap, data.payload.oldStatus);
                });
                break;
            case "SM-EVENT-SWAP_COMPLETED":
                this.swapCompletedListeners.forEach((cb) => {
                    cb(data.payload.swap);
                });
                break;
            case "SM-EVENT-SWAP_FAILED": {
                const err = new Error(data.payload.error?.message);
                this.swapFailedListeners.forEach((cb) => {
                    cb(data.payload.swap, err);
                });
                break;
            }
            case "SM-EVENT-ACTION_EXECUTED":
                this.actionExecutedListeners.forEach((cb) => {
                    cb(data.payload.swap, data.payload.action);
                });
                break;
            case "SM-EVENT-WS_CONNECTED":
                this.wsConnectedListeners.forEach((cb) => {
                    cb();
                });
                break;
            case "SM-EVENT-WS_DISCONNECTED": {
                const err = data.payload?.errorMessage
                    ? new Error(data.payload.errorMessage)
                    : undefined;
                this.wsDisconnectedListeners.forEach((cb) => {
                    cb(err);
                });
                break;
            }
            default:
                break;
        }
    };
}

function getRandomId(): string {
    return `${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
}
