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
import {
    descriptorIsOurs,
    isMainnetDescriptor,
    isWildcardTemplate,
    materializeAtIndex,
} from "./descriptor";

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
export interface TemplateOptions {
    /**
     * Account descriptor *template* — must end with the BIP-32 wildcard
     * suffix `/*)`. The seed-backed identity materializes at index 0
     * for its public {@link SeedIdentity.descriptor} field; the
     * template itself drives HD rotation.
     */
    template: string;
}

/** Either default BIP86 derivation (with optional network selection) or a caller-supplied template. */
export type SeedIdentityOptions = NetworkOptions | TemplateOptions;

/** Used for deriving an identity from a BIP39 mnemonic. */
export type MnemonicOptions = SeedIdentityOptions & {
    /** Optional BIP39 passphrase for additional seed entropy. */
    passphrase?: string;
};

// ── Helpers ──────────────────────────────────────────────────────

function hasTemplate(opts: SeedIdentityOptions = {}): opts is TemplateOptions {
    return "template" in opts && typeof opts.template === "string";
}

/**
 * Builds the BIP86 Taproot account-descriptor *template* for the
 * default account/change branch, via `scriptExpressions.trBIP32` with
 * the library's `index: '*'` wildcard. Used by the
 * {@link SeedIdentity.fromSeed} / {@link MnemonicIdentity.fromMnemonic}
 * default paths; callers that want a different path supply a template
 * directly via {@link TemplateOptions}.
 * @internal
 */
