import { Network, NetworkName } from "../networks";
import { SettlementEvent } from "../providers/ark";
import { Bytes } from "@scure/btc-signer/utils.js";
import { DefaultVtxo } from "../script/default";
import { DescriptorProvider, Identity } from "../identity";
import { Wallet } from "./wallet";
import {
    AddressInfo,
    ArkTransaction,
    ContractBalance,
    ExtendedCoin,
    ExtendedVirtualCoin,
    GetVtxosFilter,
    HDWalletBalance,
    IHDWallet,
    SendBitcoinParams,
    SettleParams,
    WalletConfig,
} from ".";
import { IContractManager } from "../contracts/contractManager";
import { RelativeTimelock } from "../script/tapscript";

/**
 * HD wallet configuration.
 * Identity must implement both Identity and DescriptorProvider interfaces.
 */
export interface HDWalletConfig extends Omit<WalletConfig, "identity"> {
    identity: Identity & DescriptorProvider;
}

/**
 * HD Wallet implementation with multi-address support.
 *
 * This wallet uses descriptor-based signing and can derive multiple addresses
 * from a single seed. It implements the IHDWallet interface and provides:
 * - Multi-address derivation via `getAddresses(index)`
 * - Contract-based balance model via `getBalance()`
 * - Full transaction capabilities inherited from Wallet
 *
 * @example
 * ```typescript
 * // Create an HD wallet with SeedIdentity
 * const identity = SeedIdentity.fromMnemonic(mnemonic, { isMainnet: false });
 * const wallet = await HDWallet.create({
 *   identity,
 *   arkServerUrl: 'https://ark.example.com',
 * });
 *
 * // Get addresses at different indexes
 * const addr0 = await wallet.getAddresses(0);
 * const addr1 = await wallet.getAddresses(1);
 *
 * // Get balance across all contracts
 * const balance = await wallet.getBalance();
 * console.log(`Total: ${balance.total}, Spendable: ${balance.spendable}`);
 * ```
 */
export class HDWallet implements IHDWallet {
    readonly identity: Identity & DescriptorProvider;

    private readonly wallet: Wallet;
    private readonly network: Network;
    private readonly networkName: NetworkName;
    private readonly arkServerPublicKey: Bytes;
    private readonly exitTimelock: RelativeTimelock;
    private readonly boardingTimelock: RelativeTimelock;

    private constructor(
        identity: Identity & DescriptorProvider,
        wallet: Wallet,
        network: Network,
        networkName: NetworkName,
        arkServerPublicKey: Bytes,
        exitTimelock: RelativeTimelock,
        boardingTimelock: RelativeTimelock
    ) {
        this.identity = identity;
        this.wallet = wallet;
        this.network = network;
        this.networkName = networkName;
        this.arkServerPublicKey = arkServerPublicKey;
        this.exitTimelock = exitTimelock;
        this.boardingTimelock = boardingTimelock;
    }

    /**
     * Create a new HDWallet instance.
     *
     * @param config - HD wallet configuration with descriptor-based identity
     * @returns Promise<HDWallet>
     * @throws Error if identity doesn't implement DescriptorProvider
     *
     * @example
     * ```typescript
     * const identity = SeedIdentity.fromMnemonic(mnemonic, { isMainnet: false });
     * const wallet = await HDWallet.create({
     *   identity,
     *   arkServerUrl: 'https://ark.example.com',
     * });
     * ```
     */
    static async create(config: HDWalletConfig): Promise<HDWallet> {
        // Validate identity implements DescriptorProvider
        if (
            typeof config.identity.getSigningDescriptor !== "function" ||
            typeof config.identity.isOurs !== "function"
        ) {
            throw new Error(
                "Identity must implement DescriptorProvider interface (getSigningDescriptor, isOurs)"
            );
        }

        // Create underlying Wallet
        const wallet = await Wallet.create(config as WalletConfig);

        // Extract timelocks from the wallet's tapscripts
        const exitTimelock =
            wallet["offchainTapscript"].options.csvTimelock ??
            DefaultVtxo.Script.DEFAULT_TIMELOCK;
        const boardingTimelock =
            wallet["boardingTapscript"].options.csvTimelock ??
            DefaultVtxo.Script.DEFAULT_TIMELOCK;

        return new HDWallet(
            config.identity,
            wallet,
            wallet["network"],
            wallet["networkName"],
            wallet["arkServerPublicKey"],
            exitTimelock,
            boardingTimelock
        );
    }

    // ========================================================================
    // IHDWallet Interface Methods
    // ========================================================================

