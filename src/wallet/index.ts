import { Bytes } from "@scure/btc-signer/utils.js";
import { ArkProvider, Output, SettlementEvent } from "../providers/ark";
import { Identity, ReadonlyIdentity } from "../identity";
import { RelativeTimelock } from "../script/tapscript";
import { EncodedVtxoScript, TapLeafScript } from "../script/base";
import { RenewalConfig, SettlementConfig } from "./vtxo-manager";
import { IndexerProvider } from "../providers/indexer";
import { OnchainProvider } from "../providers/onchain";
import { ContractWatcherConfig } from "../contracts/contractWatcher";
import { ContractRepository, WalletRepository } from "../repositories";
import { IContractManager } from "../contracts/contractManager";
import { IDelegatorManager } from "./delegator";
import { DelegatorProvider } from "../providers/delegator";

/**
 * Base configuration options shared by all wallet types.
 *
 * Supports URL-based and provider-based configuration.
 *
 * URL-based configuration starts from `arkServerUrl` and can optionally override
 * derived service URLs such as `indexerUrl` and `esploraUrl`.
 *
 * Provider-based configuration supplies concrete provider instances directly,
 * including the ArkProvider, IndexerProvider, OnchainProvider, and DelegatorProvider.
 *
 * At least one of the following must be provided:
 * - arkServerUrl OR arkProvider
 *
 * The wallet will use provided URLs to create default providers if custom provider
 * instances are not supplied. If optional parameters are not provided, the wallet
 * will fetch configuration from the Arkade server.
 *
 * @remarks
 * URL-based and provider-based configuration can be mixed, but provider instances
 * always take precedence over URLs for the corresponding service.
 *
 * @see WalletConfig
 * @see ReadonlyWalletConfig
 * @see StorageConfig
 */
export interface BaseWalletConfig {
    /** Base URL of the Arkade server. */
    arkServerUrl?: string;
    /** Optional override for the indexer URL. */
    indexerUrl?: string;
    /** Optional override for the Esplora API URL. */
    esploraUrl?: string;

    /** Optional Arkade server public key used to construct and validate Arkade addresses. */
    arkServerPublicKey?: string;
    /** Relative timelock applied to boarding scripts. */
    boardingTimelock?: RelativeTimelock;
    /** Relative timelock applied to unilateral exit paths. */
    exitTimelock?: RelativeTimelock;
    /**
     * Repository-backed storage configuration overrides.
     * Defaults to IndexedDB if unset.
     */
    storage?: StorageConfig;
    /** Optional Arkade provider instance. */
    arkProvider?: ArkProvider;
    /** Optional indexer provider instance. */
    indexerProvider?: IndexerProvider;
    /** Optional onchain provider instance. */
    onchainProvider?: OnchainProvider;
    /** Optional delegation service instance. */
    delegatorProvider?: DelegatorProvider;
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
 * @see BaseWalletConfig
 * @see IReadonlyWallet
 *
 * @example
 * ```typescript
 * // URL-based configuration
 * const wallet = await ReadonlyWallet.create({
 *   identity: ReadonlySingleKey.fromPublicKey(pubkey),
 *   arkServerUrl: 'https://arkade.computer',
 *   esploraUrl: 'https://mempool.space/api'
 * });
 *
 * // Provider-based configuration (e.g., for Expo/React Native)
 * const wallet = await ReadonlyWallet.create({
 *   identity: ReadonlySingleKey.fromPublicKey(pubkey),
 *   arkProvider: new ExpoArkProvider('https://arkade.computer'),
 *   indexerProvider: new ExpoIndexerProvider('https://arkade.computer'),
 *   onchainProvider: new EsploraProvider('https://mempool.space/api')
 * });
 * ```
 */
export interface ReadonlyWalletConfig extends BaseWalletConfig {
    /** Readonly identity used to derive wallet addresses. */
    identity: ReadonlyIdentity;
    /**
     * Configuration for the ContractManager's watcher.
     * Controls reconnection behavior and failsafe polling.
     *
     * @see ContractWatcherConfig
     */
    watcherConfig?: Partial<Omit<ContractWatcherConfig, "indexerProvider">>;
}

/**
 * Configuration options for full wallet initialization.
 *
 * This config provides full wallet capabilities including sending transactions,
 * settling virtual outputs, and all readonly operations.
 *
 * @see ReadonlyWalletConfig
 * @see IWallet
 *
 * @example
 * ```typescript
 * // URL-based configuration
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkServerUrl: 'https://arkade.computer',
 *   esploraUrl: 'https://mempool.space/api'
 * });
 *
 * // Provider-based configuration (e.g., for Expo/React Native)
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkProvider: new ExpoArkProvider('https://arkade.computer'),
 *   indexerProvider: new ExpoIndexerProvider('https://arkade.computer'),
 *   onchainProvider: new EsploraProvider('https://mempool.space/api')
 * });
 *
 * // With settlement configuration
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkServerUrl: 'https://arkade.computer',
 *   settlementConfig: {
 *     vtxoThreshold: 60 * 60 * 24, // 24 hours in seconds
 *     boardingUtxoSweep: true,
 *   },
 * });
 * ```
 */
export interface WalletConfig extends ReadonlyWalletConfig {
    /** Signing identity used to authorize transactions. */
    identity: Identity;

