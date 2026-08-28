import { Bytes } from "@scure/btc-signer/utils.js";
import { ArkProvider, Output, SettlementEvent } from "../providers/ark";
import { Identity, ReadonlyIdentity } from "../identity";
import { DescriptorProvider } from "../identity/descriptorProvider";
import { RelativeTimelock } from "../script/tapscript";
import { EncodedVtxoScript, TapLeafScript } from "../script/base";
import { RenewalConfig, SettlementConfig } from "./vtxo-manager";
import { IndexerProvider } from "../providers/indexer";
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
 * - `'auto'` *(default)*: **short-term** — currently identical to
 *   `'static'`. The `'auto'` name is reserved for a future change that
 *   will re-enable identity-probing once HD rotation has matured in
 *   the field. Until then, opt into HD explicitly via `'hd'` or a
 *   {@link DescriptorProvider}.
 *   *(See `TODO(hd-maturation)` in
 *   `src/wallet/walletReceiveRotator.ts:resolveDescriptorProvider` for
 *   the flip-back criteria.)*
 * - `'static'`: never rotate. The wallet uses one receive address derived
 *   from `identity.xOnlyPublicKey()`.
 * - `'hd'`: must rotate, using the built-in HD provider derived from the
 *   identity. Throws at `Wallet.create` if the identity isn't HD-capable
 *   or its descriptor isn't rangeable — no silent fallback.
 * - A {@link DescriptorProvider} instance: rotate via the supplied
 *   provider on every incoming VTXO. The wallet does not probe the
 *   identity; the caller is responsible for ensuring the identity can
 *   sign for whatever pubkey the provider returns. Errors thrown by the
 *   provider propagate — there is no silent fallback for an explicit
 *   provider.
 */
export type WalletMode = "auto" | "static" | "hd" | DescriptorProvider;

/**
 * Address flavours {@link Wallet.getNewAddresses} can mint. Both derive from
 * the same HD index within one call — `default` is the offchain Arkade
 * receive script, `boarding` the onchain deposit script.
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
     * Require a genuinely fresh index. A wallet with no HD stream to advance
     * (`walletMode: 'static'` / `'auto'`, or a provider that declines to
     * allocate) throws {@link WalletCannotAllocateAddressError} rather than
     * silently handing back the address it already gave you — which, for a
     * caller issuing one address per counterparty, surfaces only as two
     * people paying the same script.
     *
     * @defaultValue `false`
     */
    forceNew?: boolean;
}

/** One minted address and the contract row backing it. */
export interface NewAddress {
    /**
     * The address to hand out: the onchain address for `boarding`, the Arkade
     * address for `default`.
     *
     * Not always `contract.address`. A boarding row persists the *ark*
     * encoding of its script, so reading `contract.address` on a boarding
     * entry yields an address no onchain sender can pay.
     */
    address: string;
    /**
     * The descriptor this address was derived from — hand it to
     * `signerForDescriptor` to recover the key later. Every entry from a
     * single call carries the same one, because they share an index.
     *
     * Also present on `contract.metadata.signingDescriptor`, but surfaced here
     * typed: `Contract.metadata` is `Record<string, unknown>`, so reading it
     * there costs the caller an `as string` on the one field they are most
     * likely to persist beside an invoice.
     */
    signingDescriptor: string;
    /**
     * The persisted, watched contract row — script, type, state and metadata.
     */
    contract: Contract;
}

