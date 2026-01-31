import {
    ArkadeLightning,
    BoltzSwapProvider,
    PendingReverseSwap,
    PendingSubmarineSwap,
    decodeInvoice,
} from "@arkade-os/boltz-swap";
import { Wallet } from "../wallet/wallet";
import { ArkProvider } from "../providers/ark";
import { IndexerProvider } from "../providers/indexer";
import { NetworkName } from "../networks";
import {
    LightningSkill,
    LightningInvoice,
    CreateInvoiceParams,
    PayInvoiceParams,
    PaymentResult,
    LightningFees,
    LightningLimits,
    SwapInfo,
    SwapStatus,
} from "./types";

/**
 * Default Boltz API URLs by network.
 */
const BOLTZ_API_URLS: Record<string, string> = {
    bitcoin: "https://api.boltz.exchange",
    mainnet: "https://api.boltz.exchange",
    testnet: "https://testnet.boltz.exchange/api",
    signet: "https://testnet.boltz.exchange/api",
    regtest: "http://localhost:9001",
    mutinynet: "https://mutinynet.boltz.exchange/api",
};

/**
 * Configuration for the ArkaLightningSkill.
 */
export interface ArkaLightningSkillConfig {
    /** The Arkade wallet to use */
    wallet: Wallet;
    /** Network name */
    network: NetworkName;
    /** Optional Ark provider (will use wallet's provider if not specified) */
    arkProvider?: ArkProvider;
    /** Optional Indexer provider */
    indexerProvider?: IndexerProvider;
    /** Optional custom Boltz API URL */
    boltzApiUrl?: string;
    /** Optional Boltz referral ID */
    referralId?: string;
    /** Enable background swap monitoring (default: false) */
    enableSwapManager?: boolean;
}

/**
 * ArkaLightningSkill provides Lightning Network payment capabilities
 * for Arkade wallets using Boltz submarine swaps.
 *
 * This skill enables:
 * - Receiving Lightning payments into your Arkade wallet (reverse swaps)
 * - Sending Lightning payments from your Arkade wallet (submarine swaps)
 *
 * @example
 * ```typescript
 * import { Wallet, SingleKey, ArkaLightningSkill } from "@arkade-os/sdk";
 *
 * // Create a wallet
 * const wallet = await Wallet.create({
 *   identity: SingleKey.fromHex(privateKeyHex),
 *   arkServerUrl: "https://ark.example.com",
 * });
 *
 * // Create the Lightning skill
 * const lightning = new ArkaLightningSkill({
 *   wallet,
 *   network: "bitcoin",
 * });
 *
 * // Create an invoice to receive Lightning payment
 * const invoice = await lightning.createInvoice({
 *   amount: 50000, // 50,000 sats
 *   description: "Payment for coffee",
 * });
 * console.log("Pay this invoice:", invoice.bolt11);
 *
 * // Pay a Lightning invoice
 * const result = await lightning.payInvoice({
 *   bolt11: "lnbc...",
 * });
 * console.log("Paid! Preimage:", result.preimage);
 * ```
 */
export class ArkaLightningSkill implements LightningSkill {
    readonly name = "arka-lightning";
    readonly description =
        "Lightning Network payments via Boltz submarine swaps for Arkade wallets";
    readonly version = "1.0.0";

    private readonly arkadeLightning: ArkadeLightning;
    private readonly swapProvider: BoltzSwapProvider;
    private readonly network: NetworkName;

    /**
     * Creates a new ArkaLightningSkill instance.
     *
     * @param config - Configuration options
     */
    constructor(config: ArkaLightningSkillConfig) {
        this.network = config.network;

        const boltzApiUrl =
            config.boltzApiUrl ||
            BOLTZ_API_URLS[config.network] ||
            BOLTZ_API_URLS.bitcoin;

        this.swapProvider = new BoltzSwapProvider({
            apiUrl: boltzApiUrl,
            network: config.network,
            referralId: config.referralId,
        });

        // Cast wallet to any since boltz-swap expects Wallet from @arkade-os/sdk
        // but we have the local Wallet type - they are structurally identical
        this.arkadeLightning = new ArkadeLightning({
            wallet: config.wallet as any,
            swapProvider: this.swapProvider,
            arkProvider: config.arkProvider,
            indexerProvider: config.indexerProvider,
            swapManager: config.enableSwapManager
                ? { enableAutoActions: true, autoStart: true }
                : undefined,
        });
    }