    /**
     * Legacy renewal configuration.
     *
     * @remarks
     * This field is still accepted for backwards compatibility, but `settlementConfig`
     * is the source of truth for new code.
     *
     * @deprecated Use `settlementConfig` instead.
     */
    renewalConfig?: RenewalConfig;
    /**
     * Configuration for automatic settlement and renewal.
     * `false` = explicitly disabled, `undefined` or `{}` = enabled with defaults.
     *
     * @defaultValue `undefined` (enabled with defaults)
     * @see SettlementConfig
     */
    settlementConfig?: SettlementConfig | false;
}

/**
 * Repository implementations used to store wallet and contract state.
 *
 * @see BaseWalletConfig
 * @see WalletRepository
 * @see ContractRepository
 */
export type StorageConfig = {
    /** Wallet-state repository implementation. */
    walletRepository: WalletRepository;
    /** Contract-state repository implementation. */
    contractRepository: ContractRepository;
};

/**
 * Provider class constructor interface for dependency injection.
 * Ensures provider classes follow the consistent constructor pattern.
 */
export interface ProviderClass<T> {
    /**
     * Create a provider instance for the given server URL.
     *
     * @param serverUrl - Base server URL used by the provider
     */
    new (serverUrl: string): T;
}

/**
 * Balance summary returned by `IWallet.getBalance`.
 *
 * @see IWallet.getBalance
 *
 * @example
 * ```typescript
 * const balance = await wallet.getBalance()
 * console.log(balance.available, balance.boarding.total)
 * ```
 */
export interface WalletBalance {
    /** Boarding funds */
    boarding: {
        /** Confirmed funds ready to swap for virtual outputs. */
        confirmed: number;
        /** Pending funds awaiting confirmation on mainnet */
        unconfirmed: number;
        /** Combined boarding balance (`confirmed` + `unconfirmed`) */
        total: number;
    };
    /** Spendable settled (finalized) balance. */
    settled: number;
    /** Spendable preconfirmed (unfinalized) balance. */
    preconfirmed: number;
    /** Spendable offchain balance (`settled + preconfirmed`). */
    available: number;
    /** Recoverable balance from subdust or expired (swept) virtual outputs. */
    recoverable: number;

    /** Total balance across offchain, recoverable, and boarding funds. */
    total: number;

    /** Asset balance entries (`assetId` & `amount`) */
    assets: Asset[];
}

/**
 * Parameters accepted by `OnchainWallet.send`.
 *
 * @remarks
 * This shape was also used by the deprecated `Wallet.sendBitcoin` method.
 * New wallet sends should use `Recipient` via `IWallet.send`.
 *
 * @see Recipient
 */
export interface SendBitcoinParams {
    /** Destination address. */
    address: string;

