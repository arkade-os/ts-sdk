import { Bytes } from "@scure/btc-signer/utils.js";
import { ArkadeInfo, ArkProvider, Output, SettlementEvent } from "../providers/ark";
import { Identity, ReadonlyIdentity } from "../identity";
import { DescriptorProvider } from "../identity/descriptorProvider";
import { RelativeTimelock } from "../script/tapscript";
import { EncodedVtxoScript, TapLeafScript } from "../script/base";
import { SettlementConfig } from "./vtxo-manager";
import { GetVtxosOptions, IndexerProvider } from "../providers/indexer";
import { OnchainProvider } from "../providers/onchain";
import { ContractWatcherConfig } from "../contracts/contractWatcher";
import {
    ContractRepository,
    WalletRepository,
    IntentRepository,
    VirtualTxRepository,
} from "../repositories";
import { IContractManager } from "../contracts/contractManager";
import type { Contract } from "../contracts/types";
import type { IDelegateeManager } from "./delegatee";
import { IDelegateManager } from "./delegate";
import type { Activity, ActivityRegistry } from "./activity";
import type { ExitCaptureMode } from "./exit/capture";
import type { ExitDataSource } from "./exit/resolver";
export {
    ActivityRegistry,
    boardingResolver,
    collabExitResolver,
    assetMintResolver,
    createDefaultActivityRegistry,
    type Activity,
    type ActivityIntent,
    type GroupMembership,
    type ActivityResolver,
} from "./activity";
import { DelegateProvider } from "../providers/delegate";

/**
 * Wallet receive-address strategy.
 *
 * - `'auto'` *(default)*: currently identical to `'static'`; reserved for identity-probing once
 *   HD rotation has matured. Opt into HD via `'hd'` or a {@link DescriptorProvider}. (Flip-back
 *   criteria: `TODO(hd-maturation)` in `walletReceiveRotator.ts`.)
 * - `'static'`: never rotate; one receive address from `identity.xOnlyPublicKey()`.
 * - `'hd'`: rotate with the built-in HD provider. Throws at `Wallet.create` if the identity isn't
 *   HD-capable or its descriptor isn't rangeable — no silent fallback.
 * - A {@link DescriptorProvider}: rotate via it on every incoming VTXO. The identity is not
 *   probed; the caller must ensure it can sign for the provider's pubkeys. Provider errors
 *   propagate.
 */
export type WalletMode = "auto" | "static" | "hd" | DescriptorProvider;

/**
 * Address flavours {@link Wallet.getNewAddresses} can mint, from the same HD index within one
 * call: `default` (offchain Arkade receive) or `boarding` (onchain deposit).
 */
export type NewAddressType = "default" | "boarding";

/** Options for {@link Wallet.getNewAddresses}. */
export interface GetNewAddressesOptions {
    /**
     * Flavours to mint, in the order they are returned.
     *
     * @defaultValue `["default"]`
     */
    types?: readonly NewAddressType[];
    /**
     * Require a genuinely fresh index. A wallet with no HD stream to advance (`'static'` /
     * `'auto'`, or a provider that declines) throws {@link WalletCannotAllocateAddressError}
     * instead of silently reusing the previous address (two counterparties paying one script).
     *
     * @defaultValue `false`
     */
    forceNew?: boolean;
}

/** One minted address and the contract row backing it. */
export interface NewAddress {
    /**
     * The address to hand out: onchain for `boarding`, Arkade for `default`. Not always
     * `contract.address`: a boarding row persists the *ark* encoding, which no onchain sender
     * can pay.
     */
    address: string;
    /**
     * The descriptor this address was derived from (pass to `signerForDescriptor` to recover the
     * key); the same for every entry of one call. Typed copy of
     * `contract.metadata.signingDescriptor`.
     */
    signingDescriptor: string;
    /** The persisted, watched contract row. */
    contract: Contract;
}

