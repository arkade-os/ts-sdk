import { Transaction } from "@arkade-os/sdk";
import { NetworkError, SchemaError, SwapError } from "./errors";
import {
    Chain,
    ChainFeesResponse,
    FeesResponse,
    LimitsResponse,
    Network,
    PendingChainSwap,
    PendingReverseSwap,
    PendingSubmarineSwap,
    PendingSwap,
} from "./types";
import { base64 } from "@scure/base";

export interface SwapProviderConfig {
    apiUrl?: string;
    network: Network;
    referralId?: string;
}

// Boltz swap status types

export type BoltzSwapStatus =
    | "invoice.expired"
    | "invoice.failedToPay"
    | "invoice.paid"
    | "invoice.pending"
    | "invoice.set"
    | "invoice.settled"
    | "swap.created"
    | "swap.expired"
    | "transaction.claim.pending"
    | "transaction.claimed"
    | "transaction.confirmed"
    | "transaction.failed"
    | "transaction.lockupFailed"
    | "transaction.mempool"
    | "transaction.refunded"
    | "transaction.server.mempool"
    | "transaction.server.confirmed";

export const isSubmarineFailedStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "invoice.failedToPay",
        "transaction.lockupFailed",
        "swap.expired",
    ].includes(status);
};

export const isSubmarineFinalStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "invoice.failedToPay",
        "transaction.claimed",
        "swap.expired",
    ].includes(status);
};

export const isSubmarinePendingStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "swap.created",
        "transaction.mempool",
        "transaction.confirmed",
        "invoice.set",
        "invoice.pending",
        "invoice.paid",
        "transaction.claim.pending",
    ].includes(status);
};

export const isSubmarineRefundableStatus = (
    status: BoltzSwapStatus
): boolean => {
    return [
        "invoice.failedToPay",
        "transaction.lockupFailed",
        "swap.expired",
    ].includes(status);
};

export const isSubmarineSuccessStatus = (status: BoltzSwapStatus): boolean => {
    return status === "transaction.claimed";
};

export const isReverseFailedStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "invoice.expired",
        "transaction.failed",
        "transaction.refunded",
        "swap.expired",
    ].includes(status);
};

export const isReverseFinalStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "transaction.refunded",
        "transaction.failed",
        "invoice.settled", // normal status for completed swaps
        "swap.expired",
    ].includes(status);
};

export const isReversePendingStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "swap.created",
        "transaction.mempool",
        "transaction.confirmed",
    ].includes(status);
};

export const isReverseClaimableStatus = (status: BoltzSwapStatus): boolean => {
    return ["transaction.mempool", "transaction.confirmed"].includes(status);
};

export const isReverseSuccessStatus = (status: BoltzSwapStatus): boolean => {
    return status === "invoice.settled";
};

export const isChainFailedStatus = (status: BoltzSwapStatus): boolean => {
    return ["transaction.failed", "swap.expired"].includes(status);
};

export const isChainClaimableStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "transaction.server.mempool",
        "transaction.server.confirmed",
    ].includes(status);
};

export const isChainFinalStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "transaction.refunded",
        "transaction.failed",
        "transaction.claimed", // normal status for completed swaps
        "swap.expired",
    ].includes(status);
};

export const isChainPendingStatus = (status: BoltzSwapStatus): boolean => {
    return [
        "swap.created",
        "transaction.mempool",
        "transaction.confirmed",
        "transaction.lockupFailed",
        "transaction.server.mempool",
        "transaction.server.confirmed",
    ].includes(status);
};

export const isChainRefundableStatus = (status: BoltzSwapStatus): boolean => {
    return ["swap.expired"].includes(status);
};

export const isChainSignableStatus = (status: BoltzSwapStatus): boolean => {
    return ["transaction.claim.pending"].includes(status);
};

export const isChainSuccessStatus = (status: BoltzSwapStatus): boolean => {
    return status === "transaction.claimed";
};

// type guards

export const isPendingReverseSwap = (
    swap: PendingSwap
): swap is PendingReverseSwap => {
    return swap.type === "reverse";
};

export const isPendingSubmarineSwap = (
    swap: PendingSwap
): swap is PendingSubmarineSwap => {
    return swap.type === "submarine";
};

export const isPendingChainSwap = (
    swap: PendingSwap
): swap is PendingChainSwap => {
    return swap.type === "chain";
};

// refundable submarine swaps are those that have failed and can be refunded

export const isSubmarineSwapRefundable = (
    swap: PendingSwap
): swap is PendingSubmarineSwap => {
    return (
        isSubmarineRefundableStatus(swap.status) &&
        isPendingSubmarineSwap(swap) &&
        swap.refundable !== false &&
        swap.refunded !== true
    );
};

export const isChainSwapRefundable = (
    swap: PendingSwap
): swap is PendingChainSwap => {
    return (
        isChainRefundableStatus(swap.status) &&
        isPendingChainSwap(swap) &&
        swap.request.from === "ARK"
    );
};

