import { validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";
import { SigHash } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { assertAllowedSighashTypes, Transaction } from "../utils/transaction";
import { SignerSession, TreeSignerSession } from "../tree/signingSession";
import { schnorr, signAsync } from "@noble/secp256k1";
import {
    HDKey,
    expand,
    networks,
    scriptExpressions,
    type KeyInfo,
} from "@bitcoinerlab/descriptors-scure";
import type { SerializedSigningIdentity, SerializedReadonlyIdentity } from "./serialize";
import { DescriptorSigningRequest } from "./descriptorProvider";
import { HDCapableIdentity, ReadonlyHDCapableIdentity } from "./hdCapableIdentity";
import { descriptorIsOurs, isMainnetDescriptor } from "./descriptor";

// SIGHASH_NONE / SIGHASH_SINGLE do not commit to the outputs we intend to
// fund, so a PSBT we did not build must never talk us into one.
const ALLOWED_SIGHASH = [SigHash.DEFAULT, SigHash.ALL, SigHash.ALL_ANYONECANPAY];

/**
 * Secret-bearing state for seed-backed identities, read only by the serializer helpers below.
 * A module-private WeakMap, not `private`: TS visibility is compile-time only, and JS consumers
 * could still read or enumerate fields.
 */
const seedBytes = new WeakMap<SeedIdentity, Uint8Array>();
const mnemonicMeta = new WeakMap<MnemonicIdentity, { mnemonic: string; passphrase?: string }>();

/** Used for default BIP86 derivation with network selection. */
export interface NetworkOptions {
    /**
     * Mainnet (coin type 0) or testnet (coin type 1).
     *
     * @defaultValue `true`
     */
    isMainnet?: boolean;
}

/** Used for a caller-supplied account-descriptor template. */
export interface DescriptorOptions {
    /**
     * Account-descriptor *template*; must end with the BIP-32 wildcard suffix `/*)`. Stored as-is
     * on {@link SeedIdentity.descriptor} for HD providers to rotate through indices.
     */
    descriptor: string;
}

/** Either default BIP86 derivation (with optional network selection) or a caller-supplied template. */
export type SeedIdentityOptions = NetworkOptions | DescriptorOptions;

/** Used for deriving an identity from a BIP39 mnemonic. */
export type MnemonicOptions = SeedIdentityOptions & {
    /** Optional BIP39 passphrase for additional seed entropy. */
    passphrase?: string;
};

/**
 * Seed-based identity derived from a raw seed and an account descriptor *template*.
 *
 * The recommended identity type: BIP86 (Taproot) derivation by default, or a caller-supplied
 * wildcard template. Prefer it (or @see MnemonicIdentity) over `SingleKey`, which exists for
 * backward compatibility with raw nsec-style keys.
 *
 * {@link descriptor} holds the wildcard template (e.g. `tr([fp/86'/0'/0']xpub/0/*)`); consumers
 * materialize concrete indices themselves (see `HDDescriptorProvider`).
 *
 * Deliberately NOT a `DescriptorProvider`, so it can't silently be used as a concrete
 * descriptor source and defeat HD rotation. Wrap it in `HDDescriptorProvider` (rotating
 * receive addresses) or {@link StaticDescriptorProvider} (legacy single-key behaviour).
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
export class SeedIdentity implements HDCapableIdentity {
    private readonly derivedKey: Uint8Array;
    /** Wildcard account-descriptor template (e.g. `tr([fp/86'/0'/0']xpub/0/*)`). */
    readonly descriptor: string;

    /**
     * Constructs a SeedIdentity from a 64-byte seed and either a wildcard `{ descriptor }` or the
     * default BIP86 path for `{ isMainnet }`. Prefer {@link fromSeed}.
     *
     * Throws on a non-wildcard descriptor, an xpub mismatch with the seed, or a missing
     * derivation path.
     */
    constructor(seed: Uint8Array, opts: SeedIdentityOptions = {}) {
        if (seed.length !== 64) {
            throw new Error("Seed must be 64 bytes");
        }

        let descriptor: string;
        let network: typeof networks.bitcoin;
        if ("descriptor" in opts && typeof opts.descriptor === "string") {
            descriptor = opts.descriptor;
            network = isMainnetDescriptor(descriptor) ? networks.bitcoin : networks.testnet;
        } else {
            network =
                ((opts as NetworkOptions).isMainnet ?? true) ? networks.bitcoin : networks.testnet;
            descriptor = scriptExpressions.trBIP32({
                masterNode: HDKey.fromMasterSeed(seed, network.bip32),
                network,
                account: 0,
                change: 0,
                index: "*",
            });
        }

        // Index 0 of the template. A non-wildcard input raises the library's opaque
        // "index passed for non-ranged descriptor"; re-wrapped to name the real mistake.
        let expansion;
        try {
            expansion = expand({ descriptor, network, index: 0 });
        } catch (e) {
            throw new Error(
                `SeedIdentity requires a wildcard descriptor template (must end in "/*)"); ${e instanceof Error ? e.message : String(e)}`,
            );
        }
        const keyInfo = expansion.expansionMap?.["@0"];

        // Copy: a later mutation of the caller's buffer must not drift the serialized seed from
        // the eagerly derived key and descriptor.
        seedBytes.set(this, new Uint8Array(seed));
        this.descriptor = descriptor;

        if (!keyInfo?.originPath) {
            throw new Error("Descriptor must include a key origin path");
        }

        // The descriptor's xpub must come from this seed.
        const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
        const accountNode = masterNode.derive(`m${keyInfo.originPath}`);
        if (accountNode.publicExtendedKey !== keyInfo.bip32?.toBase58()) {
            throw new Error("xpub mismatch: derived key does not match descriptor");
        }

        // Index-0 private key via the full path.
        if (!keyInfo.path) {
            throw new Error("Descriptor must specify a full derivation path");
        }
        const derivedNode = masterNode.derive(keyInfo.path);
        if (!derivedNode.privateKey) {
            throw new Error("Failed to derive private key");
        }
        this.derivedKey = derivedNode.privateKey;
    }

    /**
     * Creates a SeedIdentity from a raw 64-byte seed: `{ isMainnet }` for default BIP86
     * derivation, or `{ descriptor }` for a template ending in `/*)`.
     *
     * @param seed - 64-byte seed (typically from mnemonicToSeedSync)
     */
    static fromSeed(seed: Uint8Array, opts: SeedIdentityOptions = {}): SeedIdentity {
        return new SeedIdentity(seed, opts);
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        return pubSchnorr(this.derivedKey);
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        return pubECDSA(this.derivedKey, true);
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        return this.signTxWithKey(tx, this.derivedKey, inputIndexes);
    }

    async signMessage(
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr",
    ): Promise<Uint8Array> {
        return this.signMessageWithKey(this.derivedKey, message, signatureType);
    }

    /**
     * BIP-340 sign `messageHash` with this identity's own key, aux_rand = 0 (for an `auto`-mode
     * wallet whose bare `tr(pubkey)` resolves to the identity itself). NOT via `signMessage`,
     * whose random aux_rand would make the signature unreproducible.
     */
    async signSchnorrDeterministic(messageHash: Uint8Array): Promise<Uint8Array> {
        return schnorr.signAsync(messageHash, this.derivedKey, new Uint8Array(32));
    }

    signerSession(): SignerSession {
        return TreeSignerSession.random();
    }

    /** Watch-only copy; carries the template forward, so it stays HD-capable without the seed. */
    async toReadonly(): Promise<ReadonlyDescriptorIdentity> {
        return ReadonlyDescriptorIdentity.fromDescriptor(this.descriptor);
    }

    /** Returns true when `descriptor` is derived from this identity's seed. */
    ownsDescriptor(descriptor: string): boolean {
        return descriptorIsOurs(descriptor, this.descriptor, pubSchnorr(this.derivedKey));
    }

    /**
     * Signs each request with the key derived from its descriptor.
     * Each descriptor must share this identity's seed ({@link ownsDescriptor}).
     */
    async signDescriptorTransactions(requests: DescriptorSigningRequest[]): Promise<Transaction[]> {
        return requests.map((request) => {
            if (!this.ownsDescriptor(request.descriptor)) {
                throw new Error(
                    `Descriptor ${request.descriptor} does not belong to this identity`,
                );
            }
            const key = this.derivePrivateKeyForDescriptor(request.descriptor);
            return this.signTxWithKey(request.tx, key, request.inputIndexes);
        });
    }

    /** Signs a message with the key derived from `descriptor`. */
    async signDescriptorMessage(
        descriptor: string,
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr",
    ): Promise<Uint8Array> {
        if (!this.ownsDescriptor(descriptor)) {
            throw new Error(`Descriptor ${descriptor} does not belong to this identity`);
        }
        const key = this.derivePrivateKeyForDescriptor(descriptor);
        return this.signMessageWithKey(key, message, signatureType);
    }

    /**
     * BIP-340 sign `messageHash` with the key derived from `descriptor`,
     * aux_rand = 0. Backs {@link DescriptorIdentity.signSchnorrDeterministic},
     * which swap preimage derivation reads through.
     */
    async signSchnorrDeterministicWithDescriptor(
        descriptor: string,
        messageHash: Uint8Array,
    ): Promise<Uint8Array> {
        if (!this.ownsDescriptor(descriptor)) {
            throw new Error(`Descriptor ${descriptor} does not belong to this identity`);
        }
        const key = this.derivePrivateKeyForDescriptor(descriptor);
        return schnorr.signAsync(messageHash, key, new Uint8Array(32));
    }

    // ── internal helpers ─────────────────────────────────────────────

    private derivePrivateKeyForDescriptor(descriptor: string): Uint8Array {
        const network = isMainnetDescriptor(descriptor) ? networks.bitcoin : networks.testnet;
        const expansion = expand({ descriptor, network });
        if (expansion.isRanged) {
            throw new Error(
                "Cannot sign with a wildcard descriptor; derive a concrete index first",
            );
        }
        const keyInfo = expansion.expansionMap?.["@0"];
        if (!keyInfo?.path) {
            throw new Error("Descriptor must specify a full derivation path for signing");
        }
        const seed = seedBytes.get(this);
        if (!seed) {
            throw new Error("Seed bytes not available for descriptor signing");
        }
        const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
        const node = masterNode.derive(keyInfo.path);
        if (!node.privateKey) {
            throw new Error("Failed to derive private key for descriptor");
        }
        return node.privateKey;
    }

    private signTxWithKey(tx: Transaction, key: Uint8Array, inputIndexes?: number[]): Transaction {
        const txCpy = tx.clone();

        if (!inputIndexes) {
            // scure silently skips an input whose sighash is outside the policy, which the
            // "No inputs signed" catch below would report as nothing to do
            assertAllowedSighashTypes(txCpy, ALLOWED_SIGHASH);

            try {
                if (!txCpy.sign(key, ALLOWED_SIGHASH)) {
                    throw new Error("Failed to sign transaction");
                }
            } catch (e) {
                if (e instanceof Error && e.message.includes("No inputs signed")) {
                    // ignore
                } else {
                    throw e;
                }
            }
        } else {
            // no preflight here: signIdx rejects a disallowed sighash itself,
            // rather than skipping the input the way the bulk path does
            for (const idx of inputIndexes) {
                if (!txCpy.signIdx(key, idx, ALLOWED_SIGHASH)) {
                    throw new Error(`Failed to sign input #${idx}`);
                }
            }
        }

        return txCpy;
    }

    private signMessageWithKey(
        key: Uint8Array,
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa",
    ): Promise<Uint8Array> {
        if (signatureType === "ecdsa") return signAsync(message, key, { prehash: false });
        return schnorr.signAsync(message, key);
    }
}