/**
 * Base configuration options shared by all wallet types. Omitted providers get the default
 * implementation for that service.
 *
 * @see WalletConfig
 * @see ReadonlyWalletConfig
 * @see StorageConfig
 */
export interface BaseWalletConfig {
    /** Optional Arkade server public key used to construct and validate Arkade addresses. */
    arkServerPublicKey?: string;
    /** Relative timelock applied to boarding scripts. */
    boardingTimelock?: RelativeTimelock;
    /** Relative timelock applied to unilateral exit paths. */
    exitTimelock?: RelativeTimelock;
    /**
     * Minimum accepted `BatchStartedEvent.batchExpiry`, as wall-clock seconds.
     * Defaults per network — see `defaultBatchExpiryPolicy`. Lowering it below
     * the default relaxes a fund-safety bound; intended for local testing.
     */
    minBatchExpirySeconds?: bigint;
    /**
     * Minimum accepted checkpoint exit delay decoded from `ArkadeInfo.checkpointTapscript`, as
     * wall-clock seconds. Defaults per network (`defaultCheckpointExitDelayPolicy`, which already
     * accepts hosted signet/mutinynet). Lowering it relaxes a fund-safety bound; for local testing.
     */
    minCheckpointExitDelaySeconds?: bigint;
    /** Repository-backed storage configuration overrides. Defaults to IndexedDB if unset. */
    storage?: StorageConfig;
    /** Optional Arkade provider instance. */
    arkProvider?: ArkProvider;
    /** Optional indexer provider instance. */
    indexerProvider?: IndexerProvider;
    /** Optional onchain provider instance. */
    onchainProvider?: OnchainProvider;
    /** @deprecated Legacy pre-signed delegator provider. Use delegateeProvider for new wallets. */
    delegateProvider?: DelegateProvider;
    /** Optional delegatee renewal service instance. */
    delegateeProvider?: import("../providers/delegatee").DelegateeProvider;
}

/**
 * Configuration for a readonly (watch-only) wallet: query balance, addresses and transactions
 * without a private key.
 *
 * @see BaseWalletConfig
 * @see IReadonlyWallet
 *
 * @example
 * ```typescript
 * // Provider-based configuration (e.g., for Expo/React Native)
 * const wallet = await ReadonlyWallet.create({
 *   identity: ReadonlySingleKey.fromPublicKey(pubkey),
 *   arkProvider: new ExpoArkProvider(),
 *   indexerProvider: new ExpoIndexerProvider(),
 *   onchainProvider: new EsploraProvider()
 * });
 * ```
 */
export interface ReadonlyWalletConfig extends BaseWalletConfig {
    /** Readonly identity used to derive wallet addresses. */
    identity: ReadonlyIdentity;
    /**
     * ContractManager watcher settings (reconnection and failsafe polling).
     *
     * @see ContractWatcherConfig
     */
    watcherConfig?: Partial<Omit<ContractWatcherConfig, "indexerProvider">>;
}

