import { Bytes } from "@scure/btc-signer/utils.js";
import { ArkProvider, Output, SettlementEvent } from "../providers/ark";
import { Identity } from "../identity";
import { RelativeTimelock } from "../script/tapscript";
import { EncodedVtxoScript, TapLeafScript } from "../script/base";
import { StorageAdapter } from "../storage";
import { IndexerProvider } from "../providers/indexer";
import { OnchainProvider } from "../providers/onchain";

/**
 * Configuration options for wallet initialization.
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
 * ```
 */
export interface WalletConfig {
    identity: Identity;
    arkServerUrl?: string;
    indexerUrl?: string;
    esploraUrl?: string;
    arkServerPublicKey?: string;
    boardingTimelock?: RelativeTimelock;
    exitTimelock?: RelativeTimelock;
    storage?: StorageAdapter;
    arkProvider?: ArkProvider;
    indexerProvider?: IndexerProvider;
    onchainProvider?: OnchainProvider;
}

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

export function isSubdust(vtxo: VirtualCoin, dust: bigint): boolean {
    return vtxo.value < dust;
}

export type GetVtxosFilter = {
    withRecoverable?: boolean; // include the swept but unspent
    withUnrolled?: boolean; // include the unrolled vtxos
};

/**
 * Core wallet interface for Bitcoin transactions with Ark protocol support.
 *
 * This interface defines the contract that all wallet implementations must follow.
 * It provides methods for address management, balance checking, virtual UTXO
 * operations, and transaction management including sending, settling, and unrolling.
 */
export interface IWallet {
    identity: Identity;
    // returns the ark address
    getAddress(): Promise<string>;
    // returns the bitcoin address used to board the ark
    getBoardingAddress(): Promise<string>;
    getBalance(): Promise<WalletBalance>;
    getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]>;
    getBoardingUtxos(): Promise<ExtendedCoin[]>;
    getTransactionHistory(): Promise<ArkTransaction[]>;

    // Transaction operations
    sendBitcoin(params: SendBitcoinParams): Promise<string>;
    settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string>;
}
