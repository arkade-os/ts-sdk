import { H as ReadonlyIdentity, a as Identity, a5 as DescriptorSigningRequest, a6 as Transaction, $ as SignerSession, W as WalletRepository, E as ExtendedVirtualCoin, a2 as VtxoRepositoryKey, d as ExtendedCoin, A as ArkTransaction, a3 as WalletState, r as Contract, C as ContractRepository, a4 as ContractFilter, a7 as IntentFeeConfig, a8 as OffchainInput, a9 as FeeAmount, aa as OnchainInput, ab as FeeOutput, m as ArkProvider, Z as SettlementConfig, ac as ContractWatcherConfig, ad as Asset, R as Recipient, I as IWallet, ae as FeeInfo, h as SettlementEvent, D as DescriptorProvider, g as SettleParams, S as SendBitcoinParams, G as GetVtxosFilter, af as CreateContractParams, ag as GetContractsFilter, q as VirtualCoin, ah as GetSpendablePathsOptions, ai as GetAllSpendingPathsOptions, aj as IssuanceParams, ak as ReissuanceParams, al as BurnParams, c as WalletBalance, am as ContractWithVtxos, an as PathSelection, ao as ContractEvent, ap as AssetDetails, aq as IssuanceResult, ar as DelegateInfo, F as IReadonlyWallet, L as IReadonlyAssetManager, as as StorageConfig, e as IContractManager, i as IAssetManager, f as IDelegateManager, at as IVtxoManager, O as OnchainProvider, N as Network, M as NetworkName, U as Coin, au as ExplorerTransaction, p as TapLeafScript, av as EncodedVtxoScript, Y as CSVMultisigTapscript, o as RelativeTimelock, V as VtxoScript, aw as Status, a1 as Intent, ax as ArkTapscript, ay as TapscriptType, az as Outpoint, aA as ChainTx, n as IndexerProvider, t as TxTree } from './ark-loKbOrJY.js';
export { Q as ArkAddress, P as ArkInfo, aB as AssetMetadata, aC as BaseWalletConfig, x as BatchFailedEvent, v as BatchFinalizationEvent, w as BatchFinalizedEvent, aD as BatchInfo, aE as BatchSignableIdentity, B as BatchStartedEvent, aF as CLTVMultisigTapscript, aG as ChainTxType, aH as CommitmentTx, aI as ConditionCSVMultisigTapscript, aJ as ConditionMultisigTapscript, aK as ContractBalance, aL as ContractEventCallback, aM as ContractHandler, X as ContractManager, aN as ContractManagerConfig, aO as ContractState, aP as ContractVtxo, aQ as ContractWatcher, aR as DelegateManagerImpl, aS as DelegateOptions, J as DelegateProvider, aT as DelegatorManagerImpl, aU as DelegatorProvider, aV as Discoverable, aW as DiscoveredContract, aX as DiscoveryDeps, aY as ESPLORA_URL, aZ as EsploraProvider, a_ as ExtendedContractVtxo, a$ as HandlerError, b0 as IDelegatorManager, b1 as IndexerTxType, b2 as KnownMetadata, b3 as MultisigTapscript, b4 as Nonces, b5 as Output, b6 as PageResponse, b7 as PaginationOptions, b8 as PartialSig, b9 as PathContext, ba as ProviderClass, K as ReadonlyWalletConfig, j as RestArkProvider, bb as RestDelegateProvider, bc as RestDelegatorProvider, k as RestIndexerProvider, bd as ScanContractsOptions, be as ScanResult, bf as ScheduledSession, bg as SettlementEventType, bh as SignRequest, a0 as SignedIntent, bi as SubscriptionEvent, bj as SubscriptionHeartbeat, l as SubscriptionResponse, bk as TapLeaves, bl as TapTreeCoder, bm as TreeNonces, u as TreeNoncesEvent, bn as TreePartialSigs, z as TreeSignatureEvent, s as TreeSigningStartedEvent, y as TreeTxEvent, bo as Tx, bp as TxHistoryRecord, bq as TxKey, T as TxNotification, br as TxTreeNode, bs as TxType, bt as VirtualStatus, bu as Vtxo, bv as VtxoChain, _ as VtxoManager, bw as VtxoType, b as WalletConfig, bx as WalletMode, by as decodeTapscript, bz as getSequence, bA as isBatchSignable, bB as isDiscoverable, bC as isExpired, bD as isRecoverable, bE as isSpendable, bF as isSubdust, bG as isVtxoExpiringSoon, bH as networks } from './ark-loKbOrJY.js';
export { D as DefaultContractHandler, a as DefaultContractParams, b as DelegateContractHandler, c as DelegateContractParams, V as VHTLC, d as VHTLCContractHandler, e as VHTLCContractParams, f as contractHandlers } from './index-BwtNRBuI.js';
export { D as DefaultVtxo, a as DelegateVtxo } from './delegate-ga-aZ53T.js';
import { W as Wallet, R as ReadonlyWallet, a as ReceiveRotatorFactory, b as ReceiveRotatorBootOpts, c as ReceiveRotatorBoot, B as Batch } from './wallet-ry_jLRhH.js';
export { I as IncomingFunds, s as selectVirtualCoins, w as waitForIncomingFunds } from './wallet-ry_jLRhH.js';
import { Bytes, BTC_NETWORK } from '@scure/btc-signer/utils.js';
import { P2TR } from '@scure/btc-signer/payment.js';
import { Transaction as Transaction$1, OP, Script, ScriptType } from '@scure/btc-signer';
import { ElectrumWS } from 'ws-electrumx-client';
import { TransactionOutput, TransactionInputUpdate } from '@scure/btc-signer/psbt.js';
import { Transaction as Transaction$2 } from '@scure/btc-signer/transaction.js';
import { S as StorageAdapter } from './index-C0IanN1m.js';
import * as P from 'micro-packed';

/**
 * Tagged envelope for a signing identity transported across the
 * service-worker boundary. All variants are structured-clone safe
 * (plain strings only — no functions or prototypes).
 *
 * `descriptor` carries the wildcard *template* (e.g.
 * `tr([fp/86'/0'/0']xpub.../0/*)`), not a concrete index — the
 * receiving factories require a template, and storing it directly
 * means nothing here has to convert concrete → template on rehydrate.
 *
 * Adding a new variant is a source change in every worker build; keep
 * old variants around until all deployed workers handle them.
 */
type SerializedSigningIdentity = {
    type: "single-key";
    privateKey: string;
} | {
    type: "seed";
    seed: string;
    descriptor: string;
} | {
    type: "mnemonic";
    mnemonic: string;
    descriptor: string;
    passphrase?: string;
};
/**
 * Tagged envelope for a readonly identity transported across the
 * service-worker boundary. All variants are structured-clone safe.
 * `descriptor` is the wildcard template (see
 * {@link SerializedSigningIdentity}).
 */
type SerializedReadonlyIdentity = {
    type: "readonly-single-key";
    publicKey: string;
} | {
    type: "readonly-descriptor";
    descriptor: string;
};
type SerializedIdentity = SerializedSigningIdentity | SerializedReadonlyIdentity;
/**
 * Legacy untagged shape emitted by page builds prior to the tagged
 * SerializedIdentity envelope. Retained so newer workers can still accept
 * older pages during a rolling upgrade. Slated for removal in the next major.
 *
 * @deprecated Use {@link SerializedIdentity}.
 */
type LegacySerializedIdentity = {
    privateKey: string;
} | {
    publicKey: string;
};

/**
 * Read-side HD capability marker. Exposes the wildcard-suffixed account
 * descriptor *template* and the descriptor-membership predicate, but no
 * signing primitives — suitable for watch-only identities backed by an
 * xpub.
 *
 * Extracted from {@link HDCapableIdentity} so that
 * `ReadonlyDescriptorIdentity` can stand in for an HD wallet's read-only
 * surface (template-aware, derives pubkeys at any index) without having
 * to claim signing capability it cannot honour.
 */
interface ReadonlyHDCapableIdentity extends ReadonlyIdentity {
    /**
     * The wildcard-suffixed account descriptor template
     * (e.g. `tr([fp/86'/0'/0']xpub/0/*)`). Consumers materialize a
     * concrete descriptor by replacing the `*` with a derivation index.
     */
    readonly descriptor: string;
    /**
     * True iff `descriptor` derives from this identity's xpub/seed.
     *
     * @deprecated Prefer `DescriptorProvider.isOurs()` via
     * `HDDescriptorProvider` for rotating HD wallets or
     * `StaticDescriptorProvider` for legacy single-key wallets.
     */
    isOurs(descriptor: string): boolean;
}
/**
 * Capability marker for identities that can be rotated through an HD
 * derivation tree AND can sign at each rotated index.
 *
 * Deliberately does NOT extend `DescriptorProvider`: if an HD-capable
 * identity were silently usable as a concrete descriptor source, callers
 * could bypass receive rotation and unknowingly reuse a single address
 * forever. To use this identity as a wallet's descriptor source, wrap
 * it explicitly:
 *
 *  - `HDDescriptorProvider` — rotating, recommended for new wallets.
 *  - `StaticDescriptorProvider` — pinned to a single key, for legacy or
 *    explicitly-non-rotating use cases.
 */
interface HDCapableIdentity extends ReadonlyHDCapableIdentity, Identity {
    /**
     * Signs each request with the key derived from its descriptor.
     *
     * @deprecated Prefer `DescriptorProvider.signWithDescriptor()` via
     * `HDDescriptorProvider` or `StaticDescriptorProvider`. Identities keep
     * this method only as backing implementation for descriptor providers.
     */
    signWithDescriptor(requests: DescriptorSigningRequest[]): Promise<Transaction[]>;
    /**
     * Signs a message using the key derived from `descriptor`.
     *
     * @deprecated Prefer `DescriptorProvider.signMessageWithDescriptor()` via
     * `HDDescriptorProvider` or `StaticDescriptorProvider`. Identities keep
     * this method only as backing implementation for descriptor providers.
     */
    signMessageWithDescriptor(descriptor: string, message: Uint8Array, signatureType?: "schnorr" | "ecdsa"): Promise<Uint8Array>;
}

/** Used for default BIP86 derivation with network selection. */
interface NetworkOptions {
    /**
     * Mainnet (coin type 0) or testnet (coin type 1).
     *
     * @defaultValue `true`
     */
    isMainnet?: boolean;
}
/** Used for a caller-supplied account-descriptor template. */
interface DescriptorOptions {
    /**
     * Account-descriptor *template* — must end with the BIP-32 wildcard
     * suffix `/*)`. Stored as-is on {@link SeedIdentity.descriptor} and
     * read by HD providers to rotate through derivation indices.
     */
    descriptor: string;
}
/** Either default BIP86 derivation (with optional network selection) or a caller-supplied template. */
type SeedIdentityOptions = NetworkOptions | DescriptorOptions;
/** Used for deriving an identity from a BIP39 mnemonic. */
type MnemonicOptions = SeedIdentityOptions & {
    /** Optional BIP39 passphrase for additional seed entropy. */
    passphrase?: string;
};
/**
 * Seed-based identity derived from a raw seed and an account descriptor
 * *template*.
 *
 * This is the recommended identity type for most applications. It uses
 * standard BIP86 (Taproot) derivation by default; callers that need a
 * different path supply the wildcard template directly.
 *
 * Prefer this (or @see MnemonicIdentity) over `SingleKey` for new
 * integrations — `SingleKey` exists for backward compatibility with
 * raw nsec-style keys.
 *
 * The identity holds the wildcard *template* (e.g.
 * `tr([fp/86'/0'/0']xpub/0/*)`) on its public {@link descriptor}
 * field. HD rotation reads it directly; consumers that need a
 * concrete descriptor at a specific index materialize it themselves
 * (see `HDDescriptorProvider` in the wallet layer).
 *
 * Exposes seed-level primitives (signing, derivation, the template)
 * but is deliberately NOT a `DescriptorProvider`. Wrap it explicitly
 * to get one:
 *  - `HDDescriptorProvider` for rotating receive addresses.
 *  - {@link StaticDescriptorProvider} for legacy, single-key behaviour.
 *
 * The split prevents a SeedIdentity from being silently used as a
 * concrete descriptor source, which would defeat HD rotation without
 * any compile-time signal that something was wrong.
 *
 * @example
 * ```typescript
 * const seed = mnemonicToSeedSync(mnemonic);
 *
 * // Testnet (BIP86 wildcard descriptor m/86'/1'/0'/0/*)
 * const identity = SeedIdentity.fromSeed(seed, { isMainnet: false });
 *
 * // Mainnet (BIP86 wildcard descriptor m/86'/0'/0'/0/*)
 * const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
 *
 * // Caller-supplied wildcard descriptor (must end in `/*)`).
 * const identity = SeedIdentity.fromSeed(seed, { descriptor });
 * ```
 */
declare class SeedIdentity implements HDCapableIdentity {
    private readonly derivedKey;
    /**
     * Wildcard account-descriptor template (e.g.
     * `tr([fp/86'/0'/0']xpub/0/*)`). The canonical thing to pass
     * through the system; consumers materialize a concrete descriptor
     * at a specific index themselves (see `HDDescriptorProvider` in
     * the wallet layer for the rotating-counter use case).
     */
    readonly descriptor: string;
    /**
     * Constructs a SeedIdentity from a 64-byte seed and either a
     * caller-supplied wildcard descriptor (`{ descriptor }`) or the
     * default BIP86 path at the requested network (`{ isMainnet }`).
     * Prefer the {@link fromSeed} factory for symmetry with
     * {@link MnemonicIdentity.fromMnemonic}.
     *
     * Throws on a non-wildcard descriptor, an xpub mismatch with the
     * seed, or a missing derivation path.
     */
    constructor(seed: Uint8Array, opts?: SeedIdentityOptions);
    /**
     * Creates a SeedIdentity from a raw 64-byte seed.
     *
     * Pass `{ isMainnet }` for default BIP86 derivation, or
     * `{ descriptor }` for a caller-supplied account-descriptor
     * template (the option's value must end with `/*)`).
     *
     * @param seed - 64-byte seed (typically from mnemonicToSeedSync)
     * @param opts - Network selection or descriptor template.
     */
    static fromSeed(seed: Uint8Array, opts?: SeedIdentityOptions): SeedIdentity;
    xOnlyPublicKey(): Promise<Uint8Array>;
    compressedPublicKey(): Promise<Uint8Array>;
    sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;
    signMessage(message: Uint8Array, signatureType?: "schnorr" | "ecdsa"): Promise<Uint8Array>;
    signerSession(): SignerSession;
    /**
     * Converts to a watch-only identity that cannot sign. Carries the
     * template forward, so the readonly side stays HD-capable (can
     * derive descriptors at any index without seed access).
     */
    toReadonly(): Promise<ReadonlyDescriptorIdentity>;
    /**
     * Returns true when `descriptor` is derived from this identity's seed.
     * HD descriptors match by account xpub; bare `tr(pubkey)` descriptors
     * match by raw pubkey. See {@link descriptorIsOurs}.
     *
     * @deprecated Prefer `DescriptorProvider.isOurs()` via
     * `HDDescriptorProvider` for rotating HD wallets or
     * `StaticDescriptorProvider` for legacy single-key wallets.
     */
    isOurs(descriptor: string): boolean;
    /**
     * Signs each request with the key derived from its descriptor.
     * Each descriptor must share this identity's seed ({@link isOurs}).
     *
     * @deprecated Prefer `DescriptorProvider.signWithDescriptor()` via
     * `HDDescriptorProvider` or `StaticDescriptorProvider`. Identities keep
     * this method only as backing implementation for descriptor providers.
     */
    signWithDescriptor(requests: DescriptorSigningRequest[]): Promise<Transaction[]>;
    /**
     * Signs a message with the key derived from `descriptor`.
     *
     * @deprecated Prefer `DescriptorProvider.signMessageWithDescriptor()` via
     * `HDDescriptorProvider` or `StaticDescriptorProvider`. Identities keep
     * this method only as backing implementation for descriptor providers.
     */
    signMessageWithDescriptor(descriptor: string, message: Uint8Array, signatureType?: "schnorr" | "ecdsa"): Promise<Uint8Array>;
    private derivePrivateKeyForDescriptor;
    private signTxWithKey;
    private signMessageWithKey;
}
/**
 * Mnemonic-based identity derived from a BIP39 phrase.
 *
 * This is the most user-friendly identity type — recommended for wallet
 * applications where users manage their own backup phrase. Extends
 * @see SeedIdentity with mnemonic validation and optional passphrase
 * support.
 *
 * @example
 * ```typescript
 * const identity = MnemonicIdentity.fromMnemonic(
 *   'abandon abandon abandon ...',
 *   { isMainnet: true, passphrase: 'secret' }
 * );
 * ```
 */
declare class MnemonicIdentity extends SeedIdentity {
    private constructor();
    /**
     * Creates a MnemonicIdentity from a BIP39 mnemonic phrase.
     *
     * Pass `{ isMainnet }` for default BIP86 derivation, or
     * `{ descriptor }` for a caller-supplied account-descriptor
     * template (the option's value must end with `/*)`).
     *
     * @param phrase - BIP39 mnemonic phrase (12 or 24 words)
     * @param opts - Network selection or descriptor template, plus optional passphrase
     */
    static fromMnemonic(phrase: string, opts?: MnemonicOptions): MnemonicIdentity;
}
/**
 * Watch-only HD identity from a descriptor *template*.
 *
 * Can derive public keys but cannot sign transactions. Use this for
 * watch-only wallets — given just an xpub-based template, the readonly
 * side still rotates through HD indices.
 *
 * Constructed from a wildcard template (e.g.
 * `tr([fp/86'/0'/0']xpub.../0/*)`); the {@link descriptor} field
 * holds it for HD providers to consume.
 *
 * @example
 * ```typescript
 * const ro = ReadonlyDescriptorIdentity.fromDescriptor(
 *   "tr([fp/86'/0'/0']xpub.../0/*)"
 * );
 * ro.descriptor;
 * // => "tr([fp/86'/0'/0']xpub.../0/*)" — the template
 * ```
 */
declare class ReadonlyDescriptorIdentity implements ReadonlyHDCapableIdentity {
    /**
     * Index-0 expansion of {@link descriptor}. Both the x-only pubkey
     * (taproot, returned by the library as 32 bytes) and the compressed
     * pubkey (derived through the bip32 node when needed) are read off
     * this on demand — no separate caches.
     */
    private readonly indexZero;
    /**
     * Wildcard account-descriptor template (e.g.
     * `tr([fp/86'/0'/0']xpub/0/*)`). HD rotation consumers materialize
     * a concrete descriptor at a specific index themselves.
     */
    readonly descriptor: string;
    private constructor();
    /**
     * Creates a ReadonlyDescriptorIdentity from an account-descriptor
     * *template* (must end with the BIP-32 wildcard suffix `/*)`).
     *
     * @param descriptor - Wildcard-suffixed Taproot template
     *   (`tr([fp/path']xpub.../child/*)`).
     */
    static fromDescriptor(descriptor: string): ReadonlyDescriptorIdentity;
    xOnlyPublicKey(): Promise<Uint8Array>;
    compressedPublicKey(): Promise<Uint8Array>;
    /**
     * Returns true when `descriptor` derives from this identity's xpub.
     * HD descriptors match by account xpub; bare `tr(pubkey)` descriptors
     * fall back to comparing against the index-0 x-only pubkey. See
     * {@link descriptorIsOurs}.
     *
     * @deprecated Prefer `DescriptorProvider.isOurs()` via
     * `HDDescriptorProvider` for rotating HD wallets or
     * `StaticDescriptorProvider` for legacy single-key wallets.
     */
    isOurs(descriptor: string): boolean;
}

/**
 * In-memory single key implementation for Bitcoin transaction signing.
 *
 * @example
 * ```typescript
 * // Create from hex string
 * const key = SingleKey.fromHex('your_private_key_hex');
 *
 * // Create from raw bytes
 * const key = SingleKey.fromPrivateKey(privateKeyBytes);
 *
 * // Create random key
 * const randomKey = SingleKey.fromRandomBytes();
 *
 * // Sign a transaction
 * const signedTx = await key.sign(transaction);
 * ```
 */
declare class SingleKey implements Identity {
    private key;
    private constructor();
    /** Create a signing identity from raw private key bytes. */
    static fromPrivateKey(privateKey: Uint8Array): SingleKey;
    /** Create a signing identity from a hex-encoded private key. */
    static fromHex(privateKeyHex: string): SingleKey;
    /** Create a signing identity with a freshly generated random private key. */
    static fromRandomBytes(): SingleKey;
    /**
     * Export the private key as a hex string.
     *
     * @returns The private key as a hex string
     */
    toHex(): string;
    sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;
    compressedPublicKey(): Promise<Uint8Array>;
    xOnlyPublicKey(): Promise<Uint8Array>;
    signerSession(): SignerSession;
    signMessage(message: Uint8Array, signatureType?: "schnorr" | "ecdsa"): Promise<Uint8Array>;
    toReadonly(): Promise<ReadonlySingleKey>;
}
declare class ReadonlySingleKey implements ReadonlyIdentity {
    private readonly publicKey;
    /** Create a readonly identity from a compressed public key. */
    constructor(publicKey: Uint8Array);
    /**
     * Create a ReadonlySingleKey from a compressed public key.
     *
     * @param publicKey - 33-byte compressed public key (02/03 prefix + 32-byte x coordinate)
     * @returns A new ReadonlySingleKey instance
     * @example
     * ```typescript
     * const pubkey = new Uint8Array(33); // your compressed public key
     * const readonlyKey = ReadonlySingleKey.fromPublicKey(pubkey);
     * ```
     */
    static fromPublicKey(publicKey: Uint8Array): ReadonlySingleKey;
    xOnlyPublicKey(): Promise<Uint8Array>;
    compressedPublicKey(): Promise<Uint8Array>;
}

