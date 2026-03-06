import { validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";
import { SigHash } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { Identity, ReadonlyIdentity } from ".";
import { Transaction } from "../utils/transaction";
import { SignerSession, TreeSignerSession } from "../tree/signingSession";
import { schnorr, signAsync } from "@noble/secp256k1";
import {
    defaultFactory,
    scureBIP32 as BIP32,
    networks,
    scriptExpressions,
} from "@kukks/bitcoin-descriptors";
import type { Network } from "@kukks/bitcoin-descriptors";

const { expand } = defaultFactory;

const ALL_SIGHASH = Object.values(SigHash).filter((x) => typeof x === "number");

/** Use default BIP86 derivation with network selection. */
export interface NetworkOptions {
    /** Mainnet (coin type 0) or testnet (coin type 1). */
    isMainnet: boolean;
}

/** Use a custom output descriptor for derivation. */
export interface DescriptorOptions {
    /** Custom output descriptor that determines the derivation path. */
    descriptor: string;
}

/** Either default BIP86 derivation (with optional network) or a custom descriptor. */
export type SeedIdentityOptions = NetworkOptions | DescriptorOptions;

export type MnemonicOptions = SeedIdentityOptions & {
    /** Optional BIP39 passphrase for additional seed entropy. */
    passphrase?: string;
};

/**
 * A signing request pairs a transaction with optional input indexes to sign.
 */
export interface SigningRequest {
    tx: Transaction;
    inputIndexes?: number[];
}

/**
 * JSON representation of a SeedIdentity for serialization.
 */
export interface SeedIdentityJSON {
    mnemonic?: string;
    seed?: string;
    descriptor: string;
}

/**
 * Detects the network from a descriptor string by checking for tpub (testnet)
 * vs xpub (mainnet) key prefix.
 * @internal
 */
function detectNetwork(descriptor: string): Network {
    return descriptor.includes("tpub") ? networks.testnet : networks.bitcoin;
}

function hasDescriptor(opts: SeedIdentityOptions): opts is DescriptorOptions {
    return "descriptor" in opts && typeof opts.descriptor === "string";
}

/**
 * Builds a BIP86 Taproot output descriptor from a seed and network flag.
 * @internal
 */
function buildDescriptor(seed: Uint8Array, isMainnet: boolean): string {
    const network = isMainnet ? networks.bitcoin : networks.testnet;
    const masterNode = BIP32.fromSeed(seed, network);
    return scriptExpressions.trBIP32({
        masterNode,
        network,
        account: 0,
        change: 0,
        index: 0,
    });
}

/**
 * Builds a BIP86 Taproot wildcard descriptor template from a seed and network flag.
 * Uses `*` as the index for ranged descriptors.
 * @internal
 */
function buildWildcardDescriptor(seed: Uint8Array, isMainnet: boolean): string {
    const network = isMainnet ? networks.bitcoin : networks.testnet;
    const masterNode = BIP32.fromSeed(seed, network);
    return scriptExpressions.trBIP32({
        masterNode,
        network,
        account: 0,
        change: 0,
        index: "*",
    });
}

/**
 * Seed-based identity derived from a raw seed and an output descriptor.
 *
 * This is the recommended identity type for most applications. It uses
 * standard BIP86 (Taproot) derivation by default and stores an output
 * descriptor for interoperability with other wallets. The descriptor
 * format is HD-ready, allowing future support for multiple addresses
 * and change derivation.
 *
 * Prefer this (or {@link MnemonicIdentity}) over `SingleKey` for new
 * integrations — `SingleKey` exists for backward compatibility with
 * raw nsec-style keys.
 *
 * @example
 * ```typescript
 * const seed = mnemonicToSeedSync(mnemonic);
 *
 * // Testnet (BIP86 path m/86'/1'/0'/0/0)
 * const identity = SeedIdentity.fromSeed(seed, { isMainnet: false });
 *
 * // Mainnet (BIP86 path m/86'/0'/0'/0/0)
 * const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
 *
 * // Custom descriptor
 * const identity = SeedIdentity.fromSeed(seed, { descriptor });
 * ```
 */
export class SeedIdentity implements Identity {
    protected readonly seed: Uint8Array;
    private readonly derivedKey: Uint8Array;
    readonly descriptor: string;
    /** The mnemonic phrase, if this identity was created from one. */
    readonly mnemonic?: string;
    /** Whether this identity uses mainnet (true) or testnet (false). */
    readonly isMainnet: boolean;

    constructor(seed: Uint8Array, descriptor: string, mnemonic?: string) {
        if (seed.length !== 64) {
            throw new Error("Seed must be 64 bytes");
        }

        this.seed = seed;
        this.descriptor = descriptor;
        this.mnemonic = mnemonic;

        const network = detectNetwork(descriptor);
        this.isMainnet = network === networks.bitcoin;

        // Parse and validate the descriptor using the library
        const expansion = expand({ descriptor, network });
        const keyInfo = expansion.expansionMap?.["@0"];

        if (!keyInfo?.originPath) {
            throw new Error("Descriptor must include a key origin path");
        }

        // Verify the xpub in the descriptor matches our seed
        const masterNode = BIP32.fromSeed(seed, network);
        const accountNode = masterNode.derivePath(`m${keyInfo.originPath}`);
        if (accountNode.neutered().toBase58() !== keyInfo.bip32?.toBase58()) {
            throw new Error(
                "xpub mismatch: derived key does not match descriptor"
            );
        }

        // Derive the private key using the full path from the descriptor
        if (!keyInfo.path) {
            throw new Error("Descriptor must specify a full derivation path");
        }
        const derivedNode = masterNode.derivePath(keyInfo.path);
        if (!derivedNode.privateKey) {
            throw new Error("Failed to derive private key");
        }
        this.derivedKey = derivedNode.privateKey;
    }

    /**
     * Creates a SeedIdentity from a raw 64-byte seed.
     *
     * Pass `{ isMainnet }` for default BIP86 derivation, or
     * `{ descriptor }` for a custom derivation path.
     *
     * @param seed - 64-byte seed (typically from mnemonicToSeedSync)
     * @param opts - Network selection or custom descriptor.
     */
    static fromSeed(seed: Uint8Array, opts: SeedIdentityOptions): SeedIdentity {
        const descriptor = hasDescriptor(opts)
            ? opts.descriptor
            : buildDescriptor(seed, (opts as NetworkOptions).isMainnet);
        return new SeedIdentity(seed, descriptor);
    }

    /**
     * Creates a SeedIdentity from a BIP39 mnemonic phrase.
     *
     * Convenience static that stores the mnemonic for later serialization.
     *
     * @param phrase - BIP39 mnemonic phrase (12 or 24 words)
     * @param opts - Network selection or custom descriptor, plus optional passphrase
     */
    static fromMnemonic(phrase: string, opts: MnemonicOptions): SeedIdentity {
        if (!validateMnemonic(phrase, wordlist)) {
            throw new Error("Invalid mnemonic");
        }
        const passphrase = opts.passphrase;
        const seed = mnemonicToSeedSync(phrase, passphrase);
        const descriptor = hasDescriptor(opts)
            ? opts.descriptor
            : buildDescriptor(seed, (opts as NetworkOptions).isMainnet);
        return new SeedIdentity(seed, descriptor, phrase);
    }

    /**
     * Restores a SeedIdentity from a JSON object.
     *
     * The JSON must contain either `mnemonic` or `seed` (hex), plus a `descriptor`.
     * When the descriptor uses a wildcard (`*`), it is resolved to index 0 for the
     * identity's default key.
     *
     * @param json - Serialized identity containing `{mnemonic?, seed?, descriptor}`
     */
    static fromJSON(json: SeedIdentityJSON): SeedIdentity {
        if (!json.descriptor) {
            throw new Error("Missing descriptor in JSON");
        }

        let seed: Uint8Array;
        let mnemonic: string | undefined;

        if (json.mnemonic) {
            if (!validateMnemonic(json.mnemonic, wordlist)) {
                throw new Error("Invalid mnemonic");
            }
            mnemonic = json.mnemonic;
            seed = mnemonicToSeedSync(json.mnemonic);
        } else if (json.seed) {
            seed = hex.decode(json.seed);
        } else {
            throw new Error("JSON must contain either mnemonic or seed");
        }

        // If descriptor has wildcard, resolve to index 0
        let descriptor = json.descriptor;
        if (descriptor.includes("*")) {
            const network = detectNetwork(descriptor);
            // Expand with index 0 to get a concrete descriptor
            const expansion = expand({ descriptor, network, index: 0 });
            descriptor = expansion.canonicalExpression;
        }

        return new SeedIdentity(seed, descriptor, mnemonic);
    }

    /**
     * Serializes this identity to a JSON object.
     *
     * The descriptor is stored as a wildcard template (e.g. `.../0/*`)
     * so it can be used to derive any child index on restore.
     *
     * @returns JSON containing `{mnemonic?, seed?, descriptor}`
     */
    toJSON(): SeedIdentityJSON {
        const network = detectNetwork(this.descriptor);
        const masterNode = BIP32.fromSeed(this.seed, network);
        const templateDescriptor = scriptExpressions.trBIP32({
            masterNode,
            network,
            account: 0,
            change: 0,
            index: "*",
        });

        const result: SeedIdentityJSON = {
            descriptor: templateDescriptor,
        };

        if (this.mnemonic) {
            result.mnemonic = this.mnemonic;
        } else {
            result.seed = hex.encode(this.seed);
        }

        return result;
    }

    /**
     * Derives a concrete signing descriptor at the given child index.
     *
     * For example, `deriveSigningDescriptor(5)` produces a descriptor like:
     * `tr([fp/86'/coinType'/0']xpub.../0/5)`
     *
     * @param index - Non-negative child index
     * @returns A concrete taproot descriptor for the given index
     */
    deriveSigningDescriptor(index: number): string {
        if (index < 0) {
            throw new Error("Index must be non-negative");
        }
        const network = detectNetwork(this.descriptor);
        const masterNode = BIP32.fromSeed(this.seed, network);
        return scriptExpressions.trBIP32({
            masterNode,
            network,
            account: 0,
            change: 0,
            index,
        });
    }

    /**
     * Checks whether a given descriptor belongs to this identity by comparing
     * the account-level xpub.
     *
     * @param descriptor - The descriptor to check
     * @returns `true` if the descriptor was derived from the same HD account
     */
    isOurs(descriptor: string): boolean {
        try {
            const network = detectNetwork(descriptor);
            const expansion = expand({ descriptor, network });
            const keyInfo = expansion.expansionMap?.["@0"];
            if (!keyInfo?.bip32) return false;

            // Compare with our own account xpub
            const ownNetwork = detectNetwork(this.descriptor);
            const ownExpansion = expand({
                descriptor: this.descriptor,
                network: ownNetwork,
            });
            const ownKeyInfo = ownExpansion.expansionMap?.["@0"];
            return keyInfo.bip32.toBase58() === ownKeyInfo?.bip32?.toBase58();
        } catch {
            return false;
        }
    }

    /**
     * Signs one or more transactions using the private key derived at the
     * index embedded in the given descriptor.
     *
     * @param descriptor - A concrete descriptor belonging to this identity
     * @param requests - Array of signing requests
     * @returns Array of signed transactions
     * @throws If the descriptor does not belong to this identity
     */
    async signWithDescriptor(
        descriptor: string,
        requests: SigningRequest[]
    ): Promise<Transaction[]> {
        if (!this.isOurs(descriptor)) {
            throw new Error("Descriptor does not belong to this identity");
        }

        if (requests.length === 0) {
            return [];
        }

        const privateKey = this.derivePrivateKeyFromDescriptor(descriptor);
        const results: Transaction[] = [];

        for (const request of requests) {
            const txCpy = request.tx.clone();

            if (!request.inputIndexes) {
                try {
                    if (!txCpy.sign(privateKey, ALL_SIGHASH)) {
                        throw new Error("Failed to sign transaction");
                    }
                } catch (e) {
                    if (
                        e instanceof Error &&
                        e.message.includes("No inputs signed")
                    ) {
                        // ignore
                    } else {
                        throw e;
                    }
                }
                results.push(txCpy);
            } else {
                for (const inputIndex of request.inputIndexes) {
                    if (!txCpy.signIdx(privateKey, inputIndex, ALL_SIGHASH)) {
                        throw new Error(`Failed to sign input #${inputIndex}`);
                    }
                }
                results.push(txCpy);
            }
        }

        return results;
    }

    /**
     * Signs a message using the private key derived at the index embedded
     * in the given descriptor.
     *
     * @param descriptor - A concrete descriptor belonging to this identity
     * @param message - The message bytes to sign
     * @param signatureType - "schnorr" or "ecdsa" (default: "schnorr")
     * @returns The signature bytes
     * @throws If the descriptor does not belong to this identity
     */
    async signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr"
    ): Promise<Uint8Array> {
        if (!this.isOurs(descriptor)) {
            throw new Error("Descriptor does not belong to this identity");
        }

        const privateKey = this.derivePrivateKeyFromDescriptor(descriptor);

        if (signatureType === "ecdsa") {
            return signAsync(message, privateKey, { prehash: false });
        }
        return schnorr.signAsync(message, privateKey);
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        return pubSchnorr(this.derivedKey);
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        return pubECDSA(this.derivedKey, true);
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        const txCpy = tx.clone();

        if (!inputIndexes) {
            try {
                if (!txCpy.sign(this.derivedKey, ALL_SIGHASH)) {
                    throw new Error("Failed to sign transaction");
                }
            } catch (e) {
                if (
                    e instanceof Error &&
                    e.message.includes("No inputs signed")
                ) {
                    // ignore
                } else {
                    throw e;
                }
            }
            return txCpy;
        }

        for (const inputIndex of inputIndexes) {
            if (!txCpy.signIdx(this.derivedKey, inputIndex, ALL_SIGHASH)) {
                throw new Error(`Failed to sign input #${inputIndex}`);
            }
        }

        return txCpy;
    }

    async signMessage(
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr"
    ): Promise<Uint8Array> {
        if (signatureType === "ecdsa") {
            return signAsync(message, this.derivedKey, { prehash: false });
        }
        return schnorr.signAsync(message, this.derivedKey);
    }

    signerSession(): SignerSession {
        return TreeSignerSession.random();
    }

    /**
     * Converts to a watch-only identity that cannot sign.
     */
    async toReadonly(): Promise<ReadonlySeedIdentity> {
        return ReadonlySeedIdentity.fromDescriptor(this.descriptor);
    }

    /**
     * Derives a private key from a concrete descriptor by extracting its
     * derivation index and computing the child key from the seed.
     * @internal
     */
    private derivePrivateKeyFromDescriptor(descriptor: string): Uint8Array {
        const network = detectNetwork(descriptor);
        const masterNode = BIP32.fromSeed(this.seed, network);
        const expansion = expand({ descriptor, network });
        const keyInfo = expansion.expansionMap?.["@0"];
        if (!keyInfo?.originPath) {
            throw new Error("Invalid descriptor: missing origin path");
        }
        const accountNode = masterNode.derivePath(`m${keyInfo.originPath}`);
        // keyPath is like "/0/5", extract the index
        const keyPath = keyInfo.keyPath;
        if (!keyPath) {
            throw new Error("Invalid descriptor: missing key path");
        }
        const segments = keyPath.split("/").filter(Boolean);
        const childIndex = segments[segments.length - 1];
        const addressNode = accountNode.derivePath(`m/0/${childIndex}`);
        if (!addressNode.privateKey) {
            throw new Error("Failed to derive private key");
        }
        return addressNode.privateKey;
    }
}

