import {
    IWallet,
    IReadonlyWallet,
    WalletBalance,
    ArkTransaction,
} from "../wallet";
import { SettlementEvent, FeeInfo } from "../providers/ark";

/**
 * Base interface for all skills.
 * Skills are modular capabilities that can be added to wallets.
 */
export interface Skill {
    /** Unique identifier for the skill */
    readonly name: string;
    /** Human-readable description of the skill's capabilities */
    readonly description: string;
    /** Version of the skill implementation */
    readonly version: string;
}

/**
 * Represents a Bitcoin address with its type and purpose.
 */
export interface BitcoinAddress {
    /** The encoded address string */
    address: string;
    /** Type of address */
    type: "ark" | "boarding" | "onchain";
    /** Description of the address purpose */
    description: string;
}

/**
 * Parameters for sending Bitcoin.
 */
export interface SendParams {
    /** Destination address (Ark address for off-chain, Bitcoin address for on-chain) */
    address: string;
    /** Amount in satoshis */
    amount: number;
    /** Optional fee rate in sat/vB */
    feeRate?: number;
    /** Optional memo for the transaction */
    memo?: string;
}

/**
 * Parameters for onboarding Bitcoin from on-chain to off-chain (Ark).
 */
export interface OnboardParams {
    /** Fee information for the settlement */
    feeInfo: FeeInfo;
    /** Optional specific amount to onboard (defaults to all available) */
    amount?: bigint;
    /** Optional callback for settlement events */
    eventCallback?: (event: SettlementEvent) => void;
}

/**
 * Parameters for offboarding Bitcoin from off-chain (Ark) to on-chain.
 */
export interface OffboardParams {
    /** Destination on-chain Bitcoin address */
    destinationAddress: string;
    /** Fee information for the settlement */
    feeInfo: FeeInfo;
    /** Optional specific amount to offboard (defaults to all available) */
    amount?: bigint;
    /** Optional callback for settlement events */
    eventCallback?: (event: SettlementEvent) => void;
}

/**
 * Result of a send operation.
 */
export interface SendResult {
    /** Transaction identifier */
    txid: string;
    /** Type of transaction */
    type: "ark" | "onchain" | "lightning";
    /** Amount sent in satoshis */
    amount: number;
    /** Fee paid in satoshis (if known) */
    fee?: number;
}

/**
 * Result of an onboard/offboard operation.
 */
export interface RampResult {
    /** Commitment transaction ID */
    commitmentTxid: string;
    /** Amount moved in satoshis */
    amount: bigint;
}

/**
 * Balance information with breakdown by type.
 */
export interface BalanceInfo {
    /** Total available balance in satoshis */
    total: number;
    /** Off-chain (Ark) balance breakdown */
    offchain: {
        /** Settled VTXOs */
        settled: number;
        /** Pending VTXOs awaiting confirmation */
        preconfirmed: number;
        /** Total off-chain available */
        available: number;
        /** Recoverable funds (swept or subdust) */
        recoverable: number;
    };
    /** On-chain balance breakdown */
    onchain: {
        /** Confirmed boarding UTXOs */
        confirmed: number;
        /** Unconfirmed boarding UTXOs */
        unconfirmed: number;
        /** Total boarding balance */
        total: number;
    };
}

/**
 * Incoming funds notification.
 */
export interface IncomingFundsEvent {
    /** Type of incoming funds */
    type: "utxo" | "vtxo";
    /** Amount received in satoshis */
    amount: number;
    /** Transaction or VTXO IDs */
    ids: string[];
}

/**
 * Interface for Bitcoin skills that can send and receive Bitcoin.
 */
export interface BitcoinSkill extends Skill {
    /**
     * Get addresses for receiving Bitcoin.
     * @returns Array of available addresses with their types
     */
    getReceiveAddresses(): Promise<BitcoinAddress[]>;

    /**
     * Get the primary Ark address for receiving off-chain Bitcoin.
     * @returns The Ark address string
     */
    getArkAddress(): Promise<string>;

    /**
     * Get the boarding address for receiving on-chain Bitcoin (to be onboarded).
     * @returns The boarding address string
     */
    getBoardingAddress(): Promise<string>;

    /**
     * Get the current balance with breakdown.
     * @returns Balance information
     */
    getBalance(): Promise<BalanceInfo>;

    /**
     * Send Bitcoin to an address.
     * @param params Send parameters
     * @returns Result of the send operation
     */
    send(params: SendParams): Promise<SendResult>;

    /**
     * Get transaction history.
     * @returns Array of transactions
     */
    getTransactionHistory(): Promise<ArkTransaction[]>;

    /**
     * Wait for incoming funds (blocking).
     * @param timeoutMs Optional timeout in milliseconds
     * @returns Information about the incoming funds
     */
    waitForIncomingFunds(timeoutMs?: number): Promise<IncomingFundsEvent>;
}

