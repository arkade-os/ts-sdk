import { hex } from "@scure/base";
import { pubSchnorr } from "@scure/btc-signer/utils.js";
import { DescriptorProvider, DescriptorSigningRequest } from "./descriptorProvider";
import { normalizeToDescriptor, extractPubKey } from "./descriptor";
import { SingleKey } from "./singleKey";
import { WalletRepository, WalletState } from "../repositories/walletRepository";
import { updateWalletState } from "../utils/syncCursors";
import { Transaction } from "../utils/transaction";

/**
 * Persisted keyring state stored under {@link WalletState.settings}`.keyring`.
 * @internal
 */
interface KeyringSettings {
    /**
     * Imported raw keys, mapped x-only pubkey hex → private key hex. The
     * pubkey is the map key (not the full descriptor) so lookups stay
     * canonical regardless of how a caller spelled the descriptor.
     */
    keys: Record<string, string>;
}

/** Settings key under {@link WalletState.settings} where keyring state lives. */
const KEYRING_SETTINGS_KEY = "keyring";

/**
 * A {@link DescriptorProvider} decorator that adds a **keyring**: raw
 * private keys imported from outside the wallet's derivation tree, each
 * addressed by a `tr(<pubkey>)` descriptor.
 *
 * Resolution is union-shaped — `signWithDescriptor` /
 * `signMessageWithDescriptor` serve a descriptor from the wrapped
 * provider's derivation tree *or* from the keyring, whichever owns it —
 * so the wallet's existing descriptor routing
 * (`InputSignerRouter`) signs foreign-key contracts with no changes: an
 * imported contract carrying `metadata.signingDescriptor` is signable by
 * construction rather than throwing `MissingSigningDescriptorError`.
 *
 * Allocation is *not* extended: `getNextSigningDescriptor` always
 * delegates to the wrapped provider. The keyring holds foreign keys the
 * wallet was handed; it never mints receive addresses.
 *
 * Lifecycle: entries persist under
 * `WalletRepository.getWalletState().settings.keyring` (same
 * no-migration pattern as `HDDescriptorProvider`), so an import survives
 * the restarts a recovery spans, and {@link deleteKey} purges it when
 * recovery completes.
 *
 * **Keys are stored unencrypted.** This is a deliberate, scoped
 * decision: the intended use is a short-lived, purge-on-completion hold
 * of a key that guards funds already destined for this wallet. At-rest
 * encryption is a possible hardening follow-up. Do not use this to hold
 * long-lived key material.
 *
 * @example
 * ```ts
 * const provider = await KeyringDescriptorProvider.create(hdProvider, walletRepo);
 * const descriptor = await provider.importKey(foreignPrivKey);
 * // descriptor: tr(<x-only pubkey hex>)
 * // ... import a contract with metadata.signingDescriptor = descriptor,
 * //     let the wallet's recovery machinery settle it, then:
 * await provider.deleteKey(descriptor);
 * ```
 */
export class KeyringDescriptorProvider implements DescriptorProvider {
    /**
     * In-memory mirror of the persisted keyring, keyed by x-only pubkey
     * hex. Required because {@link isOurs} is synchronous while
     * persistence is not; kept in lockstep with storage by
     * {@link importKey} / {@link deleteKey}, and seeded at
     * {@link create}.
     */
    private readonly keys: Map<string, SingleKey>;

    private constructor(
        /**
         * The wrapped provider. Exposed so callers that need to reach a
         * concrete provider type behind the decorator (e.g. the wallet's
         * restore path, which branches on `HDDescriptorProvider`) can
         * unwrap it rather than mis-classify the decorator.
         */
        readonly base: DescriptorProvider,
        private readonly walletRepository: WalletRepository,
        entries: Map<string, SingleKey>,
    ) {
        this.keys = entries;
    }

    /**
     * Wrap `base` with a keyring, loading any previously imported keys
     * from the repository. Unlike `HDDescriptorProvider.create`, this
     * *does* read at construction: `isOurs` is synchronous and must be
     * able to answer for persisted keys from the first call.
     */
    static async create(
        base: DescriptorProvider,
        walletRepository: WalletRepository,
    ): Promise<KeyringDescriptorProvider> {
        const state = await walletRepository.getWalletState();
        const settings = parseSettings(state ?? {});
        const entries = new Map<string, SingleKey>();
        for (const [pubKeyHex, privKeyHex] of Object.entries(settings.keys)) {
            entries.set(pubKeyHex, SingleKey.fromHex(privKeyHex));
        }
        const provider = new KeyringDescriptorProvider(base, walletRepository, entries);
        forwardOptionalCapabilities(provider, base);
        return provider;
    }

