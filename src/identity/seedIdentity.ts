import { validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { pubECDSA, pubSchnorr } from "@scure/btc-signer/utils.js";
import { SigHash } from "@scure/btc-signer";
import { hex } from "@scure/base";
import { Transaction } from "../utils/transaction";
import { SignerSession, TreeSignerSession } from "../tree/signingSession";
import { schnorr, signAsync } from "@noble/secp256k1";
import {
    HDKey,
    expand,
    networks,
    scriptExpressions,
    type KeyInfo,
} from "@bitcoinerlab/descriptors-scure";
import type {
    SerializedSigningIdentity,
    SerializedReadonlyIdentity,
} from "./serialize";
import { DescriptorSigningRequest } from "./descriptorProvider";
import {
    HDCapableIdentity,
    ReadonlyHDCapableIdentity,
} from "./hdCapableIdentity";
import { descriptorIsOurs, isMainnetDescriptor } from "./descriptor";

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

/** Used for a caller-supplied account-descriptor template. */
export interface DescriptorOptions {
    /**
     * Account-descriptor *template* — must end with the BIP-32 wildcard
     * suffix `/*)`. Stored as-is on {@link SeedIdentity.descriptor} and
     * read by HD providers to rotate through derivation indices.
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

// ── Helpers ──────────────────────────────────────────────────────

function hasDescriptor(
    opts: SeedIdentityOptions = {}
): opts is DescriptorOptions {
    return "descriptor" in opts && typeof opts.descriptor === "string";
}

/**
 * Pick the wildcard descriptor a {@link SeedIdentityOptions} resolves to:
 * either the caller-supplied `{ descriptor }` or a freshly-built BIP86
 * default at the requested network. Shared between
 * {@link SeedIdentity.fromSeed} and
 * {@link MnemonicIdentity.fromMnemonic} so the two factories agree on
 * the rule.
 */
function descriptorForOptions(
    seed: Uint8Array,
    opts: SeedIdentityOptions
): string {
    if (hasDescriptor(opts)) return opts.descriptor;
    const network =
        ((opts as NetworkOptions).isMainnet ?? true)
            ? networks.bitcoin
            : networks.testnet;
    return scriptExpressions.trBIP32({
        masterNode: HDKey.fromMasterSeed(seed, network.bip32),
        network,
        account: 0,
        change: 0,
        index: "*",
    });
}

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
export class SeedIdentity implements HDCapableIdentity {
    private readonly derivedKey: Uint8Array;
    /**
     * Wildcard account-descriptor template (e.g.
     * `tr([fp/86'/0'/0']xpub/0/*)`). The canonical thing to pass
     * through the system; consumers materialize a concrete descriptor
     * at a specific index themselves (see `HDDescriptorProvider` in
     * the wallet layer for the rotating-counter use case).
     */
    readonly descriptor: string;

    /**
     * Constructs a SeedIdentity from a 64-byte seed and an account
     * descriptor *template* (must end in `/*)`). Prefer the
     * {@link fromSeed} factory, which builds the BIP86 template via
     * `scriptExpressions.trBIP32` for the default path.
     *
     * Throws on a non-template descriptor, an xpub mismatch with the
     * seed, or a missing derivation path in the template.
     */
    constructor(seed: Uint8Array, descriptor: string) {
        if (seed.length !== 64) {
            throw new Error("Seed must be 64 bytes");
        }

        const network = isMainnetDescriptor(descriptor)
            ? networks.bitcoin
            : networks.testnet;

        // Parse the descriptor, substituting the wildcard at index 0.
        // The library raises "index passed for non-ranged descriptor"
        // if the input isn't a wildcard template, which we re-wrap so
        // the caller sees what they actually got wrong.
        let expansion;
        try {
            expansion = expand({ descriptor, network, index: 0 });
        } catch (e) {
            throw new Error(
                `SeedIdentity requires a wildcard descriptor template (must end in "/*)"); ${e instanceof Error ? e.message : String(e)}`
            );
        }
        const keyInfo = expansion.expansionMap?.["@0"];

        // Defensive copy: `derivedKey` and `descriptor` are computed eagerly
        // from the bytes we're about to stash, so a later mutation of the
        // caller's buffer must not drift the serialized `seed` out of sync
        // with the live identity state.
        seedBytes.set(this, new Uint8Array(seed));
        this.descriptor = descriptor;

        if (!keyInfo?.originPath) {
            throw new Error("Descriptor must include a key origin path");
        }

        // Verify the xpub in the descriptor matches our seed (validates
        // that the descriptor was generated from this seed; we don't
        // need to keep the xpub around afterwards — `isOurs` re-derives
        // it from `this.descriptor` on demand).
        const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
        const accountNode = masterNode.derive(`m${keyInfo.originPath}`);
        if (accountNode.publicExtendedKey !== keyInfo.bip32?.toBase58()) {
            throw new Error(
                "xpub mismatch: derived key does not match descriptor"
            );
        }

        // Derive the private key for index 0 using the full path
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
     * `{ descriptor }` for a caller-supplied account-descriptor
     * template (the option's value must end with `/*)`).
     *
     * @param seed - 64-byte seed (typically from mnemonicToSeedSync)
     * @param opts - Network selection or descriptor template.
     */
    static fromSeed(
        seed: Uint8Array,
        opts: SeedIdentityOptions = {}
    ): SeedIdentity {
        return new SeedIdentity(seed, descriptorForOptions(seed, opts));
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
     * Converts to a watch-only identity that cannot sign. Carries the
     * template forward, so the readonly side stays HD-capable (can
     * derive descriptors at any index without seed access).
     */
    async toReadonly(): Promise<ReadonlyDescriptorIdentity> {
        return ReadonlyDescriptorIdentity.fromDescriptor(this.descriptor);
    }

    /**
     * Returns true when `descriptor` is derived from this identity's seed.
     * HD descriptors match by account xpub; bare `tr(pubkey)` descriptors
     * match by raw pubkey. See {@link descriptorIsOurs}.
     */
    isOurs(descriptor: string): boolean {
        return descriptorIsOurs(
            descriptor,
            this.descriptor,
            pubSchnorr(this.derivedKey)
        );
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
        const network = isMainnetDescriptor(descriptor)
            ? networks.bitcoin
            : networks.testnet;
        const expansion = expand({ descriptor, network });
        if (expansion.isRanged) {
            throw new Error(
                "Cannot sign with a wildcard descriptor; derive a concrete index first"
            );
        }
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
     * `{ descriptor }` for a caller-supplied account-descriptor
     * template (the option's value must end with `/*)`).
     *
     * @param phrase - BIP39 mnemonic phrase (12 or 24 words)
     * @param opts - Network selection or descriptor template, plus optional passphrase
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
        return new MnemonicIdentity(
            seed,
            descriptorForOptions(seed, opts),
            phrase,
            passphrase
        );
    }
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
export class ReadonlyDescriptorIdentity implements ReadonlyHDCapableIdentity {
    /**
     * Index-0 expansion of {@link descriptor}. Both the x-only pubkey
     * (taproot, returned by the library as 32 bytes) and the compressed
     * pubkey (derived through the bip32 node when needed) are read off
     * this on demand — no separate caches.
     */
    private readonly indexZero: KeyInfo;
    /**
     * Wildcard account-descriptor template (e.g.
     * `tr([fp/86'/0'/0']xpub/0/*)`). HD rotation consumers materialize
     * a concrete descriptor at a specific index themselves.
     */
    readonly descriptor: string;

    private constructor(descriptor: string) {
        const network = isMainnetDescriptor(descriptor)
            ? networks.bitcoin
            : networks.testnet;
        // Library substitutes the wildcard at index 0 and raises
        // "index passed for non-ranged descriptor" if `descriptor` isn't
        // actually a wildcard template — re-wrap so the caller sees
        // the higher-level invariant they violated.
        let expansion;
        try {
            expansion = expand({ descriptor, network, index: 0 });
        } catch (e) {
            throw new Error(
                `ReadonlyDescriptorIdentity requires a wildcard descriptor template (must end in "/*)"); ${e instanceof Error ? e.message : String(e)}`
            );
        }
        const keyInfo = expansion.expansionMap?.["@0"];

        if (!keyInfo?.pubkey) {
            throw new Error("Failed to derive public key from descriptor");
        }
        if (!keyInfo.bip32) {
            throw new Error(
                "Cannot determine compressed public key parity from descriptor"
            );
        }

        this.descriptor = descriptor;
        this.indexZero = keyInfo;
    }

    /**
     * Creates a ReadonlyDescriptorIdentity from an account-descriptor
     * *template* (must end with the BIP-32 wildcard suffix `/*)`).
     *
     * @param descriptor - Wildcard-suffixed Taproot template
     *   (`tr([fp/path']xpub.../child/*)`).
     */
    static fromDescriptor(descriptor: string): ReadonlyDescriptorIdentity {
        return new ReadonlyDescriptorIdentity(descriptor);
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        // Validated non-null in the constructor.
        return this.indexZero.pubkey!;
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        const { bip32, keyPath } = this.indexZero;
        // bip32 validated non-null in the constructor; derivePath
        // returns a fresh node so this is a read of the index-0
        // compressed pubkey, not a mutation of the stored one.
        if (keyPath) {
            // Strip leading "/" — the library's derivePath prepends "m/" itself
            return bip32!.derivePath(keyPath.replace(/^\//, "")).publicKey;
        }
        return bip32!.publicKey;
    }

    /**
     * Returns true when `descriptor` derives from this identity's xpub.
     * HD descriptors match by account xpub; bare `tr(pubkey)` descriptors
     * fall back to comparing against the index-0 x-only pubkey. See
     * {@link descriptorIsOurs}.
     */
    isOurs(descriptor: string): boolean {
        return descriptorIsOurs(
            descriptor,
            this.descriptor,
            this.indexZero.pubkey!
        );
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
    return {
        type: "readonly-descriptor",
        descriptor: identity.descriptor,
    };
}