    /** Amount to send in satoshis. */
    amount: number;

    /** Optional fee rate override in sats/vB. */
    feeRate?: number;

    /**
     * Optional memo associated with the transaction.
     * @deprecated Does not appear to have ever been used.
     */
    memo?: string;

    /** Optional explicit virtual output selection used by `Wallet.sendBitcoin`. */
    selectedVtxos?: ExtendedVirtualCoin[];
}

/**
 * Asset amount paired with an asset id.
 *
 * @see AssetDetails
 */
export interface Asset {
    /** Asset identifier. */
    assetId: string;

    /** Asset amount in base units. */
    amount: number;
}

/**
 * Recipient accepted by `IWallet.send`.
 *
 * @see IWallet.send
 */
export interface Recipient {
    address: string;

    /**
     * BTC amount in satoshis.
     *
     * @defaultValue Dust amount (`330`).
     */
    amount?: number;

    /** Assets to send to the same recipient (`assetId` & `amount`) */
    assets?: Asset[];
}

/**
 * Known asset metadata fields.
 *
 * @remarks
 * Additional metadata keys are allowed through `AssetMetadata`.
 *
 * @see AssetMetadata
 */
export type KnownMetadata = Partial<{
    /** Asset name, e.g. "Tether USD" */
    name: string;
    /** Asset symbol, e.g. "USDT" */
    ticker: string;
    /**
     * Amount of decimal places to adjust the `amount` for
     * (e.g. `1_000_000` adjusted for `6` decimals = `1`)
     */
    decimals: number;
    /** Image source that can be passed to an `<img src>` attribute. */
    icon: string;
}>;

/**
 * Asset metadata including known fields and arbitrary extension keys.
 *
 * @see KnownMetadata
 */
export type AssetMetadata = KnownMetadata & Record<string, unknown>;

/**
 * Asset details returned by `IAssetManager.getAssetDetails`.
 *
 * @see IAssetManager.getAssetDetails
 * @see AssetMetadata
 */
export type AssetDetails = {
    /** Asset identifier. */
    assetId: string;

    /** Total issued supply in base units. */
    supply: number;

    /** Optional immutable metadata associated with the asset. */
    metadata?: AssetMetadata;

    /** Optional control asset id required for future reissuance. */
    controlAssetId?: string;
};

/**
 * Parameters accepted by `IAssetManager.issue`.
 *
 * @see IAssetManager.issue
 * @see IssuanceResult
 */
export interface IssuanceParams {
    /** Initial amount of asset to issue */
    amount: number;
    /** Optional control asset ID that can be used for future reissuance */
    controlAssetId?: string;
    /** Immutable asset metadata including `ticker`, `decimals`, `icon` */
    metadata?: AssetMetadata;
}

/**
 * Result returned by `IAssetManager.issue`.
 *
 * @see IAssetManager.issue
 * @see IssuanceParams
 */
export interface IssuanceResult {
    /** Arkade transaction ID where the asset was issued */
    arkTxId: string;
    /** Permanent asset ID, made up of above `arkTxId` and zero-based asset group index  */
    assetId: string;
}

/**
 * Parameters accepted by `IAssetManager.reissue`.
 *
 * @see IAssetManager.reissue
 */
export interface ReissuanceParams {
    /** Existing asset ID, made up of genesis (Arkade) transaction ID and zero-based asset group index */
    assetId: string;
    /** Amount of asset to issue */
    amount: number;
}

/**
 * Parameters accepted by `IAssetManager.burn`.
 *
 * @see IAssetManager.burn
 */
export interface BurnParams {
    /** Existing asset ID, made up of genesis (Arkade) transaction ID and zero-based asset group index */
    assetId: string;
    /** Amount of asset to burn */
    amount: number;
}

/**
 * Explicit inputs and outputs accepted by `IWallet.settle`.
 *
 * @remarks
 * Inputs can include both offchain virtual outputs and onchain boarding inputs.
 *
 * @see IWallet.settle
 * @see Output
 */
export interface SettleParams {
    /** Offchain virtual outputs and/or onchain boarding inputs to settle. */
    inputs: ExtendedCoin[];
    /** Optional onchain outputs to create (i.e., exit to). */
    outputs: Output[];
}

/**
 * Onchain output status
 */
export interface Status {
    /** Whether the output is confirmed */
    confirmed: boolean;

