import { expand, networks } from "@bitcoinerlab/descriptors-scure";
import { hex } from "@scure/base";

/**
 * True iff `descriptor` is a Bitcoin mainnet descriptor (xpub-prefixed
 * BIP32 key).
 *
 * Note: testnet, signet, regtest, mutinynet, and other non-mainnet
 * networks all share the same `tpub` BIP32 version bytes — they cannot
 * be distinguished from one another at the descriptor level. Callers
 * that need a `Network` constants object for `expand()` pick
 * `networks.bitcoin` vs `networks.testnet` themselves; callers that
 * need the *actual* network the wallet is on must track that
 * out-of-band.
 */
export function isMainnetDescriptor(descriptor: string): boolean {
    return !descriptor.includes("tpub");
}

/**
 * Shared "does `candidate` belong to the identity backed by
 * `ourDescriptor`?" predicate.
 *
 * - HD descriptors (expanding to a `bip32` key) match by account xpub
 *   on both sides — index-agnostic, so a wildcard template and any
 *   concrete index under it all collapse to the same xpub.
 * - Bare `tr(pubkey)` candidates fall back to comparing the candidate
 *   pubkey against `ourXOnlyPubkey` (the cached pubkey on the identity
 *   side, since pulling it from `ourDescriptor` would require an index
 *   substitution the caller already performed).
 */
export function descriptorIsOurs(
    candidate: string,
    ourDescriptor: string,
    ourXOnlyPubkey: Uint8Array,
): boolean {
    if (!isDescriptor(candidate)) return false;
    try {
        const candidateInfo = expand({
            descriptor: candidate,
            network: isMainnetDescriptor(candidate) ? networks.bitcoin : networks.testnet,
        }).expansionMap?.["@0"];
        if (!candidateInfo) return false;

        if (candidateInfo.bip32) {
            const ourBip32 = expand({
                descriptor: ourDescriptor,
                network: isMainnetDescriptor(ourDescriptor) ? networks.bitcoin : networks.testnet,
            }).expansionMap?.["@0"]?.bip32;
            if (!ourBip32) return false;
            return ourBip32.toBase58() === candidateInfo.bip32.toBase58();
        }
        if (candidateInfo.pubkey) {
            // For tr() the library hands back a 32-byte x-only key, but
            // strip a leading parity byte defensively so a 33-byte
            // compressed key (mismatched length) doesn't silently
            // false-negative against our 32-byte x-only side.
            const candidatePub =
                candidateInfo.pubkey.length === 33
                    ? candidateInfo.pubkey.subarray(1)
                    : candidateInfo.pubkey;
            if (candidatePub.length !== ourXOnlyPubkey.length) return false;
            return hex.encode(candidatePub) === hex.encode(ourXOnlyPubkey);
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Check if a string is a descriptor of the shape `tr(...)`.
 *
 * This is a shape check only — it does not validate the inner key material.
 * Use {@link expand} (via {@link extractPubKey} / {@link parseHDDescriptor})
 * for full parsing. The guard rejects empty bodies and missing/trailing
 * parentheses so callers can safely branch on descriptor vs. raw pubkey.
 */
export function isDescriptor(value: string): boolean {
    if (typeof value !== "string") return false;
    if (!value.startsWith("tr(") || !value.endsWith(")")) return false;
    // body length > 0 after stripping "tr(" and ")"
    return value.length > "tr()".length;
}

/**
 * Normalize a value to descriptor format.
 * If already a descriptor, return as-is. If hex pubkey, wrap as tr(pubkey).
 * Throws when the value is empty or not a string so we never produce
 * malformed descriptors like `tr()` that downstream parsers would reject.
 */
export function normalizeToDescriptor(value: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error("normalizeToDescriptor: expected a non-empty string value");
    }
    if (isDescriptor(value)) {
        return value;
    }
    return `tr(${value})`;
}

/**
 * Extract the public key from a simple descriptor.
 * For simple descriptors (tr(pubkey)), extracts the pubkey using the library.
 * For HD descriptors, throws — use DescriptorProvider to derive the key.
 */
export function extractPubKey(descriptor: string): string {
    if (!isDescriptor(descriptor)) {
        return descriptor;
    }

    const network = isMainnetDescriptor(descriptor) ? networks.bitcoin : networks.testnet;
    const expansion = expand({ descriptor, network });

    if (!expansion.expansionMap) {
        throw new Error("Cannot extract pubkey from descriptor: expansion failed.");
    }

    const key = expansion.expansionMap["@0"];

    // HD descriptors (have a bip32 key) require DescriptorProvider for derivation
    if (key?.bip32) {
        throw new Error(
            "Cannot extract pubkey from HD descriptor without derivation. " +
                "Use DescriptorProvider to derive the key from the xpub.",
        );
    }

    if (!key?.pubkey) {
        throw new Error("Cannot extract pubkey from descriptor: no key found.");
    }

    return hex.encode(key.pubkey);
}

/**
 * Extract the x-only (32-byte) pubkey from a materialized descriptor.
 * Handles both static `tr(pubkey)` and materialized HD
 * `tr([fp/..]xpub/0/<i>)` shapes via the descriptors-scure expansion map.
 * Throws a plain Error when the descriptor is non-rangeable / unparseable;
 * callers that need a typed error wrap this.
 */
export function deriveDescriptorLeafPubKey(descriptor: string): Uint8Array {
    const network = isMainnetDescriptor(descriptor)
        ? networks.bitcoin
        : networks.testnet;
    let expansion;
    try {
        expansion = expand({ descriptor, network });
    } catch (e) {
        throw new Error(
            `Cannot derive leaf pubkey from descriptor (length=${descriptor.length}): ` +
                `ensure it is materialized (no wildcard) and parsable.`,
            { cause: e }
        );
    }
    const key = expansion.expansionMap?.["@0"];
    if (!key?.pubkey) {
        throw new Error(
            `Cannot derive leaf pubkey from descriptor (length=${descriptor.length}): ` +
                `parsed but no '@0' pubkey in the expansion map.`
        );
    }
    return key.pubkey;
}

/** Parsed HD descriptor components. */
export interface ParsedHDDescriptor {
    fingerprint: string;
    basePath: string;
    xpub: string;
    derivationPath: string;
}

/**
 * Parse an HD descriptor into its components.
 * HD descriptors have the format: tr([fingerprint/path']xpub/derivation)
 * Returns null if the descriptor is not in HD format.
 */
export function parseHDDescriptor(descriptor: string): ParsedHDDescriptor | null {
    if (!isDescriptor(descriptor)) {
        return null;
    }

    let expansion;
    try {
        const network = isMainnetDescriptor(descriptor) ? networks.bitcoin : networks.testnet;
        expansion = expand({ descriptor, network });
    } catch {
        return null;
    }

    const key = expansion.expansionMap?.["@0"];
    if (!key?.masterFingerprint || !key.originPath || !key.keyPath || !key.bip32) {
        return null;
    }

    return {
        fingerprint: hex.encode(key.masterFingerprint),
        basePath: key.originPath.replace(/^\//, ""),
        xpub: key.bip32.toBase58(),
        derivationPath: key.keyPath.replace(/^\//, ""),
    };
}