export const isReverseSwapClaimable = (
    swap: PendingSwap
): swap is PendingReverseSwap => {
    return isReverseClaimableStatus(swap.status) && isPendingReverseSwap(swap);
};

export const isChainSwapClaimable = (
    swap: PendingSwap
): swap is PendingChainSwap => {
    return isChainClaimableStatus(swap.status) && isPendingChainSwap(swap);
};

// API call types and validators

type TimeoutBlockHeights = {
    refund: number;
    unilateralClaim: number;
    unilateralRefund: number;
    unilateralRefundWithoutReceiver: number;
};

const isTimeoutBlockHeights = (data: any): data is TimeoutBlockHeights => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.refund === "number" &&
        typeof data.unilateralClaim === "number" &&
        typeof data.unilateralRefund === "number" &&
        typeof data.unilateralRefundWithoutReceiver === "number"
    );
};

export type GetReverseSwapTxIdResponse = {
    id: string;
    timeoutBlockHeight: number;
};

export const isGetReverseSwapTxIdResponse = (
    data: any
): data is GetReverseSwapTxIdResponse => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.id === "string" &&
        typeof data.timeoutBlockHeight === "number"
    );
};

export type GetSwapStatusResponse = {
    status: BoltzSwapStatus;
    zeroConfRejected?: boolean;
    transaction?: {
        id: string;
        hex?: string;
        eta?: number;
        preimage?: string;
    };
};

export const isGetSwapStatusResponse = (
    data: any
): data is GetSwapStatusResponse => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.status === "string" &&
        (data.zeroConfRejected === undefined ||
            typeof data.zeroConfRejected === "boolean") &&
        (data.transaction === undefined ||
            (data.transaction &&
                typeof data.transaction === "object" &&
                typeof data.transaction.id === "string" &&
                (data.transaction.eta === undefined ||
                    typeof data.transaction.eta === "number") &&
                (data.transaction.hex === undefined ||
                    typeof data.transaction.hex === "string") &&
                (data.transaction.preimage === undefined ||
                    typeof data.transaction.preimage === "string")))
    );
};

type GetSubmarinePairsResponse = {
    ARK: {
        BTC: {
            hash: string;
            rate: number;
            limits: {
                maximal: number;
                minimal: number;
                maximalZeroConf: number;
            };
            fees: {
                percentage: number;
                minerFees: number;
            };
        };
    };
};

const isGetSubmarinePairsResponse = (
    data: any
): data is GetSubmarinePairsResponse => {
    return (
        data &&
        typeof data === "object" &&
        data.ARK &&
        typeof data.ARK === "object" &&
        data.ARK.BTC &&
        typeof data.ARK.BTC === "object" &&
        typeof data.ARK.BTC.hash === "string" &&
        typeof data.ARK.BTC.rate === "number" &&
        data.ARK.BTC.limits &&
        typeof data.ARK.BTC.limits === "object" &&
        typeof data.ARK.BTC.limits.maximal === "number" &&
        typeof data.ARK.BTC.limits.minimal === "number" &&
        typeof data.ARK.BTC.limits.maximalZeroConf === "number" &&
        data.ARK.BTC.fees &&
        typeof data.ARK.BTC.fees === "object" &&
        typeof data.ARK.BTC.fees.percentage === "number" &&
        typeof data.ARK.BTC.fees.minerFees === "number"
    );
};

type GetReversePairsResponse = {
    BTC: {
        ARK: {
            hash: string;
            rate: number;
            limits: {
                maximal: number;
                minimal: number;
            };
            fees: {
                percentage: number;
                minerFees: {
                    claim: number;
                    lockup: number;
                };
            };
        };
    };
};

const isGetReversePairsResponse = (
    data: any
): data is GetReversePairsResponse => {
    return (
        data &&
        typeof data === "object" &&
        data.BTC &&
        typeof data.BTC === "object" &&
        data.BTC.ARK &&
        typeof data.BTC.ARK === "object" &&
        data.BTC.ARK.hash &&
        typeof data.BTC.ARK.hash === "string" &&
        typeof data.BTC.ARK.rate === "number" &&
        data.BTC.ARK.limits &&
        typeof data.BTC.ARK.limits === "object" &&
        typeof data.BTC.ARK.limits.maximal === "number" &&
        typeof data.BTC.ARK.limits.minimal === "number" &&
        data.BTC.ARK.fees &&
        typeof data.BTC.ARK.fees === "object" &&
        typeof data.BTC.ARK.fees.percentage === "number" &&
        typeof data.BTC.ARK.fees.minerFees === "object" &&
        typeof data.BTC.ARK.fees.minerFees.claim === "number" &&
        typeof data.BTC.ARK.fees.minerFees.lockup === "number"
    );
};

export type CreateSubmarineSwapRequest = {
    invoice: string;
    refundPublicKey: string;
};

export type CreateSubmarineSwapResponse = {
    id: string;
    address: string;
    expectedAmount: number;
    claimPublicKey: string;
    acceptZeroConf: boolean;
    timeoutBlockHeights: TimeoutBlockHeights;
};

