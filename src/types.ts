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

/** A virtual transaction output (VTXO) — an off-chain UTXO in the Ark protocol. */
// TODO: replace with better data structure
export interface Vtxo {
    /** Transaction ID of the VTXO. */
    txid: string;
    /** Output index in the transaction. */
    vout: number;
    /** Amount in satoshis. */
    sats: number;
    /** The output script (hex-encoded). */
    script: string;
    /** Raw transaction data. */
    tx: {
        /** Raw transaction hex. */
        hex: string;
        /** Transaction version number. */
        version: number;
        /** Transaction locktime. */
        locktime: number;
    };
}

/** Network name (e.g. "mutinynet", "regtest", "bitcoin"). */
export type Network = NetworkName;

/** The chain side of a swap: "ARK" (off-chain Ark protocol) or "BTC" (on-chain Bitcoin). */
export type Chain = "ARK" | "BTC";

/** Response from creating an ARK → BTC chain swap. */
export interface ArkToBtcResponse {
    /** The ARK lockup address to send funds to. */
    arkAddress: string;
    /** Amount in satoshis to send to the lockup address. */
    amountToPay: number;
    /** The pending chain swap object for monitoring. */
    pendingSwap: BoltzChainSwap;
}

/** Response from creating a BTC → ARK chain swap. */
export interface BtcToArkResponse {
    /** The BTC lockup address to send funds to. */
    btcAddress: string;
    /** Amount in satoshis to send to the lockup address. */
    amountToPay: number;
    /** The pending chain swap object for monitoring. */
    pendingSwap: BoltzChainSwap;
}

/** Request to create a Lightning invoice (reverse swap: Lightning → Arkade). */
export interface CreateLightningInvoiceRequest {
    /** Invoice amount in satoshis. */
    amount: number;
    /** Optional description embedded in the BOLT11 invoice. */
    description?: string;
}

/** Response containing the created Lightning invoice and swap details. */
export interface CreateLightningInvoiceResponse {
    /** The on-chain amount in satoshis (after Boltz fees). */
    amount: number;
    /** Invoice expiry timestamp (Unix seconds). */
    expiry: number;
    /** The BOLT11-encoded Lightning invoice string. */
    invoice: string;
    /** The payment hash (hex-encoded). */
    paymentHash: string;
    /** The pending reverse swap for monitoring. */
    pendingSwap: BoltzReverseSwap;
    /** The preimage (hex-encoded). Keep secret until claiming. */
    preimage: string;
}

/** Request to send a Lightning payment (submarine swap: Arkade → Lightning). */
export interface SendLightningPaymentRequest {
    /** BOLT11-encoded Lightning invoice to pay. */
    invoice: string;
}

/** Response after a successful Lightning payment. */
export interface SendLightningPaymentResponse {
    /** Amount paid in satoshis. */
    amount: number;
    /** Payment preimage proving payment was made (hex-encoded). */
    preimage: string;
    /** Transaction ID of the Arkade payment. */
    txid: string;
}

/** Tracks an in-progress reverse swap (Lightning → Arkade). */
export interface BoltzReverseSwap {
    /** Unique swap ID from Boltz. */
    id: string;
    /** Discriminator — always "reverse". */
    type: "reverse";
    /** Unix timestamp (seconds) when the swap was created. */
    createdAt: number;
    /** The swap preimage (hex-encoded). Required for claiming the VHTLC. */
    preimage: string;
    /** Current Boltz swap status. */
    status: BoltzSwapStatus;
    /** The original request sent to Boltz. */
    request: CreateReverseSwapRequest;
    /** Boltz API response with lockup address, invoice, and timeout details. */
    response: CreateReverseSwapResponse;
}

/** Tracks an in-progress submarine swap (Arkade → Lightning). */
export interface BoltzSubmarineSwap {
    /** Unique swap ID from Boltz. */
    id: string;
    /** Discriminator — always "submarine". */
    type: "submarine";
    /** Unix timestamp (seconds) when the swap was created. */
    createdAt: number;
    /** Payment preimage (hex-encoded). Available after the Lightning payment settles. */
    preimage?: string;
    /** Original preimage hash from Boltz (available for restored swaps). */
    preimageHash?: string;
    /** Whether the swap has been refunded. */
    refunded?: boolean;
    /** Whether the swap is eligible for refund. */
    refundable?: boolean;
    /** Current Boltz swap status. */
    status: BoltzSwapStatus;
    /** The original request sent to Boltz. */
    request: CreateSubmarineSwapRequest;
    /** Boltz API response with payment address and expected amount. */
    response: CreateSubmarineSwapResponse;
}

