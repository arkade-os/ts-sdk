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
import type {
    SerializedSigningIdentity,
    SerializedReadonlyIdentity,
} from "./serialize";
import {
    DescriptorProvider,
    DescriptorSigningRequest,
} from "./descriptorProvider";
import { isDescriptor } from "./descriptor";

const ALL_SIGHASH = Object.values(SigHash).filter((x) => typeof x === "number");

/**
 * Secret-bearing state for seed-backed identities, held off the public
 * instance surface. Accessed only by the SDK-internal serializer helpers
 * below; application code cannot read these via ordinary field access.
 *
 * Using a module-private WeakMap (rather than `private` / `protected`)
 * matters because TypeScript visibility is a compile-time boundary only:
 * JavaScript consumers could still read public fields. A WeakMap removes
 * that enumeration path entirely.
 */
const seedBytes = new WeakMap<SeedIdentity, Uint8Array>();
const mnemonicMeta = new WeakMap<
    MnemonicIdentity,
    { mnemonic: string; passphrase?: string }
>();

/** Used for default BIP86 derivation with network selection. */
export interface NetworkOptions {
    /**
     * Mainnet (coin type 0) or testnet (coin type 1).
     *
     * @defaultValue `true`
     */
    isMainnet?: boolean;
}

/** Used for custom output descriptor derivation. */
export interface DescriptorOptions {
    /** Custom output descriptor that determines the derivation path. */
    descriptor: string;
}

/** Either default BIP86 derivation (with optional network selection) or a custom descriptor. */
export type SeedIdentityOptions = NetworkOptions | DescriptorOptions;

/** Used for deriving an identity from a BIP39 mnemonic. */
export type MnemonicOptions = SeedIdentityOptions & {
    /** Optional BIP39 passphrase for additional seed entropy. */
    passphrase?: string;
};

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Detects the network from a descriptor string by checking for tpub (testnet)
 * vs xpub (mainnet) key prefix.
 * @internal
 */
function detectNetwork(descriptor: string): Network {
    return descriptor.includes("tpub") ? networks.testnet : networks.bitcoin;
}

function hasDescriptor(
    opts: SeedIdentityOptions = {}
): opts is DescriptorOptions {
    return "descriptor" in opts && typeof opts.descriptor === "string";
}

/**
 * Builds a BIP86 Taproot output descriptor from a seed and network flag.
 * @internal
 */
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