/**
 * Mnemonic-based identity derived from a BIP39 phrase.
 *
 * This is the most user-friendly identity type — recommended for wallet
 * applications where users manage their own backup phrase. Extends
 * {@link SeedIdentity} with mnemonic validation and optional passphrase
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
export class MnemonicIdentity extends SeedIdentity {
    private constructor(seed: Uint8Array, descriptor: string) {
        super(seed, descriptor);
    }

    /**
     * Creates a MnemonicIdentity from a BIP39 mnemonic phrase.
     *
     * Pass `{ isMainnet }` for default BIP86 derivation, or
     * `{ descriptor }` for a custom derivation path.
     *
     * @param phrase - BIP39 mnemonic phrase (12 or 24 words)
     * @param opts - Network selection or custom descriptor, plus optional passphrase
     */
    static fromMnemonic(
        phrase: string,
        opts: MnemonicOptions
    ): MnemonicIdentity {
        if (!validateMnemonic(phrase, wordlist)) {
            throw new Error("Invalid mnemonic");
        }
        const passphrase = opts.passphrase;
        const seed = mnemonicToSeedSync(phrase, passphrase);
        const descriptor = hasDescriptor(opts)
            ? opts.descriptor
            : buildDescriptor(seed, (opts as NetworkOptions).isMainnet);
        return new MnemonicIdentity(seed, descriptor);
    }
}