export const isCreateSubmarineSwapResponse = (
    data: any
): data is CreateSubmarineSwapResponse => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.id === "string" &&
        typeof data.address === "string" &&
        typeof data.expectedAmount === "number" &&
        typeof data.claimPublicKey === "string" &&
        typeof data.acceptZeroConf === "boolean" &&
        isTimeoutBlockHeights(data.timeoutBlockHeights)
    );
};

export type GetSwapPreimageResponse = {
    preimage: string;
};

export const isGetSwapPreimageResponse = (
    data: any
): data is GetSwapPreimageResponse => {
    return (
        data && typeof data === "object" && typeof data.preimage === "string"
    );
};

export type CreateReverseSwapRequest = {
    claimPublicKey: string;
    invoiceAmount: number;
    preimageHash: string;
    description?: string; // optional description for the invoice
};

export type CreateReverseSwapResponse = {
    id: string;
    invoice: string;
    onchainAmount: number;
    lockupAddress: string;
    refundPublicKey: string;
    timeoutBlockHeights: TimeoutBlockHeights;
};

export const isCreateReverseSwapResponse = (
    data: any
): data is CreateReverseSwapResponse => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.id === "string" &&
        typeof data.invoice === "string" &&
        typeof data.onchainAmount === "number" &&
        typeof data.lockupAddress === "string" &&
        typeof data.refundPublicKey === "string" &&
        isTimeoutBlockHeights(data.timeoutBlockHeights)
    );
};

export type RefundSubmarineSwapRequest = {
    transaction: string;
    checkpoint: string;
};

export type RefundSubmarineSwapResponse = {
    transaction: string;
    checkpoint: string;
};

export const isRefundSubmarineSwapResponse = (
    data: any
): data is RefundSubmarineSwapResponse => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.transaction === "string" &&
        typeof data.checkpoint === "string"
    );
};

export type RefundChainSwapRequest = {
    transaction: string;
    checkpoint: string;
};

export type RefundChainSwapResponse = {
    transaction: string;
    checkpoint: string;
};

export const isRefundChainSwapResponse = (
    data: any
): data is RefundChainSwapResponse => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.transaction === "string" &&
        typeof data.checkpoint === "string"
    );
};

type GetChainPairsResponse = Record<
    Chain,
    Record<
        Chain,
        {
            hash: string;
            rate: number;
            limits: {
                maximal: number;
                minimal: number;
                maximalZeroConf: number;
            };
            fees: ChainFeesResponse;
        }
    >
>;

const isGetChainPairsResponse = (data: any): data is GetChainPairsResponse => {
    return (
        data &&
        typeof data === "object" &&
        data.ARK &&
        data.BTC &&
        typeof data.ARK === "object" &&
        typeof data.BTC === "object" &&
        data.ARK.BTC &&
        data.BTC.ARK &&
        typeof data.ARK.BTC === "object" &&
        typeof data.BTC.ARK === "object" &&
        typeof data.ARK.BTC.hash === "string" &&
        typeof data.BTC.ARK.hash === "string" &&
        typeof data.ARK.BTC.rate === "number" &&
        typeof data.BTC.ARK.rate === "number" &&
        data.ARK.BTC.limits &&
        data.BTC.ARK.limits &&
        typeof data.ARK.BTC.limits === "object" &&
        typeof data.BTC.ARK.limits === "object" &&
        typeof data.ARK.BTC.limits.maximal === "number" &&
        typeof data.BTC.ARK.limits.maximal === "number" &&
        typeof data.ARK.BTC.limits.minimal === "number" &&
        typeof data.BTC.ARK.limits.minimal === "number" &&
        typeof data.ARK.BTC.limits.maximalZeroConf === "number" &&
        typeof data.BTC.ARK.limits.maximalZeroConf === "number" &&
        data.ARK.BTC.fees &&
        data.BTC.ARK.fees &&
        typeof data.ARK.BTC.fees === "object" &&
        typeof data.BTC.ARK.fees === "object" &&
        typeof data.ARK.BTC.fees.percentage === "number" &&
        typeof data.BTC.ARK.fees.percentage === "number" &&
        typeof data.ARK.BTC.fees.minerFees === "object" &&
        typeof data.BTC.ARK.fees.minerFees === "object" &&
        typeof data.ARK.BTC.fees.minerFees.server === "number" &&
        typeof data.BTC.ARK.fees.minerFees.server === "number" &&
        data.ARK.BTC.fees.minerFees.user &&
        data.BTC.ARK.fees.minerFees.user &&
        typeof data.ARK.BTC.fees.minerFees.user === "object" &&
        typeof data.BTC.ARK.fees.minerFees.user === "object" &&
        typeof data.ARK.BTC.fees.minerFees.user.claim === "number" &&
        typeof data.BTC.ARK.fees.minerFees.user.claim === "number" &&
        typeof data.ARK.BTC.fees.minerFees.user.lockup === "number" &&
        typeof data.BTC.ARK.fees.minerFees.user.lockup === "number"
    );
};