/** Tracks an in-progress chain swap (ARK ↔ BTC). */
export interface BoltzChainSwap {
    /** Unique swap ID from Boltz. */
    id: string;
    /** Discriminator — always "chain". */
    type: "chain";
    /** The swap preimage (hex-encoded). Required for claiming. */
    preimage: string;
    /** Unix timestamp (seconds) when the swap was created. */
    createdAt: number;
    /** Ephemeral private key (hex) for BTC MuSig2 claim/refund signing. */
    ephemeralKey: string;
    /** Fee rate (sats/vbyte) used for on-chain BTC transactions. */
    feeSatsPerByte: number;
    /** Current Boltz swap status. */
    status: BoltzSwapStatus;
    /** The original chain swap request sent to Boltz. */
    request: CreateChainSwapRequest;
    /** Boltz API response with lockup and claim details. */
    response: CreateChainSwapResponse;
    /** Destination address for the received funds. */
    toAddress?: string;
    /** Swap amount in satoshis. */
    amount: number;
}

/** Union type of all pending swap types. */
export type BoltzSwap =
    | BoltzReverseSwap
    | BoltzSubmarineSwap
    | BoltzChainSwap;

/** Configuration for initializing ArkadeSwaps via the constructor (swapProvider is required). */
export interface ArkadeSwapsConfig {
    /** An IWallet instance from @arkade-os/sdk (must expose arkProvider and indexerProvider). */
    wallet: IWallet;
    /** Explicit ArkProvider. Falls back to wallet.arkProvider if omitted. */
    arkProvider?: ArkProvider;
    /** BoltzSwapProvider instance for interacting with the Boltz API. */
    swapProvider: BoltzSwapProvider;
    /** Explicit IndexerProvider. Falls back to wallet.indexerProvider if omitted. */
    indexerProvider?: IndexerProvider;
    /**
     * Background swap monitoring and autonomous actions (enabled by default).
     * - `undefined` or `true`: SwapManager enabled with default configuration
     * - `false`: SwapManager disabled
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

/**
 * Configuration for {@link ArkadeSwaps.create} — same as ArkadeSwapsConfig but
 * `swapProvider` is optional (auto-created from the wallet's network if omitted).
 */
export type ArkadeSwapsCreateConfig = Omit<
    ArkadeSwapsConfig,
    "swapProvider"
> & {
    swapProvider?: BoltzSwapProvider;
};

/** A decoded BOLT11 Lightning invoice. */
export interface DecodedInvoice {
    /** Invoice expiry timestamp (Unix seconds). */
    expiry: number;
    /** Invoice amount in satoshis. */
    amountSats: number;
    /** Invoice description string. */
    description: string;
    /** Payment hash (hex-encoded). */
    paymentHash: string;
}

/** Event subscription for incoming Lightning payments. */
export interface IncomingPaymentSubscription {
    /** Fires when the payment is pending. */
    on(event: "pending", listener: () => void): this;
    /** Fires when the swap has been created. */
    on(event: "created", listener: () => void): this;
    /** Fires when the payment has been settled and funds claimed. */
    on(event: "settled", listener: () => void): this;
    /** Fires when the payment fails. */
    on(event: "failed", listener: (error: Error) => void): this;
    /** Removes all listeners and cleans up. */
    unsubscribe(): void;
}

/** Swap amount limits from Boltz. */
export interface LimitsResponse {
    /** Minimum swap amount in satoshis. */
    min: number;
    /** Maximum swap amount in satoshis. */
    max: number;
}

/**
 * Lightning swap fee info from Boltz.
 * - `percentage`: Boltz fee as a percentage (e.g. 0.1 = 0.1%)
 * - `minerFees`: values in satoshis
 */
export interface FeesResponse {
    /** Submarine swap (Arkade → Lightning) fees. */
    submarine: {
        /** Boltz fee as a percentage (e.g. 0.1 = 0.1%). */
        percentage: number;
        /** Miner fee in satoshis. */
        minerFees: number;
    };
    /** Reverse swap (Lightning → Arkade) fees. */
    reverse: {
        /** Boltz fee as a percentage (e.g. 0.1 = 0.1%). */
        percentage: number;
        /** Miner fees in satoshis. */
        minerFees: {
            /** Miner fee for the lockup transaction. */
            lockup: number;
            /** Miner fee for the claim transaction. */
            claim: number;
        };
    };
}

/** Chain swap fee info from Boltz. */
export interface ChainFeesResponse {
    /** Boltz fee as a percentage (e.g. 0.1 = 0.1%). */
    percentage: number;
    /** Miner fees in satoshis. */
    minerFees: {
        /** Server-side miner fee. */
        server: number;
        /** User-side miner fees. */
        user: {
            /** Miner fee for the claim transaction. */
            claim: number;
            /** Miner fee for the lockup transaction. */
            lockup: number;
        };
    };
}