    /**
     * Import a raw private key into the keyring and return its
     * `tr(<x-only pubkey>)` descriptor handle. Idempotent: re-importing
     * the same key returns the same descriptor and leaves storage
     * unchanged.
     */
    async importKey(privateKey: Uint8Array): Promise<string> {
        // Clone: SingleKey retains the array by reference, and an import
        // API must not alias a buffer the caller may zeroize or reuse.
        const keyBytes = new Uint8Array(privateKey);
        const pubKeyHex = hex.encode(pubSchnorr(keyBytes));
        await this.mutate((settings) => {
            settings.keys[pubKeyHex] = hex.encode(keyBytes);
        });
        this.keys.set(pubKeyHex, SingleKey.fromPrivateKey(keyBytes));
        return `tr(${pubKeyHex})`;
    }

    /**
     * Purge a keyring entry. Returns `true` when an entry was removed,
     * `false` when the descriptor was not in the keyring (already
     * purged, or never ours) — so a repeated purge is a safe no-op.
     */
    async deleteKey(descriptor: string): Promise<boolean> {
        const pubKeyHex = keyOf(descriptor);
        if (!pubKeyHex || !this.keys.has(pubKeyHex)) return false;
        await this.mutate((settings) => {
            delete settings.keys[pubKeyHex];
        });
        this.keys.delete(pubKeyHex);
        return true;
    }

    /** True iff `descriptor` resolves to a key held in the keyring. */
    hasKey(descriptor: string): boolean {
        const pubKeyHex = keyOf(descriptor);
        return pubKeyHex !== undefined && this.keys.has(pubKeyHex);
    }

    /** The `tr(<pubkey>)` descriptors of every key currently held. */
    listKeyringDescriptors(): string[] {
        return Array.from(this.keys.keys(), (pubKeyHex) => `tr(${pubKeyHex})`);
    }

    /** Allocation is the wrapped provider's job; the keyring never mints. */
    async getNextSigningDescriptor(): Promise<string> {
        return this.base.getNextSigningDescriptor();
    }

    /** Ours iff the wrapped provider claims it, or the keyring holds it. */
    isOurs(descriptor: string): boolean {
        return this.base.isOurs(descriptor) || this.hasKey(descriptor);
    }

    /**
     * Signs each request with the key its descriptor resolves to.
     * Keyring-owned requests are signed here; every other request is
     * handed to the wrapped provider in a single batched call, so a
     * batch-signing identity behind a `StaticDescriptorProvider` still
     * sees one interaction.
     *
     * Results are returned in request order regardless of how the
     * requests split across the two signers.
     */
    async signWithDescriptor(requests: DescriptorSigningRequest[]): Promise<Transaction[]> {
        const results = new Array<Transaction>(requests.length);
        const delegated: { request: DescriptorSigningRequest; index: number }[] = [];

        for (const [index, request] of requests.entries()) {
            const key = this.resolveKey(request.descriptor);
            if (key) {
                results[index] = await key.sign(request.tx, request.inputIndexes);
            } else {
                delegated.push({ request, index });
            }
        }

        if (delegated.length > 0) {
            const signed = await this.base.signWithDescriptor(delegated.map((d) => d.request));
            if (signed.length !== delegated.length) {
                throw new Error(
                    `Base provider returned ${signed.length} transactions, expected ${delegated.length}`,
                );
            }
            for (const [i, { index }] of delegated.entries()) {
                results[index] = signed[i];
            }
        }

        return results;
    }

    /** Signs a message with the keyring key, or delegates to the base. */
    async signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        type: "schnorr" | "ecdsa" = "schnorr",
    ): Promise<Uint8Array> {
        const key = this.resolveKey(descriptor);
        if (key) return key.signMessage(message, type);
        return this.base.signMessageWithDescriptor(descriptor, message, type);
    }

    // ── internals ────────────────────────────────────────────────────

    /**
     * The keyring key for `descriptor`, or `undefined` when the request
     * belongs to the base provider. Base ownership wins on collision:
     * a key already in the derivation tree keeps its established signing
     * path, so importing it cannot reroute existing contracts.
     */
    private resolveKey(descriptor: string): SingleKey | undefined {
        if (this.base.isOurs(descriptor)) return undefined;
        const pubKeyHex = keyOf(descriptor);
        return pubKeyHex ? this.keys.get(pubKeyHex) : undefined;
    }

    /**
     * Read-modify-write the keyring settings inside the shared per-repo
     * wallet-state mutex, so concurrent imports/purges — including those
     * driven by separate provider instances on the same repo — cannot
     * clobber each other's entries.
     */
    private async mutate(fn: (settings: KeyringSettings) => void): Promise<void> {
        await updateWalletState(this.walletRepository, (state) => {
            const settings = parseSettings(state);
            fn(settings);
            return {
                ...state,
                settings: {
                    ...(state.settings ?? {}),
                    [KEYRING_SETTINGS_KEY]: settings,
                },
            };
        });
    }
}

