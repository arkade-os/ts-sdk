import {
    IWallet,
    IReadonlyWallet,
    RequestEnvelope,
    ResponseEnvelope,
    MessageHandler,
    type ArkInfo,
} from "@arkade-os/sdk";
import {
    BoltzSwapProvider,
    type GetSwapStatusResponse,
    BoltzSwapStatus,
} from "../boltz-swap-provider";
import { SwapRepository } from "../repositories/swap-repository";
import {
    ArkadeSwapsConfig,
    ArkToBtcResponse,
    BtcToArkResponse,
    Chain,
    ChainFeesResponse,
    type CreateLightningInvoiceRequest,
    type CreateLightningInvoiceResponse,
    type FeesResponse,
    type LimitsResponse,
    Network,
    PendingChainSwap,
    PendingReverseSwap,
    PendingSubmarineSwap,
    type SendLightningPaymentRequest,
    SendLightningPaymentResponse,
} from "../types";
import {
    ArkProvider,
    RestArkProvider,
    IndexerProvider,
    RestIndexerProvider,
} from "@arkade-os/sdk";
import { ArkadeSwaps } from "../arkade-swaps";
import type { SwapManagerClient } from "../swap-manager";

export const DEFAULT_MESSAGE_TAG = "ARKADE_SWAPS_UPDATER";

export type RequestInitArkSwaps = RequestEnvelope & {
    type: "INIT_ARKADE_SWAPS";
    payload: Omit<
        ArkadeSwapsConfig,
        "wallet" | "swapRepository" | "swapProvider" | "indexerProvider"
    > & {
        network: Network;
        arkServerUrl: string;
        swapProvider: {
            baseUrl: string;
        };
    };
};

export type ResponseInitArkLn = ResponseEnvelope & {
    type: "ARKADE_SWAPS_INITIALIZED";
};

export type RequestCreateLightningInvoice = RequestEnvelope & {
    type: "CREATE_LIGHTNING_INVOICE";
    payload: CreateLightningInvoiceRequest;
};
export type ResponseCreateLightningInvoice = ResponseEnvelope & {
    type: "LIGHTNING_INVOICE_CREATED";
    payload: CreateLightningInvoiceResponse;
};

export type RequestSendLightningPayment = RequestEnvelope & {
    type: "SEND_LIGHTNING_PAYMENT";
    payload: SendLightningPaymentRequest;
};
export type ResponseSendLightningPayment = ResponseEnvelope & {
    type: "LIGHTNING_PAYMENT_SENT";
    payload: SendLightningPaymentResponse;
};

export type RequestCreateSubmarineSwap = RequestEnvelope & {
    type: "CREATE_SUBMARINE_SWAP";
    payload: SendLightningPaymentRequest;
};
export type ResponseCreateSubmarineSwap = ResponseEnvelope & {
    type: "SUBMARINE_SWAP_CREATED";
    payload: PendingSubmarineSwap;
};

export type RequestCreateReverseSwap = RequestEnvelope & {
    type: "CREATE_REVERSE_SWAP";
    payload: CreateLightningInvoiceRequest;
};
export type ResponseCreateReverseSwap = ResponseEnvelope & {
    type: "REVERSE_SWAP_CREATED";
    payload: PendingReverseSwap;
};

export type RequestClaimVhtlc = RequestEnvelope & {
    type: "CLAIM_VHTLC";
    payload: PendingReverseSwap;
};
export type ResponseClaimVhtlc = ResponseEnvelope & {
    type: "VHTLC_CLAIMED";
};

export type RequestRefundVhtlc = RequestEnvelope & {
    type: "REFUND_VHTLC";
    payload: PendingSubmarineSwap;
};
export type ResponseRefundVhtlc = ResponseEnvelope & {
    type: "VHTLC_REFUNDED";
};

export type RequestWaitAndClaim = RequestEnvelope & {
    type: "WAIT_AND_CLAIM";
    payload: PendingReverseSwap;
};
export type ResponseWaitAndClaim = ResponseEnvelope & {
    type: "WAIT_AND_CLAIMED";
    payload: { txid: string };
};

