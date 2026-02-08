import { Bytes } from "@scure/btc-signer/utils.js";
import { ArkProvider, Output, SettlementEvent } from "../providers/ark";
import { DescriptorProvider, Identity, ReadonlyIdentity } from "../identity";
import { RelativeTimelock } from "../script/tapscript";
import { EncodedVtxoScript, TapLeafScript } from "../script/base";
import { RenewalConfig } from "./vtxo-manager";
import { IndexerProvider } from "../providers/indexer";
import { OnchainProvider } from "../providers/onchain";
import { ContractWatcherConfig } from "../contracts/contractWatcher";
import { ContractRepository, WalletRepository } from "../repositories";
import {
    Contract,
    ContractEventCallback,
    ContractManager,
    CreateContractParams,
} from "../contracts";
import { IContractManager } from "../contracts/contractManager";

/**
 * Base configuration options shared by all wallet types.
 *
 * Supports two configuration modes:
 * 1. URL-based: Provide arkServerUrl, indexerUrl (optional), and esploraUrl
 * 2. Provider-based: Provide arkProvider, indexerProvider, and onchainProvider instances
 *
 * At least one of the following must be provided:
 * - arkServerUrl OR arkProvider
 *
 * The wallet will use provided URLs to create default providers if custom provider
 * instances are not supplied. If optional parameters are not provided, the wallet
 * will fetch configuration from the Ark server.
 */
export interface BaseWalletConfig {
    arkServerUrl?: string;
    indexerUrl?: string;
    esploraUrl?: string;
    arkServerPublicKey?: string;
    boardingTimelock?: RelativeTimelock;
    exitTimelock?: RelativeTimelock;
    storage?: StorageConfig;
    arkProvider?: ArkProvider;
    indexerProvider?: IndexerProvider;
    onchainProvider?: OnchainProvider;
}

/**
 * Configuration options for readonly wallet initialization.
 *
 * Use this config when you only need to query wallet state (balance, addresses, transactions)
 * without the ability to send transactions. This is useful for:
 * - Watch-only wallets
 * - Monitoring addresses
 * - Safe sharing of wallet state without private key exposure
 *
 * @example
 * ```typescript
 * // URL-based configuration
 * const wallet = await ReadonlyWallet.create({
 *   identity: ReadonlySingleKey.fromPublicKey(pubkey),
 *   arkServerUrl: 'https://ark.example.com',
 *   esploraUrl: 'https://mempool.space/api'
 * });
 *
 * // Provider-based configuration (e.g., for Expo/React Native)
 * const wallet = await ReadonlyWallet.create({
 *   identity: ReadonlySingleKey.fromPublicKey(pubkey),
 *   arkProvider: new ExpoArkProvider('https://ark.example.com'),
 *   indexerProvider: new ExpoIndexerProvider('https://ark.example.com'),
 *   onchainProvider: new EsploraProvider('https://mempool.space/api')
 * });
 * ```
 */
export interface ReadonlyWalletConfig extends BaseWalletConfig {
    identity: ReadonlyIdentity;
    /**
     * Configuration for the ContractManager's watcher.
     * Controls reconnection behavior and failsafe polling.
     */
    watcherConfig?: Partial<Omit<ContractWatcherConfig, "indexerProvider">>;
}

/**
 * Configuration options for full wallet initialization.
 *
 * This config provides full wallet capabilities including sending transactions,
 * settling VTXOs, and all readonly operations.
 *
 * @example
 * ```typescript
 * // URL-based configuration
 * const wallet = await Wallet.create({
 *   identity: SingleKey.fromHex('...'),
 *   arkServerUrl: 'https://ark.example.com',
 *   esploraUrl: 'https://mempool.space/api'
 * });
 *
 * // Provider-based configuration (e.g., for Expo/React Native)
 * const wallet = await Wallet.create({
 *   identity: SingleKey.fromHex('...'),
 *   arkProvider: new ExpoArkProvider('https://ark.example.com'),
 *   indexerProvider: new ExpoIndexerProvider('https://ark.example.com'),
 *   onchainProvider: new EsploraProvider('https://mempool.space/api')
 * });
 *
 * // With renewal configuration
 * const wallet = await Wallet.create({
 *   identity: SingleKey.fromHex('...'),
 *   arkServerUrl: 'https://ark.example.com',
 *   renewalConfig: {
 *     enabled: true,
 *     thresholdMs: 86400000, // 24 hours
 *   }
 * });
 * ```
 */
