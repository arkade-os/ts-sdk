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
    HDKey,
    expand,
    networks,
    scriptExpressions,
    type Network,
} from "@bitcoinerlab/descriptors-scure";
import type { DescriptorSigningRequest } from "./descriptorProvider";

const ALL_SIGHASH = Object.values(SigHash).filter((x) => typeof x === "number");

/** Use default BIP86 derivation with network selection. */
export interface NetworkOptions {
    /** Mainnet (coin type 0) or testnet (coin type 1). @default true */
    isMainnet?: boolean;
}

/** Use a custom output descriptor for derivation. */
export interface DescriptorOptions {
    descriptor: string;
}

export type SeedIdentityOptions = NetworkOptions | DescriptorOptions;

export type MnemonicOptions = SeedIdentityOptions & {
    passphrase?: string;
};

/** @deprecated Use {@link DescriptorSigningRequest} instead. */
export type SigningRequest = DescriptorSigningRequest;

// ── Shared helpers ────────────────────────────────────────────────

function detectNetwork(descriptor: string): Network {
    return descriptor.includes("tpub") ? networks.testnet : networks.bitcoin;
}

function expandDescriptor(descriptor: string, index?: number) {
    const network = detectNetwork(descriptor);
    return expand(
        index !== undefined
            ? { descriptor, network, index }
            : { descriptor, network }
    );
}

function hasDescriptor(
    opts: SeedIdentityOptions = {}
): opts is DescriptorOptions {
    return "descriptor" in opts && typeof opts.descriptor === "string";
}

function buildDescriptor(seed: Uint8Array, isMainnet: boolean): string {
    const network = isMainnet ? networks.bitcoin : networks.testnet;
    const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
    return scriptExpressions.trBIP32({
        masterNode,
        network,
        account: 0,
        change: 0,
        index: 0,
    });
}

/** Check if `descriptor` was derived from the same HD account as `ownAccountXpub`. */
function isOursImpl(descriptor: string, ownAccountXpub: string): boolean {
    try {
        const keyInfo = expandDescriptor(descriptor).expansionMap?.["@0"];
        return keyInfo?.bip32?.toBase58() === ownAccountXpub;
    } catch {
        return false;
    }
}

/** Clone, sign, return. Shared by sign() and signWithDescriptor(). */
function signTxWithKey(
    tx: Transaction,
    privateKey: Uint8Array,
    inputIndexes?: number[]
): Transaction {
    const txCpy = tx.clone();
    if (!inputIndexes) {
        try {
            if (!txCpy.sign(privateKey, ALL_SIGHASH)) {
                throw new Error("Failed to sign transaction");
            }
        } catch (e) {
            if (e instanceof Error && e.message.includes("No inputs signed")) {
                // ignore — tx may have no inputs matching this key
            } else {
                throw e;
            }
        }
    } else {
        for (const idx of inputIndexes) {
            if (!txCpy.signIdx(privateKey, idx, ALL_SIGHASH)) {
                throw new Error(`Failed to sign input #${idx}`);
            }
        }
    }
    return txCpy;
}

/**
 * Seed-based identity using BIP86 (Taproot) derivation with output descriptors.
 * Prefer this (or {@link MnemonicIdentity}) over `SingleKey` for new integrations.
 */
export class SeedIdentity implements Identity {
    protected readonly seed: Uint8Array;
    private readonly derivedKey: Uint8Array;
    private readonly accountXpub: string;
    readonly descriptor: string;
    readonly isMainnet: boolean;