/**
 * Configuration for a full (signing) wallet: readonly operations plus send and settle.
 *
 * @see ReadonlyWalletConfig
 * @see IWallet
 *
 * @example
 * ```typescript
 * // Provider-based configuration
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkProvider: new ExpoArkProvider(),
 *   indexerProvider: new ExpoIndexerProvider(),
 *   onchainProvider: new EsploraProvider()
 * });
 *
 * // With settlement configuration
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkProvider: new RestArkProvider(),
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
     * Configuration for automatic settlement and renewal.
     * `false` = explicitly disabled, `undefined` or `{}` = enabled with defaults.
     *
     * @defaultValue `undefined` (enabled with defaults)
     * @see SettlementConfig
     */
    settlementConfig?: SettlementConfig | false;

    /**
     * Receive-address strategy. See {@link WalletMode}.
     *
     * @defaultValue `'auto'`
     */
    walletMode?: WalletMode;

    /**
     * Per-side width of the HD look-ahead watch window: receive scripts across
     * `[watermark - N, watermark + N]` are watched, so payments to addresses an external party
     * issued (e.g. a merchant backend sharing the seed) arrive without `restore()`. HD wallets
     * only. Raise it if the issuer may hand out more than `N` consecutive unpaid addresses. Must
     * be a positive integer.
     *
     * @defaultValue `20`
     */
    lookAheadWindow?: number;
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
    /**
     * Optional intent-lifecycle repository. Opt-in: when present, the wallet
     * persists settlement intents and excludes intent-locked VTXOs from
     * spendable balance. Absent ⇒ those code paths are no-ops.
     */
    intentRepository?: IntentRepository;
    /**
     * **Experimental / inert.** Optional virtual-tx (exit-branch) repository. Currently only a
     * best-effort raw-PSBT cache used by {@link Unroll} when passed to `Unroll.Session.create`;
     * normal sync never populates or prunes it and {@link ContractManager} never receives it.
     */
    virtualTxRepository?: VirtualTxRepository;
    /**
     * Optional exit-data capture settings (only in effect when
     * `virtualTxRepository` is set). `mode` "lite" (default) stores structure
     * only; "full" stores PSBTs so a unilateral exit needs no Ark indexer.
     * `minExitWorthSats` (default 1000) skips dust. `sources` are extra
     * `ExitDataSource`s (e.g. a wallet-provider) tried before the indexer for
     * both capture and exit reads.
     */
    exitDataCapture?: {
        mode?: ExitCaptureMode;
        minExitWorthSats?: number;
        sources?: ExitDataSource[];
    };
};

/** Provider class constructor shape for dependency injection. */
export interface ProviderClass<T> {
    /** @param serverUrl - Base server URL used by the provider */
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
    /** Settled (finalized) balance the wallet owns, including gated and intent-locked funds. */
    settled: number;
    /** Preconfirmed (unfinalized) balance the wallet owns, on the same owned rule as {@link settled}. */
    preconfirmed: number;
    /**
     * Immediately spendable offchain balance — what generic selection would pick, so `send` never
     * refuses it: `settled + preconfirmed - gated - intentLocked`, minus one reserved dust carrier
     * if any of these outputs hold assets.
     */
    available: number;
    /**
     * Owned but refused by the generic-spending gate: a VHTLC lockup, an unmarked `arkade`
     * program, or an unregistered contract type. In `settled`/`preconfirmed` and `total`, never
     * `available`. Takes precedence over {@link intentLocked} (the gate is durable; a lock clears).
     *
     * Subtract it from `settled + preconfirmed`, never from `total`, which also carries boarding,
     * recoverable, pending-recovery and unrolled funds.
     */
    gated: number;
    /**
     * Committed to an in-flight intent and not {@link gated}; returns to `available` when the
     * intent terminates. Zero when unknown (no intent repository or a failed read), so it
     * under-reports into `available` rather than misattributing.
     */
    intentLocked: number;
    /**
     * Subdust or expired (swept) virtual outputs recoverable in principle, including lockups that
     * refuse a spend right now. `VtxoManager.getRecoverableBalance()` gives what a batch would
     * return today.
     */
    recoverable: number;

    /**
     * Unswept funds under a deprecated signer past its cutoff. Not spendable until recovered
     * (excluded from `available`/`settled`/`preconfirmed` and coin selection), but in `total`.
     */
    pendingRecovery: number;

    /**
     * Already unilaterally exited: onchain behind its CSV, movable only by
     * `Unroll.completeUnroll`. Excluded from every spendable bucket and `recoverable`, but in
     * `total`.
     */
    unrolled: number;

    /**
     * Total across offchain, recoverable, pending-recovery, unrolled and boarding funds.
     *
     * Known wedge: while a `send`/`sendBitcoin`/`settle` is in flight, its VTXO inputs (not
     * boarding) are withheld from every bucket on the `Wallet` instance driving it; a
     * service-worker client on the same repository still counts them until the spend settles.
     */
    total: number;