export interface WalletConfig extends ReadonlyWalletConfig {
    identity: Identity;
    renewalConfig?: RenewalConfig;
}

export type StorageConfig = {
    walletRepository: WalletRepository;
    contractRepository: ContractRepository;
};

/**
 * Provider class constructor interface for dependency injection.
 * Ensures provider classes follow the consistent constructor pattern.
 */
export interface ProviderClass<T> {
    new (serverUrl: string): T;
}

export interface WalletBalance {
    boarding: {
        confirmed: number;
        unconfirmed: number;
        total: number;
    };
    settled: number;
    preconfirmed: number;
    available: number; // settled + preconfirmed
    recoverable: number; // subdust and (swept=true & unspent=true)
    total: number;
}

export interface SendBitcoinParams {
    address: string;
    amount: number;
    feeRate?: number;
    memo?: string;
    selectedVtxos?: VirtualCoin[];
}

export interface Recipient {
    address: string;
    amount: number;
}

export interface SettleParams {
    inputs: ExtendedCoin[];
    outputs: Output[];
}

export interface Status {
    confirmed: boolean;
    isLeaf?: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
}

export interface VirtualStatus {
    state: "preconfirmed" | "settled" | "swept" | "spent";
    commitmentTxIds?: string[];
    batchExpiry?: number;
}

export interface Outpoint {
    txid: string;
    vout: number;
}

export interface Coin extends Outpoint {
    value: number;
    status: Status;
}

export interface VirtualCoin extends Coin {
    virtualStatus: VirtualStatus;
    spentBy?: string;
    settledBy?: string;
    arkTxId?: string;
    createdAt: Date;
    isUnrolled: boolean;
    isSpent?: boolean;
}

export enum TxType {
    TxSent = "SENT",
    TxReceived = "RECEIVED",
}

export interface TxKey {
    boardingTxid: string;
    commitmentTxid: string;
    arkTxid: string;
}

export interface ArkTransaction {
    key: TxKey;
    type: TxType;
    amount: number;
    settled: boolean;
    createdAt: number;
}

// ExtendedCoin and ExtendedVirtualCoin contains the utxo/vtxo data along with the vtxo script locking it
export type TapLeaves = {
    forfeitTapLeafScript: TapLeafScript;
    intentTapLeafScript: TapLeafScript;
};

export type ExtendedCoin = TapLeaves &
    EncodedVtxoScript &
    Coin & { extraWitness?: Bytes[] };
export type ExtendedVirtualCoin = TapLeaves &
    EncodedVtxoScript &
    VirtualCoin & { extraWitness?: Bytes[] };

export function isSpendable(vtxo: VirtualCoin): boolean {
    return !vtxo.isSpent;
}

export function isRecoverable(vtxo: VirtualCoin): boolean {
    return vtxo.virtualStatus.state === "swept" && isSpendable(vtxo);
}

export function isExpired(vtxo: VirtualCoin): boolean {
    if (vtxo.virtualStatus.state === "swept") return true; // swept by server = expired

    const expiry = vtxo.virtualStatus.batchExpiry;
    if (!expiry) return false;
    // we use this as a workaround to avoid issue on regtest where expiry date is expressed in blockheight instead of timestamp
    // if expiry, as Date, is before 2025, then we admit it's too small to be a timestamp
    // TODO: API should return the expiry unit
    const expireAt = new Date(expiry);
    if (expireAt.getFullYear() < 2025) return false;

    return expiry <= Date.now();
}

export function isSubdust(vtxo: VirtualCoin, dust: bigint): boolean {
    return vtxo.value < dust;
}

export type GetVtxosFilter = {
    withRecoverable?: boolean; // include the swept but unspent
    withUnrolled?: boolean; // include the unrolled vtxos
};

/**
 * Single-key wallet interface (current behavior).
 * Uses one fixed keypair for all operations.
 * Maintains backwards compatibility with existing WalletBalance type.
 */
export interface ISingleKeyWallet extends IBaseWallet {
    identity: Identity;

    // Single address (implicit index 0)
    getAddress(): Promise<string>;
    getBoardingAddress(): Promise<string>;

    // Original balance format (non-breaking change)
    getBalance(): Promise<WalletBalance>;
}

/**
 * @deprecated Use ISingleKeyWallet instead. This alias is provided for backwards compatibility.
 */