    /**
     * Get addresses at a specific derivation index.
     *
     * @param index - The derivation index (0, 1, 2, ...)
     * @returns AddressInfo with ark address, boarding address, descriptor, and index
     *
     * @example
     * ```typescript
     * const addrInfo = await wallet.getAddresses(5);
     * console.log(`Ark address: ${addrInfo.ark}`);
     * console.log(`Boarding address: ${addrInfo.boarding}`);
     * console.log(`Descriptor: ${addrInfo.descriptor}`);
     * ```
     */
    async getAddresses(index: number): Promise<AddressInfo> {
        if (index < 0) {
            throw new Error("Index must be non-negative");
        }

        // Get the signing descriptor at this index
        const descriptor = this.identity.deriveSigningDescriptor(index);

        // Derive the public key at this index
        // We need to get the x-only public key for the tapscripts
        const pubKey = await this.getXOnlyPubKeyAtIndex(index);

        // Create tapscripts at this index
        const offchainTapscript = new DefaultVtxo.Script({
            pubKey,
            serverPubKey: this.arkServerPublicKey,
            csvTimelock: this.exitTimelock,
        });

        const boardingTapscript = new DefaultVtxo.Script({
            pubKey,
            serverPubKey: this.arkServerPublicKey,
            csvTimelock: this.boardingTimelock,
        });

        // Get ark address
        const arkAddress = offchainTapscript.address(
            this.network.hrp,
            this.arkServerPublicKey
        );

        // Get boarding address
        const boardingAddress = boardingTapscript.onchainAddress(this.network);

        return {
            ark: arkAddress.encode(),
            boarding: boardingAddress,
            descriptor,
            index,
        };
    }

    /**
     * Get the HD wallet balance across all contracts.
     *
     * Returns a unified balance model where each contract (including default
     * and boarding) is represented with spendable/unspendable/recoverable breakdown.
     *
     * @returns HDWalletBalance with per-contract breakdowns and aggregates
     *
     * @example
     * ```typescript
     * const balance = await wallet.getBalance();
     * console.log(`Total: ${balance.total}`);
     * console.log(`Spendable: ${balance.spendable}`);
     *
     * for (const contract of balance.contracts) {
     *   console.log(`${contract.type}: ${contract.spendable} spendable`);
     * }
     * ```
     */
    async getBalance(): Promise<HDWalletBalance> {
        // For initial implementation, return empty balances
        // Full implementation will use ContractManager to aggregate
        const contracts: ContractBalance[] = [];
        let spendable = 0;
        let unspendable = 0;
        let recoverable = 0;
        let total = 0;

        try {
            const manager = await this.getContractManager();
            const contractsWithVtxos = await manager.getContractsWithVtxos();

            for (const { contract, vtxos } of contractsWithVtxos) {
                let contractSpendable = 0;
                let contractUnspendable = 0;
                let contractRecoverable = 0;

                for (const vtxo of vtxos) {
                    const value = vtxo.value;
                    const state = vtxo.virtualStatus.state;

                    if (state === "swept") {
                        // Swept but unspent = recoverable
                        if (!vtxo.isSpent) {
                            contractRecoverable += value;
                        }
                    } else if (
                        state === "settled" ||
                        state === "preconfirmed"
                    ) {
                        contractSpendable += value;
                    } else {
                        contractUnspendable += value;
                    }
                }

                const contractTotal =
                    contractSpendable +
                    contractUnspendable +
                    contractRecoverable;

                if (contractTotal > 0 || contract.state === "active") {
                    contracts.push({
                        type: contract.type,
                        script: contract.script,
                        spendable: contractSpendable,
                        unspendable: contractUnspendable,
                        recoverable: contractRecoverable,
                        total: contractTotal,
                        coinCount: vtxos.length,
                    });
                }

                spendable += contractSpendable;
                unspendable += contractUnspendable;
                recoverable += contractRecoverable;
            }

            total = spendable + unspendable + recoverable;

            // Add boarding UTXOs as a "boarding" contract type
            const boardingUtxos = await this.getBoardingUtxos();
            if (boardingUtxos.length > 0) {
                let boardingConfirmed = 0;
                let boardingUnconfirmed = 0;

                for (const utxo of boardingUtxos) {
                    if (utxo.status.confirmed) {
                        // Confirmed boarding = recoverable (needs batch to become VTXO)
                        boardingConfirmed += utxo.value;
                    } else {
                        // Unconfirmed = unspendable
                        boardingUnconfirmed += utxo.value;
                    }
                }

                const boardingTotal = boardingConfirmed + boardingUnconfirmed;

                contracts.push({
                    type: "boarding",
                    script: "boarding", // Special identifier for boarding
                    spendable: 0, // Boarding UTXOs are never directly spendable
                    unspendable: boardingUnconfirmed,
                    recoverable: boardingConfirmed,
                    total: boardingTotal,
                    coinCount: boardingUtxos.length,
                });

                unspendable += boardingUnconfirmed;
                recoverable += boardingConfirmed;
                total += boardingTotal;
            }
        } catch (error) {
            // If ContractManager fails, fall back to legacy balance calculation
            console.warn(
                "Failed to get balance from ContractManager, using legacy method",
                error
            );

            const legacyBalance = await this.wallet.getBalance();
            return {
                contracts: [
                    {
                        type: "default",
                        script: this.wallet["defaultContractScript"],
                        spendable:
                            legacyBalance.settled + legacyBalance.preconfirmed,
                        unspendable: 0,
                        recoverable: legacyBalance.recoverable,
                        total:
                            legacyBalance.settled +
                            legacyBalance.preconfirmed +
                            legacyBalance.recoverable,
                        coinCount: 0,
                    },
                    {
                        type: "boarding",
                        script: "boarding",
                        spendable: 0,
                        unspendable: legacyBalance.boarding.unconfirmed,
                        recoverable: legacyBalance.boarding.confirmed,
                        total: legacyBalance.boarding.total,
                        coinCount: 0,
                    },
                ],
                spendable:
                    legacyBalance.settled + legacyBalance.preconfirmed,
                unspendable: legacyBalance.boarding.unconfirmed,
                recoverable:
                    legacyBalance.recoverable +
                    legacyBalance.boarding.confirmed,
                total: legacyBalance.total,
            };
        }

        return {
            contracts,
            spendable,
            unspendable,
            recoverable,
            total,
        };
    }