/**
 * Base configuration options shared by all wallet types.
 *
 * Supports URL-based and provider-based configuration.
 *
 * @deprecated URL-based configuration starts from `arkServerUrl` and can optionally override
 * derived service URLs such as `indexerUrl` and `esploraUrl`.
 *
 * Provider-based configuration supplies concrete provider instances directly,
 * including the ArkProvider, IndexerProvider, OnchainProvider, and DelegateProvider.
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
    /**
     * Base URL of the Arkade server.
     *
     * @deprecated Pass an explicit `arkProvider` instance instead. URL-based
     * configuration will be removed in a future major version.
     */
    arkServerUrl?: string;
    /**
     * Optional override for the indexer URL.
     *
     * @deprecated Pass an explicit `indexerProvider` instance instead.
     */
    indexerUrl?: string;
    /**
     * Optional override for the Esplora API URL.
     *
     * @deprecated Pass an explicit `onchainProvider` instance instead.
     */
    esploraUrl?: string;

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
     * Minimum accepted checkpoint exit delay decoded from `ArkInfo.checkpointTapscript`,
     * as wall-clock seconds. Defaults per network — see
     * `defaultCheckpointExitDelayPolicy`, which already carries the value the
     * hosted signet and mutinynet Arkade Services advertise, so neither needs
     * this set. Lowering it below the default relaxes a fund-safety bound;
     * intended for local testing.
     */
    minCheckpointExitDelaySeconds?: bigint;
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
    delegateProvider?: DelegateProvider;
    /** @deprecated alias for @see BaseWalletConfig.delegateProvider */
    delegatorProvider?: DelegateProvider;
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

    /**
     * Receive-address strategy. Pass `'static'`, `'hd'`, or a
     * {@link DescriptorProvider} instance to drive rotation; omit (or
     * pass `'auto'`) for the built-in auto-detect behaviour. See
     * {@link WalletMode}.
     *
     * @defaultValue `'auto'`
     */
    walletMode?: WalletMode;

    /**
     * Per-side width of the HD look-ahead watch window: the wallet watches
     * missing offchain receive scripts across `[watermark - N, watermark + N]`
     * so funds paid to an address issued by an external party (a merchant
     * backend sharing the seed) arrive without an explicit `restore()`.
     *
     * Only meaningful for HD wallets (`walletMode: 'hd'` or an HD
     * {@link DescriptorProvider}); ignored otherwise. Raise it when the issuer
     * is expected to hand out more than `N` consecutive addresses without any
     * of them being paid. Must be a positive integer.
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
     * **Experimental / inert.** Optional virtual-tx (exit-branch) repository.
     * Today it is only a best-effort raw-PSBT cache that unilateral exit
     * ({@link Unroll}) reads and writes when a caller passes it to
     * `Unroll.Session.create`. Normal wallet/contract sync does NOT populate,
     * maintain, or prune it, and {@link ContractManager} is never given it —
     * branch/full-mode persistence is out of scope for this release. Treat this
     * option as experimental until those paths land. Absent ⇒ no-op.
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
    /** Settled (finalized) balance the wallet owns, including gated and intent-locked funds. */
    settled: number;
    /** Preconfirmed (unfinalized) balance the wallet owns, on the same owned rule as {@link settled}. */
    preconfirmed: number;
    /**
     * Immediately spendable offchain balance — what generic selection would
     * pick, so nothing counted here can be refused by `send`:
     * `settled + preconfirmed - gated - intentLocked`.
     */
    available: number;
    /**
     * Spendable-but-for-the-gate funds: VTXOs under a contract the
     * generic-spending gate refuses — a VHTLC lockup, an unmarked `arkade`
     * program, or a type whose handler this runtime never registered. Counted in
     * `settled`/`preconfirmed` and `total`, never in `available`.
     *
     * Tested before {@link intentLocked}: the gate is a durable property of the
     * contract while an intent lock clears on its own, so a VTXO that is both is
     * reported here — it does not become available when the batch settles.
     *
     * Covers this bucket only: {@link recoverable} has the same owned-versus-
     * obtainable split under a different predicate and is not counted here.
     *
     * Subtract this from `settled + preconfirmed`, never from `total`. `total`
     * also carries {@link boarding}, {@link recoverable} and
     * {@link pendingRecovery}, which are still the user's funds — netting a
     * bucket out of it drops them from the figure with no signal.
     */
    gated: number;
    /**
     * Funds committed to an in-flight (non-terminal) intent, and not already
     * counted in {@link gated}. Unlike `gated`, these return to `available` when
     * the intent reaches a terminal state.
     *
     * Reported as zero where the wallet cannot answer the question — no intent
     * repository, or a repository read that fails — so this under-reports into
     * `available` rather than misattributing.
     */
    intentLocked: number;
    /**
     * Recoverable balance from subdust or expired (swept) virtual outputs —
     * recoverable in principle, so a lockup whose contract refuses a spend right
     * now is still counted and `total` does not lose it.
     * `VtxoManager.getRecoverableBalance()` answers the narrower question of
     * what a batch would hand back today, and excludes it.
     */
    recoverable: number;

    /**
     * Funds under a now-deprecated signer past its cutoff (EXPIRED) that have not
     * yet been swept by the server. NOT spendable until they recover, so excluded
     * from `available`/`settled`/`preconfirmed` and from coin selection — but
     * still the wallet's funds, so counted in `total`.
     */
    pendingRecovery: number;

    /** Total balance across offchain, recoverable, pending-recovery, and boarding funds. */
    total: number;

    /** Asset balance entries (`assetId` & `amount`) the wallet owns. */
    assets: Asset[];

    /**
     * The subset of {@link assets} generic spending will accept, i.e. the asset
     * analogue of {@link available}. `assets - availableAssets` is what is held
     * but not selectable, for the {@link gated} and {@link intentLocked} causes
     * plus recovery — assets have no per-cause split of their own.
     */
    availableAssets: Asset[];
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

    /**
     * Optional explicit virtual output selection used by `Wallet.sendBitcoin`.
     * Ungated, like `settle({ inputs })`: whatever is named here is spent, even
     * if generic selection would skip it.
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

    /**
     * Asset amount in base units. Typed as `bigint` because asset
     * supplies routinely exceed `Number.MAX_SAFE_INTEGER` (2^53 - 1)
     * and silently truncating in arithmetic would corrupt balances.
     */
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
     * The recipient contract's tapleaf set (`VtxoScript.encode` form), published
     * on this output's `PSBT_OUT_TAP_TREE` so its spending paths are recoverable
     * from the transaction alone — an address commits only to the output key.
     *
     * Refused unless it derives the recipient address's taproot key, and it must
     * come from `VtxoScript.encode()`: leaf depths are ignored on read and the
     * tree is rebuilt in arkd's canonical shape, so a tree from another encoder
     * is refused even where it commits to the same address.
     */
    tapTree?: Bytes;
}