    /**
     * Check if the Lightning skill is available.
     *
     * @returns true if the skill is properly configured
     */
    async isAvailable(): Promise<boolean> {
        try {
            await this.swapProvider.getFees();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Create a Lightning invoice for receiving payment.
     *
     * This creates a Boltz reverse swap, which locks funds on Boltz's side
     * when someone pays the invoice. The funds are then claimed into your
     * Arkade wallet as VTXOs.
     *
     * @param params - Invoice parameters
     * @returns The created invoice with payment details
     */
    async createInvoice(
        params: CreateInvoiceParams
    ): Promise<LightningInvoice> {
        const response = await this.arkadeLightning.createLightningInvoice({
            amount: params.amount,
            description: params.description,
        });

        // Extract expiry from invoice
        const decoded = decodeInvoice(response.invoice);

        return {
            bolt11: response.invoice,
            paymentHash: response.paymentHash,
            amount: response.amount,
            description: params.description,
            expirySeconds: decoded.expiry,
            createdAt: new Date(),
            preimage: response.preimage,
        };
    }

    /**
     * Pay a Lightning invoice.
     *
     * This creates a Boltz submarine swap, which sends funds from your
     * Arkade wallet to a swap address. Boltz then pays the Lightning invoice
     * and you receive the preimage as proof of payment.
     *
     * @param params - Payment parameters
     * @returns Result containing the preimage and transaction details
     */
    async payInvoice(params: PayInvoiceParams): Promise<PaymentResult> {
        const response = await this.arkadeLightning.sendLightningPayment({
            invoice: params.bolt11,
        });

        return {
            preimage: response.preimage,
            amount: response.amount,
            txid: response.txid,
        };
    }

    /**
     * Get fee information for Lightning swaps.
     *
     * @returns Fee structure for submarine and reverse swaps
     */
    async getFees(): Promise<LightningFees> {
        return this.arkadeLightning.getFees();
    }

    /**
     * Get limits for Lightning swaps.
     *
     * @returns Min and max amounts for swaps
     */
    async getLimits(): Promise<LightningLimits> {
        return this.arkadeLightning.getLimits();
    }

    /**
     * Get pending swaps.
     *
     * @returns Array of pending swap information
     */
    async getPendingSwaps(): Promise<SwapInfo[]> {
        const [reverseSwaps, submarineSwaps] = await Promise.all([
            this.arkadeLightning.getPendingReverseSwaps(),
            this.arkadeLightning.getPendingSubmarineSwaps(),
        ]);

        return [
            ...reverseSwaps.map((swap) => this.mapReverseSwap(swap)),
            ...submarineSwaps.map((swap) => this.mapSubmarineSwap(swap)),
        ];
    }

    /**
     * Get swap history.
     *
     * @returns Array of all swaps (pending and completed)
     */
    async getSwapHistory(): Promise<SwapInfo[]> {
        const history = await this.arkadeLightning.getSwapHistory();
        return history.map((swap) =>
            swap.type === "reverse"
                ? this.mapReverseSwap(swap as PendingReverseSwap)
                : this.mapSubmarineSwap(swap as PendingSubmarineSwap)
        );
    }

    /**
     * Wait for an invoice to be paid and claim the funds.
     *
     * @param pendingSwap - The pending reverse swap from createInvoice
     * @returns Transaction ID of the claimed funds
     */
    async waitAndClaim(
        pendingSwap: PendingReverseSwap
    ): Promise<{ txid: string }> {
        return this.arkadeLightning.waitAndClaim(pendingSwap);
    }

    /**
     * Get the underlying ArkadeLightning instance for advanced operations.
     *
     * @returns The ArkadeLightning instance
     */
    getArkadeLightning(): ArkadeLightning {
        return this.arkadeLightning;
    }

    /**
     * Get the swap provider for direct Boltz API access.
     *
     * @returns The BoltzSwapProvider instance
     */
    getSwapProvider(): BoltzSwapProvider {
        return this.swapProvider;
    }

    /**
     * Start the background swap manager if enabled.
     */
    async startSwapManager(): Promise<void> {
        await this.arkadeLightning.startSwapManager();
    }

    /**
     * Stop the background swap manager.
     */
    async stopSwapManager(): Promise<void> {
        await this.arkadeLightning.stopSwapManager();
    }

    /**
     * Dispose of resources and stop the swap manager.
     */
    async dispose(): Promise<void> {
        await this.arkadeLightning.dispose();
    }

    private mapReverseSwap(swap: PendingReverseSwap): SwapInfo {
        return {
            id: swap.id,
            type: "reverse",
            status: swap.status as SwapStatus,
            amount: swap.response.onchainAmount,
            createdAt: new Date(swap.createdAt),
            invoice: swap.response.invoice,
        };
    }

    private mapSubmarineSwap(swap: PendingSubmarineSwap): SwapInfo {
        // Decode invoice to get amount
        let amount = 0;
        try {
            const decoded = decodeInvoice(swap.request.invoice);
            amount = decoded.amountSats;
        } catch {
            amount = swap.response.expectedAmount;
        }

        return {
            id: swap.id,
            type: "submarine",
            status: swap.status as SwapStatus,
            amount,
            createdAt: new Date(swap.createdAt),
            invoice: swap.request.invoice,
        };
    }
}

/**
 * Create an ArkaLightningSkill from a wallet and network.
 *
 * @param wallet - The Arkade wallet to use
 * @param network - The network name
 * @param options - Optional configuration
 * @returns A new ArkaLightningSkill instance
 */
export function createLightningSkill(
    wallet: Wallet,
    network: NetworkName,
    options?: Partial<Omit<ArkaLightningSkillConfig, "wallet" | "network">>
): ArkaLightningSkill {
    return new ArkaLightningSkill({
        wallet,
        network,
        ...options,
    });
}
