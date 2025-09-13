import {
    WalletConfig,
    IWallet,
    WalletBalance,
    SendBitcoinParams,
    SettleParams,
    ArkTransaction,
    ExtendedCoin,
    ExtendedVirtualCoin,
    GetVtxosFilter,
} from ".";
import { Identity } from "../identity";
import { SettlementEvent } from "../providers/ark";
import {
    createWalletWithAutoDetection,
    IWalletImplementation,
} from "./factory";
import { WalletRepository } from "../repositories/walletRepository";
import { ContractRepository } from "../repositories/contractRepository";

/**
 * Main wallet implementation that automatically detects execution context and
 * uses the appropriate implementation (direct or service worker proxy).
 *
 * This class provides a single, consistent API regardless of whether the code
 * runs in a regular web context, Node.js, or requires service worker communication.
 */
export class Wallet implements IWallet {
    static MIN_FEE_RATE = 1; // sats/vbyte

    private implementation: IWalletImplementation;
    public readonly identity: Identity;
    public readonly walletRepository: WalletRepository;
    public readonly contractRepository: ContractRepository;

    private constructor(implementation: IWalletImplementation) {
        this.implementation = implementation;
        this.identity = implementation.identity;
        this.walletRepository = implementation.walletRepository;
        this.contractRepository = implementation.contractRepository;
    }

    /**
     * Creates a new wallet instance with automatic context detection.
     *
     * This method:
     * 1. Detects the execution context (SERVICE_WORKER, WORKER_CLIENT, or DIRECT)
     * 2. Automatically initializes service worker if needed (PWA contexts)
     * 3. Creates the appropriate implementation (Direct or Proxy)
     * 4. Returns a unified Wallet instance
     *
     * @param config - Wallet configuration
     * @returns Promise that resolves to a Wallet instance
     */
    static async create(config: WalletConfig): Promise<Wallet> {
        const implementation = await createWalletWithAutoDetection(config);
        return new Wallet(implementation);
    }

    // Delegate all IWallet methods to the implementation

    async getAddress(): Promise<string> {
        return this.implementation.getAddress();
    }

    async getBoardingAddress(): Promise<string> {
        return this.implementation.getBoardingAddress();
    }

    async getBalance(): Promise<WalletBalance> {
        return this.implementation.getBalance();
    }

    async getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]> {
        return this.implementation.getVtxos(filter);
    }

    async getBoardingUtxos(): Promise<ExtendedCoin[]> {
        return this.implementation.getBoardingUtxos();
    }

    async getTransactionHistory(): Promise<ArkTransaction[]> {
        return this.implementation.getTransactionHistory();
    }

    async sendBitcoin(params: SendBitcoinParams): Promise<string> {
        return this.implementation.sendBitcoin(params);
    }

    async settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string> {
        return this.implementation.settle(params, eventCallback);
    }

    /**
     * Clears wallet data. Available on some implementations.
     */
    async clear(): Promise<void> {
        if (
            "clear" in this.implementation &&
            typeof this.implementation.clear === "function"
        ) {
            await this.implementation.clear();
        }
    }

    /**
     * Gets the implementation type for debugging/testing purposes.
     */
    getImplementationType(): string {
        return this.implementation.constructor.name;
    }

    /**
     * Gets the underlying implementation (mainly for testing).
     *
     * @internal
     */
    _getImplementation(): IWalletImplementation {
        return this.implementation;
    }

    // Expose DirectWallet properties for compatibility with existing code
    get onchainProvider() {
        return (this.implementation as any).onchainProvider;
    }

    get arkProvider() {
        return (this.implementation as any).arkProvider;
    }

    get offchainTapscript() {
        return (this.implementation as any).offchainTapscript;
    }

    get boardingTapscript() {
        return (this.implementation as any).boardingTapscript;
    }

    get dustAmount() {
        return (this.implementation as any).dustAmount;
    }

    // Add method that was expected by the old service worker
    async getBoardingTxs() {
        // This was likely a typo in the old code, redirect to getBoardingUtxos
        return this.getBoardingUtxos();
    }
}

// Re-export useful types and functions for backwards compatibility
export type { IncomingFunds } from "./directWallet";
export { waitForIncomingFunds } from "./directWallet";