/**
 * Canonical map key for a descriptor: its lowercase x-only pubkey hex,
 * or `undefined` when the descriptor is not a bare `tr(<pubkey>)` (HD
 * descriptors and malformed input included — neither can name a keyring
 * entry).
 */
function keyOf(descriptor: string): string | undefined {
    try {
        return extractPubKey(normalizeToDescriptor(descriptor)).toLowerCase();
    } catch {
        return undefined;
    }
}

/**
 * Validate persisted keyring settings (or initialize a fresh record when
 * absent) and return a clone safe for the caller to mutate. Trusting
 * storage blindly would let a corrupted repo surface as a signing
 * failure deep in a settlement; fail loud at the boundary instead.
 *
 * Both halves of every entry are checked, including that the pubkey the
 * entry is *filed under* is the one its private key actually derives.
 * That correspondence is what `isOurs` implicitly asserts: a mismatched
 * pair would have the provider claim a descriptor and then sign it with
 * the wrong key — a failure that would otherwise only surface when the
 * server rejected the resulting settlement.
 *
 * Pubkeys are normalized to lowercase so the stored map keys match the
 * canonical form {@link keyOf} produces for lookups.
 */
function parseSettings(state: WalletState): KeyringSettings {
    const stored = state.settings?.[KEYRING_SETTINGS_KEY] as KeyringSettings | undefined;
    if (!stored) return { keys: {} };
    if (typeof stored.keys !== "object" || stored.keys === null) {
        throw new Error("Corrupt keyring settings: `keys` is not an object.");
    }

    const keys: Record<string, string> = {};
    for (const [storedPubKeyHex, privKeyHex] of Object.entries(stored.keys)) {
        const pubKeyHex = storedPubKeyHex.toLowerCase();
        if (!isHexOfBytes(pubKeyHex, 32)) {
            throw new Error(
                `Corrupt keyring settings: "${storedPubKeyHex}" is not a 32-byte hex x-only pubkey.`,
            );
        }
        if (typeof privKeyHex !== "string" || !isHexOfBytes(privKeyHex, 32)) {
            throw new Error(
                `Corrupt keyring settings: entry ${pubKeyHex} is not a 32-byte hex private key.`,
            );
        }

        let derivedPubKeyHex: string;
        try {
            derivedPubKeyHex = hex.encode(pubSchnorr(hex.decode(privKeyHex)));
        } catch (e) {
            // pubSchnorr rejects a key outside the curve order.
            throw new Error(
                `Corrupt keyring settings: entry ${pubKeyHex} is not a valid private key.`,
                { cause: e },
            );
        }
        if (derivedPubKeyHex !== pubKeyHex) {
            throw new Error(
                `Corrupt keyring settings: entry ${pubKeyHex} does not match its private key ` +
                    `(which derives ${derivedPubKeyHex}). Refusing to sign with a key the ` +
                    `descriptor does not name.`,
            );
        }

        keys[pubKeyHex] = privKeyHex;
    }
    return { keys };
}

function isHexOfBytes(value: string, bytes: number): boolean {
    return value.length === bytes * 2 && /^[0-9a-fA-F]+$/.test(value);
}

/**
 * Mirror the wrapped provider's *optional* capabilities onto the
 * decorator, so wrapping an `HDDescriptorProvider` doesn't silently
 * disable receive rotation or the boot-time descriptor peek — both of
 * which the wallet detects by duck-typed method presence.
 *
 * Forwarded dynamically rather than declared as methods, because a
 * method that always exists would make the decorator claim capabilities
 * a static base doesn't have — exactly the mis-classification the duck
 * typing is there to prevent.
 */
function forwardOptionalCapabilities(target: KeyringDescriptorProvider, base: DescriptorProvider) {
    for (const name of ["createReceiveRotator", "getCurrentSigningDescriptor"] as const) {
        const method = (base as unknown as Record<string, unknown>)[name];
        if (typeof method !== "function") continue;
        (target as unknown as Record<string, unknown>)[name] = (...args: unknown[]) =>
            (method as (...a: unknown[]) => unknown).apply(base, args);
    }
}
