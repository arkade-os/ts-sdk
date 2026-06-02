import { TxOpts, Transaction as Transaction$2 } from '@scure/btc-signer/transaction.js';
import { Bytes } from '@scure/btc-signer/utils.js';
import { PSBTOutput, TransactionInput, TransactionOutput } from '@scure/btc-signer/psbt.js';
import { Transaction as Transaction$1, NETWORK } from '@scure/btc-signer';

/**
 * Transaction is a wrapper around the @scure/btc-signer Transaction class.
 * It adds the Arkade protocol specific options to the transaction.
 */
declare class Transaction extends Transaction$1 {
    static ARK_TX_OPTS: TxOpts;
    constructor(opts?: TxOpts);
    static fromPSBT(psbt_: Bytes, opts?: TxOpts): Transaction;
    static fromRaw(raw: Bytes, opts?: TxOpts): Transaction;
}

/**
 * MuSig2 nonce pair containing public and secret values.
 * Public nonces are two compressed points (33 bytes each).
 * Secret nonces are the corresponding private scalars plus pubkey.
 */
type Nonces = {
    pubNonce: Uint8Array;
    secNonce: Uint8Array;
};

declare class PartialSig {
    s: Uint8Array;
    R: Uint8Array;
    constructor(s: Uint8Array, R: Uint8Array);
    /**
     * Encodes the partial signature into bytes
     * Returns a 32-byte array containing just the s value
     */
    encode(): Uint8Array;
    /**
     * Decodes a partial signature from bytes
     * @param bytes - 32-byte array containing s value
     */
    static decode(bytes: Uint8Array): PartialSig;
}

/**
 * TxTreeNode is a node of the tree.
 * It contains the transaction id, the transaction and the children.
 * any TxTree can be serialized as a list of TxTreeNode.
 */
type TxTreeNode = {
    txid: string;
    tx: string;
    children: Record<number, string>;
};
/**
 * TxTree is a graph of bitcoin transactions.
 * It is used to represent batch tree created during settlement session
 */
declare class TxTree {
    readonly root: Transaction$2;
    readonly children: Map<number, TxTree>;
    constructor(root: Transaction$2, children?: Map<number, TxTree>);
    static create(chunks: TxTreeNode[]): TxTree;
    nbOfNodes(): number;
    validate(): void;
    leaves(): Transaction$2[];
    get txid(): string;
    find(txid: string): TxTree | null;
    update(txid: string, fn: (tx: Transaction$2) => void): void;
    iterator(): Generator<TxTree, void, unknown>;
}

type Musig2PublicNonce = Pick<Nonces, "pubNonce">;
type TreeNonces = Map<string, Musig2PublicNonce>;
type TreePartialSigs = Map<string, PartialSig>;
interface SignerSession {
    getPublicKey(): Promise<Uint8Array>;
    init(tree: TxTree, scriptRoot: Uint8Array, rootInputAmount: bigint): Promise<void>;
    getNonces(): Promise<TreeNonces>;
    aggregatedNonces(txid: string, noncesByPubkey: TreeNonces): Promise<{
        hasAllNonces: boolean;
    }>;
    sign(): Promise<TreePartialSigs>;
}

/** A signing request that pairs a descriptor with a transaction. */
interface DescriptorSigningRequest {
    /** Descriptor identifying which key to sign with */
    descriptor: string;
    /** Transaction to sign */
    tx: Transaction;
    /** Specific input indexes to sign (signs all if omitted) */
    inputIndexes?: number[];
}
/**
 * Provider interface for descriptor-based signing.
 *
 * Implementations include:
 * - {@link StaticDescriptorProvider}: wraps a legacy {@link Identity} with a single key.
 * - {@link HDDescriptorProvider}: rotates through HD-derived descriptors.
 *
 * The provider has no read accessor for "current" — it is a pure descriptor
 * allocator. "What addresses am I currently bound to?" is a question the
 * contract repository answers, not the provider.
 *
 * Providers that want to participate in HD receive rotation can also
 * implement the wallet-side `ReceiveRotatorFactory` interface (see
 * `src/wallet/walletReceiveRotator.ts`). That extension is opt-in — the
 * core `DescriptorProvider` contract intentionally stays free of
 * wallet-specific concerns so HSM-backed and other minimal providers
 * don't have to know about the receive-rotation lifecycle.
 */
interface DescriptorProvider {
    /**
     * Allocate a new signing descriptor. For HD providers each call advances
     * the internal index and returns a fresh descriptor; for single-key
     * providers each call returns the same descriptor.
     */
    getNextSigningDescriptor(): Promise<string>;
    /** Checks if a descriptor belongs to this provider. */
    isOurs(descriptor: string): boolean;
    /** Signs transactions, each with its own descriptor-derived key. */
    signWithDescriptor(requests: DescriptorSigningRequest[]): Promise<Transaction[]>;
    /** Signs a message using the key derived from the descriptor. */
    signMessageWithDescriptor(descriptor: string, message: Uint8Array, type?: "schnorr" | "ecdsa"): Promise<Uint8Array>;
}

interface Identity extends ReadonlyIdentity {
    /** Returns a signer session used for musig2 tree signing flows. */
    signerSession(): SignerSession;
    /** Sign an arbitrary message using the requested signature type. */
    signMessage(message: Uint8Array, signatureType: "schnorr" | "ecdsa"): Promise<Uint8Array>;
    /**
     * Sign the provided transaction inputs.
     *
     * @param tx - Transaction to sign
     * @param inputIndexes - Optional input indexes to sign. When omitted, the implementation should sign every signable input.
     */
    sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;
}
interface ReadonlyIdentity {
    /** Returns the x-only public key used by Taproot scripts. */
    xOnlyPublicKey(): Promise<Uint8Array>;
    /** Returns the compressed public key for this identity. */
    compressedPublicKey(): Promise<Uint8Array>;
}
/** A single PSBT signing request within a batch. */
interface SignRequest {
    tx: Transaction;
    inputIndexes?: number[];
}
/**
 * Identity that supports signing multiple PSBTs in a single wallet interaction.
 * Browser wallet providers that support batch signing (e.g. Xverse, UniSat, OKX)
 * should implement this interface to reduce the number of confirmation popups
 * from N+1 to 1 during Arkade send transactions.
 *
 * Contract:
 * - Implementations MUST return exactly one `Transaction` per request, in the
 *   same order as the input array. The SDK validates this at runtime and will
 *   throw if the lengths do not match.
 * - Implementations MUST preserve any partial signatures already present on the
 *   input PSBTs and only ADD their own — never drop, replace, or normalize away
 *   foreign signatures. The pending-tx recovery path
 *   (`Wallet.finalizePendingTxs`) hands `signMultiple` checkpoint PSBTs that
 *   already carry the server's `tapScriptSig` and relies on that server
 *   signature surviving alongside the freshly added user signature. A provider
 *   that discards the pre-existing server sig produces checkpoints that fail
 *   server-side finalization, stranding the transaction in the pending state.
 */
interface BatchSignableIdentity extends Identity {
    /**
     * Sign multiple transactions in a single wallet interaction.
     *
     * Must preserve pre-existing partial signatures on each input PSBT (see the
     * interface-level contract) and return one signed `Transaction` per request,
     * in request order.
     *
     * @param requests - Transactions and optional input indexes to sign
     * @returns Signed transactions in the same order as the input requests
     */
    signMultiple(requests: SignRequest[]): Promise<Transaction[]>;
}
/** Type guard for identities that support batch signing. */
declare function isBatchSignable(identity: Identity): identity is BatchSignableIdentity;

/**
 * ArkAddress allows creating and decoding bech32m-encoded Arkade addresses.
 *
 * An Arkade address is composed of:
 * - a human readable prefix (hrp)
 * - a version byte (1 byte)
 * - a server public key (32 bytes)
 * - a vtxo taproot public key (32 bytes)
 *
 * @remarks
 * This is an Arkade-specific address format.
 * It is distinct from the Taproot onchain address returned by `VtxoScript.onchainAddress`.
 *
 * @see VtxoScript
 *
 * @example
 * ```typescript
 * const address = new ArkAddress(
 *     new Uint8Array(32), // server public key
 *     new Uint8Array(32), // vtxo taproot public key
 *     "ark"
 * );
 *
 * const encoded = address.encode();
 * console.log("address: ", encoded);
 *
 * const decoded = ArkAddress.decode(encoded);
 * ```
 */
declare class ArkAddress {
    readonly serverPubKey: Bytes;
    readonly vtxoTaprootKey: Bytes;
    readonly hrp: string;
    readonly version: number;
    /**
     * Create an Arkade address from its server public key, Taproot output key, and prefix.
     *
     * @param serverPubKey - 32-byte Arkade server public key
     * @param vtxoTaprootKey - 32-byte Taproot output key (a.k.a. tweaked public key)
     * @param hrp - Bech32 human-readable prefix
     * @param version - Address version byte
     * @defaultValue `version = 0`
     * @throws Error if either public key is not 32 bytes long
     */
    constructor(serverPubKey: Bytes, vtxoTaprootKey: Bytes, hrp?: string, version?: number);
    /**
     * Decode an Arkade address from its bech32m string form.
     *
     * @param address - Bech32m-encoded Arkade address
     * @returns Decoded Arkade address
     * @throws Error if the address is malformed or has an invalid payload length
     * @see encode
     */
    static decode(address: string): ArkAddress;
    /**
     * Encode the address to its bech32m string form.
     *
     * @returns Bech32m-encoded Arkade address
     * @see decode
     */
    encode(): string;
    /** ScriptPubKey used to send non-dust funds to the address. */
    get pkScript(): Bytes;
    /** ScriptPubKey used to send sub-dust funds to the address. */
    get subdustPkScript(): Bytes;
}

/**
 * RelativeTimelock lets to create timelocked with CHECKSEQUENCEVERIFY script.
 *
 * @example
 * ```typescript
 * const timelock = { value: 144n, type: "blocks" }; // 1 day in blocks
 * const timelock = { value: 512n, type: "seconds" }; // 8 minutes in seconds
 * ```
 */
type RelativeTimelock = {
    value: bigint;
    type: "seconds" | "blocks";
};
declare enum TapscriptType {
    Multisig = "multisig",
    CSVMultisig = "csv-multisig",
    ConditionCSVMultisig = "condition-csv-multisig",
    ConditionMultisig = "condition-multisig",
    CLTVMultisig = "cltv-multisig"
}
/**
 * ArkTapscript is the base element of vtxo scripts.
 * It is used to encode and decode the different types of vtxo scripts.
 */
interface ArkTapscript<T extends TapscriptType, Params> {
    type: T;
    params: Params;
    script: Uint8Array;
}
/**
 * decodeTapscript is a function that decodes an Arkade tapscript from a raw script.
 *
 * @throws {Error} if the script is not a valid Arkade tapscript
 * @example
 * ```typescript
 * const arkTapscript = decodeTapscript(new Uint8Array(32));
 * console.log("type:", arkTapscript.type);
 * ```
 */
declare function decodeTapscript(script: Uint8Array): ArkTapscript<TapscriptType, any>;
/**
 * Implements a multi-signature tapscript.
 *
 * <pubkey> CHECKSIGVERIFY <pubkey> CHECKSIG
 *
 * @example
 * ```typescript
 * const multisigTapscript = MultisigTapscript.encode({ pubkeys: [new Uint8Array(32), new Uint8Array(32)] });
 * ```
 */
declare namespace MultisigTapscript {
    type Type = ArkTapscript<TapscriptType.Multisig, Params>;
    enum MultisigType {
        CHECKSIG = 0,
        CHECKSIGADD = 1
    }
    type Params = {
        pubkeys: Bytes[];
        type?: MultisigType;
    };
    /** Encode a plain multisig tapscript. */
    function encode(params: Params): Type;
    /** Decode a plain multisig tapscript from raw script bytes. */
    function decode(script: Uint8Array): Type;
    /** Return true when the tapscript is a plain multisig tapscript. */
    function is(tapscript: ArkTapscript<any, any>): tapscript is Type;
}
/**
 * Implements a relative timelock script that requires all specified pubkeys to sign
 * after the relative timelock has expired. The timelock can be specified in blocks or seconds.
 *
 * This is the standard exit closure and it is also used for the sweep closure in vtxo trees.
 *
 * <sequence> CHECKSEQUENCEVERIFY DROP <pubkey> CHECKSIG
 *
 * @example
 * ```typescript
 * const csvMultisigTapscript = CSVMultisigTapscript.encode({ timelock: { type: "blocks", value: 144 }, pubkeys: [new Uint8Array(32), new Uint8Array(32)] });
 * ```
 */
declare namespace CSVMultisigTapscript {
    type Type = ArkTapscript<TapscriptType.CSVMultisig, Params>;
    type Params = {
        timelock: RelativeTimelock;
    } & MultisigTapscript.Params;
    /** Encode a CSV multisig tapscript. */
    function encode(params: Params): Type;
    /** Decode a CSV multisig tapscript from raw script bytes. */
    function decode(script: Uint8Array): Type;
    /** Return true when the tapscript is a CSV multisig tapscript. */
    function is(tapscript: ArkTapscript<any, any>): tapscript is Type;
    function isScriptValid(script: Uint8Array): true | Error;
}
/**
 * Combines a condition script with an exit closure. The resulting script requires
 * the condition to be met, followed by the standard exit closure requirements
 * (timelock and signatures).
 *
 * <conditionScript> VERIFY <sequence> CHECKSEQUENCEVERIFY DROP <pubkey> CHECKSIGVERIFY <pubkey> CHECKSIG
 *
 * @example
 * ```typescript
 * const conditionCSVMultisigTapscript = ConditionCSVMultisigTapscript.encode({ conditionScript: new Uint8Array(32), pubkeys: [new Uint8Array(32), new Uint8Array(32)] });
 * ```
 */
declare namespace ConditionCSVMultisigTapscript {
    type Type = ArkTapscript<TapscriptType.ConditionCSVMultisig, Params>;
    type Params = {
        conditionScript: Bytes;
    } & CSVMultisigTapscript.Params;
    /** Encode a condition + CSV multisig tapscript. */
    function encode(params: Params): Type;
    /** Decode a condition + CSV multisig tapscript from raw script bytes. */
    function decode(script: Uint8Array): Type;
    /** Return true when the tapscript is a condition + CSV multisig tapscript. */
    function is(tapscript: ArkTapscript<any, any>): tapscript is Type;
    function isScriptValid(script: Uint8Array): true | Error;
}
/**
 * Combines a condition script with a forfeit closure. The resulting script requires
 * the condition to be met, followed by the standard forfeit closure requirements
 * (multi-signature).
 *
 * <conditionScript> VERIFY <pubkey> CHECKSIGVERIFY <pubkey> CHECKSIG
 *
 * @example
 * ```typescript
 * const conditionMultisigTapscript = ConditionMultisigTapscript.encode({ conditionScript: new Uint8Array(32), pubkeys: [new Uint8Array(32), new Uint8Array(32)] });
 * ```
 */