/**
 * Mnemonic-based identity derived from a BIP39 phrase; recommended where users manage their own
 * backup phrase. Extends @see SeedIdentity with mnemonic validation and an optional passphrase.
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
    private constructor(phrase: string, opts: MnemonicOptions) {
        const { passphrase } = opts;
        super(mnemonicToSeedSync(phrase, passphrase), opts);
        mnemonicMeta.set(this, { mnemonic: phrase, passphrase });
    }

    /**
     * Creates a MnemonicIdentity from a BIP39 phrase: `{ isMainnet }` for default BIP86
     * derivation, or `{ descriptor }` for a template ending in `/*)`, plus optional passphrase.
     *
     * @param phrase - BIP39 mnemonic phrase (12 or 24 words)
     */
    static fromMnemonic(phrase: string, opts: MnemonicOptions = {}): MnemonicIdentity {
        if (!validateMnemonic(phrase, wordlist)) {
            throw new Error("Invalid mnemonic");
        }
        return new MnemonicIdentity(phrase, opts);
    }
}

/**
 * Watch-only HD identity from a wildcard descriptor template (e.g.
 * `tr([fp/86'/0'/0']xpub.../0/*)`): derives public keys and rotates HD indices, cannot sign.
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
export class ReadonlyDescriptorIdentity implements ReadonlyHDCapableIdentity {
    /**
     * Index-0 expansion of {@link descriptor}; the x-only pubkey (32 bytes) and the compressed
     * pubkey (via the bip32 node) are both read off it on demand.
     */
    private readonly indexZero: KeyInfo;
    /** Wildcard account-descriptor template (e.g. `tr([fp/86'/0'/0']xpub/0/*)`). */
    readonly descriptor: string;

    private constructor(descriptor: string) {
        const network = isMainnetDescriptor(descriptor) ? networks.bitcoin : networks.testnet;
        // Re-wrap the library's opaque non-ranged error (see SeedIdentity's constructor).
        let expansion;
        try {
            expansion = expand({ descriptor, network, index: 0 });
        } catch (e) {
            throw new Error(
                `ReadonlyDescriptorIdentity requires a wildcard descriptor template (must end in "/*)"); ${e instanceof Error ? e.message : String(e)}`,
            );
        }
        const keyInfo = expansion.expansionMap?.["@0"];

        if (!keyInfo?.pubkey) {
            throw new Error("Failed to derive public key from descriptor");
        }
        if (!keyInfo.bip32) {
            throw new Error("Cannot determine compressed public key parity from descriptor");
        }

        this.descriptor = descriptor;
        this.indexZero = keyInfo;
    }

    /** @param descriptor - Wildcard-suffixed Taproot template (`tr([fp/path']xpub.../child/*)`). */
    static fromDescriptor(descriptor: string): ReadonlyDescriptorIdentity {
        return new ReadonlyDescriptorIdentity(descriptor);
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        // Validated non-null in the constructor.
        return this.indexZero.pubkey!;
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        const { bip32, keyPath } = this.indexZero;
        // bip32 validated non-null in the constructor; derivePath returns a fresh node.
        if (keyPath) {
            // Strip leading "/" — the library's derivePath prepends "m/" itself
            return bip32!.derivePath(keyPath.replace(/^\//, "")).publicKey;
        }
        return bip32!.publicKey;
    }

    /** Returns true when `descriptor` derives from this identity's xpub. */
    ownsDescriptor(descriptor: string): boolean {
        return descriptorIsOurs(descriptor, this.descriptor, this.indexZero.pubkey!);
    }
}

/**
 * Serialize a seed-backed signing identity into a {@link SerializedSigningIdentity} envelope.
 * Kept out of the `src/identity` barrel; use {@link serializeSigningIdentity}.
 *
 * Secret-surface trade-off: the envelope carries master-seed material (mnemonic + passphrase,
 * or the raw seed), so a reader can derive any key in the HD tree, a larger blast radius than
 * `SingleKey`'s one key. Intentional, to preserve identity across the page / service-worker
 * boundary; the page already holds this material to re-initialize a killed worker. Transport is
 * same-origin `postMessage` only; see the threat model in `src/worker/browser/README.md`.
 *
 * @internal
 */
export function serializeSeedOwnedSigningIdentity(
    identity: SeedIdentity,
): SerializedSigningIdentity {
    if (identity instanceof MnemonicIdentity) {
        const meta = mnemonicMeta.get(identity);
        if (!meta) {
            throw new Error(
                "MnemonicIdentity is missing internal secret state; was it constructed via MnemonicIdentity.fromMnemonic()?",
            );
        }
        const envelope: SerializedSigningIdentity = {
            type: "mnemonic",
            mnemonic: meta.mnemonic,
            descriptor: identity.descriptor,
        };
        if (meta.passphrase !== undefined) {
            envelope.passphrase = meta.passphrase;
        }
        return envelope;
    }
    const seed = seedBytes.get(identity);
    if (!seed) {
        throw new Error(
            "SeedIdentity is missing internal secret state; was it constructed via SeedIdentity.fromSeed() or the class constructor?",
        );
    }
    return {
        type: "seed",
        seed: hex.encode(seed),
        descriptor: identity.descriptor,
    };
}

/**
 * Downgrade a seed- or descriptor-backed identity to a descriptor-only envelope; secret material
 * never crosses this path. Kept out of the barrel; use {@link serializeReadonlyIdentity}.
 *
 * @internal
 */
export function serializeSeedOwnedReadonlyIdentity(
    identity: SeedIdentity | ReadonlyDescriptorIdentity,
): SerializedReadonlyIdentity {
    return {
        type: "readonly-descriptor",
        descriptor: identity.descriptor,
    };
}
