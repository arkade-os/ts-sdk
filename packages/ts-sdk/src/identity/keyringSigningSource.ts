import { hex } from "@scure/base";
import { pubSchnorr } from "@scure/btc-signer/utils.js";
import { DescriptorSigningRequest } from "./descriptorProvider";
import { DescriptorSigningSource } from "./signingSource";
import { normalizeToDescriptor, extractPubKey } from "./descriptor";
import { SingleKey } from "./singleKey";
import { WalletRepository, WalletState } from "../repositories/walletRepository";
import { readWalletState, updateWalletState } from "../utils/syncCursors";
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
 * A {@link DescriptorSigningSource} backed by a **keyring**: raw private
 * keys imported from outside the wallet's derivation tree, each addressed
 * by a `tr(<x-only pubkey>)` descriptor.
 *
 * This is the generic "hold a foreign signable contract" capability. A
 * contract carrying `metadata.signingDescriptor` for an imported key is
 * signable by construction — the wallet composes this source behind its
 * own descriptor provider, so no configuration is needed to make an
 * imported contract spendable.
 *
 * The source never allocates: it has no `getNextSigningDescriptor`, no HD
 * materialization, and no receive-rotation surface. It holds foreign keys
 * the wallet was handed; it cannot mint receive addresses or perturb the
 * receive index stream.
 *
 * **Storage is the source of truth.** Every question — `canProvide`,
 * signing, deletion — reads
 * `WalletRepository.getWalletState().settings.keyring` through the
 * wallet-state mutex. There is no in-memory mirror to keep coherent, so
 * two sources over one repository agree by construction: a key imported
 * through one is immediately visible to the other, and a purge takes
 * effect everywhere at once. Recovery signing volume is low enough that
 * the read is the simpler correct default; a measured cache can be added
 * behind this boundary later.
 *
 * Entries persist across restarts (same no-migration `settings` pattern as
 * `HDDescriptorProvider`), so an import survives the restarts a recovery
 * spans, and {@link deleteKey} purges it when recovery completes.
 *
 * **Keys are stored unencrypted.** This is a deliberate, scoped decision:
 * the intended use is a short-lived, purge-on-completion hold of a key
 * that guards funds already destined for this wallet. At-rest encryption
 * is a possible hardening follow-up. Do not use this to hold long-lived
 * key material.
 *
 * @example
 * ```ts
 * const keyring = new KeyringSigningSource(walletRepo);
 * const descriptor = await keyring.importKey(foreignPrivKey);
 * // descriptor: tr(<x-only pubkey hex>)
 * // ... import a contract with metadata.signingDescriptor = descriptor,
 * //     let the wallet's recovery machinery settle it, then:
 * await keyring.deleteKey(descriptor);
 * ```
 */
export class KeyringSigningSource implements DescriptorSigningSource {
    constructor(private readonly walletRepository: WalletRepository) {}

    /**
     * Import a raw private key into the keyring and return its
     * `tr(<x-only pubkey>)` descriptor handle. Idempotent: re-importing
     * the same key returns the same descriptor and leaves storage
     * unchanged.
     */
    async importKey(privateKey: Uint8Array): Promise<string> {
        // Clone: an import API must not alias a buffer the caller may
        // zeroize or reuse once it believes the key is safely held.
        const keyBytes = new Uint8Array(privateKey);
        const pubKeyHex = hex.encode(pubSchnorr(keyBytes));
        const privKeyHex = hex.encode(keyBytes);
        await this.mutate((settings) => {
            settings.keys[pubKeyHex] = privKeyHex;
        });
        return `tr(${pubKeyHex})`;
    }

    /**
     * Purge a keyring entry. Returns `true` when an entry was removed,
     * `false` when the descriptor was not in the keyring (already
     * purged, or never ours) — so a repeated purge is a safe no-op.
     */
    async deleteKey(descriptor: string): Promise<boolean> {
        const pubKeyHex = keyOf(descriptor);
        if (!pubKeyHex) return false;

        let removed = false;
        await this.mutate((settings) => {
            if (!(pubKeyHex in settings.keys)) return false;
            delete settings.keys[pubKeyHex];
            removed = true;
        });
        return removed;
    }

    /** The `tr(<pubkey>)` descriptors of every key currently held. */
    async listDescriptors(): Promise<string[]> {
        const settings = await this.load();
        return Object.keys(settings.keys).map((pubKeyHex) => `tr(${pubKeyHex})`);
    }

    /** True iff `descriptor` resolves to a key held in the keyring. */
    async canProvide(descriptor: string): Promise<boolean> {
        return (await this.resolveKey(descriptor)) !== undefined;
    }

    /** Signs each request with the imported key its descriptor names. */
    async signWithDescriptor(requests: DescriptorSigningRequest[]): Promise<Transaction[]> {
        const results: Transaction[] = [];
        for (const request of requests) {
            const key = await this.requireKey(request.descriptor);
            results.push(await key.sign(request.tx, request.inputIndexes));
        }
        return results;
    }

    /** Signs a message with the imported key the descriptor names. */
    async signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        type: "schnorr" | "ecdsa" = "schnorr",
    ): Promise<Uint8Array> {
        const key = await this.requireKey(descriptor);
        return key.signMessage(message, type);
    }

    // ── internals ────────────────────────────────────────────────────

    /** Validated keyring settings as storage currently holds them. */
    private async load(): Promise<KeyringSettings> {
        return parseSettings(await readWalletState(this.walletRepository));
    }

    /**
     * The key `descriptor` names, or `undefined` when the keyring does
     * not hold it. Built fresh from storage on every call — see the
     * storage-as-truth note on the class.
     */
    private async resolveKey(descriptor: string): Promise<SingleKey | undefined> {
        const pubKeyHex = keyOf(descriptor);
        if (!pubKeyHex) return undefined;
        const privKeyHex = (await this.load()).keys[pubKeyHex];
        return privKeyHex ? SingleKey.fromHex(privKeyHex) : undefined;
    }

    /**
     * As {@link resolveKey}, but throws rather than returning undefined.
     * A composite routes signing here only after `canProvide` claimed the
     * descriptor, so reaching this throw means either a direct caller
     * misused the source or the key was purged mid-flight; silently
     * skipping the input would surface much later as a rejected
     * settlement.
     */
    private async requireKey(descriptor: string): Promise<SingleKey> {
        const key = await this.resolveKey(descriptor);
        if (!key) {
            throw new Error(`Descriptor ${descriptor} does not belong to this keyring`);
        }
        return key;
    }

    /**
     * Read-modify-write the keyring settings inside the shared per-repo
     * wallet-state mutex, so concurrent imports/purges — including those
     * driven by separate source instances on the same repo — cannot
     * clobber each other's entries.
     *
     * `fn` returning `false` means "nothing changed": the state is
     * written back untouched rather than materializing a keyring record
     * for an operation that removed nothing.
     */
    private async mutate(fn: (settings: KeyringSettings) => boolean | void): Promise<void> {
        await updateWalletState(this.walletRepository, (state) => {
            const settings = parseSettings(state);
            if (fn(settings) === false) return state;
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
 * That correspondence is what `canProvide` implicitly asserts: a
 * mismatched pair would have the source claim a descriptor and then sign
 * it with the wrong key — a failure that would otherwise only surface
 * when the server rejected the resulting settlement.
 *
 * The whole record is validated on every read, so one corrupt entry
 * blocks resolution of all keyring keys. That is deliberate: refusing to
 * sign next to corrupt key material beats partial degradation.
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
