import {
    ArkProvider,
    IndexerProvider,
    IWallet,
    NetworkName,
} from "@arkade-os/sdk";
import {
    CreateReverseSwapResponse,
    CreateSubmarineSwapResponse,
    BoltzSwapProvider,
    CreateReverseSwapRequest,
    CreateSubmarineSwapRequest,
    BoltzSwapStatus,
    CreateChainSwapRequest,
    CreateChainSwapResponse,
} from "./boltz-swap-provider";
import { SwapManagerConfig } from "./swap-manager";
import { SwapRepository } from "./repositories/swap-repository";

// TODO: replace with better data structure
export interface Vtxo {
    txid: string;
    vout: number;
    sats: number;
    script: string;
    tx: {
        hex: string;
        version: number;
        locktime: number;
    };
}

export type Network = NetworkName;

export type Chain = "ARK" | "BTC";

export interface ArkToBtcResponse {
    arkAddress: string;
    amountToPay: number;
    pendingSwap: PendingChainSwap;
}

export interface BtcToArkResponse {
    btcAddress: string;
    amountToPay: number;
    pendingSwap: PendingChainSwap;
}
export interface CreateLightningInvoiceRequest {
    amount: number;
    description?: string;
}
export interface CreateLightningInvoiceResponse {
    amount: number;
    expiry: number;
    invoice: string;
    paymentHash: string;
    pendingSwap: PendingReverseSwap;
    preimage: string;
}
export interface SendLightningPaymentRequest {
    invoice: string;
}

export interface SendLightningPaymentResponse {
    amount: number;
    preimage: string;
    txid: string;
}

export interface PendingReverseSwap {
    id: string;
    type: "reverse";
    createdAt: number;
    preimage: string;
    status: BoltzSwapStatus;
    request: CreateReverseSwapRequest;
    response: CreateReverseSwapResponse;
}

export interface PendingSubmarineSwap {
    id: string;
    type: "submarine";
    createdAt: number;
    preimage?: string;
    /** Original preimage hash from Boltz (available for restored swaps) */
    preimageHash?: string;
    refunded?: boolean;
    refundable?: boolean;
    status: BoltzSwapStatus;
    request: CreateSubmarineSwapRequest;
    response: CreateSubmarineSwapResponse;
}

export interface PendingChainSwap {
    id: string;
    type: "chain";
    preimage: string;
    createdAt: number;
    ephemeralKey: string;
    feeSatsPerByte: number;
    status: BoltzSwapStatus;
    request: CreateChainSwapRequest;
    response: CreateChainSwapResponse;
    toAddress?: string;
    amount: number;
}

export type PendingSwap =
    | PendingReverseSwap
    | PendingSubmarineSwap
    | PendingChainSwap;

export interface ArkadeSwapsConfig {
    wallet: IWallet;
    arkProvider?: ArkProvider;
    swapProvider: BoltzSwapProvider;
    indexerProvider?: IndexerProvider;
    /**
     * Enable background swap monitoring and autonomous actions.
     * - `false` or `undefined`: SwapManager disabled
     * - `true`: SwapManager enabled with default configuration
     * - `SwapManagerConfig` object: SwapManager enabled with custom configuration
     */
    swapManager?: boolean | (SwapManagerConfig & { autoStart?: boolean });
    /**
     * Optional swap repository to use for persisting swap data.
     * - `undefined`: fallback to default IndexedDbSwapRepository
     * - `SwapRepository` object: SwapRepository enabled with custom configuration
     */
    swapRepository?: SwapRepository;
}

export interface DecodedInvoice {
    expiry: number;
    amountSats: number;
    description: string;
    paymentHash: string;
}

export interface IncomingPaymentSubscription {
    on(event: "pending", listener: () => void): this;
    on(event: "created", listener: () => void): this;
    on(event: "settled", listener: () => void): this;
    on(event: "failed", listener: (error: Error) => void): this;
    unsubscribe(): void;
}

export interface LimitsResponse {
    min: number;
    max: number;
}

/**
 * Fee info returned by Boltz.
 * - percentage: value (e.g., 0.01 = 0.01%)
 * - minerFees: values in satoshis
 */
export interface FeesResponse {
    submarine: {
        percentage: number;
        minerFees: number;
    };
    reverse: {
        percentage: number;
        minerFees: {
            lockup: number;
            claim: number;
        };
    };
}

export interface ChainFeesResponse {
    percentage: number;
    minerFees: {
        server: number;
        user: {
            claim: number;
            lockup: number;
        };
    };
}