/** Object form of `IWallet.send`'s arguments; the variadic form has no slot for options. */
export interface SendParams {
    /** One or more recipients — the variadic arguments of the other form. */
    recipients: [Recipient, ...Recipient[]];

    /**
     * Spend exactly these virtual outputs instead of letting the wallet choose.
     * Taken as given, like `settle({ inputs })`: nothing is added, so a shortfall
     * is an error rather than a top-up. Use when a contract must be funded from
     * coins outliving its timelock, which generic selection does not know about.
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

    /**
     * Total issued supply in base units. Typed as `bigint` for the
     * same reason as {@link Asset.amount} — supplies often exceed
     * `Number.MAX_SAFE_INTEGER`.
     */
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
 * Virtual output status.
 *
 * @deprecated Use the canonical facts on {@link VirtualCoin} — `isSwept`, `isPreconfirmed`,
 * `isSpent`, `expiresAt`, `expiresAtHeight`, `commitmentTxIds`, `spentBy`, `settledBy` — and the
 * capability predicates {@link canSpendOffchain}, {@link canRecoverOnchain},
 * {@link hasTerminalSpend}, {@link isPastExpiry}. `state` collapses independent facts into one
 * lossy label; this object is retained only as a backward-compatible projection.
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
     * @deprecated Lossy: the states are not orthogonal and collapse with precedence
     * `spent` > `swept` > `preconfirmed` > `settled`, so a spent VTXO that was also swept reports
     * only `spent`. Read `isSpent`/`isSwept`/`isPreconfirmed` instead, or a capability predicate.
     */
    state: "preconfirmed" | "settled" | "swept" | "spent";

    /**
     * Which batch commitment transaction(s) this virtual output depends on.
     *
     * @deprecated Use {@link VirtualCoin.commitmentTxIds}.
     */
    commitmentTxIds?: string[];