    // ========================================================================
    // IBaseWallet Interface Methods (delegated to underlying Wallet)
    // ========================================================================

    /**
     * Get VTXOs with optional filter.
     * Delegates to the underlying Wallet implementation.
     */
    async getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]> {
        return this.wallet.getVtxos(filter);
    }

    /**
     * Get boarding UTXOs.
     * Delegates to the underlying Wallet implementation.
     */
    async getBoardingUtxos(): Promise<ExtendedCoin[]> {
        return this.wallet.getBoardingUtxos();
    }

    /**
     * Get transaction history.
     * Delegates to the underlying Wallet implementation.
     */
    async getTransactionHistory(): Promise<ArkTransaction[]> {
        return this.wallet.getTransactionHistory();
    }

    /**
     * Get the ContractManager instance.
     * Delegates to the underlying Wallet implementation.
     */
    async getContractManager(): Promise<IContractManager> {
        return this.wallet.getContractManager();
    }

    /**
     * Send bitcoin to an Ark address.
     * Delegates to the underlying Wallet implementation.
     */
    async sendBitcoin(params: SendBitcoinParams): Promise<string> {
        return this.wallet.sendBitcoin(params);
    }

    /**
     * Settle VTXOs and boarding UTXOs into a new batch.
     * Delegates to the underlying Wallet implementation.
     */
    async settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string> {
        return this.wallet.settle(params, eventCallback);
    }

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /**
     * Get the x-only public key at a specific derivation index.
     * @internal
     */
    private async getXOnlyPubKeyAtIndex(index: number): Promise<Uint8Array> {
        // Check if identity has xOnlyPublicKeyAtIndex method (like ReadonlySeedIdentity)
        if ("xOnlyPublicKeyAtIndex" in this.identity) {
            return (this.identity as any).xOnlyPublicKeyAtIndex(index);
        }

        // Check if identity has toReadonly method (like SeedIdentity)
        // Use the readonly version to derive public keys at arbitrary indexes
        if ("toReadonly" in this.identity) {
            const readonly = await (this.identity as any).toReadonly();
            if (
                readonly &&
                typeof readonly.xOnlyPublicKeyAtIndex === "function"
            ) {
                return readonly.xOnlyPublicKeyAtIndex(index);
            }
        }

        // For index 0, we can use the base public key
        if (index === 0) {
            return this.identity.xOnlyPublicKey();
        }

        // If identity doesn't support deriving at non-zero index, throw an error
        throw new Error(
            `Identity does not support deriving public key at index ${index}. ` +
                `Use SeedIdentity or implement xOnlyPublicKeyAtIndex method.`
        );
    }

    /**
     * Get the underlying Wallet instance.
     * Useful for accessing wallet-specific methods not in IHDWallet.
     * @internal
     */
    getUnderlyingWallet(): Wallet {
        return this.wallet;
    }
}