export type RequestWaitForSwapSettlement = RequestEnvelope & {
    type: "WAIT_FOR_SWAP_SETTLEMENT";
    payload: PendingSubmarineSwap;
};
export type ResponseWaitForSwapSettlement = ResponseEnvelope & {
    type: "SWAP_SETTLED";
    payload: { preimage: string };
};

export type RequestRestoreSwaps = RequestEnvelope & {
    type: "RESTORE_SWAPS";
    payload?: FeesResponse;
};
export type ResponseRestoreSwaps = ResponseEnvelope & {
    type: "SWAPS_RESTORED";
    payload: {
        reverseSwaps: PendingReverseSwap[];
        submarineSwaps: PendingSubmarineSwap[];
    };
};

export type RequestEnrichReverseSwapPreimage = RequestEnvelope & {
    type: "ENRICH_REVERSE_SWAP_PREIMAGE";
    payload: { swap: PendingReverseSwap; preimage: string };
};
export type ResponseEnrichReverseSwapPreimage = ResponseEnvelope & {
    type: "REVERSE_SWAP_PREIMAGE_ENRICHED";
    payload: PendingReverseSwap;
};

export type RequestEnrichSubmarineSwapInvoice = RequestEnvelope & {
    type: "ENRICH_SUBMARINE_SWAP_INVOICE";
    payload: { swap: PendingSubmarineSwap; invoice: string };
};
export type ResponseEnrichSubmarineSwapInvoice = ResponseEnvelope & {
    type: "SUBMARINE_SWAP_INVOICE_ENRICHED";
    payload: PendingSubmarineSwap;
};

export type RequestGetFees = RequestEnvelope & {
    type: "GET_FEES";
    payload?: { from: Chain; to: Chain };
};
export type ResponseGetFees = ResponseEnvelope & {
    type: "FEES";
    payload: FeesResponse | ChainFeesResponse;
};

export type RequestGetLimits = RequestEnvelope & {
    type: "GET_LIMITS";
    payload?: { from: Chain; to: Chain };
};
export type ResponseGetLimits = ResponseEnvelope & {
    type: "LIMITS";
    payload: LimitsResponse;
};

export type RequestGetSwapStatus = RequestEnvelope & {
    type: "GET_SWAP_STATUS";
    payload: { swapId: string };
};
export type ResponseGetSwapStatus = ResponseEnvelope & {
    type: "SWAP_STATUS";
    payload: GetSwapStatusResponse;
};

export type RequestGetPendingSubmarineSwaps = RequestEnvelope & {
    type: "GET_PENDING_SUBMARINE_SWAPS";
};
export type ResponseGetPendingSubmarineSwaps = ResponseEnvelope & {
    type: "PENDING_SUBMARINE_SWAPS";
    payload: PendingSubmarineSwap[];
};

export type RequestGetPendingReverseSwaps = RequestEnvelope & {
    type: "GET_PENDING_REVERSE_SWAPS";
};
export type ResponseGetPendingReverseSwaps = ResponseEnvelope & {
    type: "PENDING_REVERSE_SWAPS";
    payload: PendingReverseSwap[];
};

export type RequestGetPendingChainSwaps = RequestEnvelope & {
    type: "GET_PENDING_CHAIN_SWAPS";
};
export type ResponseGetPendingChainSwaps = ResponseEnvelope & {
    type: "PENDING_CHAIN_SWAPS";
    payload: PendingChainSwap[];
};

export type RequestGetSwapHistory = RequestEnvelope & {
    type: "GET_SWAP_HISTORY";
};
export type ResponseGetSwapHistory = ResponseEnvelope & {
    type: "SWAP_HISTORY";
    payload: (PendingReverseSwap | PendingSubmarineSwap | PendingChainSwap)[];
};

export type RequestRefreshSwapsStatus = RequestEnvelope & {
    type: "REFRESH_SWAPS_STATUS";
};
export type ResponseRefreshSwapsStatus = ResponseEnvelope & {
    type: "SWAPS_STATUS_REFRESHED";
};

export type RequestArkToBtc = RequestEnvelope & {
    type: "ARK_TO_BTC";
    payload: {
        btcAddress: string;
        senderLockAmount?: number;
        receiverLockAmount?: number;
        feeSatsPerByte?: number;
    };
};
export type ResponseArkToBtc = ResponseEnvelope & {
    type: "ARK_TO_BTC_CREATED";
    payload: ArkToBtcResponse;
};

