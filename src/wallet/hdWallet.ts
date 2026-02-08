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
     * and boarding) is represented with spend path categories.
     *
     * Spend path categories:
     * - offchainSpendable: Can send instantly via Ark offchain transfer
     * - batchSpendable: Can spend via batch (swept VTXOs, confirmed boarding, subdust)
     * - onchainSpendable: Can only spend via onchain tx (expired, requires unilateral exit)
     * - locked: Not spendable yet (unconfirmed boarding, active timelocks)
     *
     * @returns HDWalletBalance with per-contract breakdowns and aggregates
     *
     * @example
     * ```typescript
     * const balance = await wallet.getBalance();
     * console.log(`Total: ${balance.total}`);
     * console.log(`Instant send: ${balance.offchainSpendable}`);
     * console.log(`Via batch: ${balance.batchSpendable}`);
     * console.log(`Onchain only: ${balance.onchainSpendable}`);
     *
     * for (const contract of balance.contracts) {
     *   console.log(`${contract.type}: ${contract.spendable} spendable`);
     * }
     * ```
     */
    async getBalance(): Promise<HDWalletBalance> {
        const contracts: ContractBalance[] = [];
        let offchainSpendable = 0;
        let batchSpendable = 0;
        let onchainSpendable = 0;
        let locked = 0;

        try {
            const manager = await this.getContractManager();
            const contractsWithVtxos = await manager.getContractsWithVtxos();

            for (const { contract, vtxos } of contractsWithVtxos) {
                let contractOffchain = 0;
                let contractBatch = 0;
                let contractOnchain = 0;
                let contractLocked = 0;

                for (const vtxo of vtxos) {
                    const value = vtxo.value;
                    const state = vtxo.virtualStatus.state;

                    if (vtxo.isSpent) {
                        // Already spent, don't count
                        continue;
                    }

                    if (state === "swept") {
                        // Swept = batch expired, can only spend onchain
                        contractOnchain += value;
                    } else if (vtxo.isUnrolled) {
                        // Unrolled VTXO - check if batch expired
                        const expiry = vtxo.virtualStatus.batchExpiry;
                        const isExpiredBatch =
                            expiry &&
                            new Date(expiry).getFullYear() >= 2025 &&
                            expiry <= Date.now();

                        if (isExpiredBatch) {
                            // Expired batch = onchain only
                            contractOnchain += value;
                        } else {
                            // Not expired = can still use batch path
                            contractBatch += value;
                        }
                    } else if (
                        state === "settled" ||
                        state === "preconfirmed"
                    ) {
                        // Check if batch expired
                        const expiry = vtxo.virtualStatus.batchExpiry;
                        const isExpiredBatch =
                            expiry &&
                            new Date(expiry).getFullYear() >= 2025 &&
                            expiry <= Date.now();

                        if (isExpiredBatch) {
                            // Expired batch = onchain only (unilateral exit)
                            contractOnchain += value;
                        } else {
                            // Normal spendable offchain
                            contractOffchain += value;
                        }
                    } else {
                        // Other states (e.g., pending) = locked
                        contractLocked += value;
                    }
                }

                const contractSpendable =
                    contractOffchain + contractBatch + contractOnchain;
                const contractTotal = contractSpendable + contractLocked;

                if (contractTotal > 0 || contract.state === "active") {
                    contracts.push({
                        type: contract.type,
                        script: contract.script,
                        offchainSpendable: contractOffchain,
                        batchSpendable: contractBatch,
                        onchainSpendable: contractOnchain,
                        locked: contractLocked,
                        spendable: contractSpendable,
                        total: contractTotal,
                        coinCount: vtxos.length,
                    });
                }

                offchainSpendable += contractOffchain;
                batchSpendable += contractBatch;
                onchainSpendable += contractOnchain;
                locked += contractLocked;
            }

            // Add boarding UTXOs as a "boarding" contract type
            const boardingUtxos = await this.getBoardingUtxos();
            if (boardingUtxos.length > 0) {
                let boardingBatch = 0; // confirmed boarding = batch spendable
                let boardingOnchain = 0; // expired boarding = onchain only
                let boardingLocked = 0; // unconfirmed = locked

                for (const utxo of boardingUtxos) {
                    if (!utxo.status.confirmed) {
                        // Unconfirmed = locked
                        boardingLocked += utxo.value;
                    } else {
                        // Confirmed boarding - check if timelock expired
                        // TODO: Check actual boarding timelock expiry
                        // For now, assume confirmed boarding can go via batch
                        boardingBatch += utxo.value;
                    }
                }

                const boardingSpendable = boardingBatch + boardingOnchain;
                const boardingTotal = boardingSpendable + boardingLocked;

                contracts.push({
                    type: "boarding",
                    script: "boarding",
                    offchainSpendable: 0, // Boarding never directly offchain spendable
                    batchSpendable: boardingBatch,
                    onchainSpendable: boardingOnchain,
                    locked: boardingLocked,
                    spendable: boardingSpendable,
                    total: boardingTotal,
                    coinCount: boardingUtxos.length,
                });

                batchSpendable += boardingBatch;
                onchainSpendable += boardingOnchain;
                locked += boardingLocked;
            }
        } catch (error) {
            // If ContractManager fails, fall back to legacy balance calculation
            console.warn(
                "Failed to get balance from ContractManager, using legacy method",
                error
            );

            const legacyBalance = await this.wallet.getBalance();
            const legacyOffchain =
                legacyBalance.settled + legacyBalance.preconfirmed;
            const legacyBatch = legacyBalance.boarding.confirmed;
            const legacyOnchain = legacyBalance.recoverable; // swept = onchain only
            const legacyLocked = legacyBalance.boarding.unconfirmed;

            return {
                contracts: [
                    {
                        type: "default",
                        script: this.wallet["defaultContractScript"],
                        offchainSpendable: legacyOffchain,
                        batchSpendable: 0,
                        onchainSpendable: legacyOnchain,
                        locked: 0,
                        spendable: legacyOffchain + legacyOnchain,
                        total: legacyOffchain + legacyOnchain,
                        coinCount: 0,
                    },
                    {
                        type: "boarding",
                        script: "boarding",
                        offchainSpendable: 0,
                        batchSpendable: legacyBatch,
                        onchainSpendable: 0,
                        locked: legacyLocked,
                        spendable: legacyBatch,
                        total: legacyBatch + legacyLocked,
                        coinCount: 0,
                    },
                ],
                offchainSpendable: legacyOffchain,
                batchSpendable: legacyBatch,
                onchainSpendable: legacyOnchain,
                locked: legacyLocked,
                spendable: legacyOffchain + legacyBatch + legacyOnchain,
                total: legacyBalance.total,
            };
        }

        const spendable = offchainSpendable + batchSpendable + onchainSpendable;
        const total = spendable + locked;

        return {
            contracts,
            offchainSpendable,
            batchSpendable,
            onchainSpendable,
            locked,
            spendable,
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