    constructor(seed: Uint8Array, descriptor: string) {
        if (seed.length !== 64) throw new Error("Seed must be 64 bytes");

        this.seed = seed;
        this.descriptor = descriptor;

        const network = detectNetwork(descriptor);
        this.isMainnet = network === networks.bitcoin;

        const keyInfo = expandDescriptor(descriptor).expansionMap?.["@0"];
        if (!keyInfo?.originPath)
            throw new Error("Descriptor must include a key origin path");

        const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
        const accountNode = masterNode.derive(`m${keyInfo.originPath}`);
        if (accountNode.publicExtendedKey !== keyInfo.bip32?.toBase58()) {
            throw new Error(
                "xpub mismatch: derived key does not match descriptor"
            );
        }
        this.accountXpub = keyInfo.bip32!.toBase58();

        if (!keyInfo.path)
            throw new Error("Descriptor must specify a full derivation path");
        const derivedNode = masterNode.derive(keyInfo.path);
        if (!derivedNode.privateKey)
            throw new Error("Failed to derive private key");
        this.derivedKey = derivedNode.privateKey;
    }

    static fromSeed(
        seed: Uint8Array,
        opts: SeedIdentityOptions = {}
    ): SeedIdentity {
        const descriptor = hasDescriptor(opts)
            ? opts.descriptor
            : buildDescriptor(seed, (opts as NetworkOptions).isMainnet ?? true);
        return new SeedIdentity(seed, descriptor);
    }

    deriveSigningDescriptor(index: number): string {
        if (index < 0) throw new Error("Index must be non-negative");
        const network = detectNetwork(this.descriptor);
        const masterNode = HDKey.fromMasterSeed(this.seed, network.bip32);
        return scriptExpressions.trBIP32({
            masterNode,
            network,
            account: 0,
            change: 0,
            index,
        });
    }

    isOurs(descriptor: string): boolean {
        return isOursImpl(descriptor, this.accountXpub);
    }

    async signWithDescriptor(
        requests: DescriptorSigningRequest[]
    ): Promise<Transaction[]> {
        if (requests.length === 0) return [];

        const keyCache = new Map<string, Uint8Array>();
        const results: Transaction[] = [];

        for (const { descriptor, tx, inputIndexes } of requests) {
            if (!this.isOurs(descriptor)) {
                throw new Error("Descriptor does not belong to this identity");
            }
            let privateKey = keyCache.get(descriptor);
            if (!privateKey) {
                privateKey = this.derivePrivateKeyFromDescriptor(descriptor);
                keyCache.set(descriptor, privateKey);
            }
            results.push(signTxWithKey(tx, privateKey, inputIndexes));
        }

        return results;
    }

    async signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr"
    ): Promise<Uint8Array> {
        if (!this.isOurs(descriptor)) {
            throw new Error("Descriptor does not belong to this identity");
        }
        const privateKey = this.derivePrivateKeyFromDescriptor(descriptor);
        if (signatureType === "ecdsa")
            return signAsync(message, privateKey, { prehash: false });
        return schnorr.signAsync(message, privateKey);
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        return pubSchnorr(this.derivedKey);
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        return pubECDSA(this.derivedKey, true);
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        return signTxWithKey(tx, this.derivedKey, inputIndexes);
    }

    async signMessage(
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr"
    ): Promise<Uint8Array> {
        if (signatureType === "ecdsa")
            return signAsync(message, this.derivedKey, { prehash: false });
        return schnorr.signAsync(message, this.derivedKey);
    }

    signerSession(): SignerSession {
        return TreeSignerSession.random();
    }

    async toReadonly(): Promise<ReadonlySeedIdentity> {
        return ReadonlySeedIdentity.fromDescriptor(this.descriptor);
    }

    private derivePrivateKeyFromDescriptor(descriptor: string): Uint8Array {
        const network = detectNetwork(descriptor);
        const masterNode = HDKey.fromMasterSeed(this.seed, network.bip32);
        const keyInfo = expandDescriptor(descriptor).expansionMap?.["@0"];
        if (!keyInfo?.path)
            throw new Error("Invalid descriptor: missing derivation path");
        const derivedNode = masterNode.derive(keyInfo.path);
        if (!derivedNode.privateKey)
            throw new Error("Failed to derive private key");
        return derivedNode.privateKey;
    }
}

