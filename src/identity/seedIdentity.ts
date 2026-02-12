import { validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";
import { SigHash } from "@scure/btc-signer";
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

    constructor(seed: Uint8Array, descriptor: string) {
        if (seed.length !== 64) {
            throw new Error("Seed must be 64 bytes");
        }

        this.seed = seed;
        this.descriptor = descriptor;

        const network = detectNetwork(descriptor);

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
    async toReadonly(): Promise<ReadonlyDescriptorIdentity> {
        return ReadonlyDescriptorIdentity.fromDescriptor(this.descriptor);
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
 * @example
 * ```typescript
 * const descriptor = "tr([fingerprint/86'/0'/0']xpub.../0/0)";
 * const readonly = ReadonlyDescriptorIdentity.fromDescriptor(descriptor);
 * const pubKey = await readonly.xOnlyPublicKey();
 * ```
 */
export class ReadonlyDescriptorIdentity implements ReadonlyIdentity {
    private readonly xOnlyPubKey: Uint8Array;
    private readonly compressedPubKey: Uint8Array;

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
    }

    /**
     * Creates a ReadonlyDescriptorIdentity from an output descriptor.
     *
     * @param descriptor - Taproot descriptor: tr([fingerprint/path']xpub.../child/path)
     */
    static fromDescriptor(descriptor: string): ReadonlyDescriptorIdentity {
        return new ReadonlyDescriptorIdentity(descriptor);
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        return this.xOnlyPubKey;
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        return this.compressedPubKey;
    }
}