export type RequestBtcToArk = RequestEnvelope & {
    type: "BTC_TO_ARK";
    payload: {
        feeSatsPerByte?: number;
        senderLockAmount?: number;
        receiverLockAmount?: number;
    };
};
export type ResponseBtcToArk = ResponseEnvelope & {
    type: "BTC_TO_ARK_CREATED";
    payload: BtcToArkResponse;
};

export type RequestCreateChainSwap = RequestEnvelope & {
    type: "CREATE_CHAIN_SWAP";
    payload: {
        to: Chain;
        from: Chain;
        toAddress: string;
        feeSatsPerByte?: number;
        senderLockAmount?: number;
        receiverLockAmount?: number;
    };
};
export type ResponseCreateChainSwap = ResponseEnvelope & {
    type: "CHAIN_SWAP_CREATED";
    payload: PendingChainSwap;
};

export type RequestWaitAndClaimChain = RequestEnvelope & {
    type: "WAIT_AND_CLAIM_CHAIN";
    payload: PendingChainSwap;
};
export type ResponseWaitAndClaimChain = ResponseEnvelope & {
    type: "CHAIN_CLAIMED";
    payload: { txid: string };
};

export type RequestWaitAndClaimArk = RequestEnvelope & {
    type: "WAIT_AND_CLAIM_ARK";
    payload: PendingChainSwap;
};
export type ResponseWaitAndClaimArk = ResponseEnvelope & {
    type: "ARK_CLAIMED";
    payload: { txid: string };
};

export type RequestWaitAndClaimBtc = RequestEnvelope & {
    type: "WAIT_AND_CLAIM_BTC";
    payload: PendingChainSwap;
};
export type ResponseWaitAndClaimBtc = ResponseEnvelope & {
    type: "BTC_CLAIMED";
    payload: { txid: string };
};

export type RequestClaimArk = RequestEnvelope & {
    type: "CLAIM_ARK";
    payload: PendingChainSwap;
};
export type ResponseClaimArk = ResponseEnvelope & {
    type: "ARK_CLAIM_EXECUTED";
};

export type RequestClaimBtc = RequestEnvelope & {
    type: "CLAIM_BTC";
    payload: PendingChainSwap;
};
export type ResponseClaimBtc = ResponseEnvelope & {
    type: "BTC_CLAIM_EXECUTED";
};

export type RequestRefundArk = RequestEnvelope & {
    type: "REFUND_ARK";
    payload: PendingChainSwap;
};
export type ResponseRefundArk = ResponseEnvelope & {
    type: "ARK_REFUND_EXECUTED";
};

export type RequestSignServerClaim = RequestEnvelope & {
    type: "SIGN_SERVER_CLAIM";
    payload: PendingChainSwap;
};
export type ResponseSignServerClaim = ResponseEnvelope & {
    type: "SERVER_CLAIM_SIGNED";
};

export type RequestVerifyChainSwap = RequestEnvelope & {
    type: "VERIFY_CHAIN_SWAP";
    payload: {
        to: Chain;
        from: Chain;
        swap: PendingChainSwap;
        arkInfo: ArkInfo;
    };
};
export type ResponseVerifyChainSwap = ResponseEnvelope & {
    type: "CHAIN_SWAP_VERIFIED";
    payload: { verified: boolean };
};

export type RequestQuoteSwap = RequestEnvelope & {
    type: "QUOTE_SWAP";
    payload: { swapId: string };
};
export type ResponseQuoteSwap = ResponseEnvelope & {
    type: "SWAP_QUOTED";
    payload: { amount: number };
};

/* --- SwapManager requests/responses (Service Worker) --- */

export type RequestSwapManagerStart = RequestEnvelope & {
    type: "SM-START";
};
export type ResponseSwapManagerStart = ResponseEnvelope & {
    type: "SM-STARTED";
};

export type RequestSwapManagerStop = RequestEnvelope & {
    type: "SM-STOP";
};
export type ResponseSwapManagerStop = ResponseEnvelope & {
    type: "SM-STOPPED";
};

export type RequestSwapManagerAddSwap = RequestEnvelope & {
    type: "SM-ADD_SWAP";
    payload: PendingReverseSwap | PendingSubmarineSwap | PendingChainSwap;
};
export type ResponseSwapManagerAddSwap = ResponseEnvelope & {
    type: "SM-SWAP_ADDED";
};