/**
 * In-memory implementation of WalletRepository.
 * Data is ephemeral and scoped to the instance.
 */
declare class InMemoryWalletRepository implements WalletRepository {
    readonly version: 1;
    private readonly vtxosByAddress;
    private readonly utxosByAddress;
    private readonly txsByAddress;
    private walletState;
    getVtxos(address: string): Promise<ExtendedVirtualCoin[]>;
    saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    deleteVtxos(address: string): Promise<void>;
    getVtxosForScript(script: string): Promise<ExtendedVirtualCoin[]>;
    saveVtxosForScript(key: VtxoRepositoryKey, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    deleteVtxosForScript(script: string): Promise<void>;
    getUtxos(address: string): Promise<ExtendedCoin[]>;
    saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void>;
    deleteUtxos(address: string): Promise<void>;
    getTransactionHistory(address: string): Promise<ArkTransaction[]>;
    saveTransactions(address: string, txs: ArkTransaction[]): Promise<void>;
    deleteTransactions(address: string): Promise<void>;
    getWalletState(): Promise<WalletState | null>;
    saveWalletState(state: WalletState): Promise<void>;
    clear(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Encode a contract to the arkcontract string format.
 *
 * Format: arkcontract={type}&{key1}={value1}&{key2}={value2}...
 *
 * This format is compatible with NArk and allows contracts to be
 * shared/imported across different Arkade SDKs.
 *
 * @example
 * ```typescript
 * const contract: Contract = {
 *   type: "vhtlc",
 *   params: { sender: "ab12...", receiver: "cd34...", ... },
 *   // ...
 * };
 *
 * const encoded = encodeArkContract(contract);
 * // "arkcontract=vhtlc&sender=ab12...&receiver=cd34...&..."
 * ```
 */
declare function encodeArkContract(contract: Contract): string;
/**
 * Parsed result from decoding an arkcontract string.
 *
 * This is a low-level representation. For type-safe contract creation,
 * use `contractFromArkContract` or `contractFromArkContractWithAddress`
 * which validate params through the handler system.
 */
interface ParsedArkContract {
    /** Contract type (e.g., "vhtlc", "default") */
    type: string;
    /** All key-value pairs from the string */
    data: Record<string, string>;
}
/**
 * Decode an arkcontract string into raw type and data.
 *
 * This is a low-level function that parses the URL-encoded format.
 * For creating typed Contract objects, use `contractFromArkContract`
 * or `contractFromArkContractWithAddress` instead.
 *
 * @param encoded - The arkcontract string
 * @returns Parsed type and key-value data
 * @throws If the string is not a valid arkcontract
 *
 * @example
 * ```typescript
 * const parsed = decodeArkContract("arkcontract=vhtlc&sender=ab12...");
 * // { type: "vhtlc", data: { sender: "ab12...", ... } }
 * ```
 */
declare function decodeArkContract(encoded: string): ParsedArkContract;
/**
 * Create a Contract from an arkcontract string.
 *
 * This requires a handler to be registered for the contract type.
 *
 * @param encoded - The arkcontract string
 * @param options - Additional options for the contract
 * @returns A Contract object
 * @throws If the string is invalid or no handler exists for the type
 *
 * @example
 * ```typescript
 * const contract = contractFromArkContract(
 *   "arkcontract=vhtlc&sender=ab12...",
 *   {
 *     label: "Lightning Receive",
 *   }
 * );
 * ```
 */
declare function contractFromArkContract(encoded: string, options?: {
    label?: string;
    state?: "active" | "inactive";
    metadata?: Record<string, unknown>;
}): Omit<Contract, "script" | "address"> & {
    script?: string;
    address?: string;
};
/**
 * Create a full Contract with derived script and address.
 *
 * @param encoded - The arkcontract string
 * @param serverPubKey - Server public key (for address derivation)
 * @param addressPrefix - Address prefix (e.g., "tark" for testnet)
 * @param options - Additional options
 * @returns A complete Contract object
 */
declare function contractFromArkContractWithAddress(encoded: string, serverPubKey: Uint8Array, addressPrefix?: string, options?: {
    label?: string;
    state?: "active" | "inactive";
    metadata?: Record<string, unknown>;
}): Contract;
/**
 * Check if a string is an arkcontract.
 */
declare function isArkContract(str: string): boolean;

/**
 * In-memory implementation of ContractRepository.
 * Data is ephemeral and scoped to the instance.
 */
declare class InMemoryContractRepository implements ContractRepository {
    readonly version: 1;
    private readonly contractData;
    private readonly collections;
    private readonly contractsByScript;
    clear(): Promise<void>;
    getContracts(filter?: ContractFilter): Promise<Contract[]>;
    saveContract(contract: Contract): Promise<void>;
    deleteContract(script: string): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}

/**
 * IndexedDB-based implementation of ContractRepository.
 *
 * Data is stored as JSON strings in key/value stores.
 */
declare class IndexedDBContractRepository implements ContractRepository {
    private readonly dbName;
    readonly version: 1;
    private db;
    constructor(dbName?: string);
    clear(): Promise<void>;
    getContracts(filter?: ContractFilter): Promise<Contract[]>;
    saveContract(contract: Contract): Promise<void>;
    deleteContract(script: string): Promise<void>;
    private getContractsByIndexValues;
    private applyContractFilter;
    private getDB;
    [Symbol.asyncDispose](): Promise<void>;
}

/**
 * IndexedDB-based implementation of WalletRepository.
 */
declare class IndexedDBWalletRepository implements WalletRepository {
    private readonly dbName;
    readonly version: 1;
    private db;
    constructor(dbName?: string);
    clear(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
    getVtxos(address: string): Promise<ExtendedVirtualCoin[]>;
    saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    deleteVtxos(address: string): Promise<void>;
    getVtxosForScript(script: string): Promise<ExtendedVirtualCoin[]>;
    saveVtxosForScript(key: VtxoRepositoryKey, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    deleteVtxosForScript(script: string): Promise<void>;
    getUtxos(address: string): Promise<ExtendedCoin[]>;
    saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void>;
    deleteUtxos(address: string): Promise<void>;
    getTransactionHistory(address: string): Promise<ArkTransaction[]>;
    saveTransactions(address: string, txs: ArkTransaction[]): Promise<void>;
    deleteTransactions(address: string): Promise<void>;
    getWalletState(): Promise<WalletState | null>;
    saveWalletState(state: WalletState): Promise<void>;
    private getDB;
}

declare const MIGRATION_KEY: (repoType: "wallet" | "contract") => string;
type MigrationStatus = "pending" | "in-progress" | "done" | "not-needed";
declare function getMigrationStatus(repoType: "wallet" | "contract", storageAdapter: StorageAdapter): Promise<MigrationStatus>;
declare function requiresMigration(repoType: "wallet" | "contract", storageAdapter: StorageAdapter): Promise<boolean>;
declare function rollbackMigration(repoType: "wallet" | "contract", storageAdapter: StorageAdapter): Promise<void>;
/**
 * Migrate wallet data from the legacy storage adapter to the new one.
 * It accepts both onchain and offchain addresses, make sure to pass both.
 *
 * @param storageAdapter
 * @param fresh
 * @param addresses
 */
declare function migrateWalletRepository(storageAdapter: StorageAdapter, fresh: WalletRepository, addresses: {
    onchain: string[];
    offchain: string[];
}): Promise<void>;

/**
 * @deprecated This is only to be used in migration from storage V1
 */
declare class WalletRepositoryImpl implements WalletRepository {
    readonly version: 1;
    private storage;
    constructor(storage: StorageAdapter);
    getVtxos(address: string): Promise<ExtendedVirtualCoin[]>;
    saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    clearVtxos(address: string): Promise<void>;
    deleteVtxos(address: string): Promise<void>;
    getUtxos(address: string): Promise<ExtendedCoin[]>;
    saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void>;
    clearUtxos(address: string): Promise<void>;
    deleteUtxos(address: string): Promise<void>;
    getTransactionHistory(address: string): Promise<ArkTransaction[]>;
    saveTransactions(address: string, txs: ArkTransaction[]): Promise<void>;
    clearTransactions(address: string): Promise<void>;
    deleteTransactions(address: string): Promise<void>;
    getWalletState(): Promise<WalletState | null>;
    saveWalletState(state: WalletState): Promise<void>;
    clear(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}

/**
 * @deprecated This is only to be used in migration from storage V1
 */
declare class ContractRepositoryImpl implements ContractRepository {
    readonly version: 1;
    private storage;
    constructor(storage: StorageAdapter);
    getContractData<T>(contractId: string, key: string): Promise<T | null>;
    setContractData<T>(contractId: string, key: string, data: T): Promise<void>;
    deleteContractData(contractId: string, key: string): Promise<void>;
    getContractCollection<T>(contractType: string): Promise<ReadonlyArray<T>>;
    saveToContractCollection<T, K extends keyof T>(contractType: string, item: T, idField: K): Promise<void>;
    removeFromContractCollection<T, K extends keyof T>(contractType: string, id: T[K], idField: K): Promise<void>;
    getContracts(_?: ContractFilter): Promise<Contract[]>;
    saveContract(_: Contract): Promise<void>;
    deleteContract(_: string): Promise<void>;
    clear(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}

/**
 * Estimator evaluates CEL expressions to calculate fees for Arkade intents
 */
declare class Estimator {
    readonly config: IntentFeeConfig;
    private intentOffchainInput?;
    private intentOnchainInput?;
    private intentOffchainOutput?;
    private intentOnchainOutput?;
    /**
     * Creates a new Estimator with the given config
     * @param config - Configuration containing CEL programs for fee calculation
     */
    constructor(config: IntentFeeConfig);
    /**
     * Evaluates the fee for a given vtxo input
     * @param input - The offchain input to evaluate
     * @returns The fee amount for this input
     */
    evalOffchainInput(input: OffchainInput): FeeAmount;
    /**
     * Evaluates the fee for a given boarding input
     * @param input - The onchain input to evaluate
     * @returns The fee amount for this input
     */
    evalOnchainInput(input: OnchainInput): FeeAmount;
    /**
     * Evaluates the fee for a given vtxo output
     * @param output - The output to evaluate
     * @returns The fee amount for this output
     */
    evalOffchainOutput(output: FeeOutput): FeeAmount;
    /**
     * Evaluates the fee for a given collaborative exit output
     * @param output - The output to evaluate
     * @returns The fee amount for this output
     */
    evalOnchainOutput(output: FeeOutput): FeeAmount;
    /**
     * Evaluates the fee for a given set of inputs and outputs
     * @param offchainInputs - Array of offchain inputs to evaluate
     * @param onchainInputs - Array of onchain inputs to evaluate
     * @param offchainOutputs - Array of offchain outputs to evaluate
     * @param onchainOutputs - Array of onchain outputs to evaluate
     * @returns The total fee amount
     */
    eval(offchainInputs: OffchainInput[], onchainInputs: OnchainInput[], offchainOutputs: FeeOutput[], onchainOutputs: FeeOutput[]): FeeAmount;
}

/**
 * Thrown when a rotated contract (default or delegate) is missing the
 * metadata.signingDescriptor required to route it to a descriptor-aware
 * signer.
 */
declare class MissingSigningDescriptorError extends Error {
    readonly contractScript: string;
    readonly contractType: "default" | "delegate";
    readonly name = "MissingSigningDescriptorError";
    constructor(contractScript: string, contractType: "default" | "delegate");
}
/**
 * Thrown when an input needs descriptor-aware signing but no
 * DescriptorProvider was wired into the wallet.
 */
declare class DescriptorSigningProviderMissingError extends Error {
    readonly name = "DescriptorSigningProviderMissingError";
    constructor();
}

type RequestEnvelope = {
    tag: string;
    id: string;
    broadcast?: boolean;
};
type ResponseEnvelope = {
    tag: string;
    id?: string;
    error?: Error;
    broadcast?: boolean;
};
interface MessageHandler<REQ extends RequestEnvelope = RequestEnvelope, RES extends ResponseEnvelope = ResponseEnvelope> {
    /**
     * A unique identifier for the updater.
     * This is used to route messages to the correct updater.
     */
    readonly messageTag: string;
    /**
     * Called once when the SW is starting up
     * @param services - Providers and wallet instances available to the handler.
     * @param repositories - Repositories available to the handler.
     **/
    start(services: {
        arkProvider: ArkProvider;
        wallet?: Wallet;
        readonlyWallet: ReadonlyWallet;
    }, repositories: {
        walletRepository: WalletRepository;
    }): Promise<void>;
    /** Called once when the SW is shutting down */
    stop(): Promise<void>;
    /**
     * Called by the scheduler to perform a tick.
     * Can be used by the updater to perform periodic tasks or return
     * delayed responses (eg: subscriptions).
     * @param now The current time in milliseconds since the epoch.
     **/
    tick(now: number): Promise<RES[]>;
    /**
     * Handle routed messages from the clients
     **/
    handleMessage(message: REQ): Promise<RES | null>;
    /**
     * Optional opt-out from the bus-level message timeout.
     *
     * Long-running flows (e.g. settlement) surrender control to remote peers
     * and can legitimately sit idle for longer than `messageTimeoutMs`. When
     * this returns true, the bus awaits `handleMessage` without a deadline.
     * Defaults to false.
     */
    isLongRunning?(message: REQ): boolean;
}
type Options = {
    messageHandlers: MessageHandler[];
    tickIntervalMs?: number;
    messageTimeoutMs?: number;
    /**
     * Per-operation timeout overrides. Keys are either message types
     * (e.g. "SETTLE") or handler tags (e.g. "WALLET_UPDATER"). Message-type
     * matches take precedence over tag matches. Unspecified operations use
     * `messageTimeoutMs`. These are treated as defaults: any map supplied
     * via `INITIALIZE_MESSAGE_BUS` overrides per-key and is re-applied on
     * every (re-)init.
     */
    messageTimeoutOverrides?: Record<string, number>;
    debug?: boolean;
    buildServices?: (config: Initialize["config"]) => Promise<{
        arkProvider: ArkProvider;
        wallet?: Wallet;
        readonlyWallet: ReadonlyWallet;
    }>;
};
type Initialize = {
    type: "INITIALIZE_MESSAGE_BUS";
    id: string;
    config: {
        wallet: SerializedIdentity | LegacySerializedIdentity;
        arkServer: {
            url: string;
            publicKey?: string;
        };
        delegateUrl?: string;
        /** @deprecated alias for @see Initialize.config.delegateUrl */
        delegatorUrl?: string;
        indexerUrl?: string;
        esploraUrl?: string;
        settlementConfig?: SettlementConfig | false;
        walletMode?: "auto" | "static" | "hd";
        watcherConfig?: Partial<Omit<ContractWatcherConfig, "indexerProvider">>;
        /**
         * Page-supplied per-operation timeout map. Keys are message types
         * (e.g. "SETTLE"). Overrides constructor-supplied
         * `messageTimeoutOverrides` per-key; re-applied on every init.
         */
        messageTimeouts?: Record<string, number>;
    };
};
declare class MessageBus {
    private readonly walletRepository;
    private readonly contractRepository;
    private handlers;
    private tickIntervalMs;
    private messageTimeoutMs;
    private readonly constructorTimeoutOverrides;
    private messageTimeoutOverrides;
    private lateDeliveries;
    private running;
    private tickTimeout;
    private tickInProgress;
    private debug;
    private initialized;
    private readonly buildServicesFn;
    private readonly boundOnMessage;
    /** Create the service-worker message bus with repositories and handler configuration. */
    constructor(walletRepository: WalletRepository, contractRepository: ContractRepository, { messageHandlers, tickIntervalMs, messageTimeoutMs, messageTimeoutOverrides, debug, buildServices, }: Options);
    /** Start the message bus and attach service-worker event listeners. */
    start(): Promise<void>;
    /** Stop the message bus, cancel ticks, and stop all registered handlers. */
    stop(): Promise<void>;
    private scheduleNextTick;
    private runTick;
    private waitForInit;
    private buildServices;
    private onMessage;
    private processMessage;
    /**
     * Race `promise` against a timeout. Note: this does NOT cancel the
     * underlying work — the original promise keeps running. Call
     * `attachLateDelivery` after catching the timeout to surface the
     * eventual result so the message id does not go silent.
     */
    private withTimeout;
    /**
     * Extract the declared `type` from a request envelope (e.g. "SETTLE").
     * Not every envelope carries a type (PING/INIT are special cased
     * earlier), so this returns undefined for envelopes that lack one.
     */
    private extractMessageType;
    /**
     * Resolve the timeout for an operation. Message-type overrides take
     * precedence over handler-tag overrides, with the bus-wide default
     * (`messageTimeoutMs`) as the final fallback.
     */
    private resolveTimeoutMs;
    /**
     * Build a human-readable label for timeout errors. Format:
     * `"<MESSAGE_TYPE> via <HANDLER_TAG>"` when both are known, else the
     * handler tag alone. Used so timeout errors name the operation the
     * client actually triggered (e.g. SETTLE) rather than just the
     * handler that received it (e.g. WALLET_UPDATER).
     */
    private labelFor;
    /**
     * Post a response to the originating client. When `source` is null
     * (client tab closed, detached frame, etc.) the response cannot be
     * delivered; we log the drop in debug mode so it is not invisible.
     */
    private deliverResponse;
    /**
     * After a handler times out the client has already received a timeout
     * error, but the handler keeps running. Attach a follow-up so the
     * handler's eventual result (or error) is delivered under the same
     * message id, or — if the handler never completes within
     * {@link LATE_DELIVERY_GRACE_MS} — an "Operation abandoned" error is
     * sent so the client's listener (if still attached) does not hang.
     */
    private attachLateDelivery;
    /**
     * Returns the registered SW for the path.
     * It uses the functions in `service-worker-manager.ts` module.
     * @param path
     * @return the Service Worker
     * @throws if not running in a browser environment
     */
    static getServiceWorker(path?: string): Promise<ServiceWorker>;
    /**
     * Set up and register the Service Worker, ensuring it's done once at most.
     * It uses the functions in `service-worker-manager.ts` module.
     * @param path
     * @return the Service Worker
     * @throws if not running in a browser environment
     */
    static setup(path: string): Promise<ServiceWorker>;
}

declare enum AssetInputType {
    Unspecified = 0,
    Local = 1,
    Intent = 2
}
declare enum AssetRefType {
    Unspecified = 0,
    ByID = 1,
    ByGroup = 2
}

declare class BufferWriter {
    private buffer;
    write(data: Uint8Array): void;
    writeByte(byte: number): void;
    writeUint16LE(value: number): void;
    writeVarUint(value: bigint | number): void;
    writeVarSlice(data: Uint8Array): void;
    writeCompactSize(value: number): void;
    writeCompactSlice(data: Uint8Array): void;
    toBytes(): Uint8Array;
}
declare class BufferReader {
    private view;
    private offset;
    constructor(data: Uint8Array);
    remaining(): number;
    readByte(): number;
    readSlice(size: number): Uint8Array;
    readUint16LE(): number;
    readVarUint(): bigint;
    readVarSlice(): Uint8Array;
    readCompactSize(): number;
    readCompactSlice(): Uint8Array;
}

/**
 * AssetId identifies a specific asset.
 *
 * @remarks
 * Asset ids are derived from the genesis transaction id plus the asset group index.
 *
 * @see AssetRef
 *
 * @example
 * ```typescript
 * const assetId = AssetId.create('00'.repeat(32), 0)
 * const encoded = assetId.toString()
 * const decoded = AssetId.fromString(encoded)
 * ```
 */
declare class AssetId {
    readonly txid: Uint8Array;
    readonly groupIndex: number;
    private constructor();
    /**
     * Create an asset id from a genesis transaction id and group index.
     *
     * @param txid - Hex-encoded genesis transaction id
     * @param groupIndex - Asset group index within the genesis transaction
     * @returns A validated asset id
     * @throws Error if the txid is missing, malformed, or not 32 bytes long
     * @see fromString
     */
    static create(txid: string, groupIndex: number): AssetId;
    /**
     * Decode an asset id from its hex string representation.
     *
     * @param s - Hex-encoded asset id
     * @returns Decoded asset id
     * @throws Error if the string is not valid hex or does not encode a valid asset id
     * @see toString
     */
    static fromString(s: string): AssetId;
    /**
     * Decode an asset id from its serialized bytes.
     *
     * @param buf - Serialized asset id bytes
     * @returns Decoded asset id
     * @throws Error if the buffer length is invalid
     */
    static fromBytes(buf: Uint8Array): AssetId;
    /**
     * Serialize the asset id to raw bytes.
     *
     * @returns Serialized asset id bytes
     * @see fromBytes
     */
    serialize(): Uint8Array;
    /**
     * Encode the asset id to a hex string.
     *
     * @returns Hex-encoded asset id
     * @see fromString
     */
    toString(): string;
    /**
     * Validate the asset id fields.
     *
     * @throws Error if the txid is empty or the group index is out of range
     */
    validate(): void;
    /**
     * Decode an asset id from a binary reader.
     *
     * @param reader - Reader positioned at an asset id
     * @returns Decoded asset id
     * @throws Error if the reader does not contain enough bytes
     */
    static fromReader(reader: BufferReader): AssetId;
    /**
     * Serialize the asset id into an existing binary writer.
     *
     * @param writer - Writer to append the asset id to
     * @see serialize
     */
    serializeTo(writer: BufferWriter): void;
}

type AssetRefByID = {
    type: AssetRefType.ByID;
    assetId: AssetId;
};
type AssetRefByGroup = {
    type: AssetRefType.ByGroup;
    groupIndex: number;
};
/**
 * Reference to either an explicit asset id or another asset group in the same packet.
 *
 * @see AssetId
 *
 * @example
 * ```typescript
 * const refById = AssetRef.fromId(assetId)
 * const refByGroup = AssetRef.fromGroupIndex(0)
 * ```
 */
declare class AssetRef {
    readonly ref: AssetRefByID | AssetRefByGroup;
    private constructor();
    /** Reference type discriminator. */
    get type(): AssetRefType;
    /**
     * Create an asset reference that points to a specific asset id.
     *
     * @param assetId - Asset id referenced by this pointer
     * @returns Asset reference by id
     * @see fromGroupIndex
     */
    static fromId(assetId: AssetId): AssetRef;
    /**
     * Create an asset reference that points to another asset group by index.
     *
     * @param groupIndex - Zero-based asset group index in the packet
     * @returns Asset reference by group index
     * @see fromId
     */
    static fromGroupIndex(groupIndex: number): AssetRef;
    /**
     * Decode an asset reference from its hex string form.
     *
     * @param s - Hex-encoded asset reference
     * @returns Decoded asset reference
     * @throws Error if the string is not valid hex or does not encode a valid asset reference
     * @see toString
     */
    static fromString(s: string): AssetRef;
    /**
     * Decode an asset reference from its serialized bytes.
     *
     * @param buf - Serialized asset reference bytes
     * @returns Decoded asset reference
     * @throws Error if the buffer is empty or malformed
     */
    static fromBytes(buf: Uint8Array): AssetRef;
    /**
     * Serialize the asset reference to raw bytes.
     *
     * @returns Serialized asset reference bytes
     * @see fromBytes
     */
    serialize(): Uint8Array;
    /**
     * Encode the asset reference to a hex string.
     *
     * @returns Hex-encoded asset reference
     * @see fromString
     */
    toString(): string;
    /**
     * Decode an asset reference from a binary reader.
     *
     * @param reader - Reader positioned at an asset reference
     * @returns Decoded asset reference
     * @throws Error if the type is unknown or the reader does not contain enough bytes
     */
    static fromReader(reader: BufferReader): AssetRef;
    /**
     * Serialize the asset reference into an existing binary writer.
     *
     * @param writer - Writer to append the asset reference to
     * @see serialize
     */
    serializeTo(writer: BufferWriter): void;
}

type AssetInputLocal = {
    type: AssetInputType.Local;
    vin: number;
    amount: bigint;
};
type AssetInputIntent = Pick<AssetInputLocal, "vin" | "amount"> & {
    type: AssetInputType.Intent;
    txid: Uint8Array;
};
/**
 * AssetInput represents an input of an asset group.
 * a local input references a real transaction input and specify the amount in satoshis.
 * an intent input references an external intent transaction. It is created by the server to handle batch leaf transaction.
 */
declare class AssetInput {
    readonly input: AssetInputLocal | AssetInputIntent;
    private constructor();
    /** Gets the transaction input index for an asset input, e.g. 0 */
    get vin(): number;
    /** Gets the amount for an input (in most cases, 330 sats) */
    get amount(): bigint;
    /** Create a local asset input that points at a transaction input index. */
    static create(vin: number, amount: bigint | number): AssetInput;
    /** Create an intent-backed asset input referencing an external intent transaction. */
    static createIntent(txid: string, vin: number, amount: bigint | number): AssetInput;
    /** Decode an asset input from its hex string form. */
    static fromString(s: string): AssetInput;
    /** Decode an asset input from its serialized bytes. */
    static fromBytes(buf: Uint8Array): AssetInput;
    /** Serialize the asset input to raw bytes. */
    serialize(): Uint8Array;
    /** Encode the asset input to a hex string. */
    toString(): string;
    /** Validate the asset input fields. */
    validate(): void;
    /** Decode an asset input from a buffer reader. */
    static fromReader(reader: BufferReader): AssetInput;
    /** Serialize the asset input into an existing buffer writer. */
    serializeTo(writer: BufferWriter): void;
}
/**
 * AssetInputs represents a list of asset inputs.
 */
declare class AssetInputs {
    readonly inputs: AssetInput[];
    private constructor();
    /** Create a validated list of asset inputs. */
    static create(inputs: AssetInput[]): AssetInputs;
    /** Decode an asset input list from its hex string form. */
    static fromString(s: string): AssetInputs;
    /** Serialize the asset input list to raw bytes. */
    serialize(): Uint8Array;
    /** Encode the asset input list to a hex string. */
    toString(): string;
    /** Validate the asset input list. */
    validate(): void;
    /** Decode an asset input list from a buffer reader. */
    static fromReader(reader: BufferReader): AssetInputs;
    /** Serialize the asset input list into an existing buffer writer. */
    serializeTo(writer: BufferWriter): void;
}

/**
 * AssetOutput references a real transaction output and specify the amount in satoshis.
 * it must be present in an AssetGroup.
 *
 * @param vout - the output index in the transaction
 * @param amount - asset amount in satoshis
 */
declare class AssetOutput {
    readonly vout: number;
    readonly amount: bigint;
    static readonly TYPE_LOCAL = 1;
    private constructor();
    /** Create a local asset output referencing a transaction output index. */
    static create(vout: number, amount: bigint | number): AssetOutput;
    /** Decode an asset output from its hex string form. */
    static fromString(s: string): AssetOutput;
    /** Decode an asset output from its serialized bytes. */
    static fromBytes(buf: Uint8Array): AssetOutput;
    /** Serialize the asset output to raw bytes. */
    serialize(): Uint8Array;
    /** Encode the asset output to a hex string. */
    toString(): string;
    /** Validate the asset output fields. */
    validate(): void;
    /** Decode an asset output from a buffer reader. */
    static fromReader(reader: BufferReader): AssetOutput;
    /** Serialize the asset output into an existing buffer writer. */
    serializeTo(writer: BufferWriter): void;
}
/**
 * AssetOutputs is a list of AssetOutput references.
 * it must be present in an AssetGroup.
 *
 * @param outputs - the list of asset outputs
 */
declare class AssetOutputs {
    readonly outputs: AssetOutput[];
    private constructor();
    /** Create a validated list of asset outputs. */
    static create(outputs: AssetOutput[]): AssetOutputs;
    /** Decode an asset output list from its hex string form. */
    static fromString(s: string): AssetOutputs;
    /** Serialize the asset output list to raw bytes. */
    serialize(): Uint8Array;
    /** Encode the asset output list to a hex string. */
    toString(): string;
    /** Validate the asset output list. */
    validate(): void;
    /** Decode an asset output list from a buffer reader. */
    static fromReader(reader: BufferReader): AssetOutputs;
    /** Serialize the asset output list into an existing buffer writer. */
    serializeTo(writer: BufferWriter): void;
}

/**
 * Metadata represents a key-value pair.
 * @param key - the key
 * @param value - the value
 */
declare class Metadata {
    readonly key: Uint8Array;
    readonly value: Uint8Array;
    private constructor();
    /** Create a metadata entry from raw key and value bytes. */
    static create(key: Bytes, value: Bytes): Metadata;
    /** Decode metadata from its hex string form. */
    static fromString(s: string): Metadata;
    /** Decode metadata from its serialized bytes. */
    static fromBytes(buf: Uint8Array): Metadata;
    /** Serialize metadata to raw bytes. */
    serialize(): Uint8Array;
    /** Encode metadata to a hex string. */
    toString(): string;
    get keyString(): string;
    get valueString(): string;
    /** Validate the metadata key and value. */
    validate(): void;
    /** Decode metadata from a buffer reader. */
    static fromReader(reader: BufferReader): Metadata;
    /** Serialize metadata into an existing buffer writer. */
    serializeTo(writer: BufferWriter): void;
}
declare class MetadataList {
    readonly items: Metadata[];
    static readonly ARK_LEAF_TAG = "ArkadeAssetLeaf";
    static readonly ARK_BRANCH_TAG = "ArkadeAssetBranch";
    static readonly ARK_LEAF_VERSION = 0;
    constructor(items: Metadata[]);
    /** Create a metadata list from its hex string form. */
    static fromString(s: string): MetadataList;
    /** Decode a metadata list from its serialized bytes. */
    static fromBytes(buf: Uint8Array): MetadataList;
    /** Decode a metadata list from a buffer reader. */
    static fromReader(reader: BufferReader): MetadataList;
    /** Serialize the metadata list into an existing buffer writer. */
    serializeTo(writer: BufferWriter): void;
    /** Serialize the metadata list to raw bytes. */
    serialize(): Uint8Array;
    /** Iterate through metadata entries in insertion order. */
    [Symbol.iterator](): Iterator<Metadata>;
    get length(): number;
    /** Compute the tagged Merkle root for the metadata list. */
    hash(): Uint8Array;
}

/**
 * An asset group contains inputs, outputs, and all data related to a given asset id.
 *
 * @see Packet
 * @see AssetId
 * @see AssetRef
 *
 * @example
 * ```typescript
 * const group = AssetGroup.create(
 *   null,                              // asset ID: null for new issuance
 *   null,                              // control asset ID: null when reissuance not needed
 *   [],                                // asset inputs: empty for new issuance
 *   [AssetOutput.create(0, 1000)],     // asset outputs: 1000 units at vout index 0
 *   []                                 // metadata: can be empty
 * )
 * ```
 */
declare class AssetGroup {
    readonly assetId: AssetId | null;
    readonly controlAsset: AssetRef | null;
    readonly inputs: AssetInput[];
    readonly outputs: AssetOutput[];
    private readonly metadataList;
    /** @see create */
    constructor(assetId: AssetId | null, controlAsset: AssetRef | null, inputs: AssetInput[], outputs: AssetOutput[], metadata: Metadata[]);
    /**
     * Create and validate an asset group.
     *
     * @param assetId - Asset id for this group, or `null` for fresh issuance
     * @param controlAsset - Optional control asset reference for (re) issuance
     * @param inputs - Asset inputs in the group
     * @param outputs - Asset outputs in the group
     * @param metadata - Metadata entries associated with the group
     * @returns A validated asset group
     * @throws Error if the group fails validation
     * @see validate
     */
    static create(assetId: AssetId | null, controlAsset: AssetRef | null, inputs: AssetInput[], outputs: AssetOutput[], metadata: Metadata[]): AssetGroup;
    /**
     * Decode an asset group from its hex string form.
     *
     * @param s - Hex-encoded asset group
     * @returns Decoded asset group
     * @throws Error if the string is not valid hex or does not encode a valid asset group
     * @see toString
     */
    static fromString(s: string): AssetGroup;
    /**
     * Decode an asset group from its serialized bytes.
     *
     * @param buf - Serialized asset group bytes
     * @returns Decoded asset group
     * @throws Error if the buffer is empty or malformed
     */
    static fromBytes(buf: Uint8Array): AssetGroup;
    /**
     * Return true when the group represents an issuance.
     *
     * @returns `true` when the group has no asset id
     */
    isIssuance(): boolean;
    /**
     * Return true when the group represents a reissuance.
     *
     * @returns `true` when the group has an asset id and outputs exceed local inputs
     * @remarks
     * Only local inputs contribute to the comparison; intent-backed inputs contribute `0` here.
     */
    isReissuance(): boolean;
    /**
     * Serialize the asset group to raw bytes.
     *
     * @returns Serialized asset group bytes
     * @see fromBytes
     */
    serialize(): Uint8Array;
    /**
     * Validate the asset group and its child structures.
     *
     * @throws Error if the group is empty or violates issuance invariants
     */
    validate(): void;
    /**
     * Convert the group into its batch-leaf representation for the given intent txid.
     *
     * @param intentTxid - Intent transaction id used to build the leaf input reference
     * @returns Batch-leaf asset group
     * @see AssetInput.createIntent
     */
    toBatchLeafAssetGroup(intentTxid: Uint8Array): AssetGroup;
    /**
     * Encode the asset group to a hex string.
     *
     * @returns Hex-encoded asset group
     * @see fromString
     */
    toString(): string;
    /**
     * Decode an asset group from a binary reader.
     *
     * @param reader - Reader positioned at an asset group
     * @returns Decoded asset group
     * @throws Error if the encoded group is malformed
     */
    static fromReader(reader: BufferReader): AssetGroup;
    /**
     * Serialize the asset group into an existing binary writer.
     *
     * @param writer - Writer to append the asset group to
     */
    serializeTo(writer: BufferWriter): void;
}

/**
 * ExtensionPacket is the interface that all extension packets must implement.
 * It mirrors the Go extension.Packet interface.
 */
interface ExtensionPacket {
    /** type returns the 1-byte packet type tag */
    type(): number;
    /** serialize returns the raw bytes of the packet (without type or length prefix) */
    serialize(): Uint8Array;
}
/**
 * UnknownPacket holds a packet whose type is not recognized by this implementation.
 * It round-trips opaquely: the raw bytes are preserved as-is.
 */
declare class UnknownPacket implements ExtensionPacket {
    private readonly packetType;
    private readonly data;
    constructor(packetType: number, data: Uint8Array);
    type(): number;
    serialize(): Uint8Array;
}

/**
 * Packet represents a collection of asset groups.
 * It encodes/decodes as raw bytes only — OP_RETURN framing is handled by the Extension module.
 */
declare class Packet implements ExtensionPacket {
    readonly groups: AssetGroup[];
    /** PACKET_TYPE is the 1-byte TLV type tag used in the Extension envelope. */
    static readonly PACKET_TYPE = 0;
    private constructor();
    /** Create a validated asset packet from a list of asset groups. */
    static create(groups: AssetGroup[]): Packet;
    /**
     * fromBytes parses a Packet from raw bytes.
     */
    static fromBytes(buf: Uint8Array): Packet;
    /**
     * fromString parses a Packet from a raw hex string (not an OP_RETURN script).
     */
    static fromString(s: string): Packet;
    /**
     * type returns the TLV packet type tag. Implements ExtensionPacket interface.
     */
    type(): number;
    /** Convert the packet into the batch-leaf form for a specific intent transaction id. */
    leafTxPacket(intentTxid: Uint8Array): Packet;
    /**
     * serialize encodes the packet as raw bytes (varint group count + group data).
     * Does NOT include OP_RETURN, Arkade magic bytes (`ARK`), or TLV type/length; those are
     * added by the Extension module.
     */
    serialize(): Uint8Array;
    /**
     * toString returns the hex-encoded raw packet bytes.
     */
    toString(): string;
    /** Validate packet structure and cross-group references. */
    validate(): void;
    private static fromReader;
}

type index$1_AssetGroup = AssetGroup;
declare const index$1_AssetGroup: typeof AssetGroup;
type index$1_AssetId = AssetId;
declare const index$1_AssetId: typeof AssetId;
type index$1_AssetInput = AssetInput;
declare const index$1_AssetInput: typeof AssetInput;
type index$1_AssetInputType = AssetInputType;
declare const index$1_AssetInputType: typeof AssetInputType;
type index$1_AssetInputs = AssetInputs;
declare const index$1_AssetInputs: typeof AssetInputs;
type index$1_AssetOutput = AssetOutput;
declare const index$1_AssetOutput: typeof AssetOutput;
type index$1_AssetOutputs = AssetOutputs;
declare const index$1_AssetOutputs: typeof AssetOutputs;
type index$1_AssetRef = AssetRef;
declare const index$1_AssetRef: typeof AssetRef;
type index$1_AssetRefType = AssetRefType;
declare const index$1_AssetRefType: typeof AssetRefType;
type index$1_Metadata = Metadata;
declare const index$1_Metadata: typeof Metadata;
type index$1_MetadataList = MetadataList;
declare const index$1_MetadataList: typeof MetadataList;
type index$1_Packet = Packet;
declare const index$1_Packet: typeof Packet;
declare namespace index$1 {
  export { index$1_AssetGroup as AssetGroup, index$1_AssetId as AssetId, index$1_AssetInput as AssetInput, index$1_AssetInputType as AssetInputType, index$1_AssetInputs as AssetInputs, index$1_AssetOutput as AssetOutput, index$1_AssetOutputs as AssetOutputs, index$1_AssetRef as AssetRef, index$1_AssetRefType as AssetRefType, index$1_Metadata as Metadata, index$1_MetadataList as MetadataList, index$1_Packet as Packet };
}

/**
 * Creates an asset packet from asset inputs and receivers.
 * Groups inputs and outputs by asset ID and creates the Packet object
 * @param assetInputs - map input index -> assets
 * @param receivers - array of recipients with their asset allocations
 * @param changeReceiver - (optional) change receiver containing remaining assets
 * @returns packet containing all asset groups
 */
declare function createAssetPacket(assetInputs: Map<number, Asset[]>, receivers: Recipient[], changeReceiver?: Recipient): Packet;
/**
 * Selects coins that contain a specific asset.
 * Returns coins sorted by amount (smallest first for better coin selection).
 */
declare function selectCoinsWithAsset(coins: ExtendedVirtualCoin[], assetId: string, requiredAmount: bigint): {
    selected: ExtendedVirtualCoin[];
    totalAssetAmount: bigint;
};

/**
 * Thrown when a collaborative-exit / offboard would leave a change VTXO below
 * the dust threshold. Lets callers (e.g. wallet UI) react with appropriate UX
 * — for instance, offering to exit the full balance — instead of forwarding a
 * server-side dust rejection to the user.
 */
declare class DustChangeError extends Error {
    readonly change: bigint;
    readonly dustAmount: bigint;
    constructor(change: bigint, dustAmount: bigint);
}
/**
 * Ramps is a class wrapping `settle` method to provide a more convenient interface for onboarding and offboarding operations.
 *
 * @see IWallet.settle
 * @see onboard
 * @see offboard
 *
 * @example
 * ```typescript
 * const ramps = new Ramps(wallet);
 * const feeInfo = { intentFee: {}, txFeeRate: '1' };
 * await ramps.onboard(feeInfo); // onboard all boarding inputs
 * await ramps.offboard('bc1q...', feeInfo); // collaboratively exit all virtual outputs to an onchain address
 * ```
 */
declare class Ramps {
    readonly wallet: IWallet;
    /**
     * Create convenience wrappers for onboarding and offboarding flows.
     *
     * @param wallet - Wallet used to query funds and execute settlement transactions
     */
    constructor(wallet: IWallet);
    /**
     * Onboard boarding inputs.
     *
     * @param feeInfo - The fee info to deduct from the onboard amount.
     * @param boardingUtxos - Specific boarding inputs to onboard. If not provided, all boarding inputs will be used.
     * @param amount - Amount to onboard. If not provided, the total amount of boarding inputs will be onboarded.
     * @param eventCallback - Optional callback that receives settlement events
     * @returns The Arkade transaction id created by settlement
     * @throws Error if no boarding inputs remain after fee deduction or if `amount` exceeds available value
     * @see IWallet.getBoardingUtxos
     * @see IWallet.settle
     * @example
     * ```typescript
     * const feeInfo = { intentFee: {}, txFeeRate: '1' };
     * const ramps = new Ramps(wallet);
     * await ramps.onboard(feeInfo);
     * ```
     */
    onboard(feeInfo: FeeInfo, boardingUtxos?: ExtendedCoin[], amount?: bigint, eventCallback?: (event: SettlementEvent) => void): ReturnType<IWallet["settle"]>;
    /**
     * Offboard virtual outputs, or collaboratively exit them to an onchain address.
     *
     * @param destinationAddress - The destination address to offboard to.
     * @param feeInfo - The fee info to deduct from the offboard amount.
     * @param amount - The amount to offboard. If not provided, the total amount of virtual outputs will be offboarded.
     * @param eventCallback - Optional callback that receives settlement events
     * @returns The Arkade transaction id created by settlement
     * @throws Error if no virtual outputs remain after fee deduction or the destination address cannot be decoded
     * @see IWallet.getVtxos
     * @see IWallet.settle
     * @example
     * ```typescript
     * const feeInfo = { intentFee: {}, txFeeRate: '1' };
     * const ramps = new Ramps(wallet);
     * await ramps.offboard('bc1q...', feeInfo);
     * ```
     */
    offboard(destinationAddress: string, feeInfo: FeeInfo, amount?: bigint, eventCallback?: (event: SettlementEvent) => void): ReturnType<IWallet["settle"]>;
}

/**
 * HD-wallet {@link DescriptorProvider} that allocates a fresh signing
 * descriptor on every call. The provider holds no notion of "current" — it
 * is a pure rotating allocator. The question of "which descriptor is the
 * wallet currently bound to?" is answered by querying the contract
 * repository for active contracts, not by asking this provider.
 *
 * State is persisted under `WalletRepository.getWalletState().settings.hd` so
 * that no storage-schema migration is required when switching a wallet from
 * single-key to HD. The provider is backed by an {@link HDCapableIdentity},
 * which carries the wildcard account descriptor template (for derivation)
 * and the signing primitives.
 *
 * The read-modify-write of the persisted index runs inside the shared per-
 * repo `updateWalletState` mutex, so two `getNextSigningDescriptor` callers
 * — including those driving separate `HDDescriptorProvider` instances on
 * the same repo — can never observe the same index.
 *
 * @example
 * ```ts
 * const provider = await HDDescriptorProvider.create(identity, walletRepo);
 * const descriptor = await provider.getNextSigningDescriptor();
 * // descriptor: tr([fp/86'/0'/0']xpub/0/0)
 * const next = await provider.getNextSigningDescriptor();
 * // next: tr([fp/86'/0'/0']xpub/0/1)
 * ```
 */
declare class HDDescriptorProvider implements DescriptorProvider, ReceiveRotatorFactory {
    private readonly identity;
    private readonly walletRepository;
    private constructor();
    /**
     * Construct an HDDescriptorProvider. No I/O is performed here;
     * persisted state is read lazily on the first call to
     * `getNextSigningDescriptor`. A descriptor-mismatch error surfaces on
     * first use rather than at boot.
     */
    static create(identity: HDCapableIdentity, walletRepository: WalletRepository): Promise<HDDescriptorProvider>;
    /**
     * Allocate the next descriptor and return it. The first call on a fresh
     * wallet returns descriptor at index 0; subsequent calls return 1, 2, 3,
     * ... in order. Each call is atomic with respect to other rotations on
     * the same repo: two concurrent callers can never observe the same
     * index.
     */
    getNextSigningDescriptor(): Promise<string>;
    /**
     * Re-derive the descriptor at the most recently allocated index
     * WITHOUT advancing — i.e. read the same descriptor
     * `getNextSigningDescriptor` last returned. Returns `undefined`
     * when no descriptor has ever been allocated on this repo.
     *
     * Used by the boot path to keep the wallet's display address
     * stable across restarts: when no tagged display contract exists
     * (e.g. a fresh wallet that hasn't rotated yet, or a wallet whose
     * baseline-only repo carries no rotation history), the boot should
     * re-derive the existing index rather than burn a new one.
     */
    getCurrentSigningDescriptor(): Promise<string | undefined>;
    /**
     * Monotonically advance the allocation watermark so the next
     * `getNextSigningDescriptor()` skips indices discovered by a restore
     * scan. Never rewinds: a lower or equal `index` is a no-op.
     *
     * An invalid `index` (non-integer / negative) is ignored (no-op):
     * persisting it would corrupt `lastIndexUsed` and make the next
     * `parseSettings()` throw, mirroring the validation parseSettings
     * already enforces.
     */
    advanceLastIndexUsed(index: number): Promise<void>;
    /**
     * Returns true when the given descriptor is derivable from this wallet's
     * seed. Delegates to the underlying identity, which handles both HD and
     * simple `tr(pubkey)` descriptors.
     */
    isOurs(descriptor: string): boolean;
    /**
     * Signs each request with the key derived from its descriptor. Delegates
     * to the identity's signing primitives — the identity, not the provider,
     * holds the seed.
     */
    signWithDescriptor(requests: DescriptorSigningRequest[]): Promise<Transaction[]>;
    /** Signs a message using the key derived from `descriptor`. */
    signMessageWithDescriptor(descriptor: string, message: Uint8Array, signatureType?: "schnorr" | "ecdsa"): Promise<Uint8Array>;
    /**
     * HD providers participate in receive rotation. The default
     * factory boot (contract-repo lookup → allocate fresh descriptor)
     * is exactly what we want, so this just delegates to
     * {@link WalletReceiveRotator.defaultBoot}.
     */
    createReceiveRotator(opts: ReceiveRotatorBootOpts): Promise<ReceiveRotatorBoot | undefined>;
    /**
     * Substitute the wildcard in the identity's account-descriptor template
     * with a concrete index, going through the descriptors-scure parser
     * rather than ad-hoc string substitution. The parser's `expand({ index })`
     * call validates that the input is a ranged template AND produces a
     * canonical materialized key expression at the given index.
     *
     * This is a pure read: it does NOT advance the allocation watermark.
     * Used by restore's gap-scan to peek descriptors at arbitrary indices
     * without side-effects.
     */
    materializeDescriptorAt(index: number): string;
    /**
     * Run the read-modify-write of HD settings inside the shared per-repo
     * wallet-state mutex. The closure receives a freshly-validated settings
     * snapshot, mutates it, and returns whatever value the caller wants to
     * surface; the mutated settings are then persisted as part of the same
     * atomic update.
     *
     * Doing the read inside the lock is what prevents two providers (or two
     * concurrent callers on the same provider) from racing on a stale index.
     */
    private mutate;
    /**
     * Validate the persisted HD settings (or initialize a fresh record when
     * absent) and return a clone safe for the caller to mutate.
     *
     * The cast to `HDWalletSettings` trusts storage; a corrupted or
     * partially-migrated repo could otherwise produce `NaN` descriptors.
     * Fail loud rather than silently derive garbage.
     */
    private parseSettings;
}

declare class WalletNotInitializedError extends Error {
    constructor();
}
declare class ReadonlyWalletError extends Error {
    constructor();
}
declare class DelegateNotConfiguredError extends Error {
    constructor();
}
/** @deprecated alias for DelegateNotConfiguredError */
declare const DelegatorNotConfiguredError: typeof DelegateNotConfiguredError;
type DelegatorNotConfiguredError = DelegateNotConfiguredError;
type RequestInitWallet = RequestEnvelope & {
    type: "INIT_WALLET";
    payload: {
        /**
         * Legacy per-request key material. Ignored by the current handler —
         * identity hydration happens during INITIALIZE_MESSAGE_BUS. Retained
         * for wire compatibility with older workers that may still read it.
         * Slated for removal in the next major.
         *
         * @deprecated Identity is now carried by INITIALIZE_MESSAGE_BUS.
         */
        key?: {
            privateKey: string;
        } | {
            publicKey: string;
        } | {};
        arkServerUrl: string;
        arkServerPublicKey?: string;
    };
};
type ResponseInitWallet = ResponseEnvelope & {
    type: "WALLET_INITIALIZED";
};
type RequestSettle = RequestEnvelope & {
    type: "SETTLE";
    payload: {
        params?: SettleParams;
    };
};
type ResponseSettle = ResponseEnvelope & {
    type: "SETTLE_SUCCESS";
    payload: {
        txid: string;
    };
};
type RequestSendBitcoin = RequestEnvelope & {
    type: "SEND_BITCOIN";
    payload: SendBitcoinParams;
};
type ResponseSendBitcoin = ResponseEnvelope & {
    type: "SEND_BITCOIN_SUCCESS";
    payload: {
        txid: string;
    };
};
type RequestGetAddress = RequestEnvelope & {
    type: "GET_ADDRESS";
};
type ResponseGetAddress = ResponseEnvelope & {
    type: "ADDRESS";
    payload: {
        address: string;
    };
};
type RequestGetBoardingAddress = RequestEnvelope & {
    type: "GET_BOARDING_ADDRESS";
};
type ResponseGetBoardingAddress = ResponseEnvelope & {
    type: "BOARDING_ADDRESS";
    payload: {
        address: string;
    };
};
type RequestGetBalance = RequestEnvelope & {
    type: "GET_BALANCE";
};
type ResponseGetBalance = ResponseEnvelope & {
    type: "BALANCE";
    payload: WalletBalance;
};
type RequestGetVtxos = RequestEnvelope & {
    type: "GET_VTXOS";
    payload: {
        filter?: GetVtxosFilter;
    };
};
type ResponseGetVtxos = ResponseEnvelope & {
    type: "VTXOS";
    payload: {
        vtxos: Awaited<ReturnType<IWallet["getVtxos"]>>;
    };
};
type RequestGetBoardingUtxos = RequestEnvelope & {
    type: "GET_BOARDING_UTXOS";
};
type ResponseGetBoardingUtxos = ResponseEnvelope & {
    type: "BOARDING_UTXOS";
    payload: {
        utxos: ExtendedCoin[];
    };
};
type RequestGetTransactionHistory = RequestEnvelope & {
    type: "GET_TRANSACTION_HISTORY";
};
type ResponseGetTransactionHistory = ResponseEnvelope & {
    type: "TRANSACTION_HISTORY";
    payload: {
        transactions: ArkTransaction[];
    };
};
type RequestGetStatus = RequestEnvelope & {
    type: "GET_STATUS";
};
type ResponseGetStatus = ResponseEnvelope & {
    type: "WALLET_STATUS";
    payload: {
        walletInitialized: boolean;
        xOnlyPublicKey: Uint8Array | undefined;
    };
};
type RequestClear = RequestEnvelope & {
    type: "CLEAR";
};
type ResponseClear = ResponseEnvelope & {
    type: "CLEAR_SUCCESS";
    payload: {
        cleared: boolean;
    };
};
type RequestSignTransaction = RequestEnvelope & {
    type: "SIGN_TRANSACTION";
    payload: {
        tx: Transaction;
        inputIndexes?: number[];
    };
};
type ResponseSignTransaction = ResponseEnvelope & {
    type: "SIGN_TRANSACTION";
    payload: {
        tx: Transaction;
    };
};
type RequestReloadWallet = RequestEnvelope & {
    type: "RELOAD_WALLET";
};
type ResponseReloadWallet = ResponseEnvelope & {
    type: "RELOAD_SUCCESS";
    payload: {
        reloaded: boolean;
    };
};
type RequestCreateContract = RequestEnvelope & {
    type: "CREATE_CONTRACT";
    payload: CreateContractParams;
};
type ResponseCreateContract = ResponseEnvelope & {
    type: "CONTRACT_CREATED";
    payload: {
        contract: Contract;
    };
};
type RequestGetContracts = RequestEnvelope & {
    type: "GET_CONTRACTS";
    payload: {
        filter?: GetContractsFilter;
    };
};
type ResponseGetContracts = ResponseEnvelope & {
    type: "CONTRACTS";
    payload: {
        contracts: Contract[];
    };
};
type RequestGetContractsWithVtxos = RequestEnvelope & {
    type: "GET_CONTRACTS_WITH_VTXOS";
    payload: {
        filter?: GetContractsFilter;
    };
};
type ResponseGetContractsWithVtxos = ResponseEnvelope & {
    type: "CONTRACTS_WITH_VTXOS";
    payload: {
        contracts: ContractWithVtxos[];
    };
};
type RequestAnnotateVtxos = RequestEnvelope & {
    type: "ANNOTATE_VTXOS";
    payload: {
        vtxos: VirtualCoin[];
    };
};
type ResponseAnnotateVtxos = ResponseEnvelope & {
    type: "ANNOTATED_VTXOS";
    payload: {
        vtxos: ExtendedVirtualCoin[];
    };
};
type RequestUpdateContract = RequestEnvelope & {
    type: "UPDATE_CONTRACT";
    payload: {
        script: string;
        updates: Partial<Omit<Contract, "id" | "createdAt">>;
    };
};
type ResponseUpdateContract = ResponseEnvelope & {
    type: "CONTRACT_UPDATED";
    payload: {
        contract: Contract;
    };
};
type RequestDeleteContract = RequestEnvelope & {
    type: "DELETE_CONTRACT";
    payload: {
        script: string;
    };
};
type ResponseDeleteContract = ResponseEnvelope & {
    type: "CONTRACT_DELETED";
    payload: {
        deleted: boolean;
    };
};
type RequestGetSpendablePaths = RequestEnvelope & {
    type: "GET_SPENDABLE_PATHS";
    payload: {
        options: GetSpendablePathsOptions;
    };
};
type ResponseGetSpendablePaths = ResponseEnvelope & {
    type: "SPENDABLE_PATHS";
    payload: {
        paths: PathSelection[];
    };
};
type RequestIsContractManagerWatching = RequestEnvelope & {
    type: "IS_CONTRACT_MANAGER_WATCHING";
};
type ResponseIsContractManagerWatching = ResponseEnvelope & {
    type: "CONTRACT_WATCHING";
    payload: {
        isWatching: boolean;
    };
};
type RequestRefreshVtxos = RequestEnvelope & {
    type: "REFRESH_VTXOS";
    payload?: {
        scripts?: string[];
        after?: number;
        before?: number;
    };
};
type ResponseRefreshVtxos = ResponseEnvelope & {
    type: "REFRESH_VTXOS_SUCCESS";
};
type RequestRefreshOutpoints = RequestEnvelope & {
    type: "REFRESH_OUTPOINTS";
    payload: {
        outpoints: {
            txid: string;
            vout: number;
        }[];
    };
};
type ResponseRefreshOutpoints = ResponseEnvelope & {
    type: "REFRESH_OUTPOINTS_SUCCESS";
};
type RequestGetAllSpendingPaths = RequestEnvelope & {
    type: "GET_ALL_SPENDING_PATHS";
    payload: {
        options: GetAllSpendingPathsOptions;
    };
};
type ResponseGetAllSpendingPaths = ResponseEnvelope & {
    type: "ALL_SPENDING_PATHS";
    payload: {
        paths: PathSelection[];
    };
};
type ResponseSettleEvent = ResponseEnvelope & {
    broadcast: true;
    type: "SETTLE_EVENT";
    payload: SettlementEvent;
};
type ResponseRecoverVtxosEvent = ResponseEnvelope & {
    type: "RECOVER_VTXOS_EVENT";
    payload: SettlementEvent;
};
type ResponseRenewVtxosEvent = ResponseEnvelope & {
    type: "RENEW_VTXOS_EVENT";
    payload: SettlementEvent;
};
type ResponseUtxoUpdate = ResponseEnvelope & {
    broadcast: true;
    type: "UTXO_UPDATE";
    payload: {
        coins: ExtendedCoin[];
    };
};
type ResponseVtxoUpdate = ResponseEnvelope & {
    broadcast: true;
    type: "VTXO_UPDATE";
    payload: {
        newVtxos: ExtendedCoin[];
        spentVtxos: ExtendedCoin[];
    };
};
type ResponseContractEvent = ResponseEnvelope & {
    tag: string;
    broadcast: true;
    type: "CONTRACT_EVENT";
    payload: {
        event: ContractEvent;
    };
};
type RequestSend = RequestEnvelope & {
    type: "SEND";
    payload: {
        recipients: [Recipient, ...Recipient[]];
    };
};
type ResponseSend = ResponseEnvelope & {
    type: "SEND_SUCCESS";
    payload: {
        txid: string;
    };
};
type RequestGetAssetDetails = RequestEnvelope & {
    type: "GET_ASSET_DETAILS";
    payload: {
        assetId: string;
    };
};
type ResponseGetAssetDetails = ResponseEnvelope & {
    type: "ASSET_DETAILS";
    payload: {
        assetDetails: AssetDetails;
    };
};
type RequestIssue = RequestEnvelope & {
    type: "ISSUE";
    payload: {
        params: IssuanceParams;
    };
};
type ResponseIssue = ResponseEnvelope & {
    type: "ISSUE_SUCCESS";
    payload: {
        result: IssuanceResult;
    };
};
type RequestReissue = RequestEnvelope & {
    type: "REISSUE";
    payload: {
        params: ReissuanceParams;
    };
};
type ResponseReissue = ResponseEnvelope & {
    type: "REISSUE_SUCCESS";
    payload: {
        txid: string;
    };
};
type RequestBurn = RequestEnvelope & {
    type: "BURN";
    payload: {
        params: BurnParams;
    };
};
type ResponseBurn = ResponseEnvelope & {
    type: "BURN_SUCCESS";
    payload: {
        txid: string;
    };
};
type RequestDelegate = RequestEnvelope & {
    type: "DELEGATE";
    payload: {
        vtxoOutpoints: {
            txid: string;
            vout: number;
        }[];
        destination: string;
        delegateAt?: number;
    };
};
type ResponseDelegate = ResponseEnvelope & {
    type: "DELEGATE_SUCCESS";
    payload: {
        delegated: {
            txid: string;
            vout: number;
        }[];
        failed: {
            outpoints: {
                txid: string;
                vout: number;
            }[];
            error: string;
        }[];
    };
};
type RequestGetDelegateInfo = RequestEnvelope & {
    type: "GET_DELEGATE_INFO";
};
type ResponseGetDelegateInfo = ResponseEnvelope & {
    type: "DELEGATE_INFO";
    payload: {
        info: DelegateInfo;
    };
};
type RequestRecoverVtxos = RequestEnvelope & {
    type: "RECOVER_VTXOS";
};
type ResponseRecoverVtxos = ResponseEnvelope & {
    type: "RECOVER_VTXOS_SUCCESS";
    payload: {
        txid: string;
    };
};
type RequestGetRecoverableBalance = RequestEnvelope & {
    type: "GET_RECOVERABLE_BALANCE";
};
type ResponseGetRecoverableBalance = ResponseEnvelope & {
    type: "RECOVERABLE_BALANCE";
    payload: {
        recoverable: string;
        subdust: string;
        includesSubdust: boolean;
        vtxoCount: number;
    };
};
type RequestGetExpiringVtxos = RequestEnvelope & {
    type: "GET_EXPIRING_VTXOS";
    payload: {
        thresholdMs?: number;
    };
};
type ResponseGetExpiringVtxos = ResponseEnvelope & {
    type: "EXPIRING_VTXOS";
    payload: {
        vtxos: ExtendedVirtualCoin[];
    };
};
type RequestRenewVtxos = RequestEnvelope & {
    type: "RENEW_VTXOS";
};
type ResponseRenewVtxos = ResponseEnvelope & {
    type: "RENEW_VTXOS_SUCCESS";
    payload: {
        txid: string;
    };
};
type RequestGetExpiredBoardingUtxos = RequestEnvelope & {
    type: "GET_EXPIRED_BOARDING_UTXOS";
};
type ResponseGetExpiredBoardingUtxos = ResponseEnvelope & {
    type: "EXPIRED_BOARDING_UTXOS";
    payload: {
        utxos: ExtendedCoin[];
    };
};
type RequestSweepExpiredBoardingUtxos = RequestEnvelope & {
    type: "SWEEP_EXPIRED_BOARDING_UTXOS";
};
type ResponseSweepExpiredBoardingUtxos = ResponseEnvelope & {
    type: "SWEEP_EXPIRED_BOARDING_UTXOS_SUCCESS";
    payload: {
        txid: string;
    };
};
type RequestRestoreWallet = RequestEnvelope & {
    type: "RESTORE_WALLET";
    payload: {
        gapLimit?: number;
    };
};
type ResponseRestoreWallet = ResponseEnvelope & {
    type: "RESTORE_WALLET_SUCCESS";
};
type WalletUpdaterRequest = RequestInitWallet | RequestSettle | RequestSendBitcoin | RequestGetAddress | RequestGetBoardingAddress | RequestGetBalance | RequestGetVtxos | RequestGetBoardingUtxos | RequestGetTransactionHistory | RequestGetStatus | RequestClear | RequestReloadWallet | RequestSignTransaction | RequestCreateContract | RequestGetContracts | RequestGetContractsWithVtxos | RequestAnnotateVtxos | RequestUpdateContract | RequestDeleteContract | RequestGetSpendablePaths | RequestGetAllSpendingPaths | RequestIsContractManagerWatching | RequestRefreshVtxos | RequestRefreshOutpoints | RequestSend | RequestGetAssetDetails | RequestIssue | RequestReissue | RequestBurn | RequestDelegate | RequestGetDelegateInfo | RequestRecoverVtxos | RequestGetRecoverableBalance | RequestGetExpiringVtxos | RequestRenewVtxos | RequestGetExpiredBoardingUtxos | RequestSweepExpiredBoardingUtxos | RequestRestoreWallet;
type WalletUpdaterResponse = ResponseEnvelope & (ResponseInitWallet | ResponseSettle | ResponseSettleEvent | ResponseSendBitcoin | ResponseGetAddress | ResponseGetBoardingAddress | ResponseGetBalance | ResponseGetVtxos | ResponseGetBoardingUtxos | ResponseGetTransactionHistory | ResponseGetStatus | ResponseClear | ResponseReloadWallet | ResponseUtxoUpdate | ResponseVtxoUpdate | ResponseSignTransaction | ResponseCreateContract | ResponseGetContracts | ResponseGetContractsWithVtxos | ResponseAnnotateVtxos | ResponseUpdateContract | ResponseDeleteContract | ResponseGetSpendablePaths | ResponseGetAllSpendingPaths | ResponseIsContractManagerWatching | ResponseRefreshVtxos | ResponseRefreshOutpoints | ResponseContractEvent | ResponseSend | ResponseGetAssetDetails | ResponseIssue | ResponseReissue | ResponseBurn | ResponseDelegate | ResponseGetDelegateInfo | ResponseRecoverVtxos | ResponseRecoverVtxosEvent | ResponseGetRecoverableBalance | ResponseGetExpiringVtxos | ResponseRenewVtxos | ResponseRenewVtxosEvent | ResponseGetExpiredBoardingUtxos | ResponseSweepExpiredBoardingUtxos | ResponseRestoreWallet);
declare class WalletMessageHandler implements MessageHandler<WalletUpdaterRequest, WalletUpdaterResponse> {
    readonly messageTag: string;
    private wallet;
    private readonlyWallet;
    private arkProvider;
    private indexerProvider;
    private walletRepository;
    private incomingFundsSubscription;
    private contractEventsSubscription;
    private onNextTick;
    /**
     * Instantiate a new WalletUpdater.
     * Can override the default `messageTag` allowing more than one updater to run in parallel.
     * Note that the default ServiceWorkerWallet sends messages to the default WalletUpdater tag.
     */
    constructor(options?: {
        messageTag?: string;
    });
    start(...params: Parameters<MessageHandler["start"]>): Promise<void>;
    stop(): Promise<void>;
    tick(_now: number): Promise<WalletUpdaterResponse[]>;
    private scheduleForNextTick;
    private requireWallet;
    private tagged;
    isLongRunning(message: WalletUpdaterRequest): boolean;
    handleMessage(message: WalletUpdaterRequest): Promise<WalletUpdaterResponse>;
    private handleInitWallet;
    private handleGetBalance;
    private getAllBoardingUtxos;
    /**
     * Get spendable vtxos from the repository
     */
    private getSpendableVtxos;
    private onWalletInitialized;
    /**
     * Refresh virtual outputs, boarding inputs, and transaction history from cache.
     * Shared by onWalletInitialized (full bootstrap) and reloadWallet
     * (post-refresh), avoiding duplicate subscriptions and VtxoManager restarts.
     */
    private refreshCachedData;
    /**
     * Force a full VTXO refresh from the indexer, then refresh cached data.
     * Used by RELOAD_WALLET to ensure fresh data without re-subscribing
     * to incoming funds or restarting the VtxoManager.
     */
    private reloadWallet;
    private handleSettle;
    private handleSendBitcoin;
    private handleSignTransaction;
    private handleDelegate;
    private handleGetVtxos;
    private clear;
    /**
     * Read all virtual outputs from the repository, aggregated across all contract
     * addresses and the wallet's primary address, with deduplication.
     */
    private getVtxosFromRepo;
    /**
     * Build transaction history from cached virtual outputs without hitting the indexer.
     * Falls back to indexer only for uncached transaction timestamps.
     */
    private buildTransactionHistoryFromCache;
    private ensureContractEventBroadcasting;
}

type RequestType = WalletUpdaterRequest["type"];
type MessageTimeouts = Partial<Record<RequestType, number>>;
type ServiceWorkerWalletMode = "auto" | "static" | "hd";
declare const DEFAULT_MESSAGE_TIMEOUTS: Readonly<Record<RequestType, number>>;
/**
 * Service Worker-based wallet implementation for browser environments.
 *
 * This wallet uses a service worker as a backend to handle wallet logic,
 * providing secure key storage and transaction signing in web applications.
 * The service worker runs in a separate thread and can persist data between
 * browser sessions.
 *
 * @example
 * ```typescript
 * // SIMPLE: Recommended approach
 * const wallet = await ServiceWorkerWallet.setup({
 *   serviceWorkerPath: '/service-worker.js',
 *   arkServerUrl: 'https://arkade.computer',
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...')
 * });
 *
 * // ADVANCED: Manual setup with service worker control
 * const serviceWorker = await setupServiceWorker("/service-worker.js");
 * const wallet = await ServiceWorkerWallet.create({
 *   serviceWorker,
 *   arkServerUrl: 'https://arkade.computer',
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...')
 * });
 *
 * // Use like any other wallet
 * const address = await wallet.getAddress();
 * const balance = await wallet.getBalance();
 * ```
 */
interface ServiceWorkerWalletOptions {
    /** Optional Arkade server public key used to construct and validate Arkade addresses. */
    arkServerPublicKey?: string;
    /**
     * Base URL of the Arkade server.
     *
     * @deprecated Provide an explicit provider via the worker config instead.
     * URL-based configuration will be removed in a future major version.
     */
    arkServerUrl?: string;
    /**
     * Optional override for the indexer URL.
     *
     * @deprecated Provide an explicit provider via the worker config instead.
     */
    indexerUrl?: string;
    /**
     * Optional override for the Esplora API URL.
     *
     * @deprecated Provide an explicit provider via the worker config instead.
     */
    esploraUrl?: string;
    /**
     * Repository-backed storage configuration overrides.
     * Defaults to IndexedDB if unset.
     */
    storage?: StorageConfig;
    /** Identity used to derive addresses and optionally sign operations. */
    identity: ReadonlyIdentity | Identity;
    /** Optional delegation service URL. */
    delegateUrl?: string;
    /** @deprecated alias for @see ServiceWorkerWalletOptions.delegateUrl */
    delegatorUrl?: string;
    /**
     * Override the default tag used for messages sent to and received from the service worker.
     * @see DEFAULT_MESSAGE_TAG
     */
    walletUpdaterTag?: string;
    /** Timeout used while bootstrapping the message bus inside the service worker. */
    messageBusTimeoutMs?: number;
    /** Optional settlement configuration forwarded to the worker wallet. */
    settlementConfig?: SettlementConfig | false;
    /**
     * Receive-address strategy forwarded to the worker wallet.
     *
     * Service workers can only receive serializable configuration, so the
     * descriptor-provider object form accepted by `Wallet.create()` is not
     * supported here.
     */
    walletMode?: ServiceWorkerWalletMode;
    /** Optional contract watcher configuration forwarded to the worker wallet. */
    watcherConfig?: Partial<Omit<ContractWatcherConfig, "indexerProvider">>;
    /**
     * Per-request timeout overrides for wallet-updater messages.
     * @see DEFAULT_MESSAGE_TIMEOUTS
     */
    messageTimeouts?: MessageTimeouts;
}
/**
 * Options for creating a service-worker wallet with an existing worker instance.
 *
 * @see ServiceWorkerReadonlyWallet.create
 * @see ServiceWorkerWallet.create
 */
type ServiceWorkerWalletCreateOptions = ServiceWorkerWalletOptions & {
    /** Existing service worker instance used for messaging. */
    serviceWorker: ServiceWorker;
};
/**
 * Options for registering a service worker and then creating a wallet around it.
 *
 * @see ServiceWorkerReadonlyWallet.setup
 * @see ServiceWorkerWallet.setup
 */
type ServiceWorkerWalletSetupOptions = ServiceWorkerWalletOptions & {
    /** Path to the service worker script to register. */
    serviceWorkerPath: string;
    /** Timeout while waiting for the service worker to activate. */
    serviceWorkerActivationTimeoutMs?: number;
};
type MessageBusInitConfig = {
    wallet: SerializedIdentity | LegacySerializedIdentity;
    arkServer: {
        url: string;
        publicKey?: string;
    };
    delegateUrl?: string;
    /** @deprecated alias for @see MessageBusInitConfig.delegateUrl */
    delegatorUrl?: string;
    indexerUrl?: string;
    esploraUrl?: string;
    timeoutMs?: number;
    settlementConfig?: SettlementConfig | false;
    walletMode?: ServiceWorkerWalletMode;
    watcherConfig?: Partial<Omit<ContractWatcherConfig, "indexerProvider">>;
    messageTimeouts?: Record<string, number>;
};
declare class ServiceWorkerReadonlyWallet implements IReadonlyWallet {
    readonly serviceWorker: ServiceWorker;
    protected readonly messageTag: string;
    readonly walletRepository: WalletRepository;
    readonly contractRepository: ContractRepository;
    readonly identity: ReadonlyIdentity;
    private readonly _readonlyAssetManager;
    protected initConfig: MessageBusInitConfig | null;
    protected initWalletPayload: RequestInitWallet["payload"] | null;
    protected messageBusTimeoutMs?: number;
    protected messageTimeouts: Record<RequestType, number>;
    protected arkServerUrl?: string;
    protected arkServerPublicKey?: string;
    protected delegateUrl?: string;
    /** @deprecated alias for @see ServiceWorkerReadonlyWallet.delegateUrl */
    protected delegatorUrl?: string;
    protected indexerUrl?: string;
    protected esploraUrl?: string;
    protected watcherConfig?: Partial<Omit<ContractWatcherConfig, "indexerProvider">>;
    protected settlementConfig?: SettlementConfig | false;
    private reinitPromise;
    private pingPromise;
    private inflightRequests;
    get assetManager(): IReadonlyAssetManager;
    protected constructor(serviceWorker: ServiceWorker, identity: ReadonlyIdentity, walletRepository: WalletRepository, contractRepository: ContractRepository, messageTag: string);
    private getTimeoutForRequest;
    /**
     * Create a readonly service-worker wallet bound to an already-registered worker.
     *
     * @param options - Service worker, identity, and backend configuration
     * @returns Initialized readonly service-worker wallet
     * @throws Error if service-worker initialization fails
     */
    static create(options: ServiceWorkerWalletCreateOptions): Promise<ServiceWorkerReadonlyWallet>;
    /**
     * Simplified setup method that handles service worker registration
     * and wallet initialization automatically.
     *
     * @see ServiceWorkerReadonlyWallet.create
     *
     * @example
     * ```typescript
     * const wallet = await ServiceWorkerReadonlyWallet.setup({
     *   serviceWorkerPath: '/service-worker.js',
     *   arkServerUrl: 'https://arkade.computer',
     *   identity: ReadonlySingleKey.fromPublicKey('your_public_key_hex')
     * });
     * ```
     */
    static setup(options: ServiceWorkerWalletSetupOptions): Promise<ServiceWorkerReadonlyWallet>;
    private sendMessageDirect;
    private sendMessageStreaming;
    protected sendMessage(request: WalletUpdaterRequest): Promise<WalletUpdaterResponse>;
    private pingServiceWorker;
    private sendMessageWithRetry;
    protected sendMessageWithEvents(request: WalletUpdaterRequest, onEvent: (response: WalletUpdaterResponse) => void, isComplete: (response: WalletUpdaterResponse) => boolean): Promise<WalletUpdaterResponse>;
    /**
     * Produce a serialized envelope for the wallet's identity. The base
     * class always emits a readonly envelope; `ServiceWorkerWallet`
     * overrides to emit a signing envelope.
     */
    protected serializeIdentity(): Promise<SerializedIdentity>;
    /**
     * Return the cached init config, or rebuild one from live instance
     * state when the cache was never populated. Recovery path for
     * SDK-factory-created wallets; manual constructor bypasses do not
     * retain enough state here and will hit the "never initialized" throw.
     */
    protected buildInitConfig(): Promise<MessageBusInitConfig>;
    /** Minimal INIT_WALLET payload used on reinitialize when the cache is gone. */
    protected buildInitWalletPayload(): RequestInitWallet["payload"];
    private reinitialize;
    /** Clear cached wallet state from both the page and service worker storage. */
    clear(): Promise<void>;
    getAddress(): Promise<string>;
    getBoardingAddress(): Promise<string>;
    getBalance(): Promise<WalletBalance>;
    getBoardingUtxos(): Promise<ExtendedCoin[]>;
    /**
     * Return service-worker wallet status, including connectivity and sync state.
     *
     * @returns Current service-worker wallet status payload including `walletInitalized` and `xOnlyPublicKey`
     */
    getStatus(): Promise<ResponseGetStatus["payload"]>;
    getTransactionHistory(): Promise<ArkTransaction[]>;
    getVtxos(filter?: GetVtxosFilter): Promise<ExtendedVirtualCoin[]>;
    /**
     * Trigger a wallet reload inside the service worker.
     *
     * @returns `true` when the wallet was reloaded
     */
    reload(): Promise<boolean>;
    getContractManager(): Promise<IContractManager>;
}
declare class ServiceWorkerWallet extends ServiceWorkerReadonlyWallet implements IWallet {
    readonly serviceWorker: ServiceWorker;
    readonly walletRepository: WalletRepository;
    readonly contractRepository: ContractRepository;
    readonly identity: Identity;
    private readonly _assetManager;
    private readonly hasDelegate;
    protected constructor(serviceWorker: ServiceWorker, identity: Identity, walletRepository: WalletRepository, contractRepository: ContractRepository, messageTag: string, hasDelegate: boolean);
    get assetManager(): IAssetManager;
    protected serializeIdentity(): Promise<SerializedIdentity>;
    static create(options: ServiceWorkerWalletCreateOptions): Promise<ServiceWorkerWallet>;
    /**
     * Simplified setup method that handles service worker registration
     * and wallet initialization automatically.
     *
     * @example
     * ```typescript
     * const wallet = await ServiceWorkerWallet.setup({
     *   serviceWorkerPath: '/service-worker.js',
     *   arkServerUrl: 'https://arkade.computer',
     *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...')
     * });
     * ```
     */
    static setup(options: ServiceWorkerWalletSetupOptions): Promise<ServiceWorkerWallet>;
    sendBitcoin(params: SendBitcoinParams): Promise<string>;
    settle(params?: SettleParams, callback?: (event: SettlementEvent) => void): Promise<string>;
    /**
     * Explicitly recover this wallet's contracts and balance on a fresh repo.
     * Mirrors {@link Wallet.restore} but drives the scan inside the service
     * worker — the materialize() callback used by `scanContracts` cannot
     * cross the postMessage boundary, so the entire flow runs worker-side
     * and only the gapLimit / outcome cross the wire.
     *
     * Uses the streaming send path so the bus deadline does not race a
     * long indexer-bound scan. AggregateError thrown by the worker is
     * reconstructed here so callers can inspect `.errors`.
     */
    restore(opts?: {
        gapLimit?: number;
    }): Promise<void>;
    send(...recipients: [Recipient, ...Recipient[]]): Promise<string>;
    getDelegateManager(): Promise<IDelegateManager | undefined>;
    /** @deprecated alias for @see ServiceWorkerWallet.getDelegateManager */
    getDelegatorManager(): Promise<IDelegateManager | undefined>;
    getVtxoManager(): Promise<IVtxoManager>;
}

/**
 * A zero-value anchor output.
 */
declare const P2A: {
    script: Uint8Array<ArrayBuffer>;
    amount: bigint;
};
interface AnchorBumper {
    bumpP2A(parent: Transaction$1): Promise<[string, string]>;
}

/**
 * Onchain Bitcoin wallet implementation for traditional Bitcoin transactions.
 *
 * This wallet handles regular Bitcoin transactions on the blockchain without
 * using the Arkade protocol. It supports P2TR (Pay-to-Taproot) addresses and
 * provides basic Bitcoin wallet functionality.
 *
 * @example
 * ```typescript
 * const wallet = await OnchainWallet.create(identity, 'mainnet');
 * const balance = await wallet.getBalance();
 * const txid = await wallet.send({
 *   address: 'bc1...',
 *   amount: 50000
 * });
 * ```
 */
declare class OnchainWallet implements AnchorBumper {
    private identity;
    static MIN_FEE_RATE: number;
    readonly onchainP2TR: P2TR;
    readonly provider: OnchainProvider;
    readonly network: Network;
    private constructor();
    /**
     * Create an onchain wallet for the given identity and Bitcoin network.
     *
     * @param identity - Identity used to derive the Taproot key and sign transactions
     * @param networkName - Bitcoin network name, @see NetworkName
     * @param provider - Optional onchain provider override, @see OnchainProvider
     * @returns Configured onchain wallet
     * @throws Error if the configured identity cannot produce a valid x-only public key
     */
    static create(identity: Identity, networkName?: NetworkName, provider?: OnchainProvider): Promise<OnchainWallet>;
    get address(): string;
    /**
     * Fetch spendable onchain outputs for the wallet address.
     *
     * @returns Spendable onchain outputs for the wallet address
     * @see getBalance
     */
    getCoins(): Promise<Coin[]>;
    /**
     * Return the wallet's total onchain balance in satoshis.
     *
     * @returns Confirmed plus unconfirmed onchain balance
     * @see getCoins
     */
    getBalance(): Promise<number>;
    /**
     * Iteratively selects coins and estimates transaction fees until convergence.
     *
     * This method handles the circular dependency between output selection and fee
     * estimation: the fee depends on transaction size, which depends on the number
     * of inputs (selected outputs) and whether a change output is needed.
     *
     * The algorithm iterates up to 10 times, refining the fee estimate based on
     * the actual transaction structure. It resolves dust oscillation loops that
     * occur when the change amount hovers near the dust threshold—adding/removing
     * the change output causes the fee to fluctuate, preventing convergence.
     * When a lower fee is computed (indicating the change output was dropped),
     * the function accepts this state to guarantee termination.
     *
     * @param coins - Available onchain outputs to select from
     * @param amount - Target send amount in satoshis
     * @param feeRate - Fee rate in sat/vbyte
     * @param recipientAddress - Destination address for size estimation
     * @returns Selected inputs, change amount, and calculated fee
     * @throws Error if fee estimation fails to converge within max iterations
     */
    private estimateFeesAndSelectCoins;
    /**
     * Send bitcoin to a single onchain address.
     *
     * @param params - destination `address`, `amount` (in satoshis), and optional `feeRate` override (other fields ignored)
     * @returns Broadcast transaction id
     * @throws Error if the amount is non-positive, below dust, or cannot be funded
     * @see SendBitcoinParams
     */
    send(params: SendBitcoinParams): Promise<string>;
    /**
     * CPFP-bump a parent transaction that contains a pay-to-anchor output.
     *
     * @param parent - Parent transaction containing a pay-to-anchor output
     * @returns Tuple of parent transaction id and child transaction id
     * @throws Error if the parent transaction has no pay-to-anchor output or bumping cannot be funded
     * @see send
     */
    bumpP2A(parent: Transaction): Promise<[string, string]>;
}

type SetupServiceWorkerOptions = {
    path: string;
    activationTimeoutMs?: number;
};
/**
 * setupServiceWorker sets up the service worker.
 * @param pathOrOptions - the path to the service worker script or setup options
 * @throws if service workers are not supported or activation fails
 * @example
 * ```typescript
 * const worker = await setupServiceWorker("/service-worker.js");
 * ```
 */
declare function setupServiceWorker(pathOrOptions: string | SetupServiceWorkerOptions): Promise<ServiceWorker>;

/**
 * Default WebSocket Electrum endpoints. Mainnet, mutinynet, and signet
 * point at Ark Labs–operated Fulcrum 2.1 deployments (which support
 * `blockchain.transaction.broadcast_package` for atomic 1P1C TRUC
 * relay; see `ElectrumOnchainProvider.broadcastTransaction`). Testnet
 * defaults to Blockstream's public Fulcrum because Ark doesn't host
 * it. Regtest assumes the `electrum-ws` websocat bridge from
 * `vulpemventures/nigiri`.
 *
 * @example
 * ```typescript
 * import { ElectrumWS } from "ws-electrumx-client";
 * import { ELECTRUM_WS_URL, ElectrumOnchainProvider, networks } from "@arkade-os/sdk";
 *
 * const ws = new ElectrumWS(ELECTRUM_WS_URL.bitcoin);
 * const provider = new ElectrumOnchainProvider(ws, networks.bitcoin);
 * ```
 */
declare const ELECTRUM_WS_URL: Record<NetworkName, string>;
/**
 * Hostnames for Electrum endpoints reachable over raw TCP. Provided as
 * a reference for Node-side consumers — the SDK's
 * {@link ElectrumOnchainProvider} only speaks WebSocket because it has
 * to run in browsers, so this map is informational only and not
 * consumed by any built-in provider.
 *
 * Public Ark Labs Fulcrum instances expose:
 *   - port 50001 — plain TCP (Electrum protocol)
 *   - port 50002 — TCP + TLS (Electrum protocol)
 *   - port 50003 — WebSocket (Electrum-over-WS, see {@link ELECTRUM_WS_URL})
 */
declare const ELECTRUM_TCP_HOST: Record<NetworkName, string | null>;
type TransactionHistory = {
    tx_hash: string;
    height: number;
    fee?: number;
};
type BlockHeader = {
    height: number;
    hex: string;
};
type Unspent = {
    txid: string;
    vout: number;
    witnessUtxo: {
        script: Uint8Array;
        value: bigint;
    };
};
type VerboseTransaction = {
    txid: string;
    confirmations: number;
    blockhash?: string;
    blocktime?: number;
    time?: number;
    /** Raw transaction hex. Bitcoin Core's getrawtransaction <tx> 1 always
     *  includes this; we use it to derive exact satoshi amounts instead of
     *  multiplying the floating-point `value` field by 1e8. */
    hex?: string;
    vout: {
        n: number;
        value: number;
        scriptPubKey: {
            addresses?: string[];
            address?: string;
            hex: string;
        };
    }[];
    vin: {
        txid: string;
        vout: number;
    }[];
};
type HeaderSubscribeResult = {
    height: number;
    hex: string;
};
/**
 * WebSocket-based Electrum chain source using ws-electrumx-client.
 * Provides low-level methods for the Electrum protocol.
 *
 * @example
 * ```typescript
 * import { ElectrumWS } from "ws-electrumx-client";
 * import { WsElectrumChainSource } from "./providers/electrum";
 * import { networks } from "./networks";
 *
 * const ws = new ElectrumWS("wss://electrum.blockstream.info:50004");
 * const chain = new WsElectrumChainSource(ws, networks.bitcoin);
 *
 * const history = await chain.fetchHistories([script]);
 * await chain.close();
 * ```
 */
declare class WsElectrumChainSource {
    private ws;
    private network;
    private cachedTip;
    private headersSubscribePromise;
    constructor(ws: ElectrumWS, network: Network);
    /**
     * Send N requests in parallel and aggregate the results, replacement
     * for `ws.batchRequest`. The library's batchRequest is implemented as
     * `Promise.all` over individual request promises — when one element
     * rejects, the others remain pending. When their (often error)
     * responses arrive later, the library rejects them too, and nobody is
     * awaiting them: the rejections become unhandled and crash the test
     * runner / pollute production logs.
     *
     * `safeBatchRequest` issues each request through `ws.request` (so each
     * has its own request-promise lifecycle), waits for all of them via
     * `Promise.allSettled` (every promise gets an explicit handler), and
     * then surfaces the first error if any failed. Same wall-clock cost
     * as the library's batch (parallel send), no orphan rejections.
     *
     * Use this in place of `ws.batchRequest` for any call where one or
     * more elements may legitimately error (e.g. electrs index lag
     * surfacing as `missingheight` for a subset of heights/txids).
     */
    safeBatchRequest<T>(requests: {
        method: string;
        params: unknown[];
    }[]): Promise<T[]>;
    fetchTransactions(txids: string[]): Promise<{
        txID: string;
        hex: string;
    }[]>;
    fetchVerboseTransaction(txid: string): Promise<VerboseTransaction>;
    fetchVerboseTransactions(txids: string[]): Promise<VerboseTransaction[]>;
    /**
     * Look up the block height of a confirmed transaction without relying
     * on the verbose-tx endpoint. `blockchain.transaction.get_merkle` is
     * part of the standard SPV protocol and is supported by both Fulcrum
     * and electrs (whereas `blockchain.transaction.get` with verbose=true
     * is Fulcrum-only). Returns `null` when the tx is in the mempool —
     * electrs in that case rejects with a "not yet in a block" error.
     */
    fetchTxMerkle(txid: string): Promise<{
        blockHeight: number;
    } | null>;
    unsubscribeScriptStatus(script: Uint8Array): Promise<void>;
    subscribeScriptStatus(script: Uint8Array, callback: (scripthash: string, status: string | null) => void): Promise<void>;
    fetchHistories(scripts: Uint8Array[]): Promise<TransactionHistory[][]>;
    fetchHistory(script: Uint8Array): Promise<TransactionHistory[]>;
    fetchBlockHeaders(heights: number[]): Promise<BlockHeader[]>;
    fetchBlockHeader(height: number): Promise<BlockHeader>;
    /**
     * Returns the current chain tip and keeps it fresh via a single
     * server-side subscription. Subsequent calls return the cached tip
     * (updated by background notifications) without round-tripping to the
     * server. Previously each call issued `blockchain.headers.subscribe` as
     * a regular request, leaving a stale subscription on the server every
     * time — under polling that adds up. ws-electrumx-client deduplicates
     * `subscribe()` by method+params, so registering once is enough.
     */
    subscribeHeaders(): Promise<HeaderSubscribeResult>;
    estimateFees(targetNumberBlocks: number): Promise<number>;
    broadcastTransaction(txHex: string): Promise<string>;
    /**
     * Submit a package of raw transactions atomically via Fulcrum's
     * `blockchain.transaction.broadcast_package` method, the on-the-wire
     * equivalent of bitcoind's `submitpackage` RPC.
     *
     * Required for TRUC (BIP 431) 1P1C relay where the parent has zero
     * (or below-minfee) fee and depends on the child to pay for both via
     * CPFP — sequential broadcast cannot work in that case because the
     * parent would be rejected from the mempool on its own.
     *
     * @param txHexes - Topologically sorted raw transactions; child must
     *                  be the last element. Currently must be a 1P1C pair
     *                  (length 2). Parents may not depend on each other.
     * @returns The child transaction id (the last entry in the array),
     *          computed locally — `broadcast_package` itself returns
     *          `{success, errors}` rather than a txid.
     * @throws If the server does not implement `broadcast_package` (e.g.
     *         ElectrumX, or older Fulcrum, or Fulcrum backed by bitcoind
     *         < v28.0.0). Callers must surface this clearly to users —
     *         this method does NOT silently fall back to sequential
     *         broadcasts because doing so would let TRUC packages fail
     *         in subtle ways.
     * @throws If the server returns `success=false`, surfacing the
     *         underlying mempool rejection in the error message.
     */
    broadcastPackage(txHexes: string[]): Promise<string>;
    getRelayFee(): Promise<number>;
    close(): Promise<void>;
    waitForAddressReceivesTx(addr: string): Promise<void>;
    listUnspents(addr: string): Promise<Unspent[]>;
    /**
     * Get the address string for a script output, if decodable.
     */
    addressForScript(scriptHex: string): string | undefined;
}
/**
 * Electrum-based implementation of the {@link OnchainProvider} interface.
 *
 * Built around the subset of the Electrum protocol that both **Fulcrum**
 * and **electrs** support — listunspent, get_history, transaction.get
 * (non-verbose), transaction.get_merkle, block.header,
 * headers.subscribe, scripthash.subscribe, estimatefee, relayfee, and
 * broadcast. The verbose form of `transaction.get` is **not** used (it's
 * Fulcrum-only and rejected by electrs); confirmation status is derived
 * from `transaction.get_merkle` plus parsed block headers.
 *
 * Output amounts are derived from parsed raw transaction bytes (exact
 * bigints), never the floating-point `value` fields some servers return.
 *
 * Atomic 1P1C package broadcast (TRUC / BIP 431) is supported via
 * Fulcrum's `blockchain.transaction.broadcast_package`. There is **no
 * fallback** to sequential parent-then-child broadcasts — TRUC packages
 * with a zero-fee parent would silently fail, so the call surfaces an
 * error against servers that don't support the method.
 *
 * @example Default URL via {@link ELECTRUM_WS_URL}
 * ```typescript
 * import { ElectrumWS } from "ws-electrumx-client";
 * import {
 *   ElectrumOnchainProvider,
 *   ELECTRUM_WS_URL,
 *   networks,
 * } from "@arkade-os/sdk";
 *
 * const ws = new ElectrumWS(ELECTRUM_WS_URL.bitcoin);
 * const provider = new ElectrumOnchainProvider(ws, networks.bitcoin);
 *
 * const coins = await provider.getCoins("bc1q...");
 * await provider.close();
 * ```
 *
 * @example Custom server
 * ```typescript
 * const ws = new ElectrumWS("wss://my-fulcrum.example:50004");
 * const provider = new ElectrumOnchainProvider(ws, networks.bitcoin);
 * ```
 */
declare class ElectrumOnchainProvider implements OnchainProvider {
    private ws;
    private network;
    private chain;
    constructor(ws: ElectrumWS, network: Network);
    getCoins(address: string): Promise<Coin[]>;
    getFeeRate(): Promise<number | undefined>;
    /**
     * Broadcast a single transaction or a TRUC (BIP 431) 1P1C package
     * atomically.
     *
     * **Server requirements for 1P1C packages:** the backing Electrum
     * server must implement `blockchain.transaction.broadcast_package`
     * (Fulcrum ≥ 1.10) and be backed by bitcoind ≥ v28.0.0. ElectrumX
     * does not implement this method. There is **no fallback** to
     * sequential parent-then-child broadcast: TRUC packages typically
     * have a zero-fee parent and would be rejected from the mempool on
     * their own, so a fallback would silently fail in subtle ways.
     * Callers receiving a "method not found" error here should route
     * through a different provider for that submission.
     *
     * @param txs - One transaction (single broadcast) or two
     *              topologically-sorted transactions (parent first,
     *              child last) for 1P1C package relay.
     * @returns The broadcast txid (or the child txid for 1P1C packages).
     */
    broadcastTransaction(...txs: string[]): Promise<string>;
    getTxOutspends(txid: string): Promise<{
        spent: boolean;
        txid: string;
    }[]>;
    getTransactions(address: string): Promise<ExplorerTransaction[]>;
    /**
     * Resolve a list of `{tx_hash, height}` entries (as returned by the
     * scripthash history endpoint) into ExplorerTransaction shape **without
     * using the verbose-tx endpoint**, which only Fulcrum implements. We
     * reconstruct everything the verbose response would have given us:
     *   - vouts ← parse the raw tx (exact sat amounts, no float precision risk)
     *   - block_time ← batch-fetch the block headers for the heights present
     *   - addresses ← decode each output's scriptPubKey via @scure/btc-signer
     */
    private historyToExplorerTxs;
    /**
     * Build an ExplorerTransaction from a history entry plus the raw tx hex
     * (when known) and a height→block_time map. Parse errors propagate —
     * silently returning an empty vout would hide real outputs (e.g. a
     * deposit) and is far worse for protocol-level money handling than
     * failing the whole batch.
     */
    private buildExplorerTx;
    /**
     * Decode `address` into its scriptPubKey, throwing a clear error if the
     * input is malformed. @scure/btc-signer raises a generic decode error
     * which is hard to map back to user input — this wraps it.
     */
    private encodeAddress;
    getTxStatus(txid: string): Promise<{
        confirmed: false;
    } | {
        confirmed: true;
        blockTime: number;
        blockHeight: number;
    }>;
    getChainTip(): Promise<{
        height: number;
        time: number;
        hash: string;
    }>;
    watchAddresses(addresses: string[], eventCallback: (txs: ExplorerTransaction[]) => void): Promise<() => void>;
    /** Close the underlying WebSocket connection. */
    close(): Promise<void>;
}

type ArkTxInput = {
    tapLeafScript: TapLeafScript;
} & EncodedVtxoScript & Pick<VirtualCoin, "txid" | "vout" | "value">;
type OffchainTx = {
    arkTx: Transaction;
    checkpoints: Transaction[];
};
/**
 * Builds an offchain transaction with checkpoint transactions.
 *
 * Creates one checkpoint transaction per input and a virtual transaction that
 * combines all the checkpoints, sending to the specified outputs. This is the
 * core function for creating Arkade transactions.
 *
 * @param inputs - Array of virtual transaction inputs
 * @param outputs - Array of transaction outputs
 * @param serverUnrollScript - Server unroll script for checkpoint transactions
 * @returns Object containing the virtual transaction and checkpoint transactions
 */
declare function buildOffchainTx(inputs: ArkTxInput[], outputs: TransactionOutput[], serverUnrollScript: CSVMultisigTapscript.Type): OffchainTx;
declare function hasBoardingTxExpired(coin: ExtendedCoin, boardingTimelock: RelativeTimelock, chainTipHeight?: number): boolean;
/**
 * Verify tapscript signatures on a transaction input
 * @param tx Transaction to verify
 * @param inputIndex Index of the input to verify
 * @param requiredSigners List of required signer pubkeys (hex encoded)
 * @param excludePubkeys List of pubkeys to exclude from verification (hex encoded, e.g., server key not yet signed)
 * @param allowedSighashTypes List of allowed sighash types (defaults to [SigHash.DEFAULT])
 * @throws Error if verification fails
 */
declare function verifyTapscriptSignatures(tx: Transaction, inputIndex: number, requiredSigners: string[], excludePubkeys?: string[], allowedSighashTypes?: number[]): void;
/**
 * Merges the signed transaction with the original transaction
 * @param signedTx signed transaction
 * @param originalTx original transaction
 */
declare function combineTapscriptSigs(signedTx: Transaction, originalTx: Transaction): Transaction;
/**
 * Validates if a given string is a valid Arkade address by attempting to decode it.
 * @param address The Arkade address to validate.
 * @returns True if the address is valid, false otherwise.
 */
declare function isValidArkAddress(address: string): boolean;

declare function getRandomId(): string;

/**
 * ArkPsbtFieldKey are the available key names for the Arkade PSBT custom fields.
 */
declare enum ArkPsbtFieldKey {
    VtxoTaprootTree = "taptree",
    VtxoTreeExpiry = "expiry",
    Cosigner = "cosigner",
    ConditionWitness = "condition",
    PrevArkTx = "prevarktx",
    PrevoutTx = "prevouttx"
}
/**
 * ArkPsbtFieldKeyType is the key type of the Arkade PSBT custom field.
 * Every Arkade PSBT field has key type 222.
 */
declare const ArkPsbtFieldKeyType = 222;
/**
 * ArkPsbtFieldCoder is the coder for the Arkade PSBT custom fields.
 * Each type has its own coder.
 */
interface ArkPsbtFieldCoder<T> {
    key: ArkPsbtFieldKey;
    encode: (value: T) => NonNullable<TransactionInputUpdate["unknown"]>[number];
    decode: (value: NonNullable<TransactionInputUpdate["unknown"]>[number]) => T | null;
}
/**
 * setArkPsbtField appends a new unknown field to the input at inputIndex
 *
 * @example
 * ```typescript
 * setArkPsbtField(tx, 0, VtxoTaprootTree, myTaprootTree);
 * setArkPsbtField(tx, 0, VtxoTreeExpiry, myVtxoTreeExpiry);
 * ```
 */
declare function setArkPsbtField<T>(tx: Transaction$1, inputIndex: number, coder: ArkPsbtFieldCoder<T>, value: T): void;
/**
 * getArkPsbtFields returns all the values of the given coder for the input at inputIndex
 * Multiple fields of the same type can exist in a single input.
 *
 * @example
 * ```typescript
 * const vtxoTaprootTreeFields = getArkPsbtFields(tx, 0, VtxoTaprootTree);
 * console.log(`input has ${vtxoTaprootTreeFields.length} vtxoTaprootTree fields`);
 */
declare function getArkPsbtFields<T>(tx: Transaction$1, inputIndex: number, coder: ArkPsbtFieldCoder<T>): T[];
/**
 * VtxoTaprootTree is set to pass all spending leaves of the vtxo input
 *
 * @example
 * ```typescript
 * const vtxoTaprootTree = VtxoTaprootTree.encode(myTaprootTree);
 */
declare const VtxoTaprootTree: ArkPsbtFieldCoder<Uint8Array>;
/**
 * ConditionWitness is set to pass the witness data used to finalize the conditionMultisigClosure
 *
 * @example
 * ```typescript
 * const conditionWitness = ConditionWitness.encode(myConditionWitness);
 */
declare const ConditionWitness: ArkPsbtFieldCoder<Uint8Array[]>;
/**
 * PrevArkTxField carries the serialized raw bitcoin tx of the previous Ark tx
 * spent by an input. Used by OP_INSPECTINPUTSCRIPTPUBKEY on intent proofs and
 * other contexts where the prevout pkScript must be looked up off-chain.
 *
 * Key: [0xde] || "prevarktx". Value: serialized wire.MsgTx (NOT a PSBT).
 */
declare const PrevArkTxField: ArkPsbtFieldCoder<Uint8Array>;
/**
 * PrevoutTxField carries the serialized raw bitcoin tx that produced the
 * previous output spent by an input. Used by OP_INSPECTINPUTSCRIPTPUBKEY in
 * the SubmitOnchainTx flow, where there is no Ark tx but a plain Bitcoin
 * funding tx whose pkScript must be resolvable.
 *
 * Key: [0xde] || "prevouttx". Value: serialized wire.MsgTx (NOT a PSBT).
 */
declare const PrevoutTxField: ArkPsbtFieldCoder<Uint8Array>;
/**
 * CosignerPublicKey is set on every TxGraph transactions to identify the musig2 public keys
 *
 * @example
 * ```typescript
 * const cosignerPublicKey = CosignerPublicKey.encode(myCosignerPublicKey);
 */
declare const CosignerPublicKey: ArkPsbtFieldCoder<{
    index: number;
    key: Uint8Array;
}>;
/**
 * VtxoTreeExpiry is set to pass the expiry time of the input
 *
 * @example
 * ```typescript
 * const vtxoTreeExpiry = VtxoTreeExpiry.encode(myVtxoTreeExpiry);
 */
declare const VtxoTreeExpiry: ArkPsbtFieldCoder<{
    type: "blocks" | "seconds";
    value: bigint;
}>;

/**
 * BIP-322 simple message signing and verification.
 *
 * Supports P2TR (Taproot) signing and verification, P2WPKH verification,
 * and legacy P2PKH verification (Bitcoin Core signmessage format).
 *
 * Reuses the same toSpend/toSign transaction construction as Intent proofs,
 * but with the standard BIP-322 tagged hash ("BIP0322-signed-message")
 * instead of the Arkade-specific tag.
 *
 * @see https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki
 *
 * @example
 * ```typescript
 * // Sign a message (P2TR)
 * const signature = await BIP322.sign("Hello Bitcoin!", identity);
 *
 * // Verify a signature (P2TR or P2WPKH)
 * const valid = BIP322.verify("Hello Bitcoin!", signature, "bc1p...");
 * const valid2 = BIP322.verify("Hello Bitcoin!", signature, "bc1q...");
 * ```
 */
declare namespace BIP322 {
    /**
     * Sign a message using the BIP-322 simple signature scheme.
     *
     * Constructs the standard BIP-322 toSpend and toSign transactions,
     * signs via the Identity interface, and returns the base64-encoded
     * witness stack.
     *
     * @param message - The message to sign
     * @param identity - Identity instance (holds the private key internally)
     * @param network - Optional Bitcoin network for P2TR address derivation
     * @returns Base64-encoded BIP-322 simple signature (witness stack)
     */
    function sign(message: string, identity: Identity, network?: BTC_NETWORK): Promise<string>;
    /**
     * Verify a BIP-322 signature for a P2TR, P2WPKH, or legacy P2PKH address.
     *
     * For segwit addresses (P2TR, P2WPKH), reconstructs the BIP-322
     * toSpend/toSign transactions and verifies the witness signature.
     *
     * For P2PKH addresses, verifies using the Bitcoin Core legacy
     * `signmessage` format (compact recoverable ECDSA signature).
     *
     * @param message - The original message that was signed
     * @param signature - Base64-encoded signature (BIP-322 witness or legacy compact)
     * @param address - P2TR, P2WPKH, or P2PKH address of the signer
     * @param network - Optional Bitcoin network for address decoding
     * @returns true if the signature is valid
     */
    function verify(message: string, signature: string, address: string, network?: BTC_NETWORK): boolean;
}

/**
 * ArkNotes are special virtual outputs in the Arkade protocol that
 * can be created and spent without requiring any transactions.
 * The server mints them, and they are encoded as base58 strings
 * with a human-readable prefix, a preimage and a value.
 *
 * @see VtxoScript
 *
 * @example
 * ```typescript
 * // Create an ArkNote
 * const note = new ArkNote(preimage, 50000);
 *
 * // Encode to string
 * const noteString = note.toString();
 *
 * // Decode from string
 * const decodedNote = ArkNote.fromString(noteString);
 * ```
 */
declare class ArkNote implements ExtendedCoin {
    preimage: Uint8Array;
    value: number;
    HRP: string;
    static readonly DefaultHRP = "arknote";
    static readonly PreimageLength = 32;
    static readonly ValueLength = 4;
    static readonly Length: number;
    static readonly FakeOutpointIndex = 0;
    readonly vtxoScript: VtxoScript;
    /** Hashlock script backing the note. */
    readonly txid: string;
    readonly vout = 0;
    readonly forfeitTapLeafScript: TapLeafScript;
    readonly intentTapLeafScript: TapLeafScript;
    readonly tapTree: Bytes;
    readonly status: Status;
    readonly extraWitness?: Bytes[] | undefined;
    /**
     * Create an ArkNote from a preimage and value.
     *
     * @param preimage - 32-byte preimage revealed to spend the note
     * @param value - Note value in satoshis
     * @param HRP - Optional human-readable prefix for string encoding
     */
    constructor(preimage: Uint8Array, value: number, HRP?: string);
    /**
     * Encode the note as raw bytes.
     *
     * @returns Serialized note bytes
     * @see decode
     */
    encode(): Uint8Array;
    /**
     * Decode a note from raw bytes.
     *
     * @param data - Serialized note bytes
     * @param hrp - Human-readable prefix expected for future string encoding
     * @returns Decoded ArkNote
     * @throws Error if the payload length is invalid
     * @see encode
     */
    static decode(data: Uint8Array, hrp?: string): ArkNote;
    /**
     * Decode a note from its base58 string form.
     *
     * @param noteStr - Base58-encoded note string
     * @param hrp - Human-readable prefix expected on the note string
     * @returns Decoded ArkNote
     * @throws Error if the prefix or base58 payload is invalid
     * @see toString
     */
    static fromString(noteStr: string, hrp?: string): ArkNote;
    /**
     * Encode the note to its human-readable base58 string form.
     *
     * @returns Base58-encoded note string
     * @see fromString
     */
    toString(): string;
}

/**
 * Emulator REST client.
 *
 * The emulator is a signing service that executes Arkade scripts
 * and co-signs transactions when the scripts pass validation.
 */

interface EmulatorInfo {
    version: string;
    signerPubkey: string;
}
interface EmulatorProvider {
    getInfo(): Promise<EmulatorInfo>;
    submitTx(arkTx: string, checkpointTxs: string[]): Promise<{
        signedArkTx: string;
        signedCheckpointTxs: string[];
    }>;
    submitIntent(intent: {
        proof: string;
        message: Intent.RegisterMessage;
    }): Promise<string>;
    submitFinalization(intent: {
        proof: string;
        message: Intent.RegisterMessage;
    }, forfeits: string[], connectorTree: ConnectorTreeNode[] | null, commitmentTx: string): Promise<{
        signedForfeits: string[];
        signedCommitmentTx?: string;
    }>;
    submitOnchainTx(tx: string): Promise<{
        signedTx: string;
    }>;
}
interface ConnectorTreeNode {
    txid: string;
    tx: string;
    children: Record<string, string>;
}
/**
 * REST-based emulator client.
 *
 * @example
 * ```typescript
 * const client = new RestEmulatorProvider('http://localhost:7073');
 * const info = await client.getInfo();
 * console.log('Emulator pubkey:', info.signerPubkey);
 * ```
 */
declare class RestEmulatorProvider implements EmulatorProvider {
    serverUrl: string;
    constructor(serverUrl: string);
    getInfo(): Promise<EmulatorInfo>;
    submitTx(arkTx: string, checkpointTxs: string[]): Promise<{
        signedArkTx: string;
        signedCheckpointTxs: string[];
    }>;
    submitIntent(intent: {
        proof: string;
        message: Intent.RegisterMessage;
    }): Promise<string>;
    submitFinalization(intent: {
        proof: string;
        message: Intent.RegisterMessage;
    }, forfeits: string[], connectorTree: ConnectorTreeNode[] | null, commitmentTx: string): Promise<{
        signedForfeits: string[];
        signedCommitmentTx?: string;
    }>;
    submitOnchainTx(tx: string): Promise<{
        signedTx: string;
    }>;
}

/**
 * Arkade Batch Handler
 *
 * Factory function that creates a `Batch.Handler` for arkade-script
 * transactions with emulator co-signing. Handles both on-chain
 * boarding inputs and off-chain virtual VTXO settlement in a single batch.
 *
 * @module arkade/batch
 */

type ArkadeExtendedCoin = ExtendedCoin & {
    arkadeScriptBytes: Uint8Array;
};
declare function createArkadeBatchHandler(intentId: string, inputs: ArkadeExtendedCoin[], signer: Identity, signedProof: string, message: Intent.RegisterMessage, session: SignerSession, arkProvider: ArkProvider, emulator: EmulatorProvider, network: Network): Batch.Handler;

/**
 * Arkade VTXO Script
 *
 * Extends VtxoScript to support Arkade-enhanced tapscript leaves.
 * Arkade leaves have their pubkey set tweaked by the emulator's
 * script-bound key before being encoded into the taproot tree.
 *
 * @module arkade/vtxoScript
 */

type ArkadeLeaf = {
    arkadeScript: Uint8Array;
    tapscript: ArkTapscript<TapscriptType, any>;
    emulators: Uint8Array[];
};
type ArkadeVtxoInput = ArkadeLeaf | Uint8Array;
/**
 * VtxoScript subclass that supports Arkade-enhanced tapscript leaves.
 *
 * For each {@link ArkadeLeaf} in the constructor input, the emulators'
 * public keys are tweaked with the arkade script hash and appended to the
 * leaf's pubkey set before encoding into the taproot tree.
 * Plain `Uint8Array` leaves are passed through unchanged.
 *
 * The resulting `arkadeScripts` map records which leaf indices carry an
 * arkade script, so callers can set the corresponding PSBT field when
 * signing.
 *
 * @example
 * ```typescript
 * import { ArkadeVtxoScript, ArkadeScript, computeArkadeScriptPublicKey } from "@arkade-os/sdk";
 *
 * // Build an arkade script that checks output 0 goes to a specific address
 * const arkadeScriptBytes = ArkadeScript.encode([
 *     0, "INSPECTOUTPUTSCRIPTPUBKEY",
 *     1, "EQUALVERIFY",
 *     witnessProgram, "EQUAL",
 * ]);
 *
 * // Create a VtxoScript with one arkade-enhanced multisig leaf and one CSV exit leaf
 * const vtxoScript = new ArkadeVtxoScript([
 *     {
 *         arkadeScript: arkadeScriptBytes,
 *         emulators: [emulatorPubkey],
 *         tapscript: MultisigTapscript.encode({
 *             pubkeys: [bobPubkey, serverPubkey],
 *         }),
 *     },
 *     CSVMultisigTapscript.encode({
 *         timelock: { type: "blocks", value: 5120n },
 *         pubkeys: [bobPubkey, serverPubkey],
 *     }).script,
 * ]);
 *
 * // Derive the contract address
 * const address = vtxoScript.address(network.hrp, serverXOnlyPubkey).encode();
 *
 * // Find the arkade leaf for signing
 * const leaf = vtxoScript.findLeaf(hex.encode(multisigScript));
 * ```
 */
declare class ArkadeVtxoScript extends VtxoScript {
    readonly arkadeScripts: ReadonlyMap<number, Uint8Array>;
    constructor(scripts: ArkadeVtxoInput[]);
}

type VSize = {
    value: bigint;
    fee(feeRate: bigint): bigint;
};
declare class TxWeightEstimator {
    static readonly P2PKH_SCRIPT_SIG_SIZE: number;
    static readonly INPUT_SIZE: number;
    static readonly BASE_CONTROL_BLOCK_SIZE: number;
    static readonly OUTPUT_SIZE: number;
    static readonly P2WPKH_OUTPUT_SIZE: number;
    static readonly BASE_TX_SIZE: number;
    static readonly WITNESS_HEADER_SIZE = 2;
    static readonly WITNESS_SCALE_FACTOR = 4;
    static readonly P2TR_OUTPUT_SIZE: number;
    hasWitness: boolean;
    inputCount: number;
    outputCount: number;
    inputSize: number;
    inputWitnessSize: number;
    outputSize: number;
    private constructor();
    static create(): TxWeightEstimator;
    addP2AInput(): TxWeightEstimator;
    addKeySpendInput(isDefault?: boolean): TxWeightEstimator;
    addP2PKHInput(): TxWeightEstimator;
    addTapscriptInput(leafWitnessSize: number, leafScriptSize: number, leafControlBlockSize: number): TxWeightEstimator;
    addP2WPKHOutput(): TxWeightEstimator;
    addP2TROutput(): TxWeightEstimator;
    /**
     * Adds an output given a raw script.
     * Cost = 8 bytes (amount) + varint(scriptLen) + scriptLen
     */
    addOutputScript(script: Uint8Array): TxWeightEstimator;
    /**
     * Adds an output by decoding the address to get the exact script size.
     */
    addOutputAddress(address: string, network: Network): TxWeightEstimator;
    vsize(): VSize;
}

declare namespace Unroll {
    enum StepType {
        UNROLL = 0,
        WAIT = 1,
        DONE = 2
    }
    /**
     * Unroll step where the transaction has to be broadcasted in a 1C1P package
     */
    type UnrollStep = {
        tx: Transaction;
        pkg: [parent: string, child: string];
    };
    /**
     * Wait step where the transaction has to be confirmed onchain
     */
    type WaitStep = {
        txid: string;
    };
    /**
     * Done step where the unrolling process is complete
     */
    type DoneStep = {
        vtxoTxid: string;
    };
    type Step = ({
        type: StepType.DONE;
    } & DoneStep) | ({
        type: StepType.UNROLL;
    } & UnrollStep) | ({
        type: StepType.WAIT;
    } & WaitStep);
    /**
     * Manages the unrolling process of a virtual output back to the Bitcoin blockchain.
     *
     * The Session class implements an async iterator that processes the unrolling steps:
     * 1. **WAIT**: Waits for a transaction to be confirmed onchain (if it's in mempool)
     * 2. **UNROLL**: Broadcasts the next transaction in the chain to the blockchain
     * 3. **DONE**: Indicates the unrolling process is complete
     *
     * The unrolling process works by traversing the transaction chain from the root (most recent)
     * to the leaf (oldest), broadcasting each transaction that isn't already onchain.
     *
     * @example
     * ```typescript
     * const session = await Unroll.Session.create(vtxoOutpoint, bumper, explorer, indexer);
     *
     * // iterate over the steps
     * for await (const doneStep of session) {
     *   switch (doneStep.type) {
     *     case Unroll.StepType.WAIT:
     *       console.log(`Transaction ${doneStep.txid} confirmed`);
     *       break;
     *     case Unroll.StepType.UNROLL:
     *       console.log(`Broadcasting transaction ${doneStep.tx.id}`);
     *       break;
     *     case Unroll.StepType.DONE:
     *       console.log(`Unrolling complete for virtual output ${doneStep.vtxoTxid}`);
     *       break;
     *   }
     * }
     * ```
     **/
    class Session implements AsyncIterable<Step> {
        readonly toUnroll: Outpoint & {
            chain: ChainTx[];
        };
        readonly bumper: AnchorBumper;
        readonly explorer: OnchainProvider;
        readonly indexer: IndexerProvider;
        /** Create an unroll session from a virtual output outpoint and its dependency chain. */
        constructor(toUnroll: Outpoint & {
            chain: ChainTx[];
        }, bumper: AnchorBumper, explorer: OnchainProvider, indexer: IndexerProvider);
        /** Create an unroll session by loading the virtual output chain from the indexer. */
        static create(toUnroll: Outpoint, bumper: AnchorBumper, explorer: OnchainProvider, indexer: IndexerProvider): Promise<Session>;
        /**
         * Get the next step to be executed
         * @returns The next step to be executed + the function to execute it
         */
        next(): Promise<Step & {
            do: () => Promise<void>;
        }>;
        /**
         * Iterate over the steps to be executed and execute them
         * @returns An async iterator over the executed steps
         */
        [Symbol.asyncIterator](): AsyncIterator<Step>;
    }
    /**
     * Complete the unroll of a virtual output by broadcasting the transaction that spends the CSV path.
     * @param wallet the wallet owning the virtual output(s)
     * @param vtxoTxids the txids of the virtual output(s) to complete unroll
     * @param outputAddress the address to send the unrolled funds to
     * @throws if the virtual output(s) are not fully unrolled, if the txids are not found, if the tx is not confirmed, if no exit path is found or not available
     * @returns the txid of the transaction spending the unrolled funds
     */
    function completeUnroll(wallet: Wallet, vtxoTxids: string[], outputAddress: string): Promise<string>;
}

declare class ArkError extends Error {
    readonly code: number;
    readonly message: string;
    readonly name: string;
    readonly metadata?: Record<string, string> | undefined;
    constructor(code: number, message: string, name: string, metadata?: Record<string, string> | undefined);
}
/**
 * Try to convert an error to an ArkError class, returning undefined if the error is not an ArkError
 * @param error - The error to parse
 * @returns The parsed ArkError, or undefined if the error is not an ArkError
 */
declare function maybeArkError(error: any): ArkError | undefined;

declare function validateConnectorsTxGraph(settlementTxB64: string, connectorsGraph: TxTree): void;
declare function validateVtxoTxGraph(graph: TxTree, roundTransaction: Transaction$2, sweepTapTreeRoot: Uint8Array): void;

/**
 * Build a forfeit transaction that spends the provided inputs to a single forfeit output.
 *
 * @param inputs - Inputs to include in the forfeit transaction
 * @param forfeitPkScript - ScriptPubKey for the forfeit output
 * @param txLocktime - Optional locktime to apply to the transaction
 */
declare function buildForfeitTx(inputs: TransactionInputUpdate[], forfeitPkScript: Uint8Array, txLocktime?: number): Transaction;

/**
 * EmulatorEntry represents a single entry in the Emulator Packet,
 * mapping a transaction input to its arkade script and witness data.
 */
interface EmulatorEntry {
    /** Transaction input index (u16 LE) */
    vin: number;
    /** Arkade Script bytecode */
    script: Uint8Array;
    /** Script witness data (serialized) */
    witness?: Uint8Array;
}
/**
 * EmulatorPacket implements ExtensionPacket for type 0x01.
 *
 * Internal wire format (inside TLV payload):
 *   compactSize(entry_count) + for each entry:
 *     u16_le(vin) + compactSize(script_len) + script + compactSize(witness_len) + witness
 *
 * Uses Bitcoin CompactSize encoding for internal length fields.
 */
declare class EmulatorPacket implements ExtensionPacket {
    readonly entries: EmulatorEntry[];
    /** PACKET_TYPE is the 1-byte TLV type tag used in the Extension envelope. */
    static readonly PACKET_TYPE = 1;
    private constructor();
    static create(entries: EmulatorEntry[]): EmulatorPacket;
    static fromBytes(data: Uint8Array): EmulatorPacket;
    type(): number;
    serialize(): Uint8Array;
}

/**
 * ArkadeMagic is the 3-byte magic prefix ("ARK") that identifies an OP_RETURN
 * output as an Arkade extension blob.
 */
declare const ARKADE_MAGIC: Uint8Array<ArrayBuffer>;
/**
 * ErrExtensionNotFound is thrown when no extension output is found in a transaction.
 */
declare class ExtensionNotFoundError extends Error {
    constructor();
}
/**
 * Extension is a set of typed packets encoded in an OP_RETURN output.
 *
 * Wire format:
 *   OP_RETURN | <push> | ARK(3B) | [type(1B) | varint_len | data]...
 */
declare class Extension {
    private readonly packets;
    private constructor();
    static create(packets: ExtensionPacket[]): Extension;
    /**
     * isExtension returns true if the script is an OP_RETURN whose push data
     * begins with the ARK magic bytes.
     */
    static isExtension(script: Uint8Array): boolean;
    /**
     * fromBytes parses an Extension from a raw OP_RETURN script.
     */
    static fromBytes(script: Uint8Array): Extension;
    /**
     * fromTx searches the transaction outputs for an extension blob and parses it.
     * Throws ExtensionNotFoundError if none is found.
     */
    static fromTx(tx: Transaction): Extension;
    /**
     * serialize encodes the extension as an OP_RETURN script.
     *
     * Layout: OP_RETURN | <push> | ARK | [type | varint_len | data]...
     */
    serialize(): Uint8Array;
    /**
     * txOut returns the extension as a zero-value OP_RETURN transaction output.
     */
    txOut(): Required<Pick<TransactionOutput, "script" | "amount">>;
    /**
     * getAssetPacket returns the embedded Packet, or null if not present.
     */
    getAssetPacket(): Packet | null;
    /**
     * getEmulatorPacket returns the embedded EmulatorPacket, or null if not present.
     */
    getEmulatorPacket(): EmulatorPacket | null;
    /**
     * getPacketByType returns the first packet matching the given type tag, or null.
     */
    getPacketByType(packetType: number): ExtensionPacket | null;
    /**
     * Returns all embedded packets in insertion order. Used when callers need
     * to rebuild an Extension from an existing one (e.g. appending a new packet).
     */
    getPackets(): readonly ExtensionPacket[];
}

/**
 * Arkade Script Opcodes
 *
 * This module defines ONLY Arkade-specific opcodes (0xb3, 0xc4-0xf3).
 * Standard Bitcoin opcodes are imported from @scure/btc-signer.
 *
 * Reference: arkade-os/emulator pkg/arkade/opcode.go
 */

declare const ARKADE_OP: {
    readonly MERKLEBRANCHVERIFY: 179;
    readonly SHA256INITIALIZE: 196;
    readonly SHA256UPDATE: 197;
    readonly SHA256FINALIZE: 198;
    readonly INSPECTINPUTOUTPOINT: 199;
    readonly INSPECTINPUTARKADESCRIPTHASH: 200;
    readonly INSPECTINPUTVALUE: 201;
    readonly INSPECTINPUTSCRIPTPUBKEY: 202;
    readonly INSPECTINPUTSEQUENCE: 203;
    readonly CHECKSIGFROMSTACK: 204;
    readonly PUSHCURRENTINPUTINDEX: 205;
    readonly INSPECTINPUTARKADEWITNESSHASH: 206;
    readonly INSPECTOUTPUTVALUE: 207;
    readonly INSPECTOUTPUTSCRIPTPUBKEY: 209;
    readonly INSPECTVERSION: 210;
    readonly INSPECTLOCKTIME: 211;
    readonly INSPECTNUMINPUTS: 212;
    readonly INSPECTNUMOUTPUTS: 213;
    readonly TXWEIGHT: 214;
    readonly ADD64: 215;
    readonly SUB64: 216;
    readonly MUL64: 217;
    readonly DIV64: 218;
    readonly NEG64: 219;
    readonly LESSTHAN64: 220;
    readonly LESSTHANOREQUAL64: 221;
    readonly GREATERTHAN64: 222;
    readonly GREATERTHANOREQUAL64: 223;
    readonly SCRIPTNUMTOLE64: 224;
    readonly LE64TOSCRIPTNUM: 225;
    readonly LE32TOLE64: 226;
    readonly ECMULSCALARVERIFY: 227;
    readonly TWEAKVERIFY: 228;
    readonly INSPECTNUMASSETGROUPS: 229;
    readonly INSPECTASSETGROUPASSETID: 230;
    readonly INSPECTASSETGROUPCTRL: 231;
    readonly FINDASSETGROUPBYASSETID: 232;
    readonly INSPECTASSETGROUPMETADATAHASH: 233;
    readonly INSPECTASSETGROUPNUM: 234;
    readonly INSPECTASSETGROUP: 235;
    readonly INSPECTASSETGROUPSUM: 236;
    readonly INSPECTOUTASSETCOUNT: 237;
    readonly INSPECTOUTASSETAT: 238;
    readonly INSPECTOUTASSETLOOKUP: 239;
    readonly INSPECTINASSETCOUNT: 240;
    readonly INSPECTINASSETAT: 241;
    readonly INSPECTINASSETLOOKUP: 242;
    readonly TXID: 243;
    readonly INSPECTPACKET: 244;
    readonly INSPECTINPUTPACKET: 245;
};
declare const ARKADE_OPCODES: number[];
declare const ARKADE_OPCODE_NAMES: Record<number, string>;
declare const ARKADE_OPCODE_VALUES: Record<string, number>;
/**
 * Combined map from opcode value to name (with OP_ prefix)
 * Includes both Bitcoin and Arkade opcodes
 */
declare const OPCODE_NAMES: Record<number, string>;
/**
 * Combined map from opcode name to value
 * Supports both with and without OP_ prefix
 * Includes both Bitcoin and Arkade opcodes
 */
declare const OPCODE_VALUES: Record<string, number>;
/**
 * Get the name of an opcode from its value
 * Returns OP_DATA_N for data push opcodes (0x01-0x4b)
 *
 * @param value Opcode byte value
 * @returns Opcode name with OP_ prefix, or undefined if unknown
 */
declare function getOpcodeName(value: number): string | undefined;
/**
 * Get the value of an opcode from its name
 * Supports OP_DATA_N pattern for data push opcodes
 *
 * @param name Opcode name (with or without OP_ prefix)
 * @returns Opcode byte value, or undefined if unknown
 */
declare function getOpcodeValue(name: string): number | undefined;

/**
 * Arkade Script Encoding and Decoding
 *
 * This module provides script encoding/decoding and ASM conversion helpers
 * that work with both standard Bitcoin opcodes and Arkade extension opcodes.
 *
 * Note: We use our own decoder for scripts because @scure/btc-signer doesn't
 * recognize Arkade opcodes (0xb3, 0xc4-0xf3) and would treat them as data pushes.
 */

/**
 * Combined OP map: standard Bitcoin opcodes + Arkade extension opcodes.
 * Keys follow @scure convention (without OP_ prefix for most).
 */
declare const ARKADE_OPS: {
    readonly MERKLEBRANCHVERIFY: 179;
    readonly SHA256INITIALIZE: 196;
    readonly SHA256UPDATE: 197;
    readonly SHA256FINALIZE: 198;
    readonly INSPECTINPUTOUTPOINT: 199;
    readonly INSPECTINPUTARKADESCRIPTHASH: 200;
    readonly INSPECTINPUTVALUE: 201;
    readonly INSPECTINPUTSCRIPTPUBKEY: 202;
    readonly INSPECTINPUTSEQUENCE: 203;
    readonly CHECKSIGFROMSTACK: 204;
    readonly PUSHCURRENTINPUTINDEX: 205;
    readonly INSPECTINPUTARKADEWITNESSHASH: 206;
    readonly INSPECTOUTPUTVALUE: 207;
    readonly INSPECTOUTPUTSCRIPTPUBKEY: 209;
    readonly INSPECTVERSION: 210;
    readonly INSPECTLOCKTIME: 211;
    readonly INSPECTNUMINPUTS: 212;
    readonly INSPECTNUMOUTPUTS: 213;
    readonly TXWEIGHT: 214;
    readonly ADD64: 215;
    readonly SUB64: 216;
    readonly MUL64: 217;
    readonly DIV64: 218;
    readonly NEG64: 219;
    readonly LESSTHAN64: 220;
    readonly LESSTHANOREQUAL64: 221;
    readonly GREATERTHAN64: 222;
    readonly GREATERTHANOREQUAL64: 223;
    readonly SCRIPTNUMTOLE64: 224;
    readonly LE64TOSCRIPTNUM: 225;
    readonly LE32TOLE64: 226;
    readonly ECMULSCALARVERIFY: 227;
    readonly TWEAKVERIFY: 228;
    readonly INSPECTNUMASSETGROUPS: 229;
    readonly INSPECTASSETGROUPASSETID: 230;
    readonly INSPECTASSETGROUPCTRL: 231;
    readonly FINDASSETGROUPBYASSETID: 232;
    readonly INSPECTASSETGROUPMETADATAHASH: 233;
    readonly INSPECTASSETGROUPNUM: 234;
    readonly INSPECTASSETGROUP: 235;
    readonly INSPECTASSETGROUPSUM: 236;
    readonly INSPECTOUTASSETCOUNT: 237;
    readonly INSPECTOUTASSETAT: 238;
    readonly INSPECTOUTASSETLOOKUP: 239;
    readonly INSPECTINASSETCOUNT: 240;
    readonly INSPECTINASSETAT: 241;
    readonly INSPECTINASSETLOOKUP: 242;
    readonly TXID: 243;
    readonly INSPECTPACKET: 244;
    readonly INSPECTINPUTPACKET: 245;
    readonly OP_0: number;
    readonly PUSHDATA1: number;
    readonly PUSHDATA2: number;
    readonly PUSHDATA4: number;
    readonly '1NEGATE': number;
    readonly RESERVED: number;
    readonly OP_1: number;
    readonly OP_2: number;
    readonly OP_3: number;
    readonly OP_4: number;
    readonly OP_5: number;
    readonly OP_6: number;
    readonly OP_7: number;
    readonly OP_8: number;
    readonly OP_9: number;
    readonly OP_10: number;
    readonly OP_11: number;
    readonly OP_12: number;
    readonly OP_13: number;
    readonly OP_14: number;
    readonly OP_15: number;
    readonly OP_16: number;
    readonly NOP: number;
    readonly VER: number;
    readonly IF: number;
    readonly NOTIF: number;
    readonly VERIF: number;
    readonly VERNOTIF: number;
    readonly ELSE: number;
    readonly ENDIF: number;
    readonly VERIFY: number;
    readonly RETURN: number;
    readonly TOALTSTACK: number;
    readonly FROMALTSTACK: number;
    readonly '2DROP': number;
    readonly '2DUP': number;
    readonly '3DUP': number;
    readonly '2OVER': number;
    readonly '2ROT': number;
    readonly '2SWAP': number;
    readonly IFDUP: number;
    readonly DEPTH: number;
    readonly DROP: number;
    readonly DUP: number;
    readonly NIP: number;
    readonly OVER: number;
    readonly PICK: number;
    readonly ROLL: number;
    readonly ROT: number;
    readonly SWAP: number;
    readonly TUCK: number;
    readonly CAT: number;
    readonly SUBSTR: number;
    readonly LEFT: number;
    readonly RIGHT: number;
    readonly SIZE: number;
    readonly INVERT: number;
    readonly AND: number;
    readonly OR: number;
    readonly XOR: number;
    readonly EQUAL: number;
    readonly EQUALVERIFY: number;
    readonly RESERVED1: number;
    readonly RESERVED2: number;
    readonly '1ADD': number;
    readonly '1SUB': number;
    readonly '2MUL': number;
    readonly '2DIV': number;
    readonly NEGATE: number;
    readonly ABS: number;
    readonly NOT: number;
    readonly '0NOTEQUAL': number;
    readonly ADD: number;
    readonly SUB: number;
    readonly MUL: number;
    readonly DIV: number;
    readonly MOD: number;
    readonly LSHIFT: number;
    readonly RSHIFT: number;
    readonly BOOLAND: number;
    readonly BOOLOR: number;
    readonly NUMEQUAL: number;
    readonly NUMEQUALVERIFY: number;
    readonly NUMNOTEQUAL: number;
    readonly LESSTHAN: number;
    readonly GREATERTHAN: number;
    readonly LESSTHANOREQUAL: number;
    readonly GREATERTHANOREQUAL: number;
    readonly MIN: number;
    readonly MAX: number;
    readonly WITHIN: number;
    readonly RIPEMD160: number;
    readonly SHA1: number;
    readonly SHA256: number;
    readonly HASH160: number;
    readonly HASH256: number;
    readonly CODESEPARATOR: number;
    readonly CHECKSIG: number;
    readonly CHECKSIGVERIFY: number;
    readonly CHECKMULTISIG: number;
    readonly CHECKMULTISIGVERIFY: number;
    readonly NOP1: number;
    readonly CHECKLOCKTIMEVERIFY: number;
    readonly CHECKSEQUENCEVERIFY: number;
    readonly NOP4: number;
    readonly NOP5: number;
    readonly NOP6: number;
    readonly NOP7: number;
    readonly NOP8: number;
    readonly NOP9: number;
    readonly NOP10: number;
    readonly CHECKSIGADD: number;
    readonly INVALID: number;
};
/** A single script operation: opcode string key, raw bytes, number, or bigint */
type ArkadeScriptOP = keyof typeof ARKADE_OPS | Uint8Array | number | bigint;
/** Array of script operations — the type that ArkadeScript encodes/decodes */
type ArkadeScriptType = ArkadeScriptOP[];
/**
 * Script CoderType with Arkade extension opcodes.
 *
 * Same API as `Script` from @scure/btc-signer, but with Arkade extension opcodes.
 *
 * @example
 * ```typescript
 * const script: ArkadeScriptType = ['DUP', 'HASH160', pubkeyHash, 'EQUALVERIFY', 'ADD64'];
 * const bytes = ArkadeScript.encode(script);
 * const decoded = ArkadeScript.decode(bytes);
 * ```
 */
declare const ArkadeScript: P.CoderType<ArkadeScriptType>;
/**
 * Convert script operations to ASM (assembly) format.
 * Supports both Bitcoin and Arkade opcodes.
 *
 * @example
 * ```typescript
 * toASM(['DUP', 'HASH160', 'INSPECTOUTPUTVALUE']) // "OP_DUP OP_HASH160 OP_INSPECTOUTPUTVALUE"
 * toASM(ArkadeScript.decode(bytes))
 * ```
 */
declare function toASM(script: ArkadeScriptType): string;
/**
 * Parse ASM (assembly) format to script operations.
 * Supports both Bitcoin and Arkade opcodes.
 *
 * @example
 * ```typescript
 * fromASM("OP_DUP OP_HASH160 deadbeef OP_ADD64")
 * // => ['DUP', 'HASH160', Uint8Array, 'ADD64']
 * ```
 */
declare function fromASM(asm: string): ArkadeScriptType;
/**
 * Convert ASM string directly to script bytes
 */
declare function asmToBytes(asm: string): Uint8Array;
/**
 * Convert script bytes directly to ASM string
 */
declare function bytesToASM(script: Uint8Array): string;

/**
 * Arkade Script Tweak
 *
 * Computes the tweaked public key for Arkade scripts.
 * The tweak is: tweakedPubKey = P + taggedHash("ArkScriptHash", script) * G
 *
 * This is NOT taproot tweaking — it's a simple EC point addition used by
 * the emulator service to bind a script to a signing key.
 */
/**
 * Compute the tagged hash of an Arkade script.
 * Uses BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || script)
 *
 * @param script - The raw Arkade script bytes
 * @returns 32-byte hash
 */
declare function arkadeScriptHash(script: Uint8Array): Uint8Array;
/**
 * Compute the tagged hash of an Arkade witness.
 * Uses BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || witness)
 *
 * @param witness - The raw Arkade witness bytes
 * @returns 32-byte hash, or 32 zero bytes if witness is empty
 */
declare function arkadeWitnessHash(witness: Uint8Array): Uint8Array;
/**
 * Compute the Arkade script tweaked public key.
 * result = pubKey + taggedHash("ArkScriptHash", script) * G
 *
 * The input pubKey should be a compressed (33-byte) or x-only (32-byte) public key.
 * Returns a 32-byte x-only public key.
 *
 * @param pubKey - The emulator's base public key (32 or 33 bytes)
 * @param script - The raw Arkade script bytes
 * @returns 32-byte x-only tweaked public key
 */
declare function computeArkadeScriptPublicKey(pubKey: Uint8Array, script: Uint8Array): Uint8Array;

/**
 * BigNum — arbitrary-precision sign-magnitude little-endian encoding used by
 * the arkade VM in emulator v0.0.1. Up to 520 bytes (= MaxScriptElementSize).
 *
 * Wire format:
 *   - empty bytes   = 0
 *   - last byte's high bit (0x80) is the sign (set = negative)
 *   - remaining bits are magnitude, little-endian
 *   - minimal: no trailing zero magnitude byte; `[0x80]` (negative zero) is rejected
 *
 * Wraps `@scure/btc-signer`'s `ScriptNum` with a 520-byte cap. Use the
 * standalone API when you need to round-trip values outside of script encoding;
 * inside `ArkadeScript.encode([...])`, plain `bigint` literals work directly.
 */
/** Maximum number of bytes for a BigNum (= MaxScriptElementSize). */
declare const BIGNUM_MAX_BYTES = 520;
/**
 * Encode `value` as a minimal sign-magnitude little-endian byte string.
 * Throws if the encoding would exceed 520 bytes.
 */
declare function encode(value: bigint): Uint8Array;
/**
 * Decode a minimal sign-magnitude little-endian byte string into a bigint.
 * Throws on non-minimal encodings or values longer than 520 bytes.
 */
declare function decode(value: Uint8Array): bigint;
/**
 * Encode `value` to exactly `size` bytes by padding with zero magnitude bytes
 * between the value and the sign bit. Throws if the value doesn't fit.
 *
 * Useful when matching arkade VM outputs that push values as fixed-size byte
 * strings (e.g. some asset opcodes that push 8-byte LE values).
 */
declare function encodeFixed(value: bigint, size: number): Uint8Array;

declare const bignum_BIGNUM_MAX_BYTES: typeof BIGNUM_MAX_BYTES;
declare const bignum_decode: typeof decode;
declare const bignum_encode: typeof encode;
declare const bignum_encodeFixed: typeof encodeFixed;
declare namespace bignum {
  export { bignum_BIGNUM_MAX_BYTES as BIGNUM_MAX_BYTES, bignum_decode as decode, bignum_encode as encode, bignum_encodeFixed as encodeFixed };
}

/**
 * Arkade Script Support
 *
 * This module provides encoding/decoding support for Arkade script opcodes
 * and PSBT fields. It reuses @scure/btc-signer for all Bitcoin standard
 * functionality and only adds Arkade-specific extensions.
 *
 * ## Features
 * - Standard Bitcoin opcodes via @scure/btc-signer (re-exported as OP)
 * - Arkade extension opcodes (0xb3, 0xc4-0xf3)
 * - Script encoding/decoding via ScriptElement arrays
 * - ASM format conversion with Arkade opcode support
 *
 * @module arkade
 */

declare const index_ARKADE_OP: typeof ARKADE_OP;
declare const index_ARKADE_OPCODES: typeof ARKADE_OPCODES;
declare const index_ARKADE_OPCODE_NAMES: typeof ARKADE_OPCODE_NAMES;
declare const index_ARKADE_OPCODE_VALUES: typeof ARKADE_OPCODE_VALUES;
declare const index_ARKADE_OPS: typeof ARKADE_OPS;
type index_ArkadeExtendedCoin = ArkadeExtendedCoin;
type index_ArkadeLeaf = ArkadeLeaf;
declare const index_ArkadeScript: typeof ArkadeScript;
type index_ArkadeScriptOP = ArkadeScriptOP;
type index_ArkadeScriptType = ArkadeScriptType;
type index_ArkadeVtxoInput = ArkadeVtxoInput;
type index_ArkadeVtxoScript = ArkadeVtxoScript;
declare const index_ArkadeVtxoScript: typeof ArkadeVtxoScript;
declare const index_OP: typeof OP;
declare const index_OPCODE_NAMES: typeof OPCODE_NAMES;
declare const index_OPCODE_VALUES: typeof OPCODE_VALUES;
declare const index_Script: typeof Script;
declare const index_ScriptType: typeof ScriptType;
declare const index_arkadeScriptHash: typeof arkadeScriptHash;
declare const index_arkadeWitnessHash: typeof arkadeWitnessHash;
declare const index_asmToBytes: typeof asmToBytes;
declare const index_bytesToASM: typeof bytesToASM;
declare const index_computeArkadeScriptPublicKey: typeof computeArkadeScriptPublicKey;
declare const index_createArkadeBatchHandler: typeof createArkadeBatchHandler;
declare const index_fromASM: typeof fromASM;
declare const index_getOpcodeName: typeof getOpcodeName;
declare const index_getOpcodeValue: typeof getOpcodeValue;
declare const index_toASM: typeof toASM;
declare namespace index {
  export { index_ARKADE_OP as ARKADE_OP, index_ARKADE_OPCODES as ARKADE_OPCODES, index_ARKADE_OPCODE_NAMES as ARKADE_OPCODE_NAMES, index_ARKADE_OPCODE_VALUES as ARKADE_OPCODE_VALUES, index_ARKADE_OPS as ARKADE_OPS, type index_ArkadeExtendedCoin as ArkadeExtendedCoin, type index_ArkadeLeaf as ArkadeLeaf, index_ArkadeScript as ArkadeScript, type index_ArkadeScriptOP as ArkadeScriptOP, type index_ArkadeScriptType as ArkadeScriptType, type index_ArkadeVtxoInput as ArkadeVtxoInput, index_ArkadeVtxoScript as ArkadeVtxoScript, bignum as BigNum, index_OP as OP, index_OPCODE_NAMES as OPCODE_NAMES, index_OPCODE_VALUES as OPCODE_VALUES, index_Script as Script, index_ScriptType as ScriptType, index_arkadeScriptHash as arkadeScriptHash, index_arkadeWitnessHash as arkadeWitnessHash, index_asmToBytes as asmToBytes, index_bytesToASM as bytesToASM, index_computeArkadeScriptPublicKey as computeArkadeScriptPublicKey, index_createArkadeBatchHandler as createArkadeBatchHandler, index_fromASM as fromASM, index_getOpcodeName as getOpcodeName, index_getOpcodeValue as getOpcodeValue, index_toASM as toASM };
}

/**
 * Convert RelativeTimelock to BIP68 sequence number.
 */
declare function timelockToSequence(timelock: RelativeTimelock): number;
/**
 * Convert BIP68 sequence number back to RelativeTimelock.
 */
declare function sequenceToTimelock(sequence: number): RelativeTimelock;

/**
 * Opens an IndexedDB database and increments the reference count.
 * Handles global object detection and callbacks.
 *
 * @param dbName The name of the database to open.
 * @param dbVersion The database version to open.
 * @param initDatabase A function that migrates the database schema, called
 *   on `onupgradeneeded` only. Receives the database, the previous version
 *   (0 for fresh installs), and the upgrade transaction — the transaction is
 *   required for data migrations (cursor/update on existing stores).
 *
 * @returns A promise that resolves to the database instance.
 */
declare function openDatabase(dbName: string, dbVersion: number, initDatabase: (db: IDBDatabase, oldVersion: number, transaction: IDBTransaction | null) => void): Promise<IDBDatabase>;
/**
 * Decrements the reference count and closes the database when no references remain.
 *
 * @param dbName The name of the database to close.
 *
 * @returns True if the database was closed, false otherwise.
 */
declare function closeDatabase(dbName: string): Promise<boolean>;

declare const MESSAGE_BUS_NOT_INITIALIZED = "MessageBus not initialized";
declare class MessageBusNotInitializedError extends Error {
    constructor();
}
declare class ServiceWorkerTimeoutError extends Error {
    constructor(detail: string);
}

declare class ReadonlyAssetManager implements IReadonlyAssetManager {
    readonly indexer: IndexerProvider;
    constructor(indexer: IndexerProvider);
    getAssetDetails(assetId: string): Promise<AssetDetails>;
}
declare class AssetManager extends ReadonlyAssetManager implements IAssetManager {
    readonly wallet: Wallet;
    constructor(wallet: Wallet);
    /**
     * Issue a new asset.
     * @param params - Parameters for asset issuance
     * @param params.amount - Amount of asset units to issue
     * @param params.controlAssetId - Optional control asset ID (for reissuable assets)
     * @param params.metadata - Optional metadata to attach to the asset
     * @returns Promise resolving to the Arkade transaction ID and asset ID
     *
     * @example
     * ```typescript
     * // Issue a simple non-reissuable asset
     * const result = await wallet.assetManager.issue({ amount: 1000 });
     * console.log('Asset ID:', result.assetId);
     *
     * // Issue a reissuable asset with an existing control asset
     * const result = await wallet.assetManager.issue({
     *   amount: 1000,
     *   controlAssetId: 'existingControlAssetId'
     * });
     * console.log('Asset ID:', result.assetId);
     * ```
     */
    issue(params: IssuanceParams): Promise<IssuanceResult>;
    /**
     * Reissue more units of an existing asset.
     * Requires ownership of the control asset.
     *
     * @param params - Parameters for asset reissuance
     * @param params.assetId - The asset ID to reissue (control asset ID is resolved via getAssetDetails)
     * @param params.amount - Amount of additional units to issue
     * @returns Promise resolving to the Arkade transaction ID
     *
     * @example
     * ```typescript
     * const txid = await wallet.assetManager.reissue({
     *   assetId: 'def456...',
     *   amount: 500
     * });
     * ```
     */
    reissue(params: ReissuanceParams): Promise<string>;
    /**
     * Burn assets.
     * @param params - Parameters for burning
     * @param params.assetId - The asset ID to burn
     * @param params.amount - Amount of units to burn
     * @returns Promise resolving to the Arkade transaction ID
     *
     * @example
     * ```typescript
     * const txid = await wallet.assetManager.burn({
     *   assetId: 'abc123...',
     *   amount: 100
     * });
     * ```
     */
    burn(params: BurnParams): Promise<string>;
}

export { ARKADE_MAGIC, type AnchorBumper, ArkError, ArkNote, ArkProvider, type ArkPsbtFieldCoder, ArkPsbtFieldKey, ArkPsbtFieldKeyType, ArkTapscript, ArkTransaction, type ArkTxInput, type ArkadeExtendedCoin, type ArkadeLeaf, type ArkadeVtxoInput, Asset, AssetDetails, AssetManager, BIP322, Batch, BurnParams, CSVMultisigTapscript, ChainTx, Coin, ConditionWitness, type ConnectorTreeNode, Contract, ContractEvent, ContractRepository, ContractRepositoryImpl, ContractWatcherConfig, ContractWithVtxos, CosignerPublicKey, CreateContractParams, DEFAULT_MESSAGE_TIMEOUTS, DelegateInfo, DelegateNotConfiguredError, DelegatorNotConfiguredError, type DescriptorOptions, DescriptorSigningProviderMissingError, DustChangeError, ELECTRUM_TCP_HOST, ELECTRUM_WS_URL, type BlockHeader as ElectrumBlockHeader, ElectrumOnchainProvider, type TransactionHistory as ElectrumTransactionHistory, type Unspent as ElectrumUnspent, type EmulatorEntry, type EmulatorInfo, EmulatorPacket, type EmulatorProvider, EncodedVtxoScript, Estimator, ExplorerTransaction, ExtendedCoin, ExtendedVirtualCoin, Extension, ExtensionNotFoundError, type ExtensionPacket, FeeAmount, FeeInfo, FeeOutput, GetVtxosFilter, HDDescriptorProvider, IAssetManager, IContractManager, IDelegateManager, IReadonlyAssetManager, IReadonlyWallet, IVtxoManager, IWallet, Identity, InMemoryContractRepository, InMemoryWalletRepository, IndexedDBContractRepository, IndexedDBWalletRepository, IndexerProvider, Intent, IntentFeeConfig, IssuanceParams, IssuanceResult, MESSAGE_BUS_NOT_INITIALIZED, MIGRATION_KEY, MessageBus, MessageBusNotInitializedError, type MessageHandler, type MessageTimeouts, type MigrationStatus, MissingSigningDescriptorError, MnemonicIdentity, type MnemonicOptions, Network, NetworkName, type NetworkOptions, OffchainInput, type OffchainTx, OnchainInput, OnchainProvider, OnchainWallet, Outpoint, P2A, type ParsedArkContract, PathSelection, PrevArkTxField, PrevoutTxField, Ramps, ReadonlyAssetManager, ReadonlyDescriptorIdentity, ReadonlyIdentity, ReadonlySingleKey, ReadonlyWallet, ReadonlyWalletError, Recipient, ReissuanceParams, RelativeTimelock, type RequestEnvelope, type ResponseEnvelope, RestEmulatorProvider, SeedIdentity, type SeedIdentityOptions, SendBitcoinParams, ServiceWorkerReadonlyWallet, ServiceWorkerTimeoutError, ServiceWorkerWallet, type ServiceWorkerWalletMode, SettleParams, SettlementConfig, SettlementEvent, SignerSession, SingleKey, Status, StorageConfig, TapLeafScript, TapscriptType, Transaction, TxTree, TxWeightEstimator, UnknownPacket, Unroll, type VSize, VirtualCoin, VtxoScript, VtxoTaprootTree, VtxoTreeExpiry, Wallet, WalletBalance, WalletMessageHandler, WalletNotInitializedError, WalletRepository, WalletRepositoryImpl, WsElectrumChainSource, index as arkade, index$1 as asset, buildForfeitTx, buildOffchainTx, closeDatabase, combineTapscriptSigs, contractFromArkContract, contractFromArkContractWithAddress, createAssetPacket, decodeArkContract, encodeArkContract, getArkPsbtFields, getMigrationStatus, getRandomId, hasBoardingTxExpired, isArkContract, isValidArkAddress, maybeArkError, migrateWalletRepository, openDatabase, requiresMigration, rollbackMigration, selectCoinsWithAsset, sequenceToTimelock, setArkPsbtField, setupServiceWorker, timelockToSequence, validateConnectorsTxGraph, validateVtxoTxGraph, verifyTapscriptSignatures };