function buildTemplate(seed: Uint8Array, isMainnet: boolean): string {
    const network = isMainnet ? networks.bitcoin : networks.testnet;
    const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
    return scriptExpressions.trBIP32({
        masterNode,
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
 * The identity holds the *template* (e.g. `tr([fp/86'/0'/0']xpub/0/*)`)
 * and exposes a single static "this is who I am" descriptor — the
 * template materialized at index 0 — through {@link descriptor}. HD
 * rotation through other indices happens at the
 * `HDDescriptorProvider` layer, which reads the template via
 * {@link getAccountDescriptor}.
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
 * // Testnet (BIP86 template m/86'/1'/0'/0/*)
 * const identity = SeedIdentity.fromSeed(seed, { isMainnet: false });
 *
 * // Mainnet (BIP86 template m/86'/0'/0'/0/*)
 * const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
 *
 * // Caller-supplied template
 * const identity = SeedIdentity.fromSeed(seed, { template });
 * ```
 */
export class SeedIdentity implements HDCapableIdentity {
    private readonly derivedKey: Uint8Array;
    /**
     * Static "this is who I am" descriptor — the {@link template}
     * materialized at index 0. Useful as a stable per-identity handle
     * (e.g. for serialization / display); HD rotation reads the
     * template directly via {@link getAccountDescriptor}.
     */
    readonly descriptor: string;
    readonly isMainnet: boolean;
    private readonly accountXpub: string;
    private readonly template: string;

    /**
     * Constructs a SeedIdentity from a 64-byte seed and an account
     * descriptor *template* (must end in `/*)`). Prefer the
     * {@link fromSeed} factory, which builds the BIP86 template via
     * `scriptExpressions.trBIP32` for the default path.
     *
     * Throws on a non-template descriptor, an xpub mismatch with the
     * seed, or a missing derivation path in the template.
     */
    constructor(seed: Uint8Array, template: string) {
        if (seed.length !== 64) {
            throw new Error("Seed must be 64 bytes");
        }
        if (!isWildcardTemplate(template)) {
            throw new Error(
                `SeedIdentity requires a wildcard descriptor template (must end in "/*)"); got "${template}"`
            );
        }

        // Defensive copy: `derivedKey` and `descriptor` are computed eagerly
        // from the bytes we're about to stash, so a later mutation of the
        // caller's buffer must not drift the serialized `seed` out of sync
        // with the live identity state.
        seedBytes.set(this, new Uint8Array(seed));
        this.template = template;
        this.descriptor = materializeAtIndex(template, 0);

        this.isMainnet = isMainnetDescriptor(template);
        const network = this.isMainnet ? networks.bitcoin : networks.testnet;

        // Parse and validate the template using the library — pass
        // `index: 0` so `expand()` substitutes the wildcard for us.
        const expansion = expand({ descriptor: template, network, index: 0 });
        const keyInfo = expansion.expansionMap?.["@0"];

        if (!keyInfo?.originPath) {
            throw new Error("Template must include a key origin path");
        }

        // Verify the xpub in the template matches our seed
        const masterNode = HDKey.fromMasterSeed(seed, network.bip32);
        const accountNode = masterNode.derive(`m${keyInfo.originPath}`);
        if (accountNode.publicExtendedKey !== keyInfo.bip32?.toBase58()) {
            throw new Error(
                "xpub mismatch: derived key does not match template"
            );
        }
        this.accountXpub = accountNode.publicExtendedKey;

        // Derive the private key for index 0 using the full path
        if (!keyInfo.path) {
            throw new Error("Template must specify a full derivation path");
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
     * `{ template }` for a caller-supplied account-descriptor template.
     *
     * @param seed - 64-byte seed (typically from mnemonicToSeedSync)
     * @param opts - Network selection or template descriptor.
     */
    static fromSeed(
        seed: Uint8Array,
        opts: SeedIdentityOptions = {}
    ): SeedIdentity {
        const template = hasTemplate(opts)
            ? opts.template
            : buildTemplate(seed, (opts as NetworkOptions).isMainnet ?? true);
        return new SeedIdentity(seed, template);
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
        return ReadonlyDescriptorIdentity.fromTemplate(this.template);
    }

    // ── HDCapableIdentity ────────────────────────────────────────────

    /**
     * Returns the account descriptor template (e.g.
     * `tr([fp/86'/0'/0']xpub/0/*)`). The template is the canonical
     * thing to pass through the system; consumers that need a concrete
     * descriptor at a specific index materialize it themselves (see
     * `HDDescriptorProvider` in the wallet layer for the rotating-
     * counter use case).
     *
     * The template is exactly what was passed to the constructor; this
     * is a getter, not a recomputation.
     */
    getAccountDescriptor(): string {
        return this.template;
    }

    /**
     * Returns true when `descriptor` is derived from this identity's seed.
     * HD descriptors match by account xpub; bare `tr(pubkey)` descriptors
     * match by raw pubkey. See {@link descriptorIsOurs}.
     */
    isOurs(descriptor: string): boolean {
        return descriptorIsOurs(
            descriptor,
            this.accountXpub,
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
        if (isWildcardTemplate(descriptor)) {
            throw new Error(
                "Cannot sign with a wildcard descriptor; derive a concrete index first"
            );
        }
        const network = isMainnetDescriptor(descriptor)
            ? networks.bitcoin
            : networks.testnet;
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
        template: string,
        mnemonic: string,
        passphrase: string | undefined
    ) {
        super(seed, template);
        mnemonicMeta.set(this, { mnemonic, passphrase });
    }

    /**
     * Creates a MnemonicIdentity from a BIP39 mnemonic phrase.
     *
     * Pass `{ isMainnet }` for default BIP86 derivation, or
     * `{ template }` for a caller-supplied account-descriptor template.
     *
     * @param phrase - BIP39 mnemonic phrase (12 or 24 words)
     * @param opts - Network selection or template descriptor, plus optional passphrase
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
        const template = hasTemplate(opts)
            ? opts.template
            : buildTemplate(seed, (opts as NetworkOptions).isMainnet ?? true);
        return new MnemonicIdentity(seed, template, phrase, passphrase);
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
 * `tr([fp/86'/0'/0']xpub.../0/*)`). The {@link descriptor} field
 * exposes the index-0 materialization as a stable per-identity handle;
 * the template itself is what HD providers consume via
 * {@link getAccountDescriptor}.
 *
 * @example
 * ```typescript
 * const ro = ReadonlyDescriptorIdentity.fromTemplate(
 *   "tr([fp/86'/0'/0']xpub.../0/*)"
 * );
 * ro.descriptor;
 * // => "tr([fp/86'/0'/0']xpub.../0/0)" — index-0 form
 * ro.getAccountDescriptor();
 * // => "tr([fp/86'/0'/0']xpub.../0/*)" — original template
 * ```
 */
export class ReadonlyDescriptorIdentity implements ReadonlyHDCapableIdentity {
    private readonly xOnlyPubKey: Uint8Array;
    private readonly compressedPubKey: Uint8Array;
    private readonly accountXpub: string | undefined;
    private readonly template: string;
    /**
     * Static "this is who I am" descriptor — the template materialized
     * at index 0. Useful as a stable per-identity handle (e.g. for
     * serialization / display); HD rotation reads the template
     * directly via {@link getAccountDescriptor}.
     */
    readonly descriptor: string;

    private constructor(template: string) {
        if (!isWildcardTemplate(template)) {
            throw new Error(
                `ReadonlyDescriptorIdentity requires a wildcard descriptor template (must end in "/*)"); got "${template}"`
            );
        }
        this.template = template;
        this.descriptor = materializeAtIndex(template, 0);

        // Let the library substitute the wildcard via its `index`
        // parameter rather than re-doing it ourselves.
        const network = isMainnetDescriptor(template)
            ? networks.bitcoin
            : networks.testnet;
        const expansion = expand({ descriptor: template, network, index: 0 });
        const keyInfo = expansion.expansionMap?.["@0"];

        if (!keyInfo?.pubkey) {
            throw new Error("Failed to derive public key from template");
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
                "Cannot determine compressed public key parity from template"
            );
        }

        this.accountXpub = keyInfo.bip32?.toBase58();
    }

    /**
     * Creates a ReadonlyDescriptorIdentity from an account-descriptor
     * *template*.
     *
     * @param template - Wildcard-suffixed Taproot template
     *   (`tr([fp/path']xpub.../child/*)`).
     */
    static fromTemplate(template: string): ReadonlyDescriptorIdentity {
        return new ReadonlyDescriptorIdentity(template);
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        return this.xOnlyPubKey;
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        return this.compressedPubKey;
    }

    /**
     * Returns the wildcard-suffixed account descriptor template — the
     * canonical thing to pass through the system for HD rotation.
     */
    getAccountDescriptor(): string {
        return this.template;
    }

    /**
     * Returns true when `descriptor` derives from this identity's xpub.
     * HD descriptors match by account xpub; bare `tr(pubkey)` descriptors
     * fall back to comparing against the cached x-only pubkey (index 0
     * for a template input). See {@link descriptorIsOurs}.
     */
    isOurs(descriptor: string): boolean {
        return descriptorIsOurs(descriptor, this.accountXpub, this.xOnlyPubKey);
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