type SwapTree = {
    claimLeaf: {
        version: number;
        output: string;
    };
    refundLeaf: {
        version: number;
        output: string;
    };
};

const isSwapTree = (data: any): data is SwapTree => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.claimLeaf === "object" &&
        typeof data.claimLeaf.version === "number" &&
        typeof data.claimLeaf.output === "string" &&
        typeof data.refundLeaf === "object" &&
        typeof data.refundLeaf.version === "number" &&
        typeof data.refundLeaf.output === "string"
    );
};

type ChainSwapDetailsResponse = {
    amount: number;
    lockupAddress: string;
    timeoutBlockHeight: number;
    serverPublicKey: string;
    swapTree?: SwapTree;
    timeouts?: TimeoutBlockHeights;
    bip21?: string;
};

const isChainSwapDetailsResponse = (
    data: any
): data is ChainSwapDetailsResponse => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.amount === "number" &&
        typeof data.lockupAddress === "string" &&
        typeof data.serverPublicKey === "string" &&
        typeof data.timeoutBlockHeight === "number" &&
        (data.swapTree === undefined || isSwapTree(data.swapTree)) &&
        (data.timeouts === undefined || isTimeoutBlockHeights(data.timeouts)) &&
        (data.bip21 === undefined || typeof data.bip21 === "string")
    );
};

export type CreateChainSwapRequest = {
    to: Chain;
    from: Chain;
    preimageHash: string;
    claimPublicKey: string;
    feeSatsPerByte: number;
    refundPublicKey: string;
    serverLockAmount?: number;
    userLockAmount?: number;
    referralId?: string;
};

export type CreateChainSwapResponse = {
    id: string;
    claimDetails: ChainSwapDetailsResponse;
    lockupDetails: ChainSwapDetailsResponse;
};

const isCreateChainSwapResponse = (
    data: any
): data is CreateChainSwapResponse => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.id === "string" &&
        isChainSwapDetailsResponse(data.claimDetails) &&
        isChainSwapDetailsResponse(data.lockupDetails)
    );
};

export type GetChainClaimDetailsResponse = {
    pubNonce: string;
    publicKey: string;
    transactionHash: string;
};

const isGetChainClaimDetailsResponse = (
    data: any
): data is GetChainClaimDetailsResponse => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.pubNonce === "string" &&
        typeof data.publicKey === "string" &&
        typeof data.transactionHash === "string"
    );
};

export type PostChainClaimDetailsRequest = {
    preimage?: string;
    toSign?: {
        index: number;
        transaction: string;
        pubNonce: string;
    };
    signature?: {
        partialSignature: string;
        pubNonce: string;
    };
};

export type PostChainClaimDetailsResponse = {
    pubNonce?: string;
    partialSignature?: string;
};

const isPostChainClaimDetailsResponse = (
    data: any
): data is PostChainClaimDetailsResponse => {
    return (
        data &&
        typeof data === "object" &&
        ((typeof data.pubNonce === "string" &&
            typeof data.partialSignature === "string") ||
            (typeof data.pubNonce === "undefined" &&
                typeof data.partialSignature === "undefined"))
    );
};

export type GetChainQuoteResponse = {
    amount: number;
};

const isGetChainQuoteResponse = (data: any): data is GetChainQuoteResponse => {
    return data && typeof data === "object" && typeof data.amount === "number";
};

export type PostChainQuoteRequest = {
    amount: number;
};

export type PostChainQuoteResponse = {};

export const isPostChainQuoteResponse = (
    data: any
): data is PostChainQuoteResponse => {
    return (
        data &&
        typeof data === "object" &&
        Object.keys(data).length === 0 &&
        data.constructor === Object
    );
};

export type PostBtcTransactionRequest = {
    hex: string;
};

export type PostBtcTransactionResponse = {
    id: string;
};

const isPostBtcTransactionResponse = (
    data: any
): data is PostBtcTransactionResponse => {
    return data && typeof data === "object" && typeof data.id === "string";
};

export type Leaf = {
    version: number;
    output: string;
};

const isLeaf = (data: any): data is Leaf => {
    return (
        data &&
        typeof data === "object" &&
        typeof data.version === "number" &&
        typeof data.output === "string"
    );
};

export type Tree = {
    claimLeaf: Leaf;
    refundLeaf: Leaf;
    refundWithoutBoltzLeaf: Leaf;
    unilateralClaimLeaf: Leaf;
    unilateralRefundLeaf: Leaf;
    unilateralRefundWithoutBoltzLeaf: Leaf;
};

export const isTree = (data: any): data is Tree => {
    return (
        data &&
        typeof data === "object" &&
        isLeaf(data.claimLeaf) &&
        isLeaf(data.refundLeaf) &&
        isLeaf(data.refundWithoutBoltzLeaf) &&
        isLeaf(data.unilateralClaimLeaf) &&
        isLeaf(data.unilateralRefundLeaf) &&
        isLeaf(data.unilateralRefundWithoutBoltzLeaf)
    );
};