declare namespace ConditionMultisigTapscript {
    type Type = ArkTapscript<TapscriptType.ConditionMultisig, Params>;
    type Params = {
        conditionScript: Bytes;
    } & MultisigTapscript.Params;
    /** Encode a condition + multisig tapscript. */
    function encode(params: Params): Type;
    /** Decode a condition + multisig tapscript from raw script bytes. */
    function decode(script: Uint8Array): Type;
    /** Return true when the tapscript is a condition + multisig tapscript. */
    function is(tapscript: ArkTapscript<any, any>): tapscript is Type;
    function isScriptValid(script: Uint8Array): true | Error;
}
/**
 * Implements an absolute timelock (CLTV) script combined with a forfeit closure.
 * The script requires waiting until a specific block height/timestamp before the
 * forfeit closure conditions can be met.
 *
 * <locktime> CHECKLOCKTIMEVERIFY DROP <pubkey> CHECKSIGVERIFY <pubkey> CHECKSIG
 *
 * @example
 * ```typescript
 * const cltvMultisigTapscript = CLTVMultisigTapscript.encode({ absoluteTimelock: 144, pubkeys: [new Uint8Array(32), new Uint8Array(32)] });
 * ```
 */
declare namespace CLTVMultisigTapscript {
    type Type = ArkTapscript<TapscriptType.CLTVMultisig, Params>;
    type Params = {
        absoluteTimelock: bigint;
    } & MultisigTapscript.Params;
    /** Encode a CLTV multisig tapscript. */
    function encode(params: Params): Type;
    /** Decode a CLTV multisig tapscript from raw script bytes. */
    function decode(script: Uint8Array): Type;
    /** Return true when the tapscript is a CLTV multisig tapscript. */
    function is(tapscript: ArkTapscript<any, any>): tapscript is Type;
    function isScriptValid(script: Uint8Array): true | Error;
}

type TapLeafScript = [
    {
        version: number;
        internalKey: Bytes;
        merklePath: Bytes[];
    },
    Bytes
];
declare const TapTreeCoder: (typeof PSBTOutput.tapTree)[2];
/**
 * VtxoScript is a script that contains a list of tapleaf scripts.
 * It is used to create virtual output scripts.
 *
 * @see ArkAddress
 *
 * @example
 * ```typescript
 * const vtxoScript = new VtxoScript([new Uint8Array(32), new Uint8Array(32)]);
 * ```
 */
declare class VtxoScript {
    readonly scripts: Bytes[];
    readonly leaves: TapLeafScript[];
    readonly tweakedPublicKey: Bytes;
    readonly pkScript: Bytes;
    /**
     * Decode a virtual output script from an encoded TapTree.
     *
     * @param tapTree - Encoded TapTree bytes
     * @returns Decoded virtual output script
     * @throws Error if the TapTree cannot be decoded into a valid script set
     * @see encode
     */
    static decode(tapTree: Bytes): VtxoScript;
    /**
     * Create a virtual output script from its tapleaf scripts.
     *
     * @param scripts - Raw tapscript bytes for each leaf
     * @throws Error if the provided leaves cannot produce a valid Taproot tree
     */
    constructor(scripts: Bytes[]);
    /**
     * Encode the virtual output script to a TapTree byte representation.
     *
     * @returns Encoded TapTree bytes
     * @see decode
     */
    encode(): Bytes;
    /**
     * Build the Arkade address corresponding to this virtual output script.
     *
     * @param prefix - Bech32 human-readable prefix
     * @param serverPubKey - 32-byte Arkade server public key
     * @returns Arkade address for this script
     * @see ArkAddress
     */
    address(prefix: string | undefined, serverPubKey: Bytes): ArkAddress;
    /**
     * Build the Taproot onchain address corresponding to this virtual output script.
     *
     * @param network - Bitcoin network descriptor
     * @returns Taproot onchain address
     * @see address
     */
    onchainAddress(network?: typeof NETWORK): string;
    /**
     * Look up a tapleaf script by its hex-encoded tapscript body.
     *
     * @param scriptHex - Hex-encoded tapscript body without the leaf version byte
     * @returns Matching tapleaf script
     * @throws Error if no matching leaf exists
     */
    findLeaf(scriptHex: string): TapLeafScript;
    /**
     * Return all unilateral exit paths embedded in the virtual output script.
     *
     * @returns CSV-based exit paths found in the leaves
     * @see getSequence
     */
    exitPaths(): Array<CSVMultisigTapscript.Type | ConditionCSVMultisigTapscript.Type>;
}
type EncodedVtxoScript = {
    tapTree: Bytes;
};
/**
 * Extract the timelock value encoded in a timelocked tapleaf, if any.
 *
 * The return value is unit-ambiguous: for a CSV leaf it is a BIP-68
 * nSequence (relative timelock); for a CLTV leaf it is an absolute
 * nLockTime. Callers must know which leaf shape they are inspecting to
 * interpret the number correctly, and must not copy a CSV result into
 * `Transaction.lockTime` (or vice versa).
 *
 * @param tapLeafScript - Tapleaf script to inspect
 * @returns The encoded timelock value, or `undefined` when neither a CSV
 *          nor CLTV path is present
 * @see VtxoScript.exitPaths
 */
declare function getSequence(tapLeafScript: TapLeafScript): number | undefined;

/**
 * Configuration options for automatic virtual output renewal
 *
 * @see DEFAULT_RENEWAL_CONFIG
 * @deprecated Leave `renewalConfig` undefined and use `settlementConfig` instead.
 * @see SettlementConfig
 */
interface RenewalConfig {
    /**
     * Enable automatic renewal monitoring
     *
     * @defaultValue `false`
     * @deprecated Explicitly set `settlementConfig` to `false` to disable VTXO renewal.
     */
    enabled?: boolean;
    /**
     * Threshold in milliseconds to use as threshold for renewal
     * E.g., 86_400_000 means renew when 24 hours until expiry remains
     *
     * @defaultValue `259_200_000` (3 days).
     * @deprecated Use `SettlementConfig.vtxoThreshold` (in seconds) instead.
     */
    thresholdMs?: number;
}
/**
 * Configuration for automatic settlement and renewal.
 *
 * Controls two behaviors:
 * 1. **VTXO renewal**: Automatically renew virtual outputs that are close to expiry
 * 2. **Boarding UTXO sweep**: Sweep expired boarding inputs back to a fresh boarding address
 *    via the unilateral exit path (onchain self-spend to restart the timelock)
 *
 * Enabled by default when no config is provided.
 * Pass `false` to explicitly disable all settlement behavior.
 *
 * @remarks
 * VTXO renewal and boarding UTXO sweep are both coordinated by `VtxoManager`, which periodically
 * inspects wallet virtual outputs and boarding inputs and decides whether action is needed.
 *
 * @see DEFAULT_SETTLEMENT_CONFIG
 *
 * @example
 * ```typescript
 * // Default behavior: virtual output renewal at 3 days, boarding sweep enabled, polling every minute
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkProvider: new RestArkProvider(),
 * });
 *
 * // Custom expiry threshold of 24 hours
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkProvider: new RestArkProvider(),
 *   settlementConfig: {
 *     vtxoThreshold: 60 * 60 * 24, // 24 hours in seconds
 *   },
 * });
 *
 * // Explicitly disable
 * const wallet = await Wallet.create({
 *   identity: MnemonicIdentity.fromMnemonic('abandon abandon...'),
 *   arkProvider: new RestArkProvider(),
 *   settlementConfig: false,
 * });
 * ```
 */
interface SettlementConfig {
    /**
     * Seconds before virtual output expiry to trigger renewal.
     *
     * @defaultValue `259_200` (3 days)
     */
    vtxoThreshold?: number;
    /**
     * Sweep expired boarding inputs back to a fresh boarding address
     * via the unilateral exit path (onchain self-spend to restart the timelock).
     *
     * When enabled, expired boarding inputs are batched into a single onchain
     * transaction with multiple inputs and one output.
     *
     * A dust check ensures the sweep is only performed when the output
     * after fees is above dust.
     *
     * @defaultValue `true`
     */
    boardingUtxoSweep?: boolean;
    /**
     * Polling interval in milliseconds for checking boarding inputs.
     * The poll loop auto-settles new boarding inputs into Arkade and
     * sweeps expired ones (when boardingUtxoSweep is enabled).
     *
     * @defaultValue `60_000` (1 minute)
     */
    pollIntervalMs?: number;
}
/**
 * Check if a virtual output is expiring soon based on threshold
 *
 * @param vtxo - The virtual output to check
 * @param thresholdMs - Threshold in milliseconds from now
 * @returns true if virtual output expires within threshold, false otherwise
 */
declare function isVtxoExpiringSoon(vtxo: ExtendedVirtualCoin, thresholdMs: number): boolean;
/**
 * Optional arguments for {@link IVtxoManager.renewVtxos}.
 */
interface RenewVtxosOptions {
    /**
     * Override the renewal threshold for this call only, in seconds.
     *
     * When provided, takes precedence over `SettlementConfig.vtxoThreshold`
     * and the default (3 days). Useful for renewing only VTXOs that are
     * more urgently expiring than the globally configured threshold.
     */
    thresholdSeconds?: number;
}
/**
 * VtxoManager is a unified class for managing virtual output lifecycle operations including
 * recovery of swept/expired virtual outputs and renewal to prevent expiration.
 *
 * Key Features:
 * - **Recovery**: Reclaim swept or expired virtual outputs back to the wallet
 * - **Renewal**: Refresh virtual output expiration time before they expire
 * - **Smart subdust handling**: Automatically includes subdust virtual outputs when economically viable
 * - **Expiry monitoring**: Check for virtual outputs that are expiring soon
 *
 * Virtual outputs become recoverable when:
 * - The Arkade server sweeps them (virtualStatus.state === "swept") and they remain spendable
 * - They are preconfirmed subdust (to consolidate small amounts without locking liquidity on settled virtual outputs)
 *
 * @example
 * ```typescript
 * const wallet = await Wallet.create({
 *   identity,
 *   arkProvider: new RestArkProvider(),
 *   settlementConfig: {
 *      // Seconds before virtual output expiry to trigger renewal
 *      vtxoThreshold: 259_200, // 3 days
 *      // Whether to sweep expired boarding inputs back to a fresh boarding address
 *      boardingUtxoSweep: true,
 *      // Polling interval in milliseconds for checking boarding inputs
 *      pollIntervalMs: 60_000 // 1 minute
 *  },
 * });
 * const manager = await wallet.getVtxoManager();
 *
 * // Check recoverable balance
 * const balance = await manager.getRecoverableBalance();
 * if (balance.recoverable > 0n) {
 *   console.log(`Can recover ${balance.recoverable} sats`);
 *   const txid = await manager.recoverVtxos();
 * }
 *
 * // Check for expiring virtual outputs
 * const expiring = await manager.getExpiringVtxos();
 * if (expiring.length > 0) {
 *   console.log(`${expiring.length} virtual outputs expiring soon`);
 *   const txid = await manager.renewVtxos();
 * }
 * ```
 */