    /**
     * Whether the output exists as a finalized batch leaf.
     * In the current mapping this is `true` for settled and swept virtual outputs,
     * and `false` for preconfirmed virtual outputs.
     *
     * @remarks
     * `isLeaf` is currently derived from `!isPreconfirmed` in the indexer mapping.
     * It is used primarily by transaction history classification to distinguish
     * finalized batch outputs from preconfirmed offchain outputs.
     */
    isLeaf?: boolean;
    /** Block height where the output was confirmed, when known. */
    block_height?: number;
    /** Block hash where the output was confirmed, when known. */
    block_hash?: string;
    /** Block time where the output was confirmed, when known. */
    block_time?: number;
}

/**
 * Virtual output status
 */
export interface VirtualStatus {
    /**
     * Extended output status.
     *
     * - `preconfirmed`: not yet finalized in a batch
     * - `settled`: finalized in a batch
     * - `swept`: expired/swept and recoverable in a new batch
     * - `spent`: destroyed by a later transaction
     *
     * @remarks
     * `state` is the high-level lifecycle summary used throughout wallet balance,
     * recovery, and transaction history logic.
     */
    state: "preconfirmed" | "settled" | "swept" | "spent";

    /**
     * Which batch commitment transaction(s) this virtual output depends on.
     *
     * @remarks
     * The history builder uses these ids to group received batch transactions and
     * relate refreshed or forfeited virtual outputs back to the same batch.
     */
    commitmentTxIds?: string[];

    /**
     * The earliest point at which this virtual output stops being safely preconfirmed.
     *
     * @remarks
     * The value is stored in milliseconds in the wallet model and is used by expiry
     * and recovery logic to decide when a virtual output can be swept or renewed.
     */
    batchExpiry?: number;
}

/** Onchain output location data. */
export interface Outpoint {
    /** Transaction ID where the output was created */
    txid: string;
    /** Transaction output index for this output */
    vout: number;
}

/**
 * Onchain output data.
 *
 * @see Outpoint
 */
export interface Coin extends Outpoint {
    /** Value of the output in satoshis */
    value: number;
    /** Onchain output status */
    status: Status;
}

/**
 * Virtual output data.
 *
 * @see Coin
 * @see VirtualStatus
 */
export interface VirtualCoin extends Coin {
    /** Virtual output status */
    virtualStatus: VirtualStatus;
    /** Transaction id that spent this virtual output, when known. */
    spentBy?: string;
    /** Settlement transaction associated with this virtual output, when known. */
    settledBy?: string;
    /** Arkade transaction id that created or spent this virtual output, when known. */
    arkTxId?: string;
    /** Creation time of the virtual output. */
    createdAt: Date;
    /** Whether this virtual output has been unrolled to onchain outputs. */
    isUnrolled: boolean;
    /** Whether this virtual output is already spent. */
    isSpent?: boolean;
    /** Assets carried by this virtual output, if any. */
    assets?: Asset[];
    /** The scriptPubKey (hex) locking this virtual output, as returned by the indexer. */
    script?: string;
}

/** Wallet transaction direction. */
export enum TxType {
    TxSent = "SENT",
    TxReceived = "RECEIVED",
}

/**
 * Composite key used to correlate a wallet transaction across layers.
 *
 * @see ArkTransaction
 */
export interface TxKey {
    /** Boarding transaction id, when applicable. */
    boardingTxid: string;

    /** Batch commitment transaction id, when applicable. */
    commitmentTxid: string;

    /** Arkade transaction id, when applicable. */
    arkTxid: string;
}

/**
 * Wallet transaction history entry.
 *
 * @see TxKey
 * @see TxType
 */
export interface ArkTransaction {
    /** Composite key referencing the related transaction ids. */
    key: TxKey;

