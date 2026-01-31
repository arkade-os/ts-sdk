import { HDKey } from "@scure/bip32";
import { validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { hex } from "@scure/base";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";
import { SigHash } from "@scure/btc-signer";
import { Identity, ReadonlyIdentity } from ".";
import { Transaction } from "../utils/transaction";
import { SignerSession, TreeSignerSession } from "../tree/signingSession";
import { schnorr, signAsync } from "@noble/secp256k1";

/**
 * A signing request for a transaction with optional specific input indexes.
 */
export interface SigningRequest {
    /** Transaction to sign */
    tx: Transaction;
    /** Specific input indexes to sign (signs all if omitted) */
    inputIndexes?: number[];
}

const ALL_SIGHASH = Object.values(SigHash).filter((x) => typeof x === "number");

// BIP32 version bytes for xpub/xprv
const VERSIONS = { private: 0x0488ade4, public: 0x0488b21e };

/**
 * Options for creating a SeedIdentity from a raw seed.
 */
export interface SeedIdentityOptions {
    /** Whether to use mainnet (coin type 0) or testnet (coin type 1) derivation path. */
    isMainnet: boolean;
}

/**
 * Options for creating a SeedIdentity from a BIP39 mnemonic phrase.
 */
export interface MnemonicOptions extends SeedIdentityOptions {
    /** Optional BIP39 passphrase for additional seed entropy. */
    passphrase?: string;
}

/**
 * Parses a Taproot output descriptor to extract fingerprint, path, and xpub.
 *
 * @param descriptor - Output descriptor in format: tr([fingerprint/path']xpub.../0/*)
 * @returns Parsed descriptor components
 * @throws Error if descriptor format is invalid or missing /0/* template
 * @internal
 */
function parseDescriptor(descriptor: string): {
    fingerprint: string;
    path: string;
    xpub: string;
} {
    // Format: tr([fingerprint/path']xpub.../0/*)
    // The /0/* template is required for future HD wallet compatibility
    const match = descriptor.match(
        /^tr\(\[([a-f0-9]{8})\/(\d+'\/\d+'\/\d+')\]([a-zA-Z0-9]+)\/0\/\*\)$/
    );
    if (!match) {
        throw new Error(
            "Invalid descriptor format. Expected: tr([fingerprint/86'/coinType'/0']xpub.../0/*)"
        );
    }
    return {
        fingerprint: match[1],
        path: match[2],
        xpub: match[3],
    };
}

/**
 * Parses a signing descriptor to extract fingerprint, path, xpub, and index.
 *
 * @param descriptor - Signing descriptor in format: tr([fingerprint/path']xpub.../0/{index})
 * @returns Parsed descriptor components including concrete index
 * @throws Error if descriptor format is invalid
 * @internal
 */
function parseSigningDescriptor(descriptor: string): {
    fingerprint: string;
    path: string;
    xpub: string;
    index: number;
} {
    // Format: tr([fingerprint/path']xpub.../0/{index})
    const match = descriptor.match(
        /^tr\(\[([a-f0-9]{8})\/(\d+'\/\d+'\/\d+')\]([a-zA-Z0-9]+)\/0\/(\d+)\)$/
    );
    if (!match) {
        throw new Error(
            "Invalid signing descriptor format. Expected: tr([fingerprint/86'/coinType'/0']xpub.../0/{index})"
        );
    }
    return {
        fingerprint: match[1],
        path: match[2],
        xpub: match[3],
        index: parseInt(match[4], 10),
    };
}

/**
 * HD wallet identity derived from a BIP39 mnemonic or raw seed.
 *
 * Uses BIP86 (Taproot) derivation path: m/86'/{coinType}'/0'/0/0
 * - Mainnet: m/86'/0'/0'/0/0
 * - Testnet: m/86'/1'/0'/0/0
 *
 * The identity stores the seed internally for future multi-address derivation
 * and serializes to JSON with an output descriptor for wallet interoperability.
 *
 * @example
 * ```typescript
 * // From mnemonic phrase
 * const identity = SeedIdentity.fromMnemonic(
 *   'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
 *   { isMainnet: true }
 * );
 *
 * // From mnemonic with passphrase
 * const identity = SeedIdentity.fromMnemonic(mnemonic, {
 *   isMainnet: true,
 *   passphrase: 'my secret passphrase'
 * });
 *
 * // From raw 64-byte seed
 * const seed = mnemonicToSeedSync(mnemonic);
 * const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
 *
 * // Serialize and restore
 * const json = identity.toJSON();
 * const restored = SeedIdentity.fromJSON(json);
 * ```
 */
export class SeedIdentity implements Identity {
    private readonly seed: Uint8Array;
    private readonly mnemonic?: string;
    private readonly isMainnet: boolean;
    private readonly masterFingerprint: string;
    private readonly accountNode: HDKey;
    private readonly derivedKey: Uint8Array;

    private constructor(
        seed: Uint8Array,
        isMainnet: boolean,
        mnemonic?: string
    ) {
        if (seed.length !== 64) {
            throw new Error("Seed must be 64 bytes");
        }

        this.seed = seed;
        this.mnemonic = mnemonic;
        this.isMainnet = isMainnet;

        // Derive master key
        const master = HDKey.fromMasterSeed(seed, VERSIONS);

        // Extract fingerprint (first 4 bytes as hex)
        this.masterFingerprint = master.fingerprint
            .toString(16)
            .padStart(8, "0");

        // Derive account node: m/86'/{0|1}'/0'
        const coinType = isMainnet ? 0 : 1;
        const accountPath = `m/86'/${coinType}'/0'`;
        this.accountNode = master.derive(accountPath);

        // Derive address key: /0/0
        const addressNode = this.accountNode.derive("m/0/0");
        if (!addressNode.privateKey) {
            throw new Error("Failed to derive private key");
        }
        this.derivedKey = addressNode.privateKey;
    }

    /**
     * Derives the private key at a specific index.
     * @internal
     */
    private derivePrivateKeyAtIndex(index: number): Uint8Array {
        const addressNode = this.accountNode.derive(`m/0/${index}`);
        if (!addressNode.privateKey) {
            throw new Error("Failed to derive private key");
        }
        return addressNode.privateKey;
    }

    /**
     * Creates a SeedIdentity from a raw 64-byte BIP39 seed.
     *
     * @param seed - 64-byte seed (typically from mnemonicToSeedSync)
     * @param opts - Options specifying mainnet or testnet derivation
     * @returns New SeedIdentity instance
     * @throws Error if seed is not 64 bytes
     *
     * @example
     * ```typescript
     * import { mnemonicToSeedSync } from '@scure/bip39';
     *
     * const seed = mnemonicToSeedSync(mnemonic);
     * const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
     * ```
     */
    static fromSeed(seed: Uint8Array, opts: SeedIdentityOptions): SeedIdentity {
        return new SeedIdentity(seed, opts.isMainnet);
    }

    /**
     * Creates a SeedIdentity from a BIP39 mnemonic phrase.
     *
     * @param phrase - BIP39 mnemonic phrase (12 or 24 words)
     * @param opts - Options including network and optional passphrase
     * @returns New SeedIdentity instance
     * @throws Error if mnemonic is invalid
     *
     * @example
     * ```typescript
     * const identity = SeedIdentity.fromMnemonic(
     *   'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
     *   { isMainnet: true, passphrase: 'optional' }
     * );
     * ```
     */
    static fromMnemonic(phrase: string, opts: MnemonicOptions): SeedIdentity {
        if (!validateMnemonic(phrase, wordlist)) {
            throw new Error("Invalid mnemonic");
        }
        const seed = mnemonicToSeedSync(phrase, opts.passphrase);
        return new SeedIdentity(seed, opts.isMainnet, phrase);
    }

    /**
     * Restores a SeedIdentity from a JSON string.
     *
     * The JSON must contain either a `mnemonic` or `seed` field, plus a `descriptor`
     * field. The network (mainnet/testnet) is inferred from the coin type in the
     * descriptor path. The xpub in the descriptor is validated against the derived key.
     *
     * @param json - JSON string from toJSON()
     * @returns Restored SeedIdentity instance
     * @throws Error if JSON is invalid, missing required fields, or xpub doesn't match
     *
     * @example
     * ```typescript
     * const original = SeedIdentity.fromMnemonic(mnemonic, { isMainnet: true });
     * const json = original.toJSON();
     *
     * // Later, restore the identity
     * const restored = SeedIdentity.fromJSON(json);
     * ```
     */
    static fromJSON(json: string): SeedIdentity {
        const parsed = JSON.parse(json);

        if (!parsed.descriptor) {
            throw new Error("Missing descriptor");
        }

        const { xpub } = parseDescriptor(parsed.descriptor);

        // Infer isMainnet from coin type in path (86'/0'/0' vs 86'/1'/0')
        const coinTypeMatch = parsed.descriptor.match(/86'\/(\d+)'\/0'/);
        if (!coinTypeMatch) {
            throw new Error("Invalid path in descriptor");
        }
        const isMainnet = coinTypeMatch[1] === "0";

        let seed: Uint8Array;
        let mnemonic: string | undefined;

        if (parsed.mnemonic) {
            if (!validateMnemonic(parsed.mnemonic, wordlist)) {
                throw new Error("Invalid mnemonic");
            }
            mnemonic = parsed.mnemonic;
            seed = mnemonicToSeedSync(parsed.mnemonic);
        } else if (parsed.seed) {
            seed = hex.decode(parsed.seed);
        } else {
            throw new Error("Missing mnemonic or seed");
        }

        // Create identity and validate xpub matches
        const identity = new SeedIdentity(seed, isMainnet, mnemonic);

        if (identity.accountNode.publicExtendedKey !== xpub) {
            throw new Error(
                "xpub mismatch: derived key does not match descriptor"
            );
        }

        return identity;
    }

    /**
     * Returns the 32-byte x-only (Schnorr) public key.
     * @returns X-only public key for Taproot addresses
     */
    async xOnlyPublicKey(): Promise<Uint8Array> {
        return pubSchnorr(this.derivedKey);
    }

    /**
     * Returns the 33-byte compressed ECDSA public key.
     * @returns Compressed public key with prefix byte
     */
    async compressedPublicKey(): Promise<Uint8Array> {
        return pubECDSA(this.derivedKey, true);
    }

    /**
     * Signs a transaction using the derived private key.
     *
     * @param tx - Transaction to sign
     * @param inputIndexes - Optional specific input indexes to sign (signs all if omitted)
     * @returns Signed transaction copy
     */
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

    /**
     * Signs a message using Schnorr or ECDSA signature.
     *
     * @param message - 32-byte message to sign
     * @param signatureType - Signature algorithm (defaults to "schnorr")
     * @returns 64-byte signature
     */
    async signMessage(
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr"
    ): Promise<Uint8Array> {
        if (signatureType === "ecdsa") {
            return signAsync(message, this.derivedKey, { prehash: false });
        }
        return schnorr.signAsync(message, this.derivedKey);
    }

    /**
     * Creates a new signer session for tree signing operations.
     * @returns Random signer session
     */
    signerSession(): SignerSession {
        return TreeSignerSession.random();
    }

    /**
     * Serializes the identity to JSON for storage.
     *
     * The JSON contains:
     * - `mnemonic`: The mnemonic phrase (if created from mnemonic)
     * - `seed`: Hex-encoded seed (if created from raw seed)
     * - `descriptor`: Output descriptor with xpub for wallet interoperability
     *
     * @returns JSON string that can be restored with fromJSON()
     *
     * @example
     * ```typescript
     * const json = identity.toJSON();
     * // {"mnemonic":"abandon...", "descriptor":"tr([fingerprint/86'/0'/0']xpub.../0/*)"}
     * ```
     */
    toJSON(): string {
        const coinType = this.isMainnet ? 0 : 1;
        const path = `86'/${coinType}'/0'`;
        const xpub = this.accountNode.publicExtendedKey;
        const descriptor = `tr([${this.masterFingerprint}/${path}]${xpub}/0/*)`;

        if (this.mnemonic) {
            return JSON.stringify({ mnemonic: this.mnemonic, descriptor });
        } else {
            return JSON.stringify({ seed: hex.encode(this.seed), descriptor });
        }
    }

    /**
     * Converts to a watch-only identity that cannot sign.
     *
     * The readonly identity contains only the xpub and can derive public keys
     * but has no signing capability. Useful for creating watch-only wallets.
     *
     * @returns ReadonlySeedIdentity with same public key
     */
    async toReadonly(): Promise<ReadonlySeedIdentity> {
        const json = this.toJSON();
        const descriptor = JSON.parse(json).descriptor;
        return ReadonlySeedIdentity.fromDescriptor(descriptor);
    }

    /**
     * Derives a signing descriptor at a specific index.
     *
     * @param index - The address index (0, 1, 2, ...)
     * @returns Descriptor string with concrete index: tr([fp/86'/coinType'/0']xpub.../0/{index})
     * @throws Error if index is negative
     *
     * @example
     * ```typescript
     * const descriptor = identity.deriveSigningDescriptor(5);
     * // → "tr([12345678/86'/0'/0']xpub.../0/5)"
     * ```
     */
    deriveSigningDescriptor(index: number): string {
        if (index < 0) {
            throw new Error("Index must be non-negative");
        }
        const coinType = this.isMainnet ? 0 : 1;
        const path = `86'/${coinType}'/0'`;
        const xpub = this.accountNode.publicExtendedKey;
        return `tr([${this.masterFingerprint}/${path}]${xpub}/0/${index})`;
    }

    /**
     * Checks if a signing descriptor belongs to this identity.
     *
     * @param descriptor - A signing descriptor to check
     * @returns true if fingerprint and xpub match this identity
     *
     * @example
     * ```typescript
     * if (identity.isOurs(descriptor)) {
     *     // This descriptor was derived from our seed
     * }
     * ```
     */
    isOurs(descriptor: string): boolean {
        try {
            const parsed = parseSigningDescriptor(descriptor);
            return (
                parsed.fingerprint === this.masterFingerprint &&
                parsed.xpub === this.accountNode.publicExtendedKey
            );
        } catch {
            return false;
        }
    }

    /**
     * Signs multiple transactions using the key derived from a descriptor.
     *
     * @param descriptor - Signing descriptor specifying which key to use
     * @param requests - Array of signing requests
     * @returns Array of signed transactions (same order as requests)
     * @throws Error if descriptor doesn't belong to this identity
     *
     * @example
     * ```typescript
     * const [signedTx1, signedTx2] = await identity.signWithDescriptor(descriptor, [
     *     { tx: tx1, inputIndexes: [0, 2] },
     *     { tx: tx2 }  // signs all inputs
     * ]);
     * ```
     */
    async signWithDescriptor(
        descriptor: string,
        requests: SigningRequest[]
    ): Promise<Transaction[]> {
        if (!this.isOurs(descriptor)) {
            throw new Error("Descriptor does not belong to this identity");
        }

        const { index } = parseSigningDescriptor(descriptor);
        const privateKey = this.derivePrivateKeyAtIndex(index);

        const results: Transaction[] = [];
        for (const request of requests) {
            const txCopy = request.tx.clone();

            if (!request.inputIndexes) {
                try {
                    if (!txCopy.sign(privateKey, ALL_SIGHASH)) {
                        throw new Error("Failed to sign transaction");
                    }
                } catch (e) {
                    if (
                        e instanceof Error &&
                        e.message.includes("No inputs signed")
                    ) {
                        // ignore - no matching inputs
                    } else {
                        throw e;
                    }
                }
            } else {
                for (const inputIndex of request.inputIndexes) {
                    if (!txCopy.signIdx(privateKey, inputIndex, ALL_SIGHASH)) {
                        throw new Error(`Failed to sign input #${inputIndex}`);
                    }
                }
            }

            results.push(txCopy);
        }

        return results;
    }

    /**
     * Signs a message using the key derived from a descriptor.
     *
     * @param descriptor - Signing descriptor specifying which key to use
     * @param message - 32-byte message to sign
     * @param signatureType - Signature algorithm (defaults to "schnorr")
     * @returns 64-byte signature
     * @throws Error if descriptor doesn't belong to this identity
     *
     * @example
     * ```typescript
     * const signature = await identity.signMessageWithDescriptor(
     *     descriptor,
     *     messageHash,
     *     "schnorr"
     * );
     * ```
     */
    async signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr"
    ): Promise<Uint8Array> {
        if (!this.isOurs(descriptor)) {
            throw new Error("Descriptor does not belong to this identity");
        }

        const { index } = parseSigningDescriptor(descriptor);
        const privateKey = this.derivePrivateKeyAtIndex(index);

        if (signatureType === "ecdsa") {
            return signAsync(message, privateKey, { prehash: false });
        }
        return schnorr.signAsync(message, privateKey);
    }
}

/**
 * Watch-only HD wallet identity from an output descriptor.
 *
 * Can derive public keys and verify addresses but cannot sign transactions.
 * Useful for watch-only wallets and separating signing from query operations.
 *
 * @example
 * ```typescript
 * // From a full identity
 * const identity = SeedIdentity.fromMnemonic(mnemonic, { isMainnet: true });
 * const readonly = await identity.toReadonly();
 *
 * // Or from a descriptor directly
 * const descriptor = "tr([fingerprint/86'/0'/0']xpub.../0/*)";
 * const readonly = ReadonlySeedIdentity.fromDescriptor(descriptor);
 *
 * // Can get public keys
 * const pubKey = await readonly.xOnlyPublicKey();
 *
 * // Cannot sign (methods don't exist)
 * ```
 */
export class ReadonlySeedIdentity implements ReadonlyIdentity {
    private readonly accountXpub: HDKey;
    private readonly descriptor: string;
    private readonly masterFingerprint: string;
    private readonly isMainnet: boolean;

    private constructor(
        descriptor: string,
        accountXpub: HDKey,
        masterFingerprint: string,
        isMainnet: boolean
    ) {
        this.descriptor = descriptor;
        this.accountXpub = accountXpub;
        this.masterFingerprint = masterFingerprint;
        this.isMainnet = isMainnet;
    }

    /**
     * Creates a ReadonlySeedIdentity from an output descriptor.
     *
     * @param descriptor - Taproot descriptor in format: tr([fingerprint/path']xpub.../0/*)
     * @returns New ReadonlySeedIdentity instance
     * @throws Error if descriptor format is invalid or missing /0/* template
     *
     * @example
     * ```typescript
     * const descriptor = "tr([12345678/86'/0'/0']xpub.../0/*)";
     * const readonly = ReadonlySeedIdentity.fromDescriptor(descriptor);
     * ```
     */
    static fromDescriptor(descriptor: string): ReadonlySeedIdentity {
        const { xpub, fingerprint, path } = parseDescriptor(descriptor);
        const accountXpub = HDKey.fromExtendedKey(xpub, VERSIONS);
        // Infer isMainnet from coin type in path (86'/0'/0' vs 86'/1'/0')
        const isMainnet = path.includes("86'/0'/0'");
        return new ReadonlySeedIdentity(
            descriptor,
            accountXpub,
            fingerprint,
            isMainnet
        );
    }

    /**
     * Restores a ReadonlySeedIdentity from a JSON string.
     *
     * @param json - JSON string containing a `descriptor` field
     * @returns Restored ReadonlySeedIdentity instance
     * @throws Error if JSON is invalid or missing descriptor
     */
    static fromJSON(json: string): ReadonlySeedIdentity {
        const parsed = JSON.parse(json);
        if (!parsed.descriptor) {
            throw new Error("Missing descriptor");
        }
        return ReadonlySeedIdentity.fromDescriptor(parsed.descriptor);
    }

    /**
     * Returns the 32-byte x-only (Schnorr) public key.
     * @returns X-only public key for Taproot addresses
     */
    async xOnlyPublicKey(): Promise<Uint8Array> {
        const addressNode = this.accountXpub.derive("m/0/0");
        if (!addressNode.publicKey) {
            throw new Error("Failed to derive public key");
        }
        // x-only is compressed pubkey without the prefix byte
        return addressNode.publicKey.slice(1);
    }

    /**
     * Returns the 33-byte compressed ECDSA public key.
     * @returns Compressed public key with prefix byte
     */
    async compressedPublicKey(): Promise<Uint8Array> {
        const addressNode = this.accountXpub.derive("m/0/0");
        if (!addressNode.publicKey) {
            throw new Error("Failed to derive public key");
        }
        return addressNode.publicKey;
    }

    /**
     * Serializes to JSON containing only the descriptor.
     * @returns JSON string that can be restored with fromJSON()
     */
    toJSON(): string {
        return JSON.stringify({ descriptor: this.descriptor });
    }

    /**
     * Derives a signing descriptor at a specific index.
     *
     * @param index - The address index (0, 1, 2, ...)
     * @returns Descriptor string with concrete index
     * @throws Error if index is negative
     */
    deriveSigningDescriptor(index: number): string {
        if (index < 0) {
            throw new Error("Index must be non-negative");
        }
        const coinType = this.isMainnet ? 0 : 1;
        const path = `86'/${coinType}'/0'`;
        const xpub = this.accountXpub.publicExtendedKey;
        return `tr([${this.masterFingerprint}/${path}]${xpub}/0/${index})`;
    }

    /**
     * Checks if a signing descriptor belongs to this identity.
     *
     * @param descriptor - A signing descriptor to check
     * @returns true if fingerprint and xpub match this identity
     */
    isOurs(descriptor: string): boolean {
        try {
            const parsed = parseSigningDescriptor(descriptor);
            return (
                parsed.fingerprint === this.masterFingerprint &&
                parsed.xpub === this.accountXpub.publicExtendedKey
            );
        } catch {
            return false;
        }
    }

    /**
     * Returns the 32-byte x-only public key at a specific index.
     * @param index - The address index
     * @returns X-only public key for Taproot addresses
     */
    async xOnlyPublicKeyAtIndex(index: number): Promise<Uint8Array> {
        const addressNode = this.accountXpub.derive(`m/0/${index}`);
        if (!addressNode.publicKey) {
            throw new Error("Failed to derive public key");
        }
        return addressNode.publicKey.slice(1);
    }

    /**
     * Returns the 33-byte compressed public key at a specific index.
     * @param index - The address index
     * @returns Compressed public key with prefix byte
     */
    async compressedPublicKeyAtIndex(index: number): Promise<Uint8Array> {
        const addressNode = this.accountXpub.derive(`m/0/${index}`);
        if (!addressNode.publicKey) {
            throw new Error("Failed to derive public key");
        }
        return addressNode.publicKey;
    }
}