export type RequestSwapManagerRemoveSwap = RequestEnvelope & {
    type: "SM-REMOVE_SWAP";
    payload: { swapId: string };
};
export type ResponseSwapManagerRemoveSwap = ResponseEnvelope & {
    type: "SM-SWAP_REMOVED";
};

export type RequestSwapManagerGetPending = RequestEnvelope & {
    type: "SM-GET_PENDING_SWAPS";
};
export type ResponseSwapManagerGetPending = ResponseEnvelope & {
    type: "SM-PENDING_SWAPS";
    payload: (PendingReverseSwap | PendingSubmarineSwap | PendingChainSwap)[];
};

export type RequestSwapManagerHasSwap = RequestEnvelope & {
    type: "SM-HAS_SWAP";
    payload: { swapId: string };
};
export type ResponseSwapManagerHasSwap = ResponseEnvelope & {
    type: "SM-HAS_SWAP_RESULT";
    payload: { has: boolean };
};

export type RequestSwapManagerIsProcessing = RequestEnvelope & {
    type: "SM-IS_PROCESSING";
    payload: { swapId: string };
};
export type ResponseSwapManagerIsProcessing = ResponseEnvelope & {
    type: "SM-IS_PROCESSING_RESULT";
    payload: { processing: boolean };
};

export type RequestSwapManagerGetStats = RequestEnvelope & {
    type: "SM-GET_STATS";
};
export type ResponseSwapManagerGetStats = ResponseEnvelope & {
    type: "SM-STATS";
    payload: {
        isRunning: boolean;
        monitoredSwaps: number;
        websocketConnected: boolean;
        usePollingFallback: boolean;
        currentReconnectDelay: number;
        currentPollRetryDelay: number;
    };
};

export type RequestSwapManagerWaitForCompletion = RequestEnvelope & {
    type: "SM-WAIT_FOR_COMPLETION";
    payload: { swapId: string };
};
export type ResponseSwapManagerWaitForCompletion = ResponseEnvelope & {
    type: "SM-COMPLETED";
    payload: { txid: string };
};

export type ArkadeSwapsUpdaterRequest =
    | RequestInitArkSwaps
    | RequestCreateLightningInvoice
    | RequestSendLightningPayment
    | RequestCreateSubmarineSwap
    | RequestCreateReverseSwap
    | RequestClaimVhtlc
    | RequestRefundVhtlc
    | RequestWaitAndClaim
    | RequestWaitForSwapSettlement
    | RequestRestoreSwaps
    | RequestEnrichReverseSwapPreimage
    | RequestEnrichSubmarineSwapInvoice
    | RequestGetFees
    | RequestGetLimits
    | RequestGetSwapStatus
    | RequestGetPendingSubmarineSwaps
    | RequestGetPendingReverseSwaps
    | RequestGetPendingChainSwaps
    | RequestGetSwapHistory
    | RequestRefreshSwapsStatus
    | RequestArkToBtc
    | RequestBtcToArk
    | RequestCreateChainSwap
    | RequestWaitAndClaimChain
    | RequestWaitAndClaimArk
    | RequestWaitAndClaimBtc
    | RequestClaimArk
    | RequestClaimBtc
    | RequestRefundArk
    | RequestSignServerClaim
    | RequestVerifyChainSwap
    | RequestQuoteSwap
    | RequestSwapManagerStart
    | RequestSwapManagerStop
    | RequestSwapManagerAddSwap
    | RequestSwapManagerRemoveSwap
    | RequestSwapManagerGetPending
    | RequestSwapManagerHasSwap
    | RequestSwapManagerIsProcessing
    | RequestSwapManagerGetStats
    | RequestSwapManagerWaitForCompletion;