    /** Asset balance entries (`assetId` & `amount`) the wallet owns. */
    assets: Asset[];

    /**
     * The subset of {@link assets} generic spending accepts (asset analogue of
     * {@link available}). Assets have no per-cause split of what is held but not selectable.
     */
    availableAssets: Asset[];
}

/**
 * Parameters accepted by `OnchainWallet.send`.
 *
 * @remarks
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
     * Optional explicit virtual output selection. Ungated, like `settle({ inputs })`: named
     * outputs are spent even if generic selection would skip them.
     *
     * @see IReadonlyWallet.getSpendableVtxos
     */
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

    /** Asset amount in base units; `bigint` because supplies routinely exceed 2^53 - 1. */
    amount: bigint;
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
    extensions?: Array<{ type: number; payload: Uint8Array }>; // custom extension packets to embed in the tx

    /**
     * The recipient contract's tapleaf set, published on this output's `PSBT_OUT_TAP_TREE` so its
     * spending paths are recoverable from the tx alone (an address commits only to the key).
     *
     * Must come from `VtxoScript.encode()` and derive the recipient's taproot key: depths are
     * ignored on read and the tree rebuilt in arkd's canonical shape, so another encoder's tree is
     * refused even when it commits to the same address.
     */
    tapTree?: Bytes;
}

/** Object form of `IWallet.send`'s arguments; the variadic form has no slot for options. */
export interface SendParams {
    /** One or more recipients — the variadic arguments of the other form. */
    recipients: [Recipient, ...Recipient[]];

    /**
     * Spend exactly these virtual outputs, like `settle({ inputs })`: nothing is added, so a
     * shortfall is an error. For funding a contract from coins outliving its timelock, which
     * generic selection doesn't know about.
     *
     * @see IReadonlyWallet.getVtxos
     */
    selectedVtxos?: ExtendedVirtualCoin[];
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

    /** Total issued supply in base units (`bigint`, see {@link Asset.amount}). */
    supply: bigint;

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
    amount: bigint;
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
    amount: bigint;
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
    amount: bigint;
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
    /**
     * Offchain virtual outputs and/or onchain boarding inputs to settle.
     *
     * @remarks
     * Arknotes are settled by passing the `ArkNote` itself (it is an `ExtendedCoin`), not its
     * string form — `ArkNote.fromString(note)`.
     */
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
     *
     * @remarks
     * Currently derived as `!isPreconfirmed` (true for settled and swept virtual outputs); used
     * mainly by transaction history classification.
     */
    isLeaf?: boolean;
    /** Block height where the output was confirmed, when known. */
    block_height?: number;
    /** Block hash where the output was confirmed, when known. */
    block_hash?: string;
    /** Block time where the output was confirmed, when known. */
    block_time?: number;
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
 * @remarks
 * The canonical facts (`isSwept`, `isPreconfirmed`, `isSpent`, `expiresAt`, `expiresAtHeight`,
 * `commitmentTxIds`) are optional because custom {@link IndexerProvider} /
 * {@link WalletRepository} implementations may omit them. Coins the SDK returns are normalized;
 * for any other coin use {@link canSpendOffchain} / {@link canRecoverOnchain} /
 * {@link isVtxoSpent} / {@link isPastExpiry}, which normalize defensively.
 *
 * @see Coin
 */
export interface VirtualCoin extends Coin {
    /** Creation time of the virtual output. */
    createdAt: Date;
    /** The scriptPubKey (hex) locking this virtual output, as returned by the indexer. */
    script: string;
    /** Whether this virtual output has been broadcasted onchain via an unroll (unilateral exit). */
    isUnrolled: boolean;
    /** Whether this output was spent offchain (`spentBy` helper); not set for unrolled or swept. */
    isSpent?: boolean;
    /** Whether the server has swept the batch this virtual output belongs to. */
    isSwept?: boolean;
    /** Whether this virtual output is not yet finalized in a batch. */
    isPreconfirmed?: boolean;
    /** ID of the onchain commitment transaction that settled this output, if applicable. */
    settledBy?: string;
    /**
     * ID of the offchain checkpoint transaction that spent this output.
     *
     * @remarks
     * The empty string means "not spent by anything" — test truthiness, never presence.
     */
    spentBy?: string;
    /** ID of the offchain Arkade transaction that spent the above checkpoint output, if applicable. */
    arkTxId?: string;
    /** Batch commitment transaction(s) this virtual output depends on. */
    commitmentTxIds?: string[];
    /**
     * Wall-clock batch expiry, when the server expressed expiry as a timestamp.
     *
     * @remarks
     * Mutually exclusive with `expiresAtHeight`; both are absent when there is no expiry.
     */
    expiresAt?: Date;
    /**
     * Block-height batch expiry, when the server expressed expiry as a height (regtest-like
     * deployments). Evaluating it needs a chain tip — see {@link isPastExpiry}.
     */
    expiresAtHeight?: number;
    /** Assets carried by this virtual output, if any. */
    assets?: Asset[];
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
 * The categories the history builder itself assigns. Four name the mechanism that moved the
 * coin; `"gated"` names the counterparty: an offchain movement into or out of one of this
 * wallet's gated contracts (swap covenant, lockup — the {@link WalletBalance.gated} money).
 * History treats that contract as external, so the tag tells "my own escrow" from "a stranger".
 */
export type BuiltinTxTag = "offchain" | "boarding" | "exit" | "batch" | "gated";

/**
 * The category the history builder assigns to a transaction. `(string & {})` keeps the union
 * open for custom categories while preserving autocomplete for the built-in ones.
 */
export type TxTag = BuiltinTxTag | (string & {});

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