/** Convenience subclass that validates and stores a BIP39 mnemonic. */
export class MnemonicIdentity extends SeedIdentity {
    readonly mnemonic: string;

    private constructor(
        seed: Uint8Array,
        descriptor: string,
        mnemonic: string
    ) {
        super(seed, descriptor);
        this.mnemonic = mnemonic;
    }

    static fromMnemonic(
        phrase: string,
        opts: MnemonicOptions = {}
    ): MnemonicIdentity {
        if (!validateMnemonic(phrase, wordlist))
            throw new Error("Invalid mnemonic");
        const seed = mnemonicToSeedSync(phrase, opts.passphrase);
        const descriptor = hasDescriptor(opts)
            ? opts.descriptor
            : buildDescriptor(seed, (opts as NetworkOptions).isMainnet ?? true);
        return new MnemonicIdentity(seed, descriptor, phrase);
    }
}

/** Watch-only identity from an output descriptor. Cannot sign transactions. */
export class ReadonlySeedIdentity implements ReadonlyIdentity {
    private readonly xOnlyPubKey: Uint8Array;
    private readonly compressedPubKey: Uint8Array;
    private readonly accountXpub: string | undefined;
    private readonly accountBip32:
        | {
              derivePath(path: string): { publicKey: Uint8Array };
              toBase58(): string;
              publicKey: Uint8Array;
          }
        | undefined;

    private constructor(readonly descriptor: string) {
        const keyInfo = expandDescriptor(descriptor).expansionMap?.["@0"];
        if (!keyInfo?.pubkey)
            throw new Error("Failed to derive public key from descriptor");

        this.xOnlyPubKey = keyInfo.pubkey;

        // Get 33-byte compressed key with correct parity from the bip32 node
        if (keyInfo.bip32 && keyInfo.keyPath) {
            const relPath = keyInfo.keyPath.replace(/^\//, "");
            this.compressedPubKey = keyInfo.bip32.derivePath(relPath).publicKey;
        } else if (keyInfo.bip32) {
            this.compressedPubKey = keyInfo.bip32.publicKey;
        } else {
            throw new Error(
                "Cannot determine compressed public key parity from descriptor"
            );
        }

        this.accountBip32 = keyInfo.bip32;
        this.accountXpub = keyInfo.bip32?.toBase58();
    }

    static fromDescriptor(descriptor: string): ReadonlySeedIdentity {
        return new ReadonlySeedIdentity(descriptor);
    }

    deriveSigningDescriptor(index: number): string {
        if (index < 0) throw new Error("Index must be non-negative");
        if (!this.accountBip32)
            throw new Error("No BIP32 account node available");
        const keyInfo = expandDescriptor(this.descriptor).expansionMap?.["@0"];
        if (!keyInfo?.masterFingerprint || !keyInfo?.originPath) {
            throw new Error("Descriptor missing origin information");
        }
        const masterFp = hex.encode(keyInfo.masterFingerprint);
        return `tr([${masterFp}${keyInfo.originPath}]${keyInfo.bip32!.toBase58()}/0/${index})`;
    }

    isOurs(descriptor: string): boolean {
        if (!this.accountXpub) return false;
        return isOursImpl(descriptor, this.accountXpub);
    }

    async xOnlyPublicKeyAtIndex(index: number): Promise<Uint8Array> {
        if (index < 0) throw new Error("Index must be non-negative");
        const desc = this.deriveSigningDescriptor(index);
        const keyInfo = expandDescriptor(desc).expansionMap?.["@0"];
        if (!keyInfo?.pubkey)
            throw new Error("Failed to derive public key at index");
        return keyInfo.pubkey;
    }

    async compressedPublicKeyAtIndex(index: number): Promise<Uint8Array> {
        if (index < 0) throw new Error("Index must be non-negative");
        if (!this.accountBip32)
            throw new Error("No BIP32 account node available");
        return this.accountBip32.derivePath(`0/${index}`).publicKey;
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