export type ArkadeSwapsUpdaterResponse =
    | ResponseInitArkLn
    | ResponseCreateLightningInvoice
    | ResponseSendLightningPayment
    | ResponseCreateSubmarineSwap
    | ResponseCreateReverseSwap
    | ResponseClaimVhtlc
    | ResponseRefundVhtlc
    | ResponseWaitAndClaim
    | ResponseWaitForSwapSettlement
    | ResponseRestoreSwaps
    | ResponseEnrichReverseSwapPreimage
    | ResponseEnrichSubmarineSwapInvoice
    | ResponseGetFees
    | ResponseGetLimits
    | ResponseGetSwapStatus
    | ResponseGetPendingSubmarineSwaps
    | ResponseGetPendingReverseSwaps
    | ResponseGetPendingChainSwaps
    | ResponseGetSwapHistory
    | ResponseRefreshSwapsStatus
    | ResponseArkToBtc
    | ResponseBtcToArk
    | ResponseCreateChainSwap
    | ResponseWaitAndClaimChain
    | ResponseWaitAndClaimArk
    | ResponseWaitAndClaimBtc
    | ResponseClaimArk
    | ResponseClaimBtc
    | ResponseRefundArk
    | ResponseSignServerClaim
    | ResponseVerifyChainSwap
    | ResponseQuoteSwap
    | ResponseSwapManagerStart
    | ResponseSwapManagerStop
    | ResponseSwapManagerAddSwap
    | ResponseSwapManagerRemoveSwap
    | ResponseSwapManagerGetPending
    | ResponseSwapManagerHasSwap
    | ResponseSwapManagerIsProcessing
    | ResponseSwapManagerGetStats
    | ResponseSwapManagerWaitForCompletion;

type PendingSwap = PendingReverseSwap | PendingSubmarineSwap | PendingChainSwap;

export type SwapManagerEventMessage =
    | {
          tag: string;
          type: "SM-EVENT-SWAP_UPDATE";
          payload: { swap: PendingSwap; oldStatus: BoltzSwapStatus };
      }
    | {
          tag: string;
          type: "SM-EVENT-SWAP_COMPLETED";
          payload: { swap: PendingSwap };
      }
    | {
          tag: string;
          type: "SM-EVENT-SWAP_FAILED";
          payload: { swap: PendingSwap; error: { message: string } };
      }
    | {
          tag: string;
          type: "SM-EVENT-ACTION_EXECUTED";
          payload: {
              swap: PendingSwap;
              action:
                  | "claim"
                  | "refund"
                  | "claimArk"
                  | "claimBtc"
                  | "refundArk"
                  | "signServerClaim";
          };
      }
    | {
          tag: string;
          type: "SM-EVENT-WS_CONNECTED";
      }
    | {
          tag: string;
          type: "SM-EVENT-WS_DISCONNECTED";
          payload?: { errorMessage?: string };
      };