export type Details = {
    tree: Tree;
    amount?: number;
    keyIndex: number;
    transaction?: {
        id: string;
        vout: number;
    };
    lockupAddress: string;
    serverPublicKey: string;
    timeoutBlockHeight: number;
    timeoutBlockHeights: TimeoutBlockHeights;
    preimageHash?: string;
};

export const isDetails = (data: any): data is Details => {
    return (
        data &&
        typeof data === "object" &&
        isTree(data.tree) &&
        (data.amount === undefined || typeof data.amount === "number") &&
        typeof data.keyIndex === "number" &&
        (data.transaction === undefined ||
            (data.transaction &&
                typeof data.transaction === "object" &&
                typeof data.transaction.id === "string" &&
                typeof data.transaction.vout === "number")) &&
        typeof data.lockupAddress === "string" &&
        typeof data.serverPublicKey === "string" &&
        typeof data.timeoutBlockHeight === "number" &&
        isTimeoutBlockHeights(data.timeoutBlockHeights) &&
        (data.preimageHash === undefined ||
            typeof data.preimageHash === "string")
    );
};

export type RestoredSubmarineSwap = {
    to: "BTC";
    id: string;
    from: "ARK";
    type: "submarine";
    createdAt: number;
    preimageHash: string;
    status: BoltzSwapStatus;
    refundDetails: Details;
};

export const isRestoredSubmarineSwap = (
    data: any
): data is RestoredSubmarineSwap => {
    return (
        data &&
        typeof data === "object" &&
        data.to === "BTC" &&
        typeof data.id === "string" &&
        data.from === "ARK" &&
        data.type === "submarine" &&
        typeof data.createdAt === "number" &&
        typeof data.preimageHash === "string" &&
        typeof data.status === "string" &&
        isDetails(data.refundDetails)
    );
};

export type RestoredReverseSwap = {
    to: "ARK";
    id: string;
    from: "BTC";
    type: "reverse";
    createdAt: number;
    preimageHash: string;
    status: BoltzSwapStatus;
    claimDetails: Details;
};

export const isRestoredReverseSwap = (
    data: any
): data is RestoredReverseSwap => {
    return (
        data &&
        typeof data === "object" &&
        data.to === "ARK" &&
        typeof data.id === "string" &&
        data.from === "BTC" &&
        data.type === "reverse" &&
        typeof data.createdAt === "number" &&
        typeof data.preimageHash === "string" &&
        typeof data.status === "string" &&
        isDetails(data.claimDetails)
    );
};

export type CreateSwapsRestoreRequest = {
    publicKey: string;
};

export type CreateSwapsRestoreResponse = (
    | RestoredReverseSwap
    | RestoredSubmarineSwap
)[];

export const isCreateSwapsRestoreResponse = (
    data: any
): data is CreateSwapsRestoreResponse => {
    return (
        Array.isArray(data) &&
        data.every(
            (item) =>
                isRestoredReverseSwap(item) || isRestoredSubmarineSwap(item)
        )
    );
};

const BASE_URLS: Partial<Record<Network, string>> = {
    mutinynet: "https://api.boltz.mutinynet.arkade.sh",
    regtest: "http://localhost:9069",
};

export class BoltzSwapProvider {
    private readonly wsUrl: string;
    private readonly apiUrl: string;
    private readonly network: Network;
    private readonly referralId?: string;