/**
 * Watch-only identity from an output descriptor.
 *
 * Can derive public keys but cannot sign transactions. Use this for
 * watch-only wallets or when sharing identity information without
 * exposing private keys.
 *
 * Supports HD wallet methods for deriving public keys at arbitrary
 * child indexes and checking descriptor ownership.
 *
 * @example
 * ```typescript
 * const descriptor = "tr([fingerprint/86'/0'/0']xpub.../0/0)";
 * const readonly = ReadonlySeedIdentity.fromDescriptor(descriptor);
 * const pubKey = await readonly.xOnlyPublicKey();
 * ```
 */
export class ReadonlySeedIdentity implements ReadonlyIdentity {
    private readonly xOnlyPubKey: Uint8Array;
    private readonly compressedPubKey: Uint8Array;
    /** The account-level BIP32 node extracted from the descriptor. */
    private readonly accountBip32:
        | ReturnType<typeof BIP32.fromSeed>
        | undefined;

    private constructor(readonly descriptor: string) {
        const network = detectNetwork(descriptor);
        const expansion = expand({ descriptor, network });
        const keyInfo = expansion.expansionMap?.["@0"];

        if (!keyInfo?.pubkey) {
            throw new Error("Failed to derive public key from descriptor");
        }

        // For taproot, the library returns 32-byte x-only pubkey
        this.xOnlyPubKey = keyInfo.pubkey;

        // Get 33-byte compressed key with correct parity from the bip32 node
        if (keyInfo.bip32 && keyInfo.keyPath) {
            // Strip leading "/" — the library's derivePath prepends "m/" itself
            const relPath = keyInfo.keyPath.replace(/^\//, "");
            this.compressedPubKey = keyInfo.bip32.derivePath(relPath).publicKey;
        } else if (keyInfo.bip32) {
            this.compressedPubKey = keyInfo.bip32.publicKey;
        } else {
            throw new Error(
                "Cannot determine compressed public key parity from descriptor"
            );
        }

        // Store the account-level bip32 node for HD methods
        this.accountBip32 = keyInfo.bip32;
    }

    /**
     * Creates a ReadonlySeedIdentity from an output descriptor.
     *
     * @param descriptor - Taproot descriptor: tr([fingerprint/path']xpub.../child/path)
     */
    static fromDescriptor(descriptor: string): ReadonlySeedIdentity {
        return new ReadonlySeedIdentity(descriptor);
    }

    /**
     * Restores a ReadonlySeedIdentity from a JSON object.
     *
     * @param json - Object containing `{descriptor}`
     */
    static fromJSON(json: { descriptor: string }): ReadonlySeedIdentity {
        if (!json.descriptor) {
            throw new Error("Missing descriptor in JSON");
        }
        // If descriptor has wildcard, resolve to index 0
        let descriptor = json.descriptor;
        if (descriptor.includes("*")) {
            const network = detectNetwork(descriptor);
            const expansion = expand({ descriptor, network, index: 0 });
            descriptor = expansion.canonicalExpression;
        }
        return new ReadonlySeedIdentity(descriptor);
    }

    /**
     * Serializes this identity to a JSON object.
     *
     * The descriptor is stored as a wildcard template (e.g. `.../0/*`)
     * when possible, so it can derive any child index on restore.
     *
     * @returns JSON containing `{descriptor}`
     */
    toJSON(): { descriptor: string } {
        // Build a wildcard descriptor from the account bip32 node
        if (this.accountBip32) {
            const network = detectNetwork(this.descriptor);
            // Extract the origin path and fingerprint from the descriptor
            const expansion = expand({ descriptor: this.descriptor, network });
            const keyInfo = expansion.expansionMap?.["@0"];
            if (keyInfo?.originPath) {
                // Build wildcard from the xpub base58 and origin info
                const masterFp = keyInfo.masterFingerprint
                    ? hex.encode(keyInfo.masterFingerprint)
                    : "00000000";
                const xpub = keyInfo.bip32!.toBase58();
                return {
                    descriptor: `tr([${masterFp}${keyInfo.originPath}]${xpub}/0/*)`,
                };
            }
        }
        return { descriptor: this.descriptor };
    }

    /**
     * Derives a concrete signing descriptor at the given child index.
     *
     * @param index - Non-negative child index
     * @returns A concrete taproot descriptor for the given index
     */
    deriveSigningDescriptor(index: number): string {
        if (index < 0) {
            throw new Error("Index must be non-negative");
        }
        if (!this.accountBip32) {
            throw new Error("No BIP32 account node available");
        }
        const network = detectNetwork(this.descriptor);
        const expansion = expand({ descriptor: this.descriptor, network });
        const keyInfo = expansion.expansionMap?.["@0"];
        if (!keyInfo?.masterFingerprint || !keyInfo?.originPath) {
            throw new Error("Descriptor missing origin information");
        }
        const masterFp = hex.encode(keyInfo.masterFingerprint);
        const xpub = keyInfo.bip32!.toBase58();
        return `tr([${masterFp}${keyInfo.originPath}]${xpub}/0/${index})`;
    }

    /**
     * Checks whether a given descriptor belongs to this identity by comparing
     * the account-level xpub.
     *
     * @param descriptor - The descriptor to check
     * @returns `true` if the descriptor was derived from the same HD account
     */
    isOurs(descriptor: string): boolean {
        try {
            const network = detectNetwork(descriptor);
            const expansion = expand({ descriptor, network });
            const keyInfo = expansion.expansionMap?.["@0"];
            if (!keyInfo?.bip32) return false;

            // Compare with our own account xpub
            const ownNetwork = detectNetwork(this.descriptor);
            const ownExpansion = expand({
                descriptor: this.descriptor,
                network: ownNetwork,
            });
            const ownKeyInfo = ownExpansion.expansionMap?.["@0"];
            return keyInfo.bip32.toBase58() === ownKeyInfo?.bip32?.toBase58();
        } catch {
            return false;
        }
    }

    /**
     * Returns the x-only (Schnorr) public key at the given child index.
     *
     * @param index - Non-negative child index
     */
    async xOnlyPublicKeyAtIndex(index: number): Promise<Uint8Array> {
        if (index < 0) {
            throw new Error("Index must be non-negative");
        }
        const desc = this.deriveSigningDescriptor(index);
        const network = detectNetwork(desc);
        const expansion = expand({ descriptor: desc, network });
        const keyInfo = expansion.expansionMap?.["@0"];
        if (!keyInfo?.pubkey) {
            throw new Error("Failed to derive public key at index");
        }
        return keyInfo.pubkey;
    }

    /**
     * Returns the 33-byte compressed public key at the given child index.
     *
     * @param index - Non-negative child index
     */
    async compressedPublicKeyAtIndex(index: number): Promise<Uint8Array> {
        if (index < 0) {
            throw new Error("Index must be non-negative");
        }
        if (!this.accountBip32) {
            throw new Error("No BIP32 account node available");
        }
        const childNode = this.accountBip32.derivePath(`0/${index}`);
        return childNode.publicKey;
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        return this.xOnlyPubKey;
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        return this.compressedPubKey;
    }
}

/** @deprecated Use {@link ReadonlySeedIdentity} instead. */
export { ReadonlySeedIdentity as ReadonlyDescriptorIdentity };