export class ArkadeSwapsMessageHandler
    implements
        MessageHandler<ArkadeSwapsUpdaterRequest, ArkadeSwapsUpdaterResponse>
{
    static messageTag = DEFAULT_MESSAGE_TAG;
    readonly messageTag = ArkadeSwapsMessageHandler.messageTag;

    private arkProvider: ArkProvider | undefined;
    private indexerProvider: IndexerProvider | undefined;
    private swapProvider: BoltzSwapProvider | undefined;
    private wallet: IWallet | undefined;

    private handler: ArkadeSwaps | undefined;
    private swapManager: SwapManagerClient | null | undefined;

    constructor(private readonly swapRepository: SwapRepository) {}

    private getSwapManagerOrThrow(): SwapManagerClient {
        const sm = this.handler?.getSwapManager();
        if (!sm) throw new Error("SwapManager is not enabled");
        return sm;
    }

    async start(opts: {
        wallet?: IWallet;
        readonlyWallet: IReadonlyWallet;
    }): Promise<void> {
        if (!opts.wallet) throw new Error("Wallet is required");
        this.wallet = opts.wallet;
    }

    async stop() {
        const handler = this.handler;
        if (!handler) return;

        const swapManager = this.swapManager ?? handler.getSwapManager();
        if (swapManager) {
            await swapManager.stop();
        }

        if (typeof handler.dispose === "function") {
            await handler.dispose();
        }

        this.swapManager = null;
        this.handler = undefined;
        this.wallet = undefined;
        this.arkProvider = undefined;
        this.indexerProvider = undefined;
        this.swapProvider = undefined;
    }

    async tick(_now: number) {
        // Event-driven handler; no periodic work required from the service worker tick.
        return [];
    }

    private tagged(
        res: Partial<ArkadeSwapsUpdaterResponse>
    ): ArkadeSwapsUpdaterResponse {
        return {
            ...res,
            tag: this.messageTag,
        } as ArkadeSwapsUpdaterResponse;
    }

    private async broadcastEvent(
        event: SwapManagerEventMessage
    ): Promise<void> {
        const sw: any = self as any;
        if (!sw?.clients?.matchAll) return;
        const clients = await sw.clients.matchAll();
        for (const client of clients) {
            try {
                (client as any).postMessage(event);
            } catch {
                // client may have been closed; skip
            }
        }
    }

    async handleMessage(
        message: ArkadeSwapsUpdaterRequest
    ): Promise<ArkadeSwapsUpdaterResponse> {
        const id = message.id;
        if (message.type === "INIT_ARKADE_SWAPS") {
            try {
                await this.handleInit(message);
                return this.tagged({
                    id,
                    type: "ARKADE_SWAPS_INITIALIZED",
                });
            } catch (error) {
                return this.tagged({ id, error: error as Error });
            }
        }

        if (!this.handler || !this.wallet) {
            return this.tagged({
                id,
                error: new Error("handler not initialized"),
            });
        }

        try {
            switch (message.type) {
                case "CREATE_LIGHTNING_INVOICE": {
                    const res = await this.handler.createLightningInvoice(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "LIGHTNING_INVOICE_CREATED",
                        payload: res,
                    });
                }

                case "SEND_LIGHTNING_PAYMENT": {
                    const res = await this.handler.sendLightningPayment(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "LIGHTNING_PAYMENT_SENT",
                        payload: res,
                    });
                }

                case "CREATE_SUBMARINE_SWAP": {
                    const res = await this.handler.createSubmarineSwap(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "SUBMARINE_SWAP_CREATED",
                        payload: res,
                    });
                }

                case "CREATE_REVERSE_SWAP": {
                    const res = await this.handler.createReverseSwap(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "REVERSE_SWAP_CREATED",
                        payload: res,
                    });
                }

                case "CLAIM_VHTLC":
                    await this.handler.claimVHTLC(message.payload);
                    return this.tagged({ id, type: "VHTLC_CLAIMED" });

                case "REFUND_VHTLC":
                    await this.handler.refundVHTLC(message.payload);
                    return this.tagged({ id, type: "VHTLC_REFUNDED" });

                case "WAIT_AND_CLAIM": {
                    const res = await this.handler.waitAndClaim(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "WAIT_AND_CLAIMED",
                        payload: res,
                    });
                }

                case "WAIT_FOR_SWAP_SETTLEMENT": {
                    const res = await this.handler.waitForSwapSettlement(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "SWAP_SETTLED",
                        payload: res,
                    });
                }

                case "RESTORE_SWAPS": {
                    const res = await this.handler.restoreSwaps(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "SWAPS_RESTORED",
                        payload: res,
                    });
                }

                case "ENRICH_REVERSE_SWAP_PREIMAGE": {
                    const res = this.handler.enrichReverseSwapPreimage(
                        message.payload.swap,
                        message.payload.preimage
                    );
                    return this.tagged({
                        id,
                        type: "REVERSE_SWAP_PREIMAGE_ENRICHED",
                        payload: res,
                    });
                }

                case "ENRICH_SUBMARINE_SWAP_INVOICE": {
                    const res = this.handler.enrichSubmarineSwapInvoice(
                        message.payload.swap,
                        message.payload.invoice
                    );
                    return this.tagged({
                        id,
                        type: "SUBMARINE_SWAP_INVOICE_ENRICHED",
                        payload: res,
                    });
                }

                case "GET_FEES": {
                    const res = message.payload
                        ? await this.handler.getFees(
                              message.payload.from,
                              message.payload.to
                          )
                        : await this.handler.getFees();
                    return this.tagged({ id, type: "FEES", payload: res });
                }

                case "GET_LIMITS": {
                    const res = message.payload
                        ? await this.handler.getLimits(
                              message.payload.from,
                              message.payload.to
                          )
                        : await this.handler.getLimits();
                    return this.tagged({ id, type: "LIMITS", payload: res });
                }

                case "GET_SWAP_STATUS": {
                    const res = await this.handler.getSwapStatus(
                        message.payload.swapId
                    );
                    return this.tagged({
                        id,
                        type: "SWAP_STATUS",
                        payload: res,
                    });
                }

                case "GET_PENDING_SUBMARINE_SWAPS": {
                    const res = await this.handler.getPendingSubmarineSwaps();
                    return this.tagged({
                        id,
                        type: "PENDING_SUBMARINE_SWAPS",
                        payload: res,
                    });
                }

                case "GET_PENDING_REVERSE_SWAPS": {
                    const res = await this.handler.getPendingReverseSwaps();
                    return this.tagged({
                        id,
                        type: "PENDING_REVERSE_SWAPS",
                        payload: res,
                    });
                }

                case "GET_PENDING_CHAIN_SWAPS": {
                    const res = await this.handler.getPendingChainSwaps();
                    return this.tagged({
                        id,
                        type: "PENDING_CHAIN_SWAPS",
                        payload: res,
                    });
                }

                case "GET_SWAP_HISTORY": {
                    const res = await this.handler.getSwapHistory();
                    return this.tagged({
                        id,
                        type: "SWAP_HISTORY",
                        payload: res,
                    });
                }

                case "REFRESH_SWAPS_STATUS":
                    await this.handler.refreshSwapsStatus();
                    return this.tagged({ id, type: "SWAPS_STATUS_REFRESHED" });

                case "ARK_TO_BTC": {
                    const res = await this.handler.arkToBtc(message.payload);
                    return this.tagged({
                        id,
                        type: "ARK_TO_BTC_CREATED",
                        payload: res,
                    });
                }

                case "BTC_TO_ARK": {
                    const res = await this.handler.btcToArk(message.payload);
                    return this.tagged({
                        id,
                        type: "BTC_TO_ARK_CREATED",
                        payload: res,
                    });
                }

                case "CREATE_CHAIN_SWAP": {
                    const res = await this.handler.createChainSwap(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "CHAIN_SWAP_CREATED",
                        payload: res,
                    });
                }

                case "WAIT_AND_CLAIM_CHAIN": {
                    const res = await this.handler.waitAndClaimChain(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "CHAIN_CLAIMED",
                        payload: res,
                    });
                }

                case "WAIT_AND_CLAIM_ARK": {
                    const res = await this.handler.waitAndClaimArk(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "ARK_CLAIMED",
                        payload: res,
                    });
                }

                case "WAIT_AND_CLAIM_BTC": {
                    const res = await this.handler.waitAndClaimBtc(
                        message.payload
                    );
                    return this.tagged({
                        id,
                        type: "BTC_CLAIMED",
                        payload: res,
                    });
                }

                case "CLAIM_ARK":
                    await this.handler.claimArk(message.payload);
                    return this.tagged({ id, type: "ARK_CLAIM_EXECUTED" });

                case "CLAIM_BTC":
                    await this.handler.claimBtc(message.payload);
                    return this.tagged({ id, type: "BTC_CLAIM_EXECUTED" });

                case "REFUND_ARK":
                    await this.handler.refundArk(message.payload);
                    return this.tagged({ id, type: "ARK_REFUND_EXECUTED" });

                case "SIGN_SERVER_CLAIM":
                    await this.handler.signCooperativeClaimForServer(
                        message.payload
                    );
                    return this.tagged({ id, type: "SERVER_CLAIM_SIGNED" });

                case "VERIFY_CHAIN_SWAP": {
                    const verified = await this.handler.verifyChainSwap({
                        ...message.payload,
                    });
                    return this.tagged({
                        id,
                        type: "CHAIN_SWAP_VERIFIED",
                        payload: { verified },
                    });
                }

                case "QUOTE_SWAP": {
                    const amount = await this.handler.quoteSwap(
                        message.payload.swapId
                    );
                    return this.tagged({
                        id,
                        type: "SWAP_QUOTED",
                        payload: { amount },
                    });
                }

                /* --- SwapManager methods --- */
                case "SM-START": {
                    await this.handler.startSwapManager();
                    return this.tagged({ id, type: "SM-STARTED" });
                }

                case "SM-STOP": {
                    await this.handler.stopSwapManager();
                    return this.tagged({ id, type: "SM-STOPPED" });
                }

                case "SM-ADD_SWAP": {
                    await this.getSwapManagerOrThrow().addSwap(message.payload);
                    return this.tagged({ id, type: "SM-SWAP_ADDED" });
                }

                case "SM-REMOVE_SWAP": {
                    await this.getSwapManagerOrThrow().removeSwap(
                        message.payload.swapId
                    );
                    return this.tagged({ id, type: "SM-SWAP_REMOVED" });
                }

                case "SM-GET_PENDING_SWAPS": {
                    const res =
                        await this.getSwapManagerOrThrow().getPendingSwaps();
                    return this.tagged({
                        id,
                        type: "SM-PENDING_SWAPS",
                        payload: res,
                    });
                }

                case "SM-HAS_SWAP": {
                    const has = await this.getSwapManagerOrThrow().hasSwap(
                        message.payload.swapId
                    );
                    return this.tagged({
                        id,
                        type: "SM-HAS_SWAP_RESULT",
                        payload: { has },
                    });
                }

                case "SM-IS_PROCESSING": {
                    const processing =
                        await this.getSwapManagerOrThrow().isProcessing(
                            message.payload.swapId
                        );
                    return this.tagged({
                        id,
                        type: "SM-IS_PROCESSING_RESULT",
                        payload: { processing },
                    });
                }

                case "SM-GET_STATS": {
                    const stats = await this.getSwapManagerOrThrow().getStats();
                    return this.tagged({
                        id,
                        type: "SM-STATS",
                        payload: stats,
                    });
                }

                case "SM-WAIT_FOR_COMPLETION": {
                    const res =
                        await this.getSwapManagerOrThrow().waitForSwapCompletion(
                            message.payload.swapId
                        );
                    return this.tagged({
                        id,
                        type: "SM-COMPLETED",
                        payload: res,
                    });
                }

                default:
                    console.error("Unknown message type", message);
                    throw new Error("Unknown message");
            }
        } catch (error) {
            return this.tagged({ id, error: error as Error });
        }
    }

    private async handleInit({ payload }: RequestInitArkSwaps): Promise<void> {
        if (!this.wallet) {
            throw new Error("Wallet is required");
        }
        const { arkServerUrl } = payload;
        this.arkProvider = new RestArkProvider(arkServerUrl);
        this.indexerProvider = new RestIndexerProvider(arkServerUrl);
        this.swapProvider = new BoltzSwapProvider({
            apiUrl: payload.swapProvider.baseUrl,
            network: payload.network,
        });

        const handler = new ArkadeSwaps({
            wallet: this.wallet,
            arkProvider: this.arkProvider,
            swapProvider: this.swapProvider,
            indexerProvider: this.indexerProvider,
            swapRepository: this.swapRepository,
            swapManager: payload.swapManager,
        });
        this.handler = handler;

        const sm = handler.getSwapManager();
        this.swapManager = sm;
        if (sm) {
            void sm.onSwapUpdate(async (swap, oldStatus) => {
                await this.broadcastEvent({
                    tag: this.messageTag,
                    type: "SM-EVENT-SWAP_UPDATE",
                    payload: { swap, oldStatus },
                });
            });
            void sm.onSwapCompleted(async (swap) => {
                await this.broadcastEvent({
                    tag: this.messageTag,
                    type: "SM-EVENT-SWAP_COMPLETED",
                    payload: { swap },
                });
            });
            void sm.onSwapFailed(async (swap, error) => {
                await this.broadcastEvent({
                    tag: this.messageTag,
                    type: "SM-EVENT-SWAP_FAILED",
                    payload: { swap, error: { message: error.message } },
                });
            });
            void sm.onActionExecuted(async (swap, action) => {
                await this.broadcastEvent({
                    tag: this.messageTag,
                    type: "SM-EVENT-ACTION_EXECUTED",
                    payload: { swap, action },
                });
            });
            void sm.onWebSocketConnected(async () => {
                await this.broadcastEvent({
                    tag: this.messageTag,
                    type: "SM-EVENT-WS_CONNECTED",
                });
            });
            void sm.onWebSocketDisconnected(async (error) => {
                await this.broadcastEvent({
                    tag: this.messageTag,
                    type: "SM-EVENT-WS_DISCONNECTED",
                    payload: error
                        ? { errorMessage: error.message }
                        : undefined,
                });
            });
        }
    }
}