    /**
     * The {@link TxTag} category. Always set by `getTransactionHistory()`; optional only for
     * hand-built transactions.
     */
    tag?: TxTag;
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
export type ExtendedCoin = TapLeaves & EncodedVtxoScript & Coin & { extraWitness?: Bytes[] };

/**
 * Virtual output data enriched with tapscript and witness data.
 *
 * @see VirtualCoin
 * @see TapLeaves
 */
export type ExtendedVirtualCoin = TapLeaves &
    EncodedVtxoScript &
    VirtualCoin & { extraWitness?: Bytes[] };

import type { NormalizedExtendedVirtualCoin, NormalizedVtxoPage } from "./vtxo";

export {
    canRecoverOnchain,
    canSpendOffchain,
    canSweepOnchain,
    convertVtxo,
    getAllNormalizedVtxos,
    getNormalizedVtxos,
    isVtxoSpent,
    isPastExpiry,
    isVirtualCoin,
    normalizeVtxo,
    requiresForfeit,
    type NormalizedExtendedVirtualCoin,
    type NormalizedVirtualCoin,
    type NormalizedVtxoPage,
    type TimeHeight,
    type VtxoScriptQuery,
} from "./vtxo";

/**
 * Return whether a virtual output is below the dust threshold.
 *
 * @param vtxo - virtual output to inspect
 * @param dust - dust threshold in satoshis
 * @returns `true` when the virtual output value is below `dust`
 *
 * @see canRecoverOnchain
 */
export function isSubdust(vtxo: { value: number } | bigint, dust: bigint): boolean {
    if (typeof vtxo === "bigint") return vtxo < dust;
    return vtxo.value < dust;
}

/**
 * Filtering options for `IWallet.getVtxos`.
 *
 * @see IWallet.getVtxos
 */
export type GetVtxosFilter = {
    /**
     * Include swept or expired but still unspent virtual outputs. Defaults to `true`; set to
     * `false` to exclude outputs that require onchain recovery.
     */
    withRecoverable?: boolean;

    /**
     * Include virtual outputs that have been unrolled onchain — whatever else is true of them,
     * spent ones included. Unlike {@link withRecoverable} it doesn't narrow to a capability:
     * test {@link canSweepOnchain} before acting on the result. Defaults to `false`.
     */
    withUnrolled?: boolean;
};

export type GetSpendableVtxosFilter = GetVtxosFilter & {
    /** Exclude contracts retained for history from this spendable read. */
    watchedOnly?: boolean;
    /** Query only contracts whose handler permits generic spending. */
    genericallySpendableOnly?: boolean;

    /** Maximum age of a successful sync reused by this read, in milliseconds. Default: 0. */
    maxSyncAgeMs?: number;

    /** Reject repository fallback when the selected contracts could not be synced. */
    requireSynced?: boolean;
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
     * @see IssuanceParams
     * @see IssuanceResult
     */
    issue(params: IssuanceParams): Promise<IssuanceResult>;

    /**
     * Reissue an existing asset.
     *
     * @returns Arkade transaction id
     * @see ReissuanceParams
     */
    reissue(params: ReissuanceParams): Promise<string>;

    /**
     * Burn an existing asset.
     *
     * @returns Arkade transaction id
     * @see BurnParams
     */
    burn(params: BurnParams): Promise<string>;
}

/** Options for {@link IReadonlyWallet.getArkadeInfo}. */
export type GetArkadeInfoOptions = {
    /** Throw when the operator is unreachable instead of answering from the
     * persisted snapshot — for callers binding the answer into a covenant. */
    requireLive?: boolean;
};

/**
 * Chain reads beyond the wallet's own VTXOs: an arbitrary script's virtual outputs and the
 * transactions that spent them.
 *
 * Returns normalized VTXOs (as {@link getNormalizedVtxos}), so every coin carries its canonical
 * facts, while still structurally satisfying `Pick<IndexerProvider, "getVtxos" |
 * "getVirtualTxs">`. Re-normalizing downstream is harmless (`normalizeVtxo` is idempotent); do
 * not "fix" that by stripping normalization here — it is the point of the seam. Deliberately not
 * the whole provider: `getVtxoChain`/`getSubscription` would bypass the wallet (and the service
 * worker can't express them).
 */
// `getVirtualTxs`: txids ride the URL path, one request per call, no chunking; following a
// returned `page` is the caller's job (`swap`'s restore scan chunks at 50 txids for this).
export type ArkadeReader = Pick<IndexerProvider, "getVirtualTxs"> & {
    /**
     * `opts` is required, unlike on `IndexerProvider`: this seam reads *named* foreign scripts
     * or outpoints. One logical query, no chunking: `scripts` travel in the query string and a
     * wide list can `414` — use {@link getAllNormalizedVtxos} to chunk and page to exhaustion.
     *
     * @see getNormalizedVtxos
     */
    getVtxos(opts: GetVtxosOptions): Promise<NormalizedVtxoPage>;
};

/**
 * Submit and finalize a signed Arkade transaction. Only on {@link IWallet}: broadcasting is the
 * one thing a readonly wallet must not do (hence `ReadonlyWallet.arkProvider` is protected).
 */
export type ArkadeBroadcaster = Pick<ArkProvider, "submitTx" | "finalizeTx">;

/**
 * Signing wallet interface: {@link IReadonlyWallet} plus sending, settling and asset operations.
 *
 * @see IReadonlyWallet
 */
export interface IWallet extends IReadonlyWallet {
    /**
     * Broadcast access to this wallet's Arkade server, so a plugin needs no server URL of its own.
     *
     * @returns A submit/finalize pair bound to this wallet's server
     * @see ArkadeBroadcaster
     */
    getArkadeBroadcaster(): Promise<ArkadeBroadcaster>;