/**
 * Seed-based identity derived from a raw seed and an output descriptor.
 *
 * This is the recommended identity type for most applications. It uses
 * standard BIP86 (Taproot) derivation by default and stores an output
 * descriptor for interoperability with other wallets.
 *
 * Prefer this (or @see MnemonicIdentity) over `SingleKey` for new
 * integrations — `SingleKey` exists for backward compatibility with
 * raw nsec-style keys.
 *
 * For descriptor-based signing, wrap with {@link StaticDescriptorProvider}.
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
export class SeedIdentity implements Identity, DescriptorProvider {
    private readonly derivedKey: Uint8Array;
    readonly descriptor: string;
    readonly isMainnet: boolean;
    private readonly accountXpub: string;

    constructor(seed: Uint8Array, descriptor: string) {
        if (seed.length !== 64) {
            throw new Error("Seed must be 64 bytes");
        }

        // Defensive copy: `derivedKey` and `descriptor` are computed eagerly
        // from the bytes we're about to stash, so a later mutation of the
        // caller's buffer must not drift the serialized `seed` out of sync
        // with the live identity state.
        seedBytes.set(this, new Uint8Array(seed));
        this.descriptor = descriptor;

        const network = detectNetwork(descriptor);
        this.isMainnet = network === networks.bitcoin;

        // Parse and validate the descriptor using the library
        const expansion = expand({ descriptor, network });
        const keyInfo = expansion.expansionMap?.["@0"];

        if (!keyInfo?.originPath) {
            throw new Error("Descriptor must include a key origin path");
        }

        // Verify the xpub in the descriptor matches our seed
        const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
        const accountNode = masterNode.derive(`m${keyInfo.originPath}`);
        if (accountNode.publicExtendedKey !== keyInfo.bip32?.toBase58()) {
            throw new Error(
                "xpub mismatch: derived key does not match descriptor"
            );
        }
        this.accountXpub = accountNode.publicExtendedKey;

        // Derive the private key using the full path from the descriptor
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
     * Creates a SeedIdentity from a raw 64-byte seed.
     *
     * Pass `{ isMainnet }` for default BIP86 derivation, or
     * `{ descriptor }` for a custom derivation path.
     *
     * @param seed - 64-byte seed (typically from mnemonicToSeedSync)
     * @param opts - Network selection or custom descriptor.
     */
    static fromSeed(
        seed: Uint8Array,
        opts: SeedIdentityOptions = {}
    ): SeedIdentity {
        const descriptor = hasDescriptor(opts)
            ? opts.descriptor
            : buildDescriptor(seed, (opts as NetworkOptions).isMainnet ?? true);
        return new SeedIdentity(seed, descriptor);
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
        signatureType: "schnorr" | "ecdsa" = "schnorr"
    ): Promise<Uint8Array> {
        return this.signMessageWithKey(this.derivedKey, message, signatureType);
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

    // ── DescriptorProvider ───────────────────────────────────────────

    /**
     * Returns the account descriptor template with the final path segment
     * replaced by a wildcard `*`. The template is the canonical thing to
     * pass through the system; consumers that need a concrete descriptor
     * at a specific index materialize it themselves (see
     * `HDDescriptorProvider` in the wallet layer for the rotating-counter
     * use case).
     *
     * @example
     * ```ts
     * // If this.descriptor is tr([fp/86'/0'/0']xpub/0/0)
     * identity.getAccountDescriptor();
     * // returns tr([fp/86'/0'/0']xpub/0/*)
     * ```
     */
    getAccountDescriptor(): string {
        const match = this.descriptor.match(/^(.*\/)\d+\)$/);
        if (!match) {
            throw new Error(
                "Cannot build account descriptor: missing trailing numeric index"
            );
        }
        return `${match[1]}*)`;
    }

    /**
     * Returns the current signing descriptor (concrete, at the index this
     * identity was constructed with). Phase C's `HDDescriptorProvider` will
     * return the currently-active receive descriptor instead.
     */
    getSigningDescriptor(): string {
        return this.descriptor;
    }

    /**
     * Returns true when `descriptor` is derived from this identity's seed.
     *
     * HD descriptors match when the master fingerprint and account xpub
     * agree — index and change path are irrelevant. Simple `tr(pubkey)`
     * descriptors match when the x-only pubkey matches.
     */
    isOurs(descriptor: string): boolean {
        if (!isDescriptor(descriptor)) return false;
        try {
            const network = detectNetwork(descriptor);
            // expand() may reject wildcard descriptors — substitute index 0
            // for parsing purposes only.
            const probe = descriptor.replace(/\/\*\)$/, "/0)");
            const expansion = expand({ descriptor: probe, network });
            const keyInfo = expansion.expansionMap?.["@0"];
            if (!keyInfo) return false;

            // HD case: compare account xpub (and implicitly the fingerprint
            // because two seeds cannot produce the same xpub).
            if (keyInfo.bip32) {
                return keyInfo.bip32.toBase58() === this.accountXpub;
            }

            // Static case: compare raw pubkey against our derived key.
            if (keyInfo.pubkey) {
                return (
                    hex.encode(keyInfo.pubkey) ===
                    hex.encode(pubSchnorr(this.derivedKey))
                );
            }
            return false;
        } catch {
            return false;
        }
    }

    /**
     * Signs each request with the key derived from its descriptor.
     * Each descriptor must share this identity's seed ({@link isOurs}).
     */
    async signWithDescriptor(
        requests: DescriptorSigningRequest[]
    ): Promise<Transaction[]> {
        return requests.map((request) => {
            if (!this.isOurs(request.descriptor)) {
                throw new Error(
                    `Descriptor ${request.descriptor} does not belong to this identity`
                );
            }
            const key = this.derivePrivateKeyForDescriptor(request.descriptor);
            return this.signTxWithKey(request.tx, key, request.inputIndexes);
        });
    }

    /**
     * Signs a message with the key derived from `descriptor`.
     */
    async signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr"
    ): Promise<Uint8Array> {
        if (!this.isOurs(descriptor)) {
            throw new Error(
                `Descriptor ${descriptor} does not belong to this identity`
            );
        }
        const key = this.derivePrivateKeyForDescriptor(descriptor);
        return this.signMessageWithKey(key, message, signatureType);
    }

    // ── internal helpers ─────────────────────────────────────────────

    private derivePrivateKeyForDescriptor(descriptor: string): Uint8Array {
        if (descriptor.includes("/*)")) {
            throw new Error(
                "Cannot sign with a wildcard descriptor; derive a concrete index first"
            );
        }
        const network = detectNetwork(descriptor);
        const expansion = expand({ descriptor, network });
        const keyInfo = expansion.expansionMap?.["@0"];
        if (!keyInfo?.path) {
            throw new Error(
                "Descriptor must specify a full derivation path for signing"
            );
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

    private signTxWithKey(
        tx: Transaction,
        key: Uint8Array,
        inputIndexes?: number[]
    ): Transaction {
        const txCpy = tx.clone();

        if (!inputIndexes) {
            try {
                if (!txCpy.sign(key, ALL_SIGHASH)) {
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
        } else {
            for (const idx of inputIndexes) {
                if (!txCpy.signIdx(key, idx, ALL_SIGHASH)) {
                    throw new Error(`Failed to sign input #${idx}`);
                }
            }
        }

        return txCpy;
    }

    private signMessageWithKey(
        key: Uint8Array,
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa"
    ): Promise<Uint8Array> {
        if (signatureType === "ecdsa")
            return signAsync(message, key, { prehash: false });
        return schnorr.signAsync(message, key);
    }
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
export class MnemonicIdentity extends SeedIdentity {
    private constructor(
        seed: Uint8Array,
        descriptor: string,
        mnemonic: string,
        passphrase: string | undefined
    ) {
        super(seed, descriptor);
        mnemonicMeta.set(this, { mnemonic, passphrase });
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
        opts: MnemonicOptions = {}
    ): MnemonicIdentity {
        if (!validateMnemonic(phrase, wordlist)) {
            throw new Error("Invalid mnemonic");
        }
        const passphrase = opts.passphrase;
        const seed = mnemonicToSeedSync(phrase, passphrase);
        const descriptor = hasDescriptor(opts)
            ? opts.descriptor
            : buildDescriptor(seed, (opts as NetworkOptions).isMainnet ?? true);
        return new MnemonicIdentity(seed, descriptor, phrase, passphrase);
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

/**
 * Serialize a seed-backed signing identity into a
 * {@link SerializedSigningIdentity} envelope without exposing the
 * underlying secret material on the public instance surface.
 *
 * Called by {@link serializeSigningIdentity}; application code should
 * prefer that public dispatcher instead of calling this directly. This
 * helper is deliberately kept out of the `src/identity` barrel so it is
 * not part of the package's public export surface.
 *
 * Secret-surface trade-off: the resulting envelope carries master-seed
 * material — the BIP39 mnemonic (+ optional passphrase) for
 * `MnemonicIdentity` or the raw 64-byte seed for `SeedIdentity`. A party
 * that reads this envelope can derive any key under the HD tree, not
 * just the key currently in use. The pre-change `SingleKey` flow only
 * shipped one derived private key and therefore had a smaller blast
 * radius. This is an intentional design trade to preserve class and
 * descriptor identity across the page / service-worker boundary; the
 * page already holds the same material so that it can re-initialize a
 * killed worker. Transport is same-origin `postMessage` only. See the
 * threat-model note in `src/worker/browser/README.md`.
 *
 * @internal
 */
export function serializeSeedOwnedSigningIdentity(
    identity: SeedIdentity
): SerializedSigningIdentity {
    if (identity instanceof MnemonicIdentity) {
        const meta = mnemonicMeta.get(identity);
        if (!meta) {
            throw new Error(
                "MnemonicIdentity is missing internal secret state; was it constructed via MnemonicIdentity.fromMnemonic()?"
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
            "SeedIdentity is missing internal secret state; was it constructed via SeedIdentity.fromSeed() or the class constructor?"
        );
    }
    return {
        type: "seed",
        seed: hex.encode(seed),
        descriptor: identity.descriptor,
    };
}

/**
 * Downgrade a seed-backed or descriptor-backed identity into a readonly
 * descriptor envelope. Always produces a descriptor-only shape — secret
 * material never crosses this path, even if the input is a signing
 * identity.
 *
 * Deliberately kept out of the `src/identity` barrel; consumers should go
 * through {@link serializeReadonlyIdentity}.
 *
 * @internal
 */
export function serializeSeedOwnedReadonlyIdentity(
    identity: SeedIdentity | ReadonlyDescriptorIdentity
): SerializedReadonlyIdentity {
    return { type: "readonly-descriptor", descriptor: identity.descriptor };
}