    /** Transaction direction. */
    type: TxType;

    /** Net transaction amount in satoshis. */
    amount: number;

    /** Whether the transaction is finalized. */
    settled: boolean;

    /** Creation timestamp in milliseconds since epoch. */
    createdAt: number;

    /** Assets sent or received by this transaction, if any. */
    assets?: Asset[];
}

/**
 * Tapleaves required to spend or settle a wallet output.
 *
 * @see ExtendedCoin
 * @see ExtendedVirtualCoin
 */
export type TapLeaves = {
    /** Tapleaf script used for the forfeit path. */
    forfeitTapLeafScript: TapLeafScript;

    /** Tapleaf script used for the intent path. */
    intentTapLeafScript: TapLeafScript;
};

/**
 * Onchain output data enriched with tapscript and witness data.
 *
 * @see Coin
 * @see TapLeaves
 */
export type ExtendedCoin = TapLeaves &
    EncodedVtxoScript &
    Coin & { extraWitness?: Bytes[] };

/**
 * Virtual output data enriched with tapscript and witness data.
 *
 * @see VirtualCoin
 * @see TapLeaves
 */
export type ExtendedVirtualCoin = TapLeaves &
    EncodedVtxoScript &
    VirtualCoin & { extraWitness?: Bytes[] };

/**
 * Return whether a virtual output is still spendable.
 *
 * @param vtxo - virtual output to inspect
 * @returns `true` when the virtual output is not marked as spent
 *
 * @see isRecoverable
 * @see isExpired
 */
export function isSpendable(vtxo: VirtualCoin): boolean {
    return !vtxo.isSpent;
}

/**
 * Return whether a virtual output is recoverable.
 *
 * @param vtxo - virtual output to inspect
 * @returns `true` when the virtual output is swept but still spendable
 *
 * @remarks
 * Recoverable virtual outputs are typically re-settled into fresh virtual outputs by the virtual output manager.
 *
 * @see isSpendable
 * @see isExpired
 */
export function isRecoverable(vtxo: VirtualCoin): boolean {
    return vtxo.virtualStatus.state === "swept" && isSpendable(vtxo);
}

/**
 * Return whether a virtual output should be treated as expired.
 *
 * @param vtxo - virtual output to inspect
 * @returns `true` when the virtual output is swept or its batch expiry has passed
 * @remarks
 * On regtest-like environments the upstream expiry value may be expressed as a block
 * height instead of a timestamp. This helper intentionally ignores obviously non-time
 * values to avoid false positives.
 *
 * @see VirtualStatus.batchExpiry
 */
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

/**
 * Return whether a virtual output is below the dust threshold.
 *
 * @param vtxo - virtual output to inspect
 * @param dust - dust threshold in satoshis
 * @returns `true` when the virtual output value is below `dust`
 *
 * @see isRecoverable
 */
export function isSubdust(vtxo: VirtualCoin, dust: bigint): boolean {
    return vtxo.value < dust;
}

/**
 * Filtering options for `IWallet.getVtxos`.
 *
 * @see IWallet.getVtxos
 */
export type GetVtxosFilter = {
    /** Include swept but still unspent virtual outputs. */
    withRecoverable?: boolean;

    /** Include virtual outputs that have been unrolled onchain. */
    withUnrolled?: boolean;
};

/**
 * Readonly asset manager interface for asset operations that do not require wallet identity.
 *
 * @see IAssetManager
 */
export interface IReadonlyAssetManager {
    /**
     * Fetch metadata and supply data for an asset.
     *
     * @param assetId - Asset identifier
     * @returns Asset details
     * @see AssetDetails
     */
    getAssetDetails(assetId: string): Promise<AssetDetails>;
}

/**
 * Asset manager interface for asset operations that require wallet identity.
 *
 * @see IReadonlyAssetManager
 */
export interface IAssetManager extends IReadonlyAssetManager {
    /**
     * Issue a new asset.
     *
     * @param params - Asset issuance parameters
     * @returns Asset issuance result
     * @see IssuanceParams
     * @see IssuanceResult
     */
    issue(params: IssuanceParams): Promise<IssuanceResult>;