    /**
     * Signing identity associated with the wallet. Must be a real signer (`isSigningIdentity`):
     * contract corridors need `signerSession`, which a watch-only identity lacks, and refuse such
     * a wallet with `WalletCannotSignError` before anything is funded.
     */
    identity: Identity;

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
        eventCallback?: (event: SettlementEvent) => void,
    ): Promise<string>;

    /**
     * Send bitcoin and/or assets to one or more Arkade recipients, as variadic `Recipient`s or a
     * `SendParams` object (which can also name the inputs).
     *
     * @returns Arkade transaction id
     * @see SendParams
     * @example
     * ```typescript
     * await wallet.send({ address: 'ark1q...', amount: 1000 })
     *
     * // choosing the inputs as well as the outputs
     * await wallet.send({
     *     recipients: [{ address: 'ark1q...', amount: 1000 }],
     *     selectedVtxos: mine,
     * })
     * ```
     */
    send(...args: [SendParams] | [Recipient, ...Recipient[]]): Promise<string>;

    // TODO: this needs to be async or find a workaround
    /** Asset manager bound to this wallet instance. */
    assetManager: IAssetManager;

    /** @deprecated Legacy pre-signed delegator manager; use getDelegateeManager. */
    getDelegateManager(): Promise<IDelegateManager | undefined>;