/**
 * Interface for skills that support on/off ramping between on-chain and off-chain.
 */
export interface RampSkill extends Skill {
    /**
     * Onboard Bitcoin from on-chain to off-chain (Ark).
     * @param params Onboard parameters
     * @returns Result of the onboard operation
     */
    onboard(params: OnboardParams): Promise<RampResult>;

    /**
     * Offboard Bitcoin from off-chain (Ark) to on-chain.
     * @param params Offboard parameters
     * @returns Result of the offboard operation
     */
    offboard(params: OffboardParams): Promise<RampResult>;
}

/**
 * Lightning Network invoice for receiving payments.
 */
export interface LightningInvoice {
    /** BOLT11 encoded invoice string */
    bolt11: string;
    /** Payment hash */
    paymentHash: string;
    /** Amount in satoshis */
    amount: number;
    /** Invoice description */
    description?: string;
    /** Expiry time in seconds */
    expirySeconds: number;
    /** Creation timestamp */
    createdAt: Date;
    /** Preimage (available after payment or when creating) */
    preimage?: string;
}

/**
 * Parameters for creating a Lightning invoice.
 */
export interface CreateInvoiceParams {
    /** Amount in satoshis */
    amount: number;
    /** Invoice description */
    description?: string;
}

/**
 * Parameters for paying a Lightning invoice.
 */
export interface PayInvoiceParams {
    /** BOLT11 encoded invoice string */
    bolt11: string;
}

/**
 * Result of a Lightning payment.
 */
export interface PaymentResult {
    /** Payment preimage (proof of payment) */
    preimage: string;
    /** Amount paid in satoshis */
    amount: number;
    /** Transaction ID (Ark txid for the swap) */
    txid: string;
}

/**
 * Fee information for Lightning swaps.
 */
export interface LightningFees {
    /** Submarine swap fees (send to Lightning) */
    submarine: {
        /** Percentage fee (e.g., 0.01 = 0.01%) */
        percentage: number;
        /** Miner fees in satoshis */
        minerFees: number;
    };
    /** Reverse swap fees (receive from Lightning) */
    reverse: {
        /** Percentage fee (e.g., 0.01 = 0.01%) */
        percentage: number;
        /** Miner fees in satoshis */
        minerFees: {
            lockup: number;
            claim: number;
        };
    };
}

/**
 * Limits for Lightning swaps.
 */
export interface LightningLimits {
    /** Minimum swap amount in satoshis */
    min: number;
    /** Maximum swap amount in satoshis */
    max: number;
}

/**
 * Status of a Lightning swap.
 */
export type SwapStatus =
    | "pending"
    | "invoice.set"
    | "invoice.pending"
    | "invoice.paid"
    | "invoice.settled"
    | "invoice.expired"
    | "invoice.failedToPay"
    | "swap.created"
    | "swap.expired"
    | "transaction.mempool"
    | "transaction.confirmed"
    | "transaction.claimed"
    | "transaction.refunded"
    | "transaction.failed"
    | "transaction.lockupFailed"
    | "transaction.claim.pending";

/**
 * Information about a pending swap.
 */
export interface SwapInfo {
    /** Swap ID */
    id: string;
    /** Swap type */
    type: "submarine" | "reverse";
    /** Current status */
    status: SwapStatus;
    /** Amount in satoshis */
    amount: number;
    /** Creation timestamp */
    createdAt: Date;
    /** Invoice (if applicable) */
    invoice?: string;
}

/**
 * Interface for Lightning Network skills.
 */
export interface LightningSkill extends Skill {
    /**
     * Create a Lightning invoice for receiving payment.
     * Uses Boltz reverse swap to receive Lightning into Arkade.
     * @param params Invoice parameters
     * @returns The created invoice
     */
    createInvoice(params: CreateInvoiceParams): Promise<LightningInvoice>;

    /**
     * Pay a Lightning invoice.
     * Uses Boltz submarine swap to send from Arkade to Lightning.
     * @param params Payment parameters
     * @returns Result of the payment
     */
    payInvoice(params: PayInvoiceParams): Promise<PaymentResult>;

    /**
     * Check if the Lightning skill is available and configured.
     * @returns true if Lightning is available
     */
    isAvailable(): Promise<boolean>;

    /**
     * Get fee information for Lightning swaps.
     * @returns Fee structure for swaps
     */
    getFees(): Promise<LightningFees>;

    /**
     * Get limits for Lightning swaps.
     * @returns Min/max limits for swaps
     */
    getLimits(): Promise<LightningLimits>;

    /**
     * Get pending swaps.
     * @returns Array of pending swap information
     */
    getPendingSwaps(): Promise<SwapInfo[]>;

    /**
     * Get swap history.
     * @returns Array of all swaps (pending and completed)
     */
    getSwapHistory(): Promise<SwapInfo[]>;
}