    constructor(config: SwapProviderConfig) {
        this.network = config.network;
        this.referralId = config.referralId;
        const apiUrl = config.apiUrl || BASE_URLS[config.network];
        if (!apiUrl)
            throw new Error(
                `API URL is required for network: ${config.network}`
            );
        this.apiUrl = apiUrl;
        this.wsUrl =
            this.apiUrl
                .replace(/^http(s)?:\/\//, "ws$1://")
                .replace("9069", "9004") + "/v2/ws";
    }

    getApiUrl(): string {
        return this.apiUrl;
    }

    getWsUrl(): string {
        return this.wsUrl;
    }

    getNetwork(): Network {
        return this.network;
    }

    async getFees(): Promise<FeesResponse> {
        const [submarine, reverse] = await Promise.all([
            this.request<GetSubmarinePairsResponse>(
                "/v2/swap/submarine",
                "GET"
            ),
            this.request<GetReversePairsResponse>("/v2/swap/reverse", "GET"),
        ]);
        if (!isGetSubmarinePairsResponse(submarine))
            throw new SchemaError({ message: "error fetching submarine fees" });
        if (!isGetReversePairsResponse(reverse))
            throw new SchemaError({ message: "error fetching reverse fees" });
        return {
            submarine: {
                percentage: submarine.ARK.BTC.fees.percentage,
                minerFees: submarine.ARK.BTC.fees.minerFees,
            },
            reverse: {
                percentage: reverse.BTC.ARK.fees.percentage,
                minerFees: reverse.BTC.ARK.fees.minerFees,
            },
        };
    }

    async getLimits(): Promise<LimitsResponse> {
        const response = await this.request<GetSubmarinePairsResponse>(
            "/v2/swap/submarine",
            "GET"
        );
        if (!isGetSubmarinePairsResponse(response))
            throw new SchemaError({ message: "error fetching limits" });
        return {
            min: response.ARK.BTC.limits.minimal,
            max: response.ARK.BTC.limits.maximal,
        };
    }

    async getReverseSwapTxId(id: string): Promise<GetReverseSwapTxIdResponse> {
        const res = await this.request<GetReverseSwapTxIdResponse>(
            `/v2/swap/reverse/${id}/transaction`,
            "GET"
        );
        if (!isGetReverseSwapTxIdResponse(res))
            throw new SchemaError({
                message: `error fetching txid for swap: ${id}`,
            });
        return res;
    }

    async getSwapStatus(id: string): Promise<GetSwapStatusResponse> {
        const response = await this.request<GetSwapStatusResponse>(
            `/v2/swap/${id}`,
            "GET"
        );
        if (!isGetSwapStatusResponse(response))
            throw new SchemaError({
                message: `error fetching status for swap: ${id}`,
            });
        return response;
    }

    async getSwapPreimage(id: string): Promise<GetSwapPreimageResponse> {
        const res = await this.request<GetSwapPreimageResponse>(
            `/v2/swap/submarine/${id}/preimage`,
            "GET"
        );
        if (!isGetSwapPreimageResponse(res))
            throw new SchemaError({
                message: `error fetching preimage for swap: ${id}`,
            });
        return res;
    }

    async createSubmarineSwap({
        invoice,
        refundPublicKey,
    }: CreateSubmarineSwapRequest): Promise<CreateSubmarineSwapResponse> {
        // refundPublicKey must be in compressed version (33 bytes / 66 hex chars)
        if (refundPublicKey.length != 66) {
            throw new SwapError({
                message: "refundPublicKey must be a compressed public key",
            });
        }
        // make submarine swap request
        const requestBody = {
            from: "ARK",
            to: "BTC",
            invoice,
            refundPublicKey,
            ...(this.referralId ? { referralId: this.referralId } : {}),
        };
        const response = await this.request<CreateSubmarineSwapResponse>(
            "/v2/swap/submarine",
            "POST",
            requestBody
        );
        if (!isCreateSubmarineSwapResponse(response))
            throw new SchemaError({ message: "Error creating submarine swap" });
        return response;
    }

    async createReverseSwap({
        invoiceAmount,
        claimPublicKey,
        preimageHash,
        description,
    }: CreateReverseSwapRequest): Promise<CreateReverseSwapResponse> {
        // claimPublicKey must be in compressed version (33 bytes / 66 hex chars)
        if (claimPublicKey.length != 66) {
            throw new SwapError({
                message: "claimPublicKey must be a compressed public key",
            });
        }
        // make reverse swap request
        const requestBody = {
            from: "BTC",
            to: "ARK",
            invoiceAmount,
            claimPublicKey,
            preimageHash,
            ...(description?.trim() ? { description: description.trim() } : {}),
            ...(this.referralId ? { referralId: this.referralId } : {}),
        };

        const response = await this.request<CreateReverseSwapResponse>(
            "/v2/swap/reverse",
            "POST",
            requestBody
        );

        if (!isCreateReverseSwapResponse(response))
            throw new SchemaError({ message: "Error creating reverse swap" });

        return response;
    }

    async createChainSwap({
        to,
        from,
        preimageHash,
        feeSatsPerByte,
        claimPublicKey,
        refundPublicKey,
        serverLockAmount,
        userLockAmount,
    }: CreateChainSwapRequest): Promise<CreateChainSwapResponse> {
        // validate direction
        if (["BTC", "ARK"].indexOf(to) === -1)
            throw new SwapError({ message: "Invalid 'to' chain" });
        if (["BTC", "ARK"].indexOf(from) === -1)
            throw new SwapError({ message: "Invalid 'from' chain" });
        if (to === from)
            throw new SwapError({ message: "Invalid swap direction" });

        // validate preimage hash
        if (!preimageHash || preimageHash.length != 64)
            throw new SwapError({ message: "Invalid preimageHash" });

        // validate fee
        if (feeSatsPerByte <= 0)
            throw new SwapError({ message: "Invalid feeSatsPerByte" });

        // validate lock amounts
        if (
            (serverLockAmount !== undefined && userLockAmount !== undefined) ||
            (serverLockAmount === undefined && userLockAmount === undefined)
        )
            throw new SwapError({
                message:
                    "Either serverLockAmount or userLockAmount must be provided",
            });
        if (userLockAmount !== undefined && userLockAmount <= 0)
            throw new SwapError({ message: "Invalid userLockAmount" });
        if (serverLockAmount !== undefined && serverLockAmount <= 0)
            throw new SwapError({ message: "Invalid serverLockAmount" });

        // claimPublicKey must be in compressed version (33 bytes / 66 hex chars)
        if (claimPublicKey.length != 66) {
            throw new SwapError({
                message: "claimPublicKey must be a compressed public key",
            });
        }

        // refundPublicKey must be in compressed version (33 bytes / 66 hex chars)
        if (refundPublicKey.length != 66) {
            throw new SwapError({
                message: "refundPublicKey must be a compressed public key",
            });
        }

        // make chain swap request
        const requestBody: CreateChainSwapRequest = {
            to,
            from,
            preimageHash,
            feeSatsPerByte,
            claimPublicKey,
            refundPublicKey,
            serverLockAmount,
            userLockAmount,
            ...(this.referralId ? { referralId: this.referralId } : {}),
        };

        const response = await this.request<CreateChainSwapResponse>(
            "/v2/swap/chain",
            "POST",
            requestBody
        );

        // validate response
        if (!isCreateChainSwapResponse(response))
            throw new SchemaError({ message: "Error creating chain swap" });

        return response;
    }

    async refundSubmarineSwap(
        swapId: string,
        transaction: Transaction,
        checkpoint: Transaction
    ): Promise<{ transaction: Transaction; checkpoint: Transaction }> {
        // make refund swap request
        const requestBody: RefundSubmarineSwapRequest = {
            checkpoint: base64.encode(checkpoint.toPSBT()),
            transaction: base64.encode(transaction.toPSBT()),
        };

        const response = await this.request<RefundSubmarineSwapResponse>(
            `/v2/swap/submarine/${swapId}/refund/ark`,
            "POST",
            requestBody
        );

        if (!isRefundSubmarineSwapResponse(response))
            throw new SchemaError({
                message: "Error refunding submarine swap",
            });

        return {
            transaction: Transaction.fromPSBT(
                base64.decode(response.transaction)
            ),
            checkpoint: Transaction.fromPSBT(
                base64.decode(response.checkpoint)
            ),
        };
    }

    async refundChainSwap(
        swapId: string,
        transaction: Transaction,
        checkpoint: Transaction
    ): Promise<{ transaction: Transaction; checkpoint: Transaction }> {
        // make refund swap request
        const requestBody: RefundChainSwapRequest = {
            checkpoint: base64.encode(checkpoint.toPSBT()),
            transaction: base64.encode(transaction.toPSBT()),
        };

        const response = await this.request<RefundChainSwapResponse>(
            `/v2/swap/chain/${swapId}/refund/ark`,
            "POST",
            requestBody
        );

        if (!isRefundChainSwapResponse(response))
            throw new SchemaError({
                message: "Error refunding chain swap",
            });

        return {
            transaction: Transaction.fromPSBT(
                base64.decode(response.transaction)
            ),
            checkpoint: Transaction.fromPSBT(
                base64.decode(response.checkpoint)
            ),
        };
    }

    async monitorSwap(
        swapId: string,
        update: (type: BoltzSwapStatus, data?: any) => void
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const webSocket = new globalThis.WebSocket(this.wsUrl);

            const connectionTimeout = setTimeout(() => {
                webSocket.close();
                reject(new NetworkError("WebSocket connection timeout"));
            }, 30000); // 30 second timeout

            webSocket.onerror = (error) => {
                clearTimeout(connectionTimeout);
                reject(
                    new NetworkError(
                        `WebSocket error: ${(error as any).message}`
                    )
                );
            };

            webSocket.onopen = () => {
                clearTimeout(connectionTimeout);
                webSocket.send(
                    JSON.stringify({
                        op: "subscribe",
                        channel: "swap.update",
                        args: [swapId],
                    })
                );
            };

            webSocket.onclose = () => {
                clearTimeout(connectionTimeout);
                resolve();
            };

            webSocket.onmessage = async (rawMsg) => {
                const msg = JSON.parse(rawMsg.data as string);

                // we are only interested in updates for the specific swap
                if (msg.event !== "update" || msg.args[0].id !== swapId) return;

                if (msg.args[0].error) {
                    webSocket.close();
                    reject(new SwapError({ message: msg.args[0].error }));
                }

                const status = msg.args[0].status as BoltzSwapStatus;

                // chain swaps lockupFailed can be negotiable
                const negotiable =
                    status === "transaction.lockupFailed" &&
                    msg.args[0].failureDetails?.actual !== undefined &&
                    msg.args[0].failureDetails?.expected !== undefined;

                switch (status) {
                    case "invoice.settled":
                    case "transaction.claimed":
                    case "transaction.refunded":
                    case "invoice.expired":
                    case "invoice.failedToPay":
                    case "transaction.failed":
                    case "swap.expired":
                        webSocket.close();
                        update(status, msg.args[0]);
                        break;
                    case "transaction.lockupFailed":
                        if (!negotiable) webSocket.close();
                        update(status, msg.args[0]);
                        break;
                    case "invoice.paid":
                    case "invoice.pending":
                    case "invoice.set":
                    case "swap.created":
                    case "transaction.mempool":
                    case "transaction.confirmed":
                    case "transaction.claim.pending":
                    case "transaction.server.mempool":
                    case "transaction.server.confirmed":
                        update(status, msg.args[0]);
                }
            };
        });
    }

    async getChainFees(from: Chain, to: Chain): Promise<ChainFeesResponse> {
        if (from === to) {
            throw new SwapError({ message: "Invalid chain pair" });
        }

        const response = await this.request<GetChainPairsResponse>(
            "/v2/swap/chain",
            "GET"
        );

        if (!isGetChainPairsResponse(response))
            throw new SchemaError({ message: "error fetching fees" });

        if (!response[from]?.[to]) {
            throw new SchemaError({
                message: `unsupported chain pair: ${from} -> ${to}`,
            });
        }
        return response[from][to].fees;
    }

    async getChainLimits(from: Chain, to: Chain): Promise<LimitsResponse> {
        if (from === to) {
            throw new SwapError({ message: "Invalid chain pair" });
        }

        const response = await this.request<GetChainPairsResponse>(
            "/v2/swap/chain",
            "GET"
        );

        if (!isGetChainPairsResponse(response))
            throw new SchemaError({ message: "error fetching limits" });

        if (!response[from]?.[to]) {
            throw new SchemaError({
                message: `unsupported chain pair: ${from} -> ${to}`,
            });
        }

        return {
            min: response[from][to].limits.minimal,
            max: response[from][to].limits.maximal,
        };
    }

    async getChainClaimDetails(
        swapId: string
    ): Promise<GetChainClaimDetailsResponse> {
        const response = await this.request<GetChainClaimDetailsResponse>(
            `/v2/swap/chain/${swapId}/claim`,
            "GET"
        );
        if (!isGetChainClaimDetailsResponse(response))
            throw new SchemaError({
                message: `error fetching claim details for swap: ${swapId}`,
            });
        return response;
    }

    async getChainQuote(swapId: string): Promise<GetChainQuoteResponse> {
        const response = await this.request<GetChainQuoteResponse>(
            `/v2/swap/chain/${swapId}/quote`,
            "GET"
        );
        if (!isGetChainQuoteResponse(response))
            throw new SchemaError({
                message: `error fetching quote for swap: ${swapId}`,
            });
        return response;
    }

    async postChainQuote(
        swapId: string,
        request: PostChainQuoteRequest
    ): Promise<PostChainQuoteResponse> {
        const response = await this.request<PostChainQuoteResponse>(
            `/v2/swap/chain/${swapId}/quote`,
            "POST",
            request
        );
        if (!isPostChainQuoteResponse(response))
            throw new SchemaError({
                message: `error posting quote for swap: ${swapId}`,
            });
        return response;
    }

    async postBtcTransaction(hex: string): Promise<PostBtcTransactionResponse> {
        const requestBody: PostBtcTransactionRequest = { hex };

        const response = await this.request<PostBtcTransactionResponse>(
            "/v2/chain/BTC/transaction",
            "POST",
            requestBody
        );

        if (!isPostBtcTransactionResponse(response))
            throw new SchemaError({
                message: "error posting BTC transaction",
            });

        return response;
    }

    async postChainClaimDetails(
        swapId: string,
        request: PostChainClaimDetailsRequest
    ): Promise<PostChainClaimDetailsResponse> {
        const response = await this.request<PostChainClaimDetailsResponse>(
            `/v2/swap/chain/${swapId}/claim`,
            "POST",
            request
        );

        if (!isPostChainClaimDetailsResponse(response))
            throw new SchemaError({
                message: `error posting claim details for swap: ${swapId}`,
            });

        return response;
    }

    async restoreSwaps(publicKey: string): Promise<CreateSwapsRestoreResponse> {
        const requestBody: CreateSwapsRestoreRequest = {
            publicKey,
        };

        const response = await this.request<CreateSwapsRestoreResponse>(
            "/v2/swap/restore",
            "POST",
            requestBody
        );

        if (!isCreateSwapsRestoreResponse(response))
            throw new SchemaError({
                message: "Invalid schema in response for swap restoration",
            });

        return response;
    }

    private async request<T>(
        path: string,
        method: "GET" | "POST",
        body?: unknown
    ): Promise<T> {
        const url = `${this.apiUrl}${path}`;
        try {
            const response = await globalThis.fetch(url, {
                method,
                headers: { "Content-Type": "application/json" },
                body: body ? JSON.stringify(body) : undefined,
            });

            if (!response.ok) {
                const errorBody = await response.text();
                let errorData: any;
                try {
                    errorData = JSON.parse(errorBody);
                } catch {
                    // If parsing fails, errorData remains undefined
                }
                const message = `Boltz API error: ${response.status} ${errorBody}`;
                throw new NetworkError(message, response.status, errorData);
            }
            if (response.headers.get("content-length") === "0") {
                throw new NetworkError("Empty response from Boltz API");
            }
            // Use type assertion to T, as we expect the API to return the correct type
            return (await response.json()) as T;
        } catch (error) {
            if (error instanceof NetworkError) throw error;
            throw new NetworkError(
                `Request to ${url} failed: ${(error as Error).message}`
            );
        }
    }
}