    /** @returns The template-based delegatee manager, when configured. */
    getDelegateeManager(): Promise<IDelegateeManager | undefined>;
}

/**
 * Readonly wallet interface: addresses, balances, virtual outputs, history and contracts.
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

    /**
     * Info (network, signer key, delays, dust, fees, limits) for this wallet's Arkade server.
     * Live when reachable, else the snapshot persisted at construction.
     *
     * With `requireLive` it throws instead of using the cache — for callers binding
     * `signerPubkey` or a delay into a covenant, where a stale snapshot could derive an address
     * the operator no longer co-signs for.
     *
     * @see ArkadeInfo
     */
    getArkadeInfo(opts?: GetArkadeInfoOptions): Promise<ArkadeInfo>;

    /**
     * Server-side chain reads for scripts the wallet does not own (e.g. a plugin's covenant);
     * {@link getVtxos} reads the wallet's own outputs from repositories.
     *
     * @see ArkadeReader
     */
    getArkadeReader(): Promise<ArkadeReader>;

    /** @returns The wallet's combined onchain and offchain balance. */
    getBalance(): Promise<WalletBalance>;

    /**
     * Get virtual outputs tracked by the wallet.
     *
     * @returns Virtual outputs with tapscript and witness data, normalized (every canonical fact
     * populated, whatever the repository stored)
     * @see GetVtxosFilter
     */
    getVtxos(filter?: GetVtxosFilter): Promise<NormalizedExtendedVirtualCoin[]>;

    /**
     * The subset of {@link getVtxos} generic spending may select: minus gated contracts,
     * pending-recovery funds and intent-locked outpoints (all from one contract snapshot). Every
     * implicit coin selection reads this; `getVtxos` stays the raw reporting/recovery read.
     *
     * @param filter - Same coin flags and defaults as {@link getVtxos}, with opt-in contract scopes
     * @see GetSpendableVtxosFilter
     */
    getSpendableVtxos(filter?: GetSpendableVtxosFilter): Promise<NormalizedExtendedVirtualCoin[]>;

    /** @returns Onchain boarding inputs tracked by the wallet. */
    getBoardingUtxos(): Promise<ExtendedCoin[]>;

    /** @returns Wallet transaction history derived from boarding and Arkade activity. */
    getTransactionHistory(): Promise<ArkTransaction[]>;

    /** Resolvers that group/label {@link getActivityHistory} rows. */
    readonly activity: ActivityRegistry;

    /** @returns Wallet history grouped into logical activities with signed net amounts. */
    getActivityHistory(): Promise<Activity[]>;

    /** The wallet's contract manager, for querying contract state and watching contract events. */
    getContractManager(): Promise<IContractManager>;

    /** Readonly asset manager bound to this wallet instance. */
    assetManager: IReadonlyAssetManager;

    /** Wipe all locally persisted wallet data (VTXOs, UTXOs, history, sync cursor, contracts). */
    clear(): Promise<void>;
}

export {
    registerWalletRestoreHook,
    type WalletRestoreHook,
} from "./restoreHooks";