    /**
     * Reissue an existing asset.
     *
     * @param params - Asset reissuance parameters
     * @returns Arkade transaction id
     * @see ReissuanceParams
     */
    reissue(params: ReissuanceParams): Promise<string>;

    /**
     * Burn an existing asset.
     *
     * @param params - Asset burn parameters
     * @returns Arkade transaction id
     * @see BurnParams
     */
    burn(params: BurnParams): Promise<string>;
}

/**
 * Core wallet interface for Bitcoin transactions with Arkade protocol support.
 *
 * This interface defines the contract that all wallet implementations must follow.
 * It provides methods for address management, balance checking, virtual output
 * operations, and transaction management including sending, settling, and unrolling.
 *
 * @see IReadonlyWallet
 */
export interface IWallet extends IReadonlyWallet {
    /** Signing identity associated with the wallet. */
    identity: Identity;

    /**
     * Send bitcoin to a single Arkade address.
     *
     * @param params - Destination, amount, fee rate override, etc
     * @returns Arkade transaction id
     * @deprecated Use `send`
     * @see send
     * @see Recipient
     */
    sendBitcoin(params: SendBitcoinParams): Promise<string>;

    /**
     * Settle boarding inputs and/or preconfirmed virtual outputs into settled virtual outputs.
     *
     * @param params - Optional explicit settlement inputs and outputs
     * @param eventCallback - Optional callback that receives settlement events
     * @returns Arkade transaction id
     * @see SettleParams
     */
    settle(
        params?: SettleParams,
        eventCallback?: (event: SettlementEvent) => void
    ): Promise<string>;

    /**
     * Send bitcoin and/or assets to one or more Arkade recipients.
     *
     * @param recipients - One or more recipients
     * @returns Arkade transaction id
     * @example
     * ```typescript
     * await wallet.send({ address: 'ark1q...', amount: 1000 })
     * ```
     */
    send(...recipients: [Recipient, ...Recipient[]]): Promise<string>;

    // TODO: this needs to be async or find a workaround
    /** Asset manager bound to this wallet instance. */
    assetManager: IAssetManager;

    /** @returns Delegation manager, when configured. */
    getDelegatorManager(): Promise<IDelegatorManager | undefined>;
}

/**
 * Readonly wallet interface for Bitcoin transactions with Arkade protocol support.
 *
 * This interface defines the contract that all wallet implementations must follow.
 * It provides methods for address management, balance checking, virtual output
 * operations, and transaction management including sending, settling, and unrolling.
 *
 * @see IWallet
 */
export interface IReadonlyWallet {
    /** Readonly identity associated with the wallet. */
    identity: ReadonlyIdentity;

    /** @returns Arkade address used for offchain funds. */
    getAddress(): Promise<string>;

    /** @returns Onchain boarding address used to move funds into Arkade. */
    getBoardingAddress(): Promise<string>;

    /** @returns The wallet's combined onchain and offchain balance. */
    getBalance(): Promise<WalletBalance>;

    /**
     * Get virtual outputs tracked by the wallet.
     *
     * @param filter - Optional filtering flags
     * @returns virtual outputs with tapscript and witness data
     * @see GetVtxosFilter
     */
    getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]>;

    /** @returns Onchain boarding inputs tracked by the wallet. */
    getBoardingUtxos(): Promise<ExtendedCoin[]>;

    /** @returns Wallet transaction history derived from boarding and Arkade activity. */
    getTransactionHistory(): Promise<ArkTransaction[]>;

    /**
     * Get the contract manager associated with this wallet.
     * This is useful for querying contract state and watching for contract events.
     *
     * @returns Contract manager instance
     */
    getContractManager(): Promise<IContractManager>;

    /** Readonly asset manager bound to this wallet instance. */
    assetManager: IReadonlyAssetManager;
}