    /**
     * The earliest point at which this virtual output stops being safely preconfirmed,
     * in milliseconds.
     *
     * @deprecated Unit-ambiguous: the server returns a single scalar that is either unix seconds or
     * a block height, and both land here multiplied by 1000. Use {@link VirtualCoin.expiresAt} and
     * {@link VirtualCoin.expiresAtHeight}, which disambiguate the two.
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
 * @remarks
 * The canonical facts (`isSwept`, `isPreconfirmed`, `isSpent`, `expiresAt`, `expiresAtHeight`,
 * `commitmentTxIds`) are optional because `VirtualCoin` is also a *construction* type: custom
 * {@link IndexerProvider} and {@link WalletRepository} implementations may hand back coins without
 * them. The SDK normalizes every incoming coin, so coins it returns always carry the facts that are
 * determinable; do not read these fields off a coin the SDK has not returned to you — use
 * {@link canSpendOffchain} / {@link canRecoverOnchain} / {@link hasTerminalSpend} /
 * {@link isPastExpiry}, which normalize defensively.
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
    /**
     * Whether this virtual output is already spent (boolean helper for `spentBy`).
     * This is not set to true if the virtual output is unrolled or swept, only when it's spent offchain.
     */
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
    /**
     * Virtual output status.
     *
     * @deprecated See {@link VirtualStatus}.
     */
    virtualStatus: VirtualStatus;
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

/** The categories the history builder itself assigns. */
export type BuiltinTxTag = "offchain" | "boarding" | "exit" | "batch";

/**
 * The category the history builder assigns to a transaction. The `(string & {})`
 * arm keeps the union open — apps and resolvers can introduce their own
 * categories without a breaking change — while preserving editor autocomplete
 * for the built-in four.
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
     * The {@link TxTag} category assigned by the history builder. Always set on
     * transactions returned by the wallet's `getTransactionHistory()`; optional
     * only because a hand-built `ArkTransaction` may omit it.
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

import type { NormalizedExtendedVirtualCoin } from "./vtxo";

export {
    canRecoverOnchain,
    canSpendOffchain,
    convertVtxo,
    getAllNormalizedVtxos,
    getNormalizedVtxos,
    hasTerminalSpend,
    isExpired,
    isPastExpiry,
    isRecoverable,
    isSpendable,
    isVirtualCoin,
    normalizeVtxo,
    toVirtualStatus,
    type NormalizedExtendedVirtualCoin,
    type NormalizedVirtualCoin,
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
 * @see isRecoverable
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
    /**
     * Signing identity associated with the wallet.
     *
     * A real signer, not a `ReadonlyIdentity` that structurally fits: contract
     * corridors need all four members — `sign`, `signMessage`, `signerSession`
     * and `xOnlyPublicKey` — and `signerSession` is the one a watch-only
     * identity lacks. `isSigningIdentity` is the check; a wallet that fails it
     * is refused as `WalletCannotSignError` before anything is funded, rather
     * than at the push that discovers there is no signer.
     */
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
        eventCallback?: (event: SettlementEvent) => void,
    ): Promise<string>;

    /**
     * Send bitcoin and/or assets to one or more Arkade recipients, passed
     * either as variadic `Recipient`s or as a single `SendParams` object —
     * the latter also carries the inputs to spend.
     *
     * @param args - Recipients, or a `SendParams` object
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

    /** @returns Delegation manager, when configured. */
    getDelegateManager(): Promise<IDelegateManager | undefined>;

    /** @deprecated alias for @see IWallet.getDelegateManager */
    getDelegatorManager(): Promise<IDelegateManager | undefined>;
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
     * @returns virtual outputs with tapscript and witness data, normalized: every canonical fact
     * the capability predicates read is populated, whatever the underlying repository stored
     * @see GetVtxosFilter
     */
    getVtxos(filter?: GetVtxosFilter): Promise<NormalizedExtendedVirtualCoin[]>;

    /**
     * The subset of {@link getVtxos} that generic spending may select: the same
     * filter, minus contracts the generic-spending gate closes, minus funds
     * awaiting recovery under a past-cutoff signer, minus outpoints locked by an
     * in-flight intent. Every implicit coin selection in the SDK reads this;
     * `getVtxos` stays the raw reporting/recovery read.
     *
     * Both exclusion sets are derived from one contract snapshot, so they cannot
     * disagree about which VTXOs exist.
     *
     * @param filter - Same flags, same defaults, as {@link getVtxos}
     * @see GetVtxosFilter
     */
    getSpendableVtxos(filter?: GetVtxosFilter): Promise<NormalizedExtendedVirtualCoin[]>;

    /** @returns Onchain boarding inputs tracked by the wallet. */
    getBoardingUtxos(): Promise<ExtendedCoin[]>;

    /** @returns Wallet transaction history derived from boarding and Arkade activity. */
    getTransactionHistory(): Promise<ArkTransaction[]>;

    /** Resolvers that group/label {@link getActivityHistory} rows. */
    readonly activity: ActivityRegistry;

    /** @returns Wallet history grouped into logical activities with signed net amounts. */
    getActivityHistory(): Promise<Activity[]>;

    /**
     * Get the contract manager associated with this wallet.
     * This is useful for querying contract state and watching for contract events.
     *
     * @returns Contract manager instance
     */
    getContractManager(): Promise<IContractManager>;

    /** Readonly asset manager bound to this wallet instance. */
    assetManager: IReadonlyAssetManager;

    /**
     * Wipe all locally persisted wallet data (VTXOs, UTXOs, history, sync
     * cursor, contracts).
     */
    clear(): Promise<void>;
}