interface IVtxoManager {
    recoverVtxos(eventCallback?: (event: SettlementEvent) => void): Promise<string>;
    getRecoverableBalance(): Promise<{
        recoverable: bigint;
        subdust: bigint;
        includesSubdust: boolean;
        vtxoCount: number;
    }>;
    getExpiringVtxos(thresholdMs?: number): Promise<ExtendedVirtualCoin[]>;
    renewVtxos(eventCallback?: (event: SettlementEvent) => void, options?: RenewVtxosOptions): Promise<string>;
    getExpiredBoardingUtxos(): Promise<ExtendedCoin[]>;
    sweepExpiredBoardingUtxos(): Promise<string>;
    dispose(): Promise<void>;
}
declare class VtxoManager implements AsyncDisposable, IVtxoManager {
    readonly wallet: IWallet;
    /** @deprecated Use settlementConfig instead */
    readonly renewalConfig?: RenewalConfig | undefined;
    readonly settlementConfig: SettlementConfig | false;
    private contractEventsSubscription?;
    private readonly contractEventsSubscriptionReady;
    private disposePromise?;
    private pollTimeoutId?;
    private knownBoardingUtxos;
    private sweptBoardingUtxos;
    private pollInProgress;
    private pollDone?;
    private disposed;
    private consecutivePollFailures;
    private startupPollTimeoutId?;
    private static readonly MAX_BACKOFF_MS;
    private renewalInProgress;
    private lastRenewalTimestamp;
    private static readonly RENEWAL_COOLDOWN_MS;
    private lastPeriodicSettleTimestamp;
    private consecutivePeriodicSettleFailures;
    private static readonly PERIODIC_SETTLE_COOLDOWN_MS;
    private static readonly PERIODIC_SETTLE_MAX_BACKOFF_MS;
    private lastVtxoSpentRefreshTimestamp;
    private vtxoSpentRefreshPromise?;
    private static readonly VTXO_SPENT_REFRESH_COOLDOWN_MS;
    constructor(wallet: IWallet, 
    /** @deprecated Use settlementConfig instead */
    renewalConfig?: RenewalConfig | undefined, settlementConfig?: SettlementConfig | false);
    /**
     * Recover swept/expired virtual outputs by settling them back to the wallet's Arkade address.
     *
     * This method:
     * 1. Fetches all virtual outputs (including recoverable ones)
     * 2. Filters for swept but still spendable virtual outputs and preconfirmed subdust
     * 3. Includes subdust virtual outputs if the total value >= dust threshold
     * 4. Settles everything back to the wallet's Arkade address
     *
     * Note: Settled virtual outputs with long expiry are NOT recovered to avoid locking liquidity unnecessarily.
     * Only preconfirmed subdust is recovered to consolidate small amounts.
     *
     * @param eventCallback - Optional callback to receive settlement events
     * @returns Settlement transaction ID
     * @throws Error if no recoverable virtual outputs found
     *
     * @example
     * ```typescript
     * const manager = await wallet.getVtxoManager();
     *
     * // Simple recovery
     * const txid = await manager.recoverVtxos();
     *
     * // With event callback
     * const txid = await manager.recoverVtxos((event) => {
     *   console.log('Settlement event:', event.type);
     * });
     * ```
     */
    recoverVtxos(eventCallback?: (event: SettlementEvent) => void): Promise<string>;
    /**
     * Get information about recoverable balance without executing recovery.
     *
     * Useful for displaying to users before they decide to recover funds.
     *
     * @returns Object containing recoverable amounts and subdust information
     *
     * @example
     * ```typescript
     * const manager = await wallet.getVtxoManager();
     * const balance = await manager.getRecoverableBalance();
     *
     * if (balance.recoverable > 0n) {
     *   console.log(`You can recover ${balance.recoverable} sats`);
     *   if (balance.includesSubdust) {
     *     console.log(`This includes ${balance.subdust} sats from subdust virtual outputs`);
     *   }
     * }
     * ```
     */
    getRecoverableBalance(): Promise<{
        recoverable: bigint;
        subdust: bigint;
        includesSubdust: boolean;
        vtxoCount: number;
    }>;
    /**
     * Get virtual outputs that are expiring soon based on renewal configuration
     *
     * @param thresholdMs - Optional override for threshold in milliseconds
     * @returns Array of expiring virtual outputs, empty array if renewal is disabled or no virtual outputs expiring
     *
     * @example
     * ```typescript
     * const wallet = await Wallet.create({
     *  identity,
     *  arkProvider: new RestArkProvider(),
     *  settlementConfig: {
     *      vtxoThreshold: 86_400 // 24 hours
     *  },
     * });
     * const manager = await wallet.getVtxoManager();
     * const expiringVtxos = await manager.getExpiringVtxos();
     * if (expiringVtxos.length > 0) {
     *   console.log(`${expiringVtxos.length} virtual outputs expiring soon`);
     * }
     * ```
     */
    getExpiringVtxos(thresholdMs?: number): Promise<ExtendedVirtualCoin[]>;
    /**
     * Renew expiring virtual outputs by settling them back to the wallet's address
     *
     * This method collects all expiring spendable virtual outputs (including recoverable ones) and settles
     * them back to the wallet, effectively refreshing their expiration time. This is the
     * primary way to prevent virtual outputs from expiring.
     *
     * @param eventCallback - Optional callback for settlement events
     * @param options - Optional per-call overrides; see {@link RenewVtxosOptions}
     * @returns Settlement transaction ID
     * @throws Error if no virtual outputs available to renew
     * @throws Error if total amount is below dust threshold
     *
     * @example
     * ```typescript
     * const manager = await wallet.getVtxoManager();
     *
     * // Simple renewal
     * const txid = await manager.renewVtxos();
     *
     * // With event callback
     * const txid = await manager.renewVtxos((event) => {
     *   console.log('Settlement event:', event.type);
     * });
     *
     * // Renew only VTXOs that expire within 6 hours
     * const txid = await manager.renewVtxos(undefined, { thresholdSeconds: 6 * 60 * 60 });
     * ```
     */
    renewVtxos(eventCallback?: (event: SettlementEvent) => void, options?: RenewVtxosOptions): Promise<string>;
    /**
     * Get boarding inputs whose timelock has expired.
     *
     * These inputs can no longer be onboarded cooperatively via `settle()` and
     * must be swept back to a fresh boarding address using the unilateral exit path.
     *
     * @returns Array of expired boarding inputs
     *
     * @example
     * ```typescript
     * const manager = await wallet.getVtxoManager();
     * const expired = await manager.getExpiredBoardingUtxos();
     * if (expired.length > 0) {
     *   console.log(`${expired.length} expired boarding inputs to sweep`);
     * }
     * ```
     */
    getExpiredBoardingUtxos(prefetchedUtxos?: ExtendedCoin[]): Promise<ExtendedCoin[]>;
    /**
     * Sweep expired boarding inputs back to a fresh boarding address via
     * the unilateral exit path (onchain self-spend).
     *
     * This builds a raw onchain transaction that:
     * - Uses all expired boarding inputs as inputs (spent via the CSV exit script path)
     * - Has a single output to the wallet's boarding address (restarts the timelock)
     * - Batches multiple expired boarding inputs into one transaction
     * - Skips the sweep if the output after fees would be below dust
     *
     * No Arkade server involvement is needed — this is a pure onchain transaction.
     *
     * @returns The broadcast transaction ID
     * @throws Error if no expired boarding inputs are found
     * @throws Error if output after fees is below dust (not economical to sweep)
     * @throws Error if boarding input sweep is not enabled in settlementConfig
     *
     * @example
     * ```typescript
     * const wallet = await Wallet.create({
     *   identity,
     *   arkProvider: new RestArkProvider(),
     *   settlementConfig: {
     *     boardingUtxoSweep: true,
     *   },
     * });
     * const manager = await wallet.getVtxoManager();
     *
     * try {
     *   const txid = await manager.sweepExpiredBoardingUtxos();
     *   console.log('Swept expired boarding inputs:', txid);
     * } catch (e) {
     *   console.log('No sweep needed or not economical');
     * }
     * ```
     */
    sweepExpiredBoardingUtxos(prefetchedUtxos?: ExtendedCoin[]): Promise<string>;
    /** Asserts sweep capability and returns the typed wallet. */
    private getSweepWallet;
    /** Decodes the boarding tapscript exit path to extract the CSV timelock. */
    private getBoardingTimelock;
    /** Returns the TapLeafScript for the boarding tapscript's exit (CSV) path. */
    private getBoardingExitLeaf;
    /** Returns the pkScript (output script) of the boarding tapscript. */
    private getBoardingOutputScript;
    /** Returns the onchain provider for fee estimation and broadcasting. */
    private getOnchainProvider;
    /** Returns the Ark provider for intent fee and server info lookups. */
    private getArkProvider;
    /** Returns the Bitcoin network configuration from the wallet. */
    private getNetwork;
    /** Returns the wallet's identity for transaction signing. */
    private getIdentity;
    private initializeSubscription;
    /**
     * VTXO_ALREADY_SPENT means the server's authoritative view of VTXO state
     * is ahead of ours — cross-instance race, pre-lock snapshot drift, or an
     * SSE gap left stale data in the local cache. Silent-swallowing
     * guarantees the same error on the next cycle because nothing
     * reconciles the cache.
     *
     * The cursor-derived delta sync filters by `created_at`, so a VTXO that
     * was created before the cursor but spent recently can never be
     * reconciled by `refreshVtxos()`. Use `refreshOutpoints` for surgical
     * recovery: query the indexer for the specific stale outpoint and
     * upsert its authoritative state into the wallet repository.
     *
     * Throttled because the same VTXO can fire repeatedly before the
     * upsert observably propagates through the renewal selector.
     */
    private maybeRefreshAfterVtxoSpent;
    /**
     * Extract the offending VTXO outpoint from a `VTXO_ALREADY_SPENT` error,
     * if the server attached one in `metadata.vtxo_outpoint`. Returns
     * `undefined` when the error isn't a parsed ArkError, isn't this code,
     * or doesn't carry the metadata.
     */
    private extractSpentOutpoint;
    /**
     * Reconcile the chosen VTXOs with the indexer's authoritative state
     * before submitting a settle intent. Pulls the canonical record for
     * each candidate outpoint via {@link IContractManager.refreshOutpoints}
     * (which upserts the result into the wallet repository), then
     * re-selects through the standard expiring-vtxo filter so anything
     * the refresh flagged as spent is dropped.
     *
     * Best-effort: a failed refresh just falls back to the original
     * candidates and lets the post-submit `VTXO_ALREADY_SPENT` recovery
     * handle whatever slipped through.
     */
    private revalidateBeforeSettle;
    /** Computes the next poll delay, applying exponential backoff on failures. */
    private getNextPollDelay;
    /**
     * Starts a polling loop that:
     * 1. Auto-settles new boarding inputs into Arkade
     * 2. Sweeps expired boarding inputs (when boardingUtxoSweep is enabled)
     *
     * Uses setTimeout chaining (not setInterval) so a slow/blocked poll
     * cannot stack up and the next delay can incorporate backoff.
     */
    private startBoardingUtxoPoll;
    private schedulePoll;
    private pollBoardingUtxos;
    /**
     * Auto-settle new (unexpired) boarding inputs AND near-expiry VTXOs into
     * Arkade in a single intent. Skips boarding UTXOs that are already expired
     * (those are handled by sweep) and those already in-flight (tracked in
     * knownBoardingUtxos). If the event-driven renewal path is currently
     * running, VTXOs are omitted from this cycle to avoid double-spending.
     *
     * Failure bookkeeping: after every settle *attempt*, lastPeriodicSettleTimestamp
     * is armed and consecutive failures are counted so the next attempt is
     * blocked by an exponentially growing cooldown (capped). This stops a
     * persistently failing input from producing identical RegisterIntent +
     * DeleteIntent retries on every 60s poll.
     */
    private runPeriodicSettle;
    dispose(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}

type NetworkName = "bitcoin" | "testnet" | "signet" | "mutinynet" | "regtest";
interface Network {
    hrp: string;
    bech32: string;
    pubKeyHash: number;
    scriptHash: number;
    wif: number;
}
declare const networks: {
    bitcoin: Network;
    testnet: Network;
    signet: Network;
    mutinynet: Network;
    regtest: Network;
};

/**
 * The default base URLs for esplora API providers.
 *
 * Mainnet, mutinynet, and signet point at Ark Labs–operated
 * mempool deployments (mempool.space-compatible esplora API).
 * Testnet falls back to the public mempool.space deployment
 * because Ark doesn't host it. Regtest assumes a local nigiri
 * stack on the standard port.
 */
declare const ESPLORA_URL: Record<NetworkName, string>;
type ExplorerTransaction = {
    txid: string;
    vout: {
        scriptpubkey_address: string;
        value: string;
    }[];
    status: {
        confirmed: boolean;
        block_time: number;
    };
};
interface OnchainProvider {
    /**
     * Fetch spendable onchain outputs for an address.
     *
     * @param address - Bitcoin address to query
     * @returns Spendable onchain outputs for the address
     * @see Coin
     */
    getCoins(address: string): Promise<Coin[]>;
    /**
     * Fetch the current fastest fee rate estimate.
     *
     * @returns Fee rate in sats/vB, if available
     * @remarks
     * Implementations may return `undefined` when the backing service does not expose
     * a usable fee estimate.
     */
    getFeeRate(): Promise<number | undefined>;
    /**
     * Broadcast a single transaction or a 1P1C package.
     *
     * @param txs - One or more raw transaction hex strings
     * @returns Broadcast transaction id
     * @throws Error if the broadcast request fails or the package shape is invalid
     */
    broadcastTransaction(...txs: string[]): Promise<string>;
    /**
     * Fetch outspend information for every output in a transaction.
     *
     * @param txid - Transaction id to inspect
     * @returns Per-output spend status information
     * @see getTxStatus
     */
    getTxOutspends(txid: string): Promise<{
        spent: boolean;
        txid: string;
    }[]>;
    /**
     * Fetch transactions associated with an address.
     *
     * @param address - Bitcoin address to query
     * @returns Transactions involving the address
     * @see ExplorerTransaction
     */
    getTransactions(address: string): Promise<ExplorerTransaction[]>;
    /**
     * Fetch confirmation status for a transaction.
     *
     * @param txid - Transaction id to inspect
     * @returns Confirmation status and block metadata when confirmed
     * @see getTxOutspends
     */
    getTxStatus(txid: string): Promise<{
        confirmed: false;
    } | {
        confirmed: true;
        blockTime: number;
        blockHeight: number;
    }>;
    /**
     * Fetch the current chain tip.
     *
     * @returns Current chain height, block time, and block hash
     */
    getChainTip(): Promise<{
        height: number;
        time: number;
        hash: string;
    }>;
    /**
     * Watch a set of addresses and invoke the callback when transactions are observed.
     *
     * @param addresses - Addresses to monitor
     * @param eventCallback - Callback invoked when matching transactions are seen
     * @returns Stop function that cancels the watch
     * @remarks
     * Implementations may use websockets, server-sent events, polling, or a hybrid strategy.
     * @see getTransactions
     */
    watchAddresses(addresses: string[], eventCallback: (txs: ExplorerTransaction[]) => void): Promise<() => void>;
}
/**
 * Implementation of the onchain provider interface for esplora REST API.
 *
 * @see https://mempool.space/docs/api/rest
 * @example
 * ```typescript
 * const provider = new EsploraProvider("https://mempool.space/api");
 * const outputs = await provider.getCoins("bcrt1q679zsd45msawvr7782r0twvmukns3drlstjt77");
 * ```
 */
declare class EsploraProvider implements OnchainProvider {
    private baseUrl;
    readonly pollingInterval: number;
    readonly forcePolling: boolean;
    constructor(baseUrl?: string, opts?: {
        /** Polling interval in milliseconds. */
        pollingInterval?: number;
        /** Force polling even when websocket transport is available. */
        forcePolling?: boolean;
    });
    getCoins(address: string): Promise<Coin[]>;
    getFeeRate(): Promise<number | undefined>;
    broadcastTransaction(...txs: string[]): Promise<string>;
    getTxOutspends(txid: string): Promise<{
        spent: boolean;
        txid: string;
    }[]>;
    getTransactions(address: string): Promise<ExplorerTransaction[]>;
    getTxStatus(txid: string): Promise<{
        confirmed: false;
    } | {
        confirmed: true;
        blockTime: number;
        blockHeight: number;
    }>;
    watchAddresses(addresses: string[], callback: (txs: ExplorerTransaction[]) => void): Promise<() => void>;
    getChainTip(): Promise<{
        height: number;
        time: number;
        hash: string;
    }>;
    private broadcastPackage;
    private broadcastTx;
}

interface WalletState {
    /** Arbitrary stored wallet settings. */
    settings?: Record<string, any>;
    /**
     * High-water mark for VTXO indexer syncs, in milliseconds.
     *
     * Reused the legacy `lastSyncTime` column name to avoid an
     * `ALTER TABLE` migration; the value is interpreted as the new
     * "max indexer `updatedAt`" cursor only after `settings.vtxoCursorMigrated`
     * is set, so pre-existing values written by the buggy pre-PR sync
     * are ignored and force a one-shot re-bootstrap on upgrade.
     */
    lastSyncTime?: number;
}
interface VtxoRepositoryKey {
    /** Authoritative ownership key. */
    script: string;
    /** Legacy storage bucket. Required by all current backends; throw if absent. */
    address?: string;
}
interface WalletRepository extends AsyncDisposable {
    readonly version: 1;
    /**
     * Clear all data from storage.
     */
    clear(): Promise<void>;
    /** Fetch stored virtual outputs for an address. */
    getVtxos(address: string): Promise<ExtendedVirtualCoin[]>;
    /** Save virtual outputs for an address. */
    saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    /** Delete stored virtual outputs for an address. */
    deleteVtxos(address: string): Promise<void>;
    /**
     * Fetch stored virtual outputs for a script.
     * @optional SDK backends implement this; custom backends fall back to Tier 1.
     */
    getVtxosForScript?(script: string): Promise<ExtendedVirtualCoin[]>;
    /**
     * Save virtual outputs for a script.
     * @optional SDK backends implement this; custom backends fall back to Tier 1.
     */
    saveVtxosForScript?(key: VtxoRepositoryKey, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    /**
     * Delete stored virtual outputs for a script.
     * @optional SDK backends implement this; custom backends fall back to Tier 1.
     */
    deleteVtxosForScript?(script: string): Promise<void>;
    /** Fetch stored boarding inputs for an address. */
    getUtxos(address: string): Promise<ExtendedCoin[]>;
    /** Save boarding inputs for an address. */
    saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void>;
    /** Delete stored boarding inputs for an address. */
    deleteUtxos(address: string): Promise<void>;
    /** Fetch stored transaction history for an address. */
    getTransactionHistory(address: string): Promise<ArkTransaction[]>;
    /** Save transaction history for an address. */
    saveTransactions(address: string, txs: ArkTransaction[]): Promise<void>;
    /** Delete stored transaction history for an address. */
    deleteTransactions(address: string): Promise<void>;
    /** Fetch stored wallet state. */
    getWalletState(): Promise<WalletState | null>;
    /** Save wallet state. */
    saveWalletState(state: WalletState): Promise<void>;
}

/**
 * Filter options for querying contracts.
 */
interface ContractFilter {
    /** Filter by script(s) */
    script?: string | string[];
    /** Filter by state(s) */
    state?: ContractState | ContractState[];
    /** Filter by contract type(s) */
    type?: string | string[];
}
interface ContractRepository extends AsyncDisposable {
    readonly version: 1;
    /**
     * Clear all data from storage.
     */
    clear(): Promise<void>;
    /**
     * Get contracts with optional filter.
     * Returns all contracts if no filter provided.
     */
    getContracts(filter?: ContractFilter): Promise<Contract[]>;
    /**
     * Save or update a contract.
     */
    saveContract(contract: Contract): Promise<void>;
    /**
     * Delete a contract by script.
     */
    deleteContract(script: string): Promise<void>;
}

type RefreshVtxosOptions = {
    scripts?: string[];
    after?: number;
    before?: number;
    /**
     * When true and `scripts` is not set, refresh every contract in
     * the repository — including those marked `inactive` and those
     * that have dropped out of the watcher's active set. Useful for
     * "did anyone send funds to a stale rotated display address?"
     * audits.
     *
     * Because this is a *superset* of the watcher's watched set, the
     * cursor invariant still holds and the cursor advances normally
     * (unless an explicit `after` / `before` window is also supplied).
     *
     * Ignored when `scripts` is set (the explicit list already
     * specifies what to refresh, regardless of contract state).
     *
     * @defaultValue `false`
     */
    includeInactive?: boolean;
};
/**
 * A single `Discoverable` handler's `discoverAt` rejection, captured during
 * a {@link IContractManager.scanContracts} run instead of aborting the loop.
 */
interface HandlerError {
    handler: string;
    index: number;
    error: unknown;
}
/**
 * Outcome of a {@link IContractManager.scanContracts} run.
 *
 * `lastIndexUsed` is the highest HD index at which any handler discovered a
 * contract (`-1` if nothing was found). `handlerErrors` collects per-handler
 * `discoverAt` failures — non-empty means the gap window may have closed
 * early and the caller should surface this (the scan itself still resolved).
 */
interface ScanResult {
    lastIndexUsed: number;
    handlerErrors: HandlerError[];
}
/**
 * Options for {@link IContractManager.scanContracts}.
 */
interface ScanContractsOptions {
    /** Default 20. A non-positive / non-integer value throws. */
    gapLimit?: number;
    /** HD mode → unbounded gap loop guided by the gap counter; false → probe only index 0 (single static pass). */
    hd: boolean;
    /**
     * Materialize the descriptor at an HD index. Pure derivation; a throw
     * here is structural/fatal and propagates out of `scanContracts`.
     */
    materialize: (index: number) => string;
    /** Read-only context injected into every `discoverAt` call. */
    deps: DiscoveryDeps;
}
interface IContractManager extends Disposable {
    /**
     * Create and register a new contract.
     *
     * Implementations may validate that:
     * - A handler exists for `params.type`
     * - `params.script` matches the script derived from `params.params`
     *
     * The contract script is used as the unique identifier.
     */
    createContract(params: CreateContractParams): Promise<Contract>;
    /**
     * List contracts with optional filters.
     *
     * @example
     * ```typescript
     * const vhtlcs = await manager.getContracts({ type: "vhtlc" });
     * const active = await manager.getContracts({ state: "active" });
     * ```
     */
    getContracts(filter?: GetContractsFilter): Promise<Contract[]>;
    /**
     * List contracts and their current virtual outputs.
     *
     * If no filter is provided, returns all contracts with their virtual outputs.
     */
    getContractsWithVtxos(filter?: GetContractsFilter): Promise<ContractWithVtxos[]>;
    /**
     * Stamp raw virtual outputs with the correct per-contract tapscripts
     * (forfeit, intent, tap tree).
     *
     * Resolves each vtxo's `script` to its owning contract via the contract
     * repository and attaches the matching tapscripts. Throws when any vtxo
     * references a script with no registered contract — callers are expected
     * to register the contract before asking for annotation. This is the
     * single shared path that replaces scattered `extendVirtualCoin*` calls
     * in wallet/handler code, and keeps the wallet from silently stamping the
     * default tapscript onto a non-default vtxo.
     */
    annotateVtxos(vtxos: VirtualCoin[]): Promise<ExtendedVirtualCoin[]>;
    /**
     * Update mutable contract fields.
     *
     * `script` and `createdAt` are immutable.
     */
    updateContract(script: string, updates: Partial<Omit<Contract, "script" | "createdAt">>): Promise<Contract>;
    /**
     * Convenience helper to update only the contract state.
     */
    setContractState(script: string, state: ContractState): Promise<void>;
    /**
     * Delete a contract by script and stop watching it (if applicable).
     */
    deleteContract(script: string): Promise<void>;
    /**
     * Get all currently spendable paths for a contract.
     *
     * Returns an empty array if the contract or its handler cannot be found.
     */
    getSpendablePaths(options: GetSpendablePathsOptions): Promise<PathSelection[]>;
    /**
     * Get all possible spending paths for a contract.
     *
     * Returns an empty array if the contract or its handler cannot be found.
     */
    getAllSpendingPaths(options: GetAllSpendingPathsOptions): Promise<PathSelection[]>;
    /**
     * Subscribe to contract events.
     *
     * @returns Unsubscribe function
     */
    onContractEvent(callback: ContractEventCallback): () => void;
    /**
     * Force a virtual output refresh from the indexer.
     *
     * Without options, refreshes all contracts from scratch.
     * With options, narrows the refresh to specific scripts and/or a time window.
     */
    refreshVtxos(opts?: RefreshVtxosOptions): Promise<void>;
    /**
     * Reconcile specific outpoints with the indexer's authoritative state and
     * upsert the result into the wallet repository.
     *
     * The cursor-derived delta sync filters by `created_at`, so a VTXO that
     * was created before the cursor but spent recently won't surface in a
     * standard `refreshVtxos()` call. This method is the surgical recovery
     * path for that case: when something hands us a stale outpoint (e.g. the
     * server returns `VTXO_ALREADY_SPENT` with a `vtxo_outpoint` in its
     * error metadata), call this to pull the latest state and unblock the
     * caller — no full re-scan, no cursor change.
     *
     * Outpoints not owned by any tracked contract are silently dropped.
     */
    refreshOutpoints(outpoints: Outpoint[]): Promise<void>;
    /**
     * Explicit, gap-limit contract discovery used by `wallet.restore()`.
     *
     * Walks HD indices from 0, asking every registered `Discoverable`
     * handler whether it owns a contract anchored at that index, and
     * registers each find via the idempotent {@link createContract}. A hit
     * at index `i` (by any handler, including an injected swap handler)
     * resets the gap counter, so swap discovery keeps the HD window open.
     *
     * Error contract (safety-critical — see spec §4):
     * - A handler's `discoverAt` rejecting is **collected** into
     *   `handlerErrors` and the loop **continues**; it never aborts the
     *   scan or throws.
     * - A fatal operational error — `materialize()` throwing, or
     *   `createContract` rejecting — **propagates** out of `scanContracts`
     *   (it invalidates the gap-window signal, so a silent truncation
     *   would risk hiding user funds).
     *
     * @param opts See {@link ScanContractsOptions}.
     * @returns `{ lastIndexUsed, handlerErrors }` — the caller surfaces
     *   `handlerErrors` *after* the inline VTXO pull.
     */
    scanContracts(opts: ScanContractsOptions): Promise<ScanResult>;
    /**
     * Whether the underlying watcher is currently active.
     */
    isWatching(): Promise<boolean>;
    /**
     * Release resources (stop watching, clear listeners).
     */
    dispose(): void;
}
/**
 * Options for getting spendable paths.
 */
type GetSpendablePathsOptions = {
    /** The contract script */
    contractScript: string;
    /** The specific virtual output being evaluated */
    vtxo: VirtualCoin;
    /** Whether collaborative spending is available (default: true) */
    collaborative?: boolean;
    /** Wallet's public key (hex) to determine role */
    walletPubKey?: string;
};
/**
 * Options for getting all possible spending paths.
 */
type GetAllSpendingPathsOptions = {
    /** The contract script */
    contractScript: string;
    /** Whether collaborative spending is available (default: true) */
    collaborative?: boolean;
    /** Wallet's public key (hex) to determine role */
    walletPubKey?: string;
};
/**
 * Configuration for the ContractManager.
 */
interface ContractManagerConfig {
    /** The indexer provider */
    indexerProvider: IndexerProvider;
    /** The contract repository for persistence */
    contractRepository: ContractRepository;
    /** The wallet repository for virtual output storage (single source of truth) */
    walletRepository: WalletRepository;
    /** Watcher configuration */
    watcherConfig?: Partial<ContractWatcherConfig>;
}
/**
 * Parameters for creating a new contract.
 */
type CreateContractParams = Omit<Contract, "createdAt" | "state"> & {
    /** Initial state (defaults to "active") */
    state?: ContractState;
};
/**
 * Central manager for contract lifecycle and operations.
 *
 * Responsibilities:
 * - Create and persist contracts
 * - Query stored contracts (optionally with their virtual outputs)
 * - Provide spendable path selection for a contract
 * - Emit contract-related events (virtual output received/spent, connection reset)
 *
 * Notes:
 * - Implementations typically start watching automatically during initialization
 *   (so `onContractEvent()` is just for subscribing).
 *
 * @example
 * ```typescript
 * const manager = await ContractManager.create({
 *   indexerProvider: wallet.indexerProvider,
 *   contractRepository: wallet.contractRepository,
 * });
 *
 * // Create a new VHTLC contract
 * const contract = await manager.createContract({
 *   label: "Lightning Receive",
 *   type: "vhtlc",
 *   params: { sender: "ark1q...", receiver: "ark1q...", ... },
 *   script: "5120...",
 *   address: "ark1q...",
 * });
 *
 * // Start watching for events
 * const unsubscribe = manager.onContractEvent((event) => {
 *   console.log(`${event.type} on ${event.contractScript}`);
 * });
 *
 * // Query contracts together with their current virtual outputs
 * const contractsWithVtxos = await manager.getContractsWithVtxos();
 *
 * // Get balance across all contracts
 * const balances = contractsWithVtxos.flatMap(({vtxos}) => vtxos).reduce((acc, vtxo) => acc + vtxo.value, 0)
 *
 * // Later: unsubscribe from events
 * unsubscribe();
 *
 * // Clean up
 * manager.dispose();
 * ```
 */
declare class ContractManager implements IContractManager {
    private config;
    private watcher;
    private initialized;
    private eventCallbacks;
    private stopWatcherFn?;
    private constructor();
    /**
     * Static factory method for creating a new ContractManager.
     * Initialize the manager by loading persisted contracts and starting to watch.
     *
     * After initialization, the manager automatically watches all active contracts
     * and contracts with virtual outputs. Use `onContractEvent()` to register event callbacks.
     *
     * @param config ContractManagerConfig
     */
    static create(config: ContractManagerConfig): Promise<ContractManager>;
    private initialize;
    /**
     * Delta-sync the full watched set and reconcile the pending frontier.
     *
     * Shared recovery path used on initial boot and after a subscription
     * reconnect. `syncContracts({})` scopes to the current watched set
     * (see {@link ContractWatcher.getWatchedContracts}), uses the
     * cursor-derived delta window, and advances the cursor on success.
     * `reconcilePendingFrontier` catches not-yet-finalized virtual
     * outputs that could sit outside any delta window.
     */
    private reconcileWatched;
    /**
     * Create and register a new contract.
     *
     * @param params - Contract parameters
     * @returns The created contract
     */
    createContract(params: CreateContractParams): Promise<Contract>;
    /**
     * Lightweight variant of {@link createContract} for batch discovery
     * paths (currently: {@link scanContracts}). Validates, dedupes, persists,
     * and registers the watcher — but skips the per-contract
     * `fetchContractVxosFromIndexer` round-trip. The caller is responsible
     * for hydrating VTXOs afterwards via a bulk `refreshVtxos(...)` so a
     * scan that finds N contracts costs one batched indexer call instead
     * of N + 1. Error semantics are identical to `createContract`:
     * validation / type-mismatch / persistence failures propagate.
     */
    private persistAndWatchContract;
    /**
     * Shared validate + check-existing + persist core for
     * {@link createContract} and {@link persistAndWatchContract}. Returns
     * the resolved contract and whether *this* call wrote it — callers
     * that need to attach hydration / watcher work do so only when
     * `persisted` is `true`.
     */
    private upsertContract;
    /**
     * Explicit, gap-limit contract discovery (see {@link IContractManager.scanContracts}).
     *
     * Each hit is routed through {@link persistAndWatchContract} — the same
     * dedupe + watcher-register path as {@link createContract} minus the
     * per-contract indexer round-trip. The caller (`Wallet.restore`) follows
     * up with a single bulk `refreshVtxos({ includeInactive: true })`, so a
     * scan that finds N contracts costs one batched indexer call instead of
     * N + 1.
     *
     * Safety-critical invariants (spec §2.C / §4):
     * - `opts.materialize(i)` throwing is structural/fatal: it is NOT
     *   wrapped — it propagates and aborts the scan.
     * - A `discoverAt` rejection is collected into `handlerErrors` and the
     *   loop continues (the gap counter still advances for that index if no
     *   other handler hit it).
     * - `persistAndWatchContract` rejecting is operational/fatal and
     *   propagates (only `discoverAt` is guarded).
     */
    scanContracts(opts: ScanContractsOptions): Promise<ScanResult>;
    /**
     * Get contracts with optional filters.
     *
     * @param filter - Optional filter criteria
     * @returns Filtered contracts TODO: filter spent/unspent
     *
     * @example
     * ```typescript
     * // Get all VHTLC contracts
     * const vhtlcs = await manager.getContracts({ type: 'vhtlc' });
     *
     * // Get all active contracts
     * const active = await manager.getContracts({ state: 'active' });
     * ```
     */
    getContracts(filter?: GetContractsFilter): Promise<Contract[]>;
    getContractsWithVtxos(filter?: GetContractsFilter, pageSize?: number): Promise<ContractWithVtxos[]>;
    annotateVtxos(vtxos: VirtualCoin[]): Promise<ExtendedVirtualCoin[]>;
    private buildContractsDbFilter;
    /**
     * Update a contract.
     * Nested fields like `params` and `metadata` are replaced with the provided values.
     * If you need to preserve existing fields, merge them manually.
     *
     * @param script - Contract script
     * @param updates - Fields to update
     */
    updateContract(script: string, updates: Partial<Omit<Contract, "script" | "createdAt">>): Promise<Contract>;
    /**
     * Update a contract's params.
     * This method preserves existing params by merging the provided values.
     *
     * @param script - Contract script
     * @param updates - The new values to merge with existing params
     */
    updateContractParams(script: string, updates: Contract["params"]): Promise<Contract>;
    /**
     * Set a contract's state.
     */
    setContractState(script: string, state: ContractState): Promise<void>;
    /**
     * Delete a contract.
     *
     * @param script - Contract script
     */
    deleteContract(script: string): Promise<void>;
    /**
     * Get currently spendable paths for a contract.
     *
     * @param options - Options for getting spendable paths
     */
    getSpendablePaths(options: GetSpendablePathsOptions): Promise<PathSelection[]>;
    /**
     * Get every currently valid spending path for a contract.
     *
     * @param options - Options for getting spending paths
     */
    getAllSpendingPaths(options: GetAllSpendingPathsOptions): Promise<PathSelection[]>;
    /**
     * Register a callback for contract events.
     *
     * The manager automatically watches after `initialize()`. This method
     * allows registering callbacks to receive events.
     *
     * @param callback - Event callback
     * @returns Unsubscribe function to remove this callback
     *
     * @example
     * ```typescript
     * const unsubscribe = manager.onContractEvent((event) => {
     *   console.log(`${event.type} on ${event.contractScript}`);
     * });
     *
     * // Later: stop receiving events
     * unsubscribe();
     * ```
     */
    onContractEvent(callback: ContractEventCallback): () => void;
    /**
     * Force refresh virtual outputs from the indexer.
     *
     * Without options, re-fetches every contract in the watcher's
     * watched set and advances the global cursor.
     *
     * `scripts` narrows the refresh to a specific list (subset query —
     * cursor is not advanced because contracts outside the list may
     * have data we'd skip).
     *
     * `includeInactive: true` (and no `scripts`) widens the refresh to
     * every contract in the repository, including ones marked
     * `inactive` and ones that have dropped out of the watcher's
     * active set. This is a *superset* of the watched set, so the
     * cursor invariant still holds and the cursor advances normally.
     *
     * `after` / `before` apply a caller-supplied time window. The
     * cursor never advances on a windowed query because the window
     * may skip data outside its bounds.
     */
    refreshVtxos(opts?: RefreshVtxosOptions): Promise<void>;
    refreshOutpoints(outpoints: Outpoint[]): Promise<void>;
    /**
     * Check if currently watching.
     */
    isWatching(): Promise<boolean>;
    /**
     * Emit an event to all registered callbacks.
     */
    private emitEvent;
    /**
     * Handle events from the watcher.
     */
    private handleContractEvent;
    private getVtxosForContracts;
    /**
     * Sync virtual outputs for the given contracts against the indexer.
     *
     * When `options.contracts` is omitted the sync covers the full
     * watched set (active contracts plus any inactive contracts still
     * holding cached VTXOs) and the global cursor is advanced on
     * success. Passing an explicit subset leaves the cursor alone so a
     * narrow poll can't hide data that other contracts still need to
     * pick up.
     */
    private syncContracts;
    /**
     * Fetch all pending (unfinalized) virtual outputs and upsert them into the
     * repository. This catches virtual outputs whose state changed outside the delta
     * window (e.g. a spend that hasn't settled yet).
     */
    private reconcilePendingFrontier;
    private fetchContractVxosFromIndexer;
    private fetchContractVtxosBulk;
    /**
     * Dispose of the ContractManager and release all resources.
     *
     * Stops the watcher, clears callbacks, and marks
     * the manager as uninitialized.
     *
     * Implements the disposable pattern for cleanup.
     */
    dispose(): void;
    /**
     * Symbol.dispose implementation for using with `using` keyword.
     * @example
     * ```typescript
     * {
     *   using manager = await wallet.getContractManager();
     *   // ... use manager
     * } // automatically disposed
     * ```
     */
    [Symbol.dispose](): void;
}

/**
 * Contract state indicating whether it should be actively monitored.
 */
type ContractState = "active" | "inactive";
/**
 * Represents a contract that can receive and manage virtual outputs.
 *
 * A contract is defined by its type and parameters, which together
 * determine the VtxoScript (spending paths). The wallet's default
 * receiving address is itself a contract of type "default".
 *
 * External services (Boltz swaps, atomic swaps, etc.) create additional
 * contracts with their own types and parameters.
 *
 * @example
 * ```typescript
 * const vhtlcContract: Contract = {
 *   type: "vhtlc",
 *   params: {
 *     sender: "ab12...",
 *     receiver: "cd34...",
 *     server: "ef56...",
 *     hash: "1234...",
 *     refundLocktime: "800000",
 *     // ... timelocks
 *   },
 *   script: "5120...",
 *   address: "ark1q...",
 *   state: "active",
 *   createdAt: 1704067200000,
 * };
 * ```
 */
interface Contract {
    /** Human-readable label for display purposes. */
    label?: string;
    /**
     * Contract type identifier.
     * Built-in types: "default", "vhtlc"
     * Custom types can be registered via ContractHandler.
     */
    type: string;
    /**
     * Type-specific parameters for constructing the VtxoScript.
     * All values are serialized as strings (hex for bytes, string for bigint).
     * The ContractHandler for this type knows how to interpret these.
     */
    params: Record<string, string>;
    /** The pkScript hex, used as the unique identifier and primary key for contracts. */
    script: string;
    /** Address derived from the contract script. */
    address: string;
    /** Current state of the contract. */
    state: ContractState;
    /** Unix timestamp in milliseconds when this contract was created. */
    createdAt: number;
    /**
     * Optional metadata for external integrations.
     */
    metadata?: Record<string, unknown>;
}
/**
 * A virtual output that has been associated with a specific contract.
 */
type ContractVtxo = VirtualCoin & Partial<TapLeaves & EncodedVtxoScript> & {
    extraWitness?: Bytes[];
    contractScript: string;
};
/**
 * A {@link ContractVtxo} with all taproot annotation fields required.
 *
 * Mirrors the {@link ExtendedVirtualCoin} / {@link VirtualCoin} split:
 * - {@link ContractVtxo} carries `TapLeaves` and `EncodedVtxoScript` as
 *   `Partial<>` because VTXOs fetched raw from the indexer do not yet have
 *   taproot data.
 * - `ExtendedContractVtxo` narrows those fields to required, guaranteeing
 *   that `annotateVtxos` has run and the taproot leaves are present.
 *
 * Use this type (instead of {@link ContractVtxo}) wherever the compiler
 * should enforce that annotation has happened — e.g. `saveVtxos` and
 * forfeit transaction construction.
 */
type ExtendedContractVtxo = ExtendedVirtualCoin & {
    contractScript: string;
};
/**
 * Result of path selection, including the tapleaf to use and any extra witness data.
 */
interface PathSelection {
    /** Tapleaf script to use for spending. */
    leaf: TapLeafScript;
    /** Additional witness elements, for example a preimage for HTLC-like paths. */
    extraWitness?: Bytes[];
    /**
     * nSequence for the spending input, BIP-68 encoded when the leaf
     * uses CSV. Decode with `sequenceToTimelock`; do NOT use as an
     * absolute `Transaction.lockTime`.
     */
    sequence?: number;
}
/**
 * Context for path selection decisions.
 */
interface PathContext {
    /** Whether collaborative spending is available through server cooperation. */
    collaborative: boolean;
    /** Current time in milliseconds. */
    currentTime: number;
    /** Current block height, when known. */
    blockHeight?: number;
    /**
     * Wallet's descriptor for signing.
     * Format: tr(pubkey) for static keys, tr([fingerprint/path']xpub/0/{index}) for HD.
     * Used by handlers to determine wallet's role in multi-party contracts.
     */
    walletDescriptor?: string;
    /**
     * Wallet's public key (x-only, 32 bytes hex).
     * @deprecated Use walletDescriptor instead.
     */
    walletPubKey?: string;
    /**
     * Explicit role override for multi-party contracts such as VHTLC.
     * If not provided, the handler may derive the role by matching
     * {@link walletDescriptor} (preferred) — or {@link walletPubKey} as a
     * fallback — against the contract's sender/receiver params.
     */
    role?: string;
    /** The specific virtual output being evaluated. */
    vtxo?: VirtualCoin;
}
/**
 * Handler for a specific contract type.
 *
 * Each contract type (`default`, `vhtlc`, etc.) has a handler that knows how to:
 * 1. Create the VtxoScript from parameters
 * 2. Serialize/deserialize parameters for storage
 * 3. Select the appropriate spending path based on context
 *
 * @example
 * ```typescript
 * const vhtlcHandler: ContractHandler = {
 *   type: "vhtlc",
 *   createScript(params) {
 *     return new VHTLC.Script(this.deserializeParams(params));
 *   },
 *   selectPath(script, contract, context) {
 *     const vhtlc = script as VHTLC.Script;
 *     const preimage = contract.data?.preimage;
 *     if (context.collaborative && preimage) {
 *       return { leaf: vhtlc.claim(), extraWitness: [hex.decode(preimage)] };
 *     }
 *     // ... other paths
 *   },
 *   // ...
 * };
 * ```
 */
interface ContractHandler<P = Record<string, unknown>, S extends VtxoScript = VtxoScript> {
    /** Contract type managed by this handler. */
    readonly type: string;
    /**
     * Create the VtxoScript from serialized parameters.
     *
     * @param params - Serialized contract parameters
     * @returns Contract script instance
     */
    createScript(params: Record<string, string>): S;
    /**
     * Serialize typed parameters to string key-value pairs.
     *
     * @param params - Typed contract parameters
     * @returns Serialized key-value representation
     */
    serializeParams(params: P): Record<string, string>;
    /**
     * Deserialize string key-value pairs to typed parameters.
     */
    deserializeParams(params: Record<string, string>): P;
    /**
     * Select the preferred spending path based on contract state and context.
     * Returns the best available path (e.g., collaborative over unilateral).
     *
     * @returns PathSelection if a viable path exists, null otherwise
     */
    selectPath(script: S, contract: Contract, context: PathContext): PathSelection | null;
    /**
     * Get all possible spending paths for the current context.
     * Returns empty array if no paths are available.
     *
     * Useful for showing users which spending options exist regardless of
     * current spendability.
     */
    getAllSpendingPaths(script: S, contract: Contract, context: PathContext): PathSelection[];
    /**
     * Get all currently spendable paths.
     * Returns empty array if no paths are available.
     */
    getSpendablePaths(script: S, contract: Contract, context: PathContext): PathSelection[];
}
/**
 * What a {@link Discoverable.discoverAt} call returns — exactly the
 * shape `ContractManager.createContract` accepts (script-keyed,
 * idempotent on re-register).
 */
interface DiscoveredContract {
    type: string;
    params: Record<string, string>;
    script: string;
    address: string;
    metadata?: Record<string, unknown>;
    label?: string;
}
/**
 * Read-only context the scanner injects into every `discoverAt` call.
 * The boltz/swap handler does NOT receive its Boltz client here — it
 * closes over its own client at registration time.
 */
interface DiscoveryDeps {
    indexerProvider: IndexerProvider;
    onchainProvider: OnchainProvider;
    network: {
        hrp: string;
    };
    serverPubKey: Uint8Array;
    /** Relative timelocks the wallet treats as its baseline matrix. */
    csvTimelocks: RelativeTimelock[];
    /** Present only for delegate wallets. */
    delegatePubKey?: Uint8Array;
}
/**
 * Optional capability a {@link ContractHandler} implements to participate
 * in `wallet.restore()`'s gap-limit scan. The scanner owns the index
 * loop and the gap counter; the handler answers "do I own a contract
 * anchored to the pubkey/descriptor at this index?" — checked against
 * the indexer / explorer / (for swaps) the handler's own source. The
 * handler MAY batch/cache internally across calls.
 */
interface Discoverable {
    discoverAt(index: number, descriptor: string, deps: DiscoveryDeps): Promise<DiscoveredContract[]>;
}
/** Duck-typed guard (mirrors `hasReceiveRotatorFactory`). */
declare function isDiscoverable(handler: ContractHandler<unknown> | undefined): handler is ContractHandler<unknown> & Discoverable;
/**
 * Event emitted when contract-related changes occur.
 */
type ContractEvent = {
    type: "vtxo_received";
    contractScript: string;
    vtxos: ContractVtxo[];
    contract: Contract;
    timestamp: number;
} | {
    type: "vtxo_spent";
    contractScript: string;
    vtxos: ContractVtxo[];
    contract: Contract;
    timestamp: number;
} | {
    type: "connection_reset";
    timestamp: number;
};
/**
 * Callback for contract events.
 */
type ContractEventCallback = (event: ContractEvent) => void;
/**
 * Options for retrieving contracts from the Contract Manager.
 * Currently an alias of the repository's filter type but can be extended in the future.
 */
type GetContractsFilter = ContractFilter;
/**
 * Contract with its virtual outputs included.
 */
type ContractWithVtxos = {
    contract: Contract;
    vtxos: ExtendedContractVtxo[];
};
/**
 * Summary of a contract's balance.
 */
interface ContractBalance {
    /** Total balance (settled + pending) in satoshis */
    total: number;
    /** Spendable balance in satoshis */
    spendable: number;
    /** Number of virtual outputs in this contract */
    vtxoCount: number;
}

/**
 * Configuration for the ContractWatcher.
 *
 * @see ContractWatcher
 *
 * @example
 * ```typescript
 * const watcher = new ContractWatcher({
 *   indexerProvider,
 *   walletRepository,
 * })
 * ```
 */
interface ContractWatcherConfig {
    /** Indexer provider used for subscriptions and queries. */
    indexerProvider: IndexerProvider;
    /** Wallet repository used to store virtual output state between watcher updates. */
    walletRepository: WalletRepository;
    /**
     * Interval for failsafe polling (ms).
     * Polls even when subscription is active to catch missed events.
     *
     * @defaultValue `60_000` (1 minute)
     */
    failsafePollIntervalMs?: number;
    /**
     * Initial reconnection delay (ms).
     * Uses exponential backoff on repeated failures.
     *
     * @defaultValue `1_000` (1 second)
     */
    reconnectDelayMs?: number;
    /**
     * Maximum reconnection delay (ms).
     *
     * @defaultValue `30_000` (30 seconds)
     */
    maxReconnectDelayMs?: number;
    /**
     * Maximum reconnection attempts before giving up.
     * Set to 0 for unlimited attempts.
     *
     * @defaultValue `0` (unlimited)
     */
    maxReconnectAttempts?: number;
}
/**
 * Connection state for the watcher.
 */
type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";
/**
 * Watches multiple contracts for virtual output state changes with resilient connection handling.
 *
 * Features:
 * - Automatic reconnection with exponential backoff
 * - Failsafe polling to catch missed events
 * - Polls immediately after (re)connection to sync state
 * - Graceful handling of subscription failures
 *
 * @example
 * ```typescript
 * const watcher = new ContractWatcher({
 *   indexerProvider: wallet.indexerProvider,
 * });
 *
 * // Add the wallet's default contract
 * await watcher.addContract(defaultContract);
 *
 * // Add additional contracts (swaps, etc.)
 * await watcher.addContract(swapContract);
 *
 * // Start watching for events
 * const stop = await watcher.startWatching((event) => {
 *   console.log(`${event.type} on contract ${event.contractScript}`);
 * });
 *
 * // Later: stop watching
 * stop();
 * ```
 */
declare class ContractWatcher {
    private config;
    private contracts;
    private subscriptionId?;
    private abortController?;
    private isWatching;
    private eventCallback?;
    private connectionState;
    private reconnectAttempts;
    private reconnectTimeoutId?;
    private failsafePollIntervalId?;
    /**
     * Create a contract watcher with the given providers and polling settings.
     *
     * @param config - Contract watcher configuration
     * @see ContractWatcherConfig
     */
    constructor(config: ContractWatcherConfig);
    /**
     * Add a contract to be watched.
     *
     * Active contracts are immediately subscribed.
     *
     * All contracts are polled to discover any existing virtual outputs
     * (which may cause them to be watched even if inactive).
     */
    addContract(contract: Contract): Promise<void>;
    /**
     * Pre-populate `lastKnownVtxos` from the wallet repository.
     *
     * Runs on add (and can be re-run after reconnect) so polling always
     * compares the indexer's view against what is already persisted,
     * emitting only genuine deltas.
     */
    private seedLastKnownVtxos;
    /**
     * Update an existing contract.
     */
    updateContract(contract: Contract): Promise<void>;
    /**
     * Remove a contract from watching.
     */
    removeContract(contractScript: string): Promise<void>;
    /**
     * Get all in-memory contracts.
     */
    getAllContracts(): Contract[];
    /**
     * Contracts the watcher is actually tracking:
     * - all active contracts, plus
     * - inactive contracts that still hold known virtual outputs
     *   (the subscription keeps watching them so `vtxo_spent` events for
     *   those unspent outputs are still observed).
     *
     * This is the single source of truth for "contracts whose VTXO state
     * we still care about" — callers and the subscription itself fan out
     * over the same set so nothing is reconciled that isn't also watched.
     */
    getWatchedContracts(): Contract[];
    /**
     * Get virtual outputs for contracts, grouped by contract script.
     * @see WalletRepository for `repo`
     */
    private getContractVtxos;
    /**
     * Start watching for virtual output events across all active contracts.
     */
    startWatching(callback: ContractEventCallback): Promise<() => void>;
    /**
     * Stop watching for events.
     */
    stopWatching(): Promise<void>;
    /**
     * Check if currently watching.
     */
    isCurrentlyWatching(): boolean;
    /**
     * Get current connection state.
     */
    getConnectionState(): ConnectionState;
    /**
     * Force a poll of all active contracts.
     * Useful for manual refresh or after app resume.
     */
    forcePoll(): Promise<void>;
    /**
     * Connect to the subscription.
     *
     * @param skipUpdate - Skip the leading `updateSubscription` call when
     *   the caller has already established `subscriptionId`.
     */
    private connect;
    /**
     * Schedule a reconnection attempt.
     */
    private scheduleReconnect;
    /**
     * Start the failsafe polling interval.
     */
    private startFailsafePolling;
    private pollAllContracts;
    /**
     * Poll specific contracts and emit events for changes.
     */
    private pollContracts;
    private tryUpdateSubscription;
    /**
     * Update the subscription with scripts that should be watched.
     *
     * Watches both active contracts and contracts with virtual outputs.
     */
    private updateSubscription;
    /**
     * Main listening loop for subscription events.
     */
    private listenLoop;
    /**
     * Handle a subscription update.
     */
    private handleSubscriptionUpdate;
    /**
     * Process virtual outputs from subscription and route each VTXO to the
     * single contract that actually locks it via `vtxo.script`. If the script
     * doesn't match any watched contract, skip the VTXO rather than fan it
     * out to every matching contract — fan-out produced phantom state in
     * non-owning contracts that then never reconciled.
     */
    private processSubscriptionVtxos;
    /**
     * Emit a virtual output event for a contract.
     */
    private emitVtxoEvent;
}

/**
 * Intent proof implementation for Bitcoin message signing.
 *
 * Intent proof defines a standard for signing Bitcoin messages as well as proving
 * ownership of outputs.
 *
 * This namespace provides utilities for creating and validating Intent proof.
 *
 * It is greatly inspired by BIP322.
 * @see https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki
 *
 * @example
 * ```typescript
 * // Create a Intent proof
 * const proof = Intent.create(
 *   "Hello Bitcoin!",
 *   [input],
 *   [output]
 * );
 *
 * // Sign the proof
 * const signedProof = await identity.sign(proof);
 *
 */
declare namespace Intent {
    type Proof = Transaction;
    /**
     * Creates a new Intent proof unsigned transaction.
     *
     * This function constructs a special transaction that can be signed to prove
     * ownership of onchain and virtual outputs. The proof includes the message to be
     * signed and the inputs/outputs that demonstrate ownership.
     *
     * @param message - The Intent message to be signed, either raw string of Message object
     * @param ins - Array of transaction inputs to prove ownership of
     * @param outputs - Optional array of transaction outputs
     * @returns An unsigned Intent proof transaction
     */
    function create(message: string | Message, ins: (TransactionInput | ExtendedCoin)[], outputs?: TransactionOutput[]): Proof;
    /**
     * Compute the fee paid by an intent proof transaction.
     *
     * @param proof - Intent proof transaction
     * @returns The fee in satoshis
     */
    function fee(proof: Proof): number;
    type RegisterMessage = {
        type: "register";
        onchain_output_indexes: number[];
        valid_at: number;
        expire_at: number;
        cosigners_public_keys: string[];
    };
    type DeleteMessage = {
        type: "delete";
        expire_at: number;
    };
    type GetPendingTxMessage = {
        type: "get-pending-tx";
        expire_at: number;
    };
    type Message = RegisterMessage | DeleteMessage | GetPendingTxMessage;
    /**
     * Serialize an intent message to the canonical JSON string used for signing.
     *
     * @param message - Intent message payload
     * @returns Canonical string form of the message
     */
    function encodeMessage(message: Message): string;
}

/**
 * Delegate identity and fee information returned by `getDelegateInfo`.
 */
interface DelegateInfo {
    /** Delegate public key. */
    pubkey: string;
    /** Delegate fee amount or expression returned by the delegate. */
    fee: string;
    /** Address for delegate fee collection. Sourced from `delegatorAddress` in Fulmine response, for now. */
    delegateAddress: string;
    /** @deprecated alias for @see DelegateInfo.delegateAddress */
    delegatorAddress?: string;
}
/**
 * Optional delegate behavior flags.
 */
interface DelegateOptions {
    /**
     * Instruct the delegate not to replace an existing delegation
     * (meaning a signed register intent and its forfeit transactions)
     * that already includes at least one virtual output from this request.
     *
     * @defaultValue `false`
     */
    rejectReplace?: boolean;
}
/**
 * Provider interface for remote delegation service.
 */
interface DelegateProvider {
    /**
     * Request delegation for a signed register intent and its forfeit transactions.
     *
     * @param intent - Signed register intent to delegate
     * @param forfeitTxs - Forfeit transactions associated with the delegation request
     * @param options - Optional delegate behavior flags
     */
    delegate(intent: SignedIntent<Intent.RegisterMessage>, forfeitTxs: string[], options?: DelegateOptions): Promise<void>;
    /**
     * Fetch delegate metadata such as pubkey, fee, and delegate address.
     *
     * @returns Delegate identity and fee information
     */
    getDelegateInfo(): Promise<DelegateInfo>;
}
/** @deprecated alias for @see DelegateProvider */
type DelegatorProvider = DelegateProvider;
/**
 * REST-based delegate provider implementation.
 * @example
 * ```typescript
 * const provider = new RestDelegateProvider('https://delegate.example.com');
 * const info = await provider.getDelegateInfo();
 * await provider.delegate(intent, forfeitTxs);
 * ```
 */
declare class RestDelegateProvider implements DelegateProvider {
    url: string;
    /**
     * Create a REST delegate provider targeting the given base URL.
     *
     * @param url - Base URL of the remote delegation service.
     */
    constructor(url: string);
    /**
     * Submit a delegation request to the remote delegation service.
     *
     * @param intent - Signed register intent to delegate
     * @param forfeitTxs - Forfeit transactions associated with the delegation request
     * @param options - Optional delegate behavior flags
     * @throws Error if the remote service rejects the request
     */
    delegate(intent: SignedIntent<Intent.RegisterMessage>, forfeitTxs: string[], options?: DelegateOptions): Promise<void>;
    /**
     * Fetch delegate metadata exposed by the remote delegation service.
     *
     * @returns Delegate identity and fee information
     * @throws Error if the remote service returns invalid data
     */
    getDelegateInfo(): Promise<DelegateInfo>;
}
/** @deprecated alias for @see RestDelegateProvider */
declare const RestDelegatorProvider: typeof RestDelegateProvider;
type RestDelegatorProvider = RestDelegateProvider;

interface IDelegateManager {
    /**
     * Delegate virtual outputs to the remote delegation service.
     *
     * Vtxos that are not locked to a delegate-type contract (no tap leaf
     * matches the delegate's pubkey) are filtered out silently, since they
     * cannot be co-signed by the delegate.
     *
     * @param vtxos - Virtual outputs to delegate
     * @param destination - Arkade address that should receive renewed funds
     * @param delegateAt - Optional timestamp to force a specific delegation time
     * @returns Successfully delegated and failed outpoint groups
     */
    delegate(vtxos: ContractVtxo[], destination: string, delegateAt?: Date): Promise<{
        delegated: Outpoint[];
        failed: {
            outpoints: Outpoint[];
            error: unknown;
        }[];
    }>;
    /** Fetch delegate metadata such as pubkey, fee, and delegate address. */
    getDelegateInfo(): Promise<DelegateInfo>;
}
/** @deprecated alias for @see IDelegateManager */
type IDelegatorManager = IDelegateManager;
declare class DelegateManagerImpl implements IDelegateManager {
    readonly delegateProvider: DelegateProvider;
    readonly arkInfoProvider: Pick<ArkProvider, "getInfo">;
    readonly identity: Identity;
    /** Create a delegate manager from the configured provider, Arkade info source, and wallet identity. */
    constructor(delegateProvider: DelegateProvider, arkInfoProvider: Pick<ArkProvider, "getInfo">, identity: Identity);
    getDelegateInfo(): Promise<DelegateInfo>;
    delegate(vtxos: ContractVtxo[], destination: string, delegateAt?: Date): Promise<{
        delegated: Outpoint[];
        failed: {
            outpoints: Outpoint[];
            error: unknown;
        }[];
    }>;
}
/** @deprecated alias for @see DelegateManagerImpl */
declare const DelegatorManagerImpl: typeof DelegateManagerImpl;
type DelegatorManagerImpl = DelegateManagerImpl;

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
type WalletMode = "auto" | "static" | "hd" | DescriptorProvider;
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
interface BaseWalletConfig {
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
interface ReadonlyWalletConfig extends BaseWalletConfig {
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
interface WalletConfig extends ReadonlyWalletConfig {
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
}
/**
 * Repository implementations used to store wallet and contract state.
 *
 * @see BaseWalletConfig
 * @see WalletRepository
 * @see ContractRepository
 */
type StorageConfig = {
    /** Wallet-state repository implementation. */
    walletRepository: WalletRepository;
    /** Contract-state repository implementation. */
    contractRepository: ContractRepository;
};
/**
 * Provider class constructor interface for dependency injection.
 * Ensures provider classes follow the consistent constructor pattern.
 */
interface ProviderClass<T> {
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
interface WalletBalance {
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
interface SendBitcoinParams {
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
interface Asset {
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
interface Recipient {
    address: string;
    /**
     * BTC amount in satoshis.
     *
     * @defaultValue Dust amount (`330`).
     */
    amount?: number;
    /** Assets to send to the same recipient (`assetId` & `amount`) */
    assets?: Asset[];
    extensions?: Array<{
        type: number;
        payload: Uint8Array;
    }>;
}
/**
 * Known asset metadata fields.
 *
 * @remarks
 * Additional metadata keys are allowed through `AssetMetadata`.
 *
 * @see AssetMetadata
 */
type KnownMetadata = Partial<{
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
type AssetMetadata = KnownMetadata & Record<string, unknown>;
/**
 * Asset details returned by `IAssetManager.getAssetDetails`.
 *
 * @see IAssetManager.getAssetDetails
 * @see AssetMetadata
 */
type AssetDetails = {
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
interface IssuanceParams {
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
interface IssuanceResult {
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
interface ReissuanceParams {
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
interface BurnParams {
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
interface SettleParams {
    /** Offchain virtual outputs and/or onchain boarding inputs to settle. */
    inputs: ExtendedCoin[];
    /** Optional onchain outputs to create (i.e., exit to). */
    outputs: Output[];
}
/**
 * Onchain output status
 */
interface Status {
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
interface VirtualStatus {
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
interface Outpoint {
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
interface Coin extends Outpoint {
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
interface VirtualCoin extends Coin {
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
    /** ID of the onchain commitment transaction that settled this output, if applicable. */
    settledBy?: string;
    /** ID of the offchain checkpoint transaction that spent this output, if applicable. */
    spentBy?: string;
    /** ID of the offchain Arkade transaction that spent the above checkpoint output, if applicable. */
    arkTxId?: string;
    /** Virtual output status */
    virtualStatus: VirtualStatus;
    /** Assets carried by this virtual output, if any. */
    assets?: Asset[];
}
/** Wallet transaction direction. */
declare enum TxType {
    TxSent = "SENT",
    TxReceived = "RECEIVED"
}
/**
 * Composite key used to correlate a wallet transaction across layers.
 *
 * @see ArkTransaction
 */
interface TxKey {
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
interface ArkTransaction {
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
type TapLeaves = {
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
type ExtendedCoin = TapLeaves & EncodedVtxoScript & Coin & {
    extraWitness?: Bytes[];
};
/**
 * Virtual output data enriched with tapscript and witness data.
 *
 * @see VirtualCoin
 * @see TapLeaves
 */
type ExtendedVirtualCoin = TapLeaves & EncodedVtxoScript & VirtualCoin & {
    extraWitness?: Bytes[];
};
/**
 * Return whether a virtual output is still spendable.
 *
 * @param vtxo - virtual output to inspect
 * @returns `true` when the virtual output is not marked as spent
 *
 * @see isRecoverable
 * @see isExpired
 */
declare function isSpendable(vtxo: VirtualCoin): boolean;
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
declare function isRecoverable(vtxo: VirtualCoin): boolean;
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
declare function isExpired(vtxo: VirtualCoin): boolean;
/**
 * Return whether a virtual output is below the dust threshold.
 *
 * @param vtxo - virtual output to inspect
 * @param dust - dust threshold in satoshis
 * @returns `true` when the virtual output value is below `dust`
 *
 * @see isRecoverable
 */
declare function isSubdust(vtxo: VirtualCoin, dust: bigint): boolean;
/**
 * Filtering options for `IWallet.getVtxos`.
 *
 * @see IWallet.getVtxos
 */
type GetVtxosFilter = {
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
interface IReadonlyAssetManager {
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
interface IAssetManager extends IReadonlyAssetManager {
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
interface IWallet extends IReadonlyWallet {
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
    settle(params?: SettleParams, eventCallback?: (event: SettlementEvent) => void): Promise<string>;
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
interface IReadonlyWallet {
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

type PaginationOptions = {
    pageIndex?: number;
    pageSize?: number;
};
declare enum IndexerTxType {
    INDEXER_TX_TYPE_UNSPECIFIED = 0,
    INDEXER_TX_TYPE_RECEIVED = 1,
    INDEXER_TX_TYPE_SENT = 2
}
declare enum ChainTxType {
    UNSPECIFIED = "INDEXER_CHAINED_TX_TYPE_UNSPECIFIED",
    COMMITMENT = "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
    ARK = "INDEXER_CHAINED_TX_TYPE_ARK",
    TREE = "INDEXER_CHAINED_TX_TYPE_TREE",
    CHECKPOINT = "INDEXER_CHAINED_TX_TYPE_CHECKPOINT"
}
interface PageResponse {
    /** Current page index **/
    current: number;
    /** Next page index **/
    next: number;
    /** Total pages given the page-size used in the query **/
    total: number;
}
interface BatchInfo {
    totalOutputAmount: string;
    totalOutputVtxos: number;
    expiresAt: string;
    swept: boolean;
}
interface ChainTx {
    txid: string;
    expiresAt: string;
    type: ChainTxType;
    /** IDs of the transactions in the chain used as input of the current transaction. */
    spends: string[];
}
interface CommitmentTx {
    startedAt: string;
    endedAt: string;
    batches: {
        [key: string]: BatchInfo;
    };
    totalInputAmount: string;
    totalInputVtxos: number;
    totalOutputAmount: string;
    totalOutputVtxos: number;
}
interface Tx {
    txid: string;
    children: Record<number, string>;
}
interface TxHistoryRecord {
    commitmentTxid?: string;
    virtualTxid?: string;
    type: IndexerTxType;
    amount: string;
    createdAt: string;
    isSettled: boolean;
    settledBy: string;
}
interface VtxoAsset {
    assetId: string;
    amount: string;
}
interface Vtxo {
    outpoint: Outpoint;
    createdAt: string;
    expiresAt: string | null;
    amount: string;
    script: string;
    isPreconfirmed: boolean;
    isSwept: boolean;
    isUnrolled: boolean;
    isSpent: boolean;
    spentBy: string | null;
    commitmentTxids: string[];
    settledBy?: string;
    arkTxid?: string;
    assets?: VtxoAsset[];
}
interface VtxoChain {
    chain: ChainTx[];
    page?: PageResponse;
}
interface SubscriptionResponse {
    txid?: string;
    scripts: string[];
    newVtxos: VirtualCoin[];
    spentVtxos: VirtualCoin[];
    sweptVtxos: VirtualCoin[];
    tx?: string;
    checkpointTxs?: Record<string, {
        txid: string;
        tx: string;
    }>;
}
interface SubscriptionHeartbeat {
    type: "heartbeat";
}
interface SubscriptionEvent extends SubscriptionResponse {
    type: "event";
}
/**
 * Filters accepted by `IndexerProvider.getVtxos`.
 *
 * @remarks
 * Exactly one of `scripts` or `outpoints` must be supplied.
 *
 * @see IndexerProvider.getVtxos
 */
type GetVtxosOptions = PaginationOptions & {
    /** Only return spendable virtual outputs. */
    spendableOnly?: boolean;
    /** Only return spent virtual outputs. */
    spentOnly?: boolean;
    /** Only return recoverable virtual outputs. */
    recoverableOnly?: boolean;
    /** Only return pending/preconfirmed virtual outputs. */
    pendingOnly?: boolean;
    /** Only return virtual outputs created after this timestamp. */
    after?: number;
    /** Only return virtual outputs created before this timestamp. */
    before?: number;
} & ({
    /** Scripts to search for matching virtual outputs. */
    scripts: string[];
    outpoints?: never;
} | {
    /** Explicit outpoints to fetch. */
    outpoints: Outpoint[];
    scripts?: never;
});
interface IndexerProvider {
    /**
     * Fetch the virtual output tree for a batch outpoint.
     *
     * @param batchOutpoint - Batch outpoint whose tree should be fetched
     * @param opts - Optional pagination settings
     * @returns virtual output tree nodes and optional pagination state
     */
    getVtxoTree(batchOutpoint: Outpoint, opts?: PaginationOptions): Promise<{
        vtxoTree: Tx[];
        page?: PageResponse;
    }>;
    /**
     * Fetch the leaf outpoints for a batch virtual output tree.
     *
     * @param batchOutpoint - Batch outpoint whose leaf outpoints should be fetched
     * @param opts - Optional pagination settings
     * @returns Leaf outpoints and optional pagination state
     */
    getVtxoTreeLeaves(batchOutpoint: Outpoint, opts?: PaginationOptions): Promise<{
        leaves: Outpoint[];
        page?: PageResponse;
    }>;
    /**
     * Fetch sweep transactions that spent a batch.
     *
     * @param batchOutpoint - Batch outpoint to inspect
     * @returns Sweep transaction ids
     */
    getBatchSweepTransactions(batchOutpoint: Outpoint): Promise<{
        sweptBy: string[];
    }>;
    /**
     * Fetch a commitment transaction by txid.
     *
     * @param txid - Commitment transaction id
     * @returns Commitment transaction details
     */
    getCommitmentTx(txid: string): Promise<CommitmentTx>;
    /**
     * Fetch connector transactions for a commitment transaction.
     *
     * @param txid - Commitment transaction id
     * @param opts - Optional pagination settings
     * @returns Connector transactions and optional pagination state
     */
    getCommitmentTxConnectors(txid: string, opts?: PaginationOptions): Promise<{
        connectors: Tx[];
        page?: PageResponse;
    }>;
    /**
     * Fetch forfeit transaction ids for a commitment transaction.
     *
     * @param txid - Commitment transaction id
     * @param opts - Optional pagination settings
     * @returns Forfeit transaction ids and optional pagination state
     */
    getCommitmentTxForfeitTxs(txid: string, opts?: PaginationOptions): Promise<{
        txids: string[];
        page?: PageResponse;
    }>;
    /**
     * Open a streamed subscription for a previously created subscription id.
     *
     * @param subscriptionId - Subscription identifier returned by `subscribeForScripts`
     * @param abortSignal - Signal used to terminate the stream
     * @returns Async iterator of subscription responses
     */
    getSubscription(subscriptionId: string, abortSignal: AbortSignal): AsyncIterableIterator<SubscriptionResponse>;
    /**
     * Fetch raw virtual transactions by txid.
     *
     * @param txids - Virtual transaction ids to fetch
     * @param opts - Optional pagination settings
     * @returns Raw virtual transactions and optional pagination state
     */
    getVirtualTxs(txids: string[], opts?: PaginationOptions): Promise<{
        txs: string[];
        page?: PageResponse;
    }>;
    /**
     * Fetch the ancestry chain for a virtual output.
     *
     * @param vtxoOutpoint - Virtual output outpoint to inspect
     * @param opts - Optional pagination settings
     * @returns Chain data and optional pagination state
     */
    getVtxoChain(vtxoOutpoint: Outpoint, opts?: PaginationOptions): Promise<VtxoChain>;
    /**
     * Fetch virtual outputs by script set or outpoints.
     *
     * @param opts - Virtual output filters and pagination settings
     * @returns Virtual outputs and optional pagination state
     */
    getVtxos(opts?: GetVtxosOptions): Promise<{
        vtxos: VirtualCoin[];
        page?: PageResponse;
    }>;
    /**
     * Fetch metadata for a specific asset id.
     *
     * @param assetId - Asset identifier
     * @returns Asset details
     */
    getAssetDetails(assetId: string): Promise<AssetDetails>;
    /**
     * Create or extend a subscription for a set of scripts.
     *
     * @param scripts - Scripts to monitor
     * @param subscriptionId - Existing subscription id to extend
     * @returns Subscription id
     */
    subscribeForScripts(scripts: string[], subscriptionId?: string): Promise<string>;
    /**
     * Remove some or all scripts from an existing subscription.
     *
     * @param subscriptionId - Subscription identifier to update
     * @param scripts - Scripts to remove, or omit to remove all
     */
    unsubscribeForScripts(subscriptionId: string, scripts?: string[]): Promise<void>;
}
/**
 * REST-based indexer provider implementation.
 * @see https://buf.build/arkade-os/arkd/docs/main:ark.v1#ark.v1.IndexerService
 * @example
 * ```typescript
 * const provider = new RestIndexerProvider('https://arkade.computer');
 * const commitmentTx = await provider.getCommitmentTx("6686af8f3be3517880821f62e6c3d749b9d6713736a1d8e229a55daa659446b2");
 * ```
 */
declare class RestIndexerProvider implements IndexerProvider {
    serverUrl: string;
    constructor(serverUrl?: string);
    getVtxoTree(batchOutpoint: Outpoint, opts?: PaginationOptions): Promise<{
        vtxoTree: Tx[];
        page?: PageResponse;
    }>;
    getVtxoTreeLeaves(batchOutpoint: Outpoint, opts?: PaginationOptions): Promise<{
        leaves: Outpoint[];
        page?: PageResponse;
    }>;
    getBatchSweepTransactions(batchOutpoint: Outpoint): Promise<{
        sweptBy: string[];
    }>;
    getCommitmentTx(txid: string): Promise<CommitmentTx>;
    getCommitmentTxConnectors(txid: string, opts?: PaginationOptions): Promise<{
        connectors: Tx[];
        page?: PageResponse;
    }>;
    getCommitmentTxForfeitTxs(txid: string, opts?: PaginationOptions): Promise<{
        txids: string[];
        page?: PageResponse;
    }>;
    getSubscription(subscriptionId: string, abortSignal: AbortSignal): AsyncIterableIterator<SubscriptionResponse>;
    getVirtualTxs(txids: string[], opts?: PaginationOptions): Promise<{
        txs: string[];
        page?: PageResponse;
    }>;
    getVtxoChain(vtxoOutpoint: Outpoint, opts?: PaginationOptions): Promise<VtxoChain>;
    getVtxos(opts?: GetVtxosOptions): Promise<{
        vtxos: VirtualCoin[];
        page?: PageResponse;
    }>;
    getAssetDetails(assetId: string): Promise<AssetDetails>;
    subscribeForScripts(scripts: string[], subscriptionId?: string): Promise<string>;
    unsubscribeForScripts(subscriptionId: string, scripts?: string[]): Promise<void>;
}

/**
 * FeeAmount is a wrapper around a number that represents a fee amount in satoshis floating point.
 * @param value - The fee amount in floating point.
 * @example
 * const fee = new FeeAmount(1.23456789);
 * console.log(fee.value); // 1.23456789
 * console.log(fee.satoshis); // 2
 */
declare class FeeAmount {
    readonly value: number;
    static ZERO: FeeAmount;
    constructor(value: number);
    /** Returns the fee amount rounded up to whole satoshis. */
    get satoshis(): number;
    /** Add two fee amounts together. */
    add(other: FeeAmount): FeeAmount;
}
interface IntentFeeConfig {
    offchainInput?: string;
    onchainInput?: string;
    offchainOutput?: string;
    onchainOutput?: string;
}
type VtxoType = "recoverable" | "vtxo" | "note";
interface OffchainInput {
    amount: bigint;
    expiry?: Date;
    birth?: Date;
    type: VtxoType;
    weight: number;
}
interface OnchainInput {
    amount: bigint;
}
interface FeeOutput {
    amount: bigint;
    script: string;
}

/** Output requested during settlement or transaction submission. */
type Output = {
    /** Destination address, either onchain or Arkade (offchain). */
    address: string;
    /** Amount to send in satoshis. */
    amount: bigint;
};
declare enum SettlementEventType {
    BatchStarted = "batch_started",
    BatchFinalization = "batch_finalization",
    BatchFinalized = "batch_finalized",
    BatchFailed = "batch_failed",
    TreeSigningStarted = "tree_signing_started",
    TreeNonces = "tree_nonces",
    TreeTx = "tree_tx",
    TreeSignature = "tree_signature",
    StreamStarted = "stream_started"
}
type BatchFinalizationEvent = {
    type: SettlementEventType.BatchFinalization;
    id: string;
    commitmentTx: string;
};
type BatchFinalizedEvent = {
    type: SettlementEventType.BatchFinalized;
    id: string;
    commitmentTxid: string;
};
type BatchFailedEvent = {
    type: SettlementEventType.BatchFailed;
    id: string;
    reason: string;
};
type TreeSigningStartedEvent = {
    type: SettlementEventType.TreeSigningStarted;
    id: string;
    cosignersPublicKeys: string[];
    unsignedCommitmentTx: string;
};
type TreeNoncesEvent = {
    type: SettlementEventType.TreeNonces;
    id: string;
    topic: string[];
    txid: string;
    /** Musig2 public nonces keyed by cosigner public key. */
    nonces: TreeNonces;
};
type BatchStartedEvent = {
    type: SettlementEventType.BatchStarted;
    id: string;
    intentIdHashes: string[];
    batchExpiry: bigint;
};
type TreeTxEvent = {
    type: SettlementEventType.TreeTx;
    id: string;
    topic: string[];
    batchIndex: number;
    chunk: TxTreeNode;
};
type TreeSignatureEvent = {
    type: SettlementEventType.TreeSignature;
    id: string;
    topic: string[];
    batchIndex: number;
    txid: string;
    signature: string;
};
type StreamStartedEvent = {
    type: SettlementEventType.StreamStarted;
    id: string;
};
type SettlementEvent = BatchFinalizationEvent | BatchFinalizedEvent | BatchFailedEvent | TreeSigningStartedEvent | TreeNoncesEvent | BatchStartedEvent | TreeTxEvent | TreeSignatureEvent | StreamStartedEvent;
interface ScheduledSession {
    duration: bigint;
    fees: FeeInfo;
    nextEndTime: bigint;
    nextStartTime: bigint;
    period: bigint;
}
interface FeeInfo {
    intentFee: IntentFeeConfig;
    txFeeRate: string;
}
interface PendingTx {
    arkTxid: string;
    finalArkTx: string;
    signedCheckpointTxs: string[];
}
interface DeprecatedSigner {
    cutoffDate: bigint;
    pubkey: string;
}
type ServiceStatus = Record<string, string>;
interface ArkInfo {
    boardingExitDelay: bigint;
    checkpointTapscript: string;
    deprecatedSigners: DeprecatedSigner[];
    digest: string;
    dust: bigint;
    fees: FeeInfo;
    forfeitAddress: string;
    forfeitPubkey: string;
    network: string;
    scheduledSession?: ScheduledSession;
    serviceStatus: ServiceStatus;
    sessionDuration: bigint;
    signerPubkey: string;
    unilateralExitDelay: bigint;
    /**
     * Maximum boarding input amount.
     *
     * @remarks
     * `-1` means unlimited, while `0` disables boarding.
     */
    utxoMaxAmount: bigint;
    utxoMinAmount: bigint;
    version: string;
    /**
     * Maximum virtual output amount.
     *
     * @remarks
     * `-1` means unlimited.
     */
    vtxoMaxAmount: bigint;
    vtxoMinAmount: bigint;
}
/** Signed intent payload sent to the Arkade server. */
interface SignedIntent<T extends Intent.Message> {
    /** Base64-encoded signed proof transaction. */
    proof: string;
    /** Intent message payload associated with the proof. */
    message: T;
}
/** Transaction notification emitted by the Arkade server stream. */
interface TxNotification {
    /** Transaction id. */
    txid: string;
    /** Raw transaction payload. */
    tx: string;
    /** Virtual outputs spent by the transaction. */
    spentVtxos: Vtxo[];
    /** Virtual outputs made spendable by the transaction. */
    spendableVtxos: Vtxo[];
    /** Optional checkpoint transactions associated with the notification. */
    checkpointTxs?: Record<string, {
        txid: string;
        tx: string;
    }>;
}
interface ArkProvider {
    /** Fetch Arkade server configuration and fee settings. */
    getInfo(): Promise<ArkInfo>;
    /** Submit a signed Arkade transaction and its checkpoint transactions. */
    submitTx(signedArkTx: string, checkpointTxs: string[]): Promise<{
        arkTxid: string;
        finalArkTx: string;
        signedCheckpointTxs: string[];
    }>;
    /** Finalize a previously submitted Arkade transaction. */
    finalizeTx(arkTxid: string, finalCheckpointTxs: string[]): Promise<void>;
    /** Register a signed intent with the Arkade server. */
    registerIntent(intent: SignedIntent<Intent.RegisterMessage>): Promise<string>;
    /** Delete a previously registered intent. */
    deleteIntent(intent: SignedIntent<Intent.DeleteMessage>): Promise<void>;
    /** Confirm an already registered intent id. */
    confirmRegistration(intentId: string): Promise<void>;
    /** Submit musig2 tree nonces for a batch signing session. */
    submitTreeNonces(batchId: string, pubkey: string, nonces: TreeNonces): Promise<void>;
    /** Submit musig2 partial signatures for a batch signing session. */
    submitTreeSignatures(batchId: string, pubkey: string, signatures: TreePartialSigs): Promise<void>;
    /** Submit signed forfeit transactions for cooperative settlement. */
    submitSignedForfeitTxs(signedForfeitTxs: string[], signedCommitmentTx?: string): Promise<void>;
    /** Open the settlement event stream for the given topics. */
    getEventStream(signal: AbortSignal, topics: string[]): AsyncIterableIterator<SettlementEvent>;
    /** Stream transaction notifications emitted by the Arkade server. */
    getTransactionsStream(signal: AbortSignal): AsyncIterableIterator<{
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    }>;
    /** Fetch pending transactions for a signed get-pending-tx intent. */
    getPendingTxs(intent: SignedIntent<Intent.GetPendingTxMessage>): Promise<PendingTx[]>;
}
/**
 * REST-based Arkade provider implementation.
 *
 * @see https://buf.build/arkade-os/arkd/docs/main:ark.v1#ark.v1.ArkService
 * @example
 * ```typescript
 * const provider = new RestArkProvider('https://arkade.computer');
 * const info = await provider.getInfo();
 * ```
 */
declare class RestArkProvider implements ArkProvider {
    serverUrl: string;
    constructor(serverUrl?: string);
    getInfo(): Promise<ArkInfo>;
    submitTx(signedArkTx: string, checkpointTxs: string[]): Promise<{
        arkTxid: string;
        finalArkTx: string;
        signedCheckpointTxs: string[];
    }>;
    finalizeTx(arkTxid: string, finalCheckpointTxs: string[]): Promise<void>;
    registerIntent(intent: SignedIntent<Intent.RegisterMessage>): Promise<string>;
    deleteIntent(intent: SignedIntent<Intent.DeleteMessage>): Promise<void>;
    confirmRegistration(intentId: string): Promise<void>;
    submitTreeNonces(batchId: string, pubkey: string, nonces: TreeNonces): Promise<void>;
    submitTreeSignatures(batchId: string, pubkey: string, signatures: TreePartialSigs): Promise<void>;
    submitSignedForfeitTxs(signedForfeitTxs: string[], signedCommitmentTx?: string): Promise<void>;
    getEventStream(signal: AbortSignal, topics: string[]): AsyncIterableIterator<SettlementEvent>;
    getTransactionsStream(signal: AbortSignal): AsyncIterableIterator<{
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    }>;
    getPendingTxs(intent: SignedIntent<Intent.GetPendingTxMessage>): Promise<PendingTx[]>;
    protected parseSettlementEvent(data: ProtoTypes.GetEventStreamResponse): SettlementEvent | null;
    protected parseTransactionNotification(data: ProtoTypes.GetTransactionsStreamResponse): {
        commitmentTx?: TxNotification;
        arkTx?: TxNotification;
    } | null;
}
declare namespace ProtoTypes {
    interface BatchStartedEvent {
        id: string;
        intentIdHashes: string[];
        batchExpiry: number;
    }
    interface BatchFailed {
        id: string;
        reason: string;
    }
    export interface BatchFinalizationEvent {
        id: string;
        commitmentTx: string;
    }
    interface BatchFinalizedEvent {
        id: string;
        commitmentTxid: string;
    }
    interface TreeSigningStartedEvent {
        id: string;
        cosignersPubkeys: string[];
        unsignedCommitmentTx: string;
    }
    interface TreeNoncesAggregatedEvent {
        id: string;
        treeNonces: Record<string, string>;
    }
    interface TreeNoncesEvent {
        id: string;
        topic: string[];
        txid: string;
        nonces: Record<string, string>;
    }
    interface TreeTxEvent {
        id: string;
        topic: string[];
        batchIndex: number;
        txid: string;
        tx: string;
        children: Record<string, string>;
    }
    interface TreeSignatureEvent {
        id: string;
        topic: string[];
        batchIndex: number;
        txid: string;
        signature: string;
    }
    interface StreamStartedEvent {
        id: string;
    }
    interface Heartbeat {
    }
    export interface VtxoData {
        outpoint: {
            txid: string;
            vout: number;
        };
        amount: string;
        script: string;
        createdAt: string;
        expiresAt: string | null;
        commitmentTxids: string[];
        isPreconfirmed: boolean;
        isSwept: boolean;
        isUnrolled: boolean;
        isSpent: boolean;
        spentBy: string;
        settledBy?: string;
        arkTxid?: string;
    }
    export interface GetEventStreamResponse {
        batchStarted?: BatchStartedEvent;
        batchFailed?: BatchFailed;
        batchFinalization?: BatchFinalizationEvent;
        batchFinalized?: BatchFinalizedEvent;
        treeSigningStarted?: TreeSigningStartedEvent;
        treeNoncesAggregated?: TreeNoncesAggregatedEvent;
        treeNonces?: TreeNoncesEvent;
        treeTx?: TreeTxEvent;
        treeSignature?: TreeSignatureEvent;
        streamStarted?: StreamStartedEvent;
        heartbeat?: Heartbeat;
    }
    export interface GetTransactionsStreamResponse {
        commitmentTx?: {
            txid: string;
            tx: string;
            spentVtxos: VtxoData[];
            spendableVtxos: VtxoData[];
            checkpointTxs?: Record<string, {
                txid: string;
                tx: string;
            }>;
        };
        arkTx?: {
            txid: string;
            tx: string;
            spentVtxos: VtxoData[];
            spendableVtxos: VtxoData[];
            checkpointTxs?: Record<string, {
                txid: string;
                tx: string;
            }>;
        };
        heartbeat?: Heartbeat;
    }
    export interface EventData {
        batchStarted?: BatchStartedEvent;
        batchFailed?: BatchFailed;
        batchFinalization?: BatchFinalizationEvent;
        batchFinalized?: BatchFinalizedEvent;
        treeSigningStarted?: TreeSigningStartedEvent;
        treeNoncesAggregated?: TreeNoncesAggregatedEvent;
        treeTx?: TreeTxEvent;
        treeSignature?: TreeSignatureEvent;
    }
    export interface TransactionData {
        commitmentTx?: {
            txid: string;
            tx: string;
            spentVtxos: VtxoData[];
            spendableVtxos: VtxoData[];
            checkpointTxs?: Record<string, {
                txid: string;
                tx: string;
            }>;
        };
        arkTx?: {
            txid: string;
            tx: string;
            spentVtxos: VtxoData[];
            spendableVtxos: VtxoData[];
            checkpointTxs?: Record<string, {
                txid: string;
                tx: string;
            }>;
        };
    }
    export {  };
}

export { CSVMultisigTapscript as $, type ArkTransaction as A, type BatchStartedEvent as B, type ContractRepository as C, type BatchFailedEvent as D, type ExtendedVirtualCoin as E, type TreeTxEvent as F, type GetVtxosFilter as G, type TreeSignatureEvent as H, type IWallet as I, type DescriptorProvider as J, type IReadonlyWallet as K, type ReadonlyIdentity as L, type DelegateProvider as M, type Network as N, type OnchainProvider as O, type ReadonlyWalletConfig as P, type IReadonlyAssetManager as Q, type Recipient as R, type SendBitcoinParams as S, type TxNotification as T, type NetworkName as U, VtxoScript as V, type WalletRepository as W, type ArkInfo as X, ArkAddress as Y, type Coin as Z, ContractManager as _, type Identity as a, type ExtendedContractVtxo as a$, type SettlementConfig as a0, VtxoManager as a1, type SignerSession as a2, type SignedIntent as a3, Intent as a4, type DescriptorSigningRequest as a5, Transaction as a6, type IntentFeeConfig as a7, type OffchainInput as a8, FeeAmount as a9, type Outpoint as aA, type ChainTx as aB, type AssetMetadata as aC, type BaseWalletConfig as aD, type BatchInfo as aE, type BatchSignableIdentity as aF, CLTVMultisigTapscript as aG, ChainTxType as aH, type CommitmentTx as aI, ConditionCSVMultisigTapscript as aJ, ConditionMultisigTapscript as aK, type ContractBalance as aL, type ContractEventCallback as aM, type ContractHandler as aN, type ContractManagerConfig as aO, type ContractState as aP, type ContractVtxo as aQ, ContractWatcher as aR, DelegateManagerImpl as aS, type DelegateOptions as aT, DelegatorManagerImpl as aU, type DelegatorProvider as aV, type Discoverable as aW, type DiscoveredContract as aX, type DiscoveryDeps as aY, ESPLORA_URL as aZ, EsploraProvider as a_, type OnchainInput as aa, type FeeOutput as ab, type ContractWatcherConfig as ac, type Asset as ad, type FeeInfo as ae, type CreateContractParams as af, type GetContractsFilter as ag, type GetSpendablePathsOptions as ah, type GetAllSpendingPathsOptions as ai, type IssuanceParams as aj, type ReissuanceParams as ak, type BurnParams as al, type RenewVtxosOptions as am, type ContractWithVtxos as an, type PathSelection as ao, type ContractEvent as ap, type AssetDetails as aq, type IssuanceResult as ar, type DelegateInfo as as, type StorageConfig as at, type IVtxoManager as au, type ExplorerTransaction as av, type EncodedVtxoScript as aw, type Status as ax, type ArkTapscript as ay, TapscriptType as az, type WalletConfig as b, type HandlerError as b0, type IDelegatorManager as b1, IndexerTxType as b2, type KnownMetadata as b3, MultisigTapscript as b4, type Nonces as b5, type Output as b6, type PageResponse as b7, type PaginationOptions as b8, PartialSig as b9, getSequence as bA, isBatchSignable as bB, isDiscoverable as bC, isExpired as bD, isRecoverable as bE, isSpendable as bF, isSubdust as bG, isVtxoExpiringSoon as bH, networks as bI, type PathContext as ba, type ProviderClass as bb, RestDelegateProvider as bc, RestDelegatorProvider as bd, type ScanContractsOptions as be, type ScanResult as bf, type ScheduledSession as bg, SettlementEventType as bh, type SignRequest as bi, type SubscriptionEvent as bj, type SubscriptionHeartbeat as bk, type TapLeaves as bl, TapTreeCoder as bm, type TreeNonces as bn, type TreePartialSigs as bo, type Tx as bp, type TxHistoryRecord as bq, type TxKey as br, type TxTreeNode as bs, TxType as bt, type VirtualStatus as bu, type Vtxo as bv, type VtxoChain as bw, type VtxoType as bx, type WalletMode as by, decodeTapscript as bz, type WalletBalance as c, type ExtendedCoin as d, type IContractManager as e, type IDelegateManager as f, type SettleParams as g, type SettlementEvent as h, type IAssetManager as i, RestArkProvider as j, RestIndexerProvider as k, type SubscriptionResponse as l, type ArkProvider as m, type IndexerProvider as n, type RelativeTimelock as o, type TapLeafScript as p, type VirtualCoin as q, type Contract as r, type VtxoRepositoryKey as s, type WalletState as t, type ContractFilter as u, type TreeSigningStartedEvent as v, TxTree as w, type TreeNoncesEvent as x, type BatchFinalizationEvent as y, type BatchFinalizedEvent as z };