export type IWallet = ISingleKeyWallet;

/**
 * Readonly wallet interface for Bitcoin transactions with Ark protocol support.
 *
 * This interface defines the contract that all wallet implementations must follow.
 * It provides methods for address management, balance checking, virtual UTXO
 * operations, and transaction management including sending, settling, and unrolling.
 */
export interface IReadonlyWallet {
    identity: ReadonlyIdentity;
    // returns the ark address
    getAddress(): Promise<string>;
    // returns the bitcoin address used to board the ark
    getBoardingAddress(): Promise<string>;
    getBalance(): Promise<WalletBalance>;
    getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]>;
    getBoardingUtxos(): Promise<ExtendedCoin[]>;
    getTransactionHistory(): Promise<ArkTransaction[]>;

    /**
     * Returns the contract manager associated with this wallet.
     * This is useful for querying contract state and watching for contract events.
     */
    getContractManager(): Promise<IContractManager>;
}

/**
 * Address information at a specific HD derivation index.
 */
export interface AddressInfo {
    /** Ark address for receiving offchain funds */
    ark: string;

    /** Boarding address for onchain-to-offchain transitions */
    boarding: string;

    /** Signing descriptor: tr([fp/86'/coinType'/0']xpub/0/{index}) */
    descriptor: string;

    /** The derivation index */
    index: number;
}

/**
 * Balance summary for a contract.
 *
 * Categorizes coins by their available spend paths:
 * - offchainSpendable: Can send instantly via Ark offchain transfer
 * - batchSpendable: Can spend via batch (swept VTXOs, confirmed boarding, subdust)
 * - onchainSpendable: Can only spend via onchain tx (expired, requires unilateral exit)
 * - locked: Not spendable yet (unconfirmed boarding, active timelocks)
 */
export interface ContractBalance {
    /** Contract type (e.g., "default", "vhtlc", "boarding") */
    type: string;

    /** Contract script (unique identifier) */
    script: string;

    /** Can spend instantly via offchain send (settled/preconfirmed VTXOs) */
    offchainSpendable: number;

    /** Can spend via batch only (swept VTXOs, confirmed boarding, subdust) */
    batchSpendable: number;

    /** Can only spend via onchain tx (expired batch, requires unilateral exit) */
    onchainSpendable: number;

    /** Not spendable yet (unconfirmed boarding, active timelocks) */
    locked: number;

    /** Total spendable (offchainSpendable + batchSpendable + onchainSpendable) */
    spendable: number;

    /** Total balance */
    total: number;

    /** Number of coins */
    coinCount: number;
}

/**
 * HD Wallet balance structure.
 *
 * Provides a unified view of balance across all contracts with spend path categories:
 * - offchainSpendable: Instant Ark transfers
 * - batchSpendable: Requires joining a batch round
 * - onchainSpendable: Requires onchain withdrawal (unilateral exit)
 * - locked: Awaiting confirmation or timelock
 */
export interface HDWalletBalance {
    /** Balance by contract */
    contracts: ContractBalance[];

    /** Can spend instantly via offchain send */
    offchainSpendable: number;

    /** Can spend via batch only */
    batchSpendable: number;

    /** Can only spend via onchain tx (unilateral exit) */
    onchainSpendable: number;

    /** Not spendable yet */
    locked: number;

    /** Total spendable (offchain + batch + onchain) */
    spendable: number;

    /** Grand total */
    total: number;
}

/**
 * Base wallet interface - shared by both single-key and HD wallets.
 * No identity field here - that's implementation-specific.
 */
export interface IBaseWallet {
    // Query operations
    getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]>;
    getBoardingUtxos(): Promise<ExtendedCoin[]>;
    getTransactionHistory(): Promise<ArkTransaction[]>;
    getContractManager(): Promise<IContractManager>;

    // Transaction operations (same signature for both wallet types)
    sendBitcoin(params: SendBitcoinParams): Promise<string>;
    settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string>;
}

/**
 * HD wallet interface - multiple addresses, descriptor-based signing.
 * Identity must implement DescriptorProvider for HD key derivation.
 */
export interface IHDWallet extends IBaseWallet {
    identity: Identity & DescriptorProvider;

    // Multi-address operations
    getAddresses(index: number): Promise<AddressInfo>;

    // New balance format (contract-based, unified model)
    getBalance(): Promise<HDWalletBalance>;
}
