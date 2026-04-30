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
 * Shared "does `descriptor` belong to an HD-or-static identity
 * characterized by (`accountXpub`, `xOnlyPubkey`)?" predicate.
 *
 * - HD descriptors (those expanding to a `bip32` key) match by
 *   account xpub.
 * - Bare `tr(pubkey)` descriptors fall back to comparing the candidate
 *   pubkey against `xOnlyPubkey`.
 *
 * Works uniformly on ranged (template) and non-ranged inputs:
 * `Expansion.expansionMap['@0'].bip32` is the index-agnostic account
 * xpub, present in both cases, so we don't need to substitute the
 * wildcard before parsing.
 */
export function descriptorIsOurs(
    descriptor: string,
    accountXpub: string | undefined,
    xOnlyPubkey: Uint8Array
): boolean {
    if (!isDescriptor(descriptor)) return false;
    try {
        const network = isMainnetDescriptor(descriptor)
            ? networks.bitcoin
            : networks.testnet;
        const keyInfo = expand({ descriptor, network }).expansionMap?.["@0"];
        if (!keyInfo) return false;

        if (keyInfo.bip32 && accountXpub) {
            return keyInfo.bip32.toBase58() === accountXpub;
        }
        if (keyInfo.pubkey) {
            // For tr() the library hands back a 32-byte x-only key, but
            // strip a leading parity byte defensively so a 33-byte
            // compressed key (mismatched length) doesn't silently
            // false-negative against our 32-byte x-only side.
            const candidate =
                keyInfo.pubkey.length === 33
                    ? keyInfo.pubkey.subarray(1)
                    : keyInfo.pubkey;
            if (candidate.length !== xOnlyPubkey.length) return false;
            return hex.encode(candidate) === hex.encode(xOnlyPubkey);
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
        throw new Error(
            "normalizeToDescriptor: expected a non-empty string value"
        );
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

    const network = isMainnetDescriptor(descriptor)
        ? networks.bitcoin
        : networks.testnet;
    const expansion = expand({ descriptor, network });

    if (!expansion.expansionMap) {
        throw new Error(
            "Cannot extract pubkey from descriptor: expansion failed."
        );
    }

    const key = expansion.expansionMap["@0"];

    // HD descriptors (have a bip32 key) require DescriptorProvider for derivation
    if (key?.bip32) {
        throw new Error(
            "Cannot extract pubkey from HD descriptor without derivation. " +
                "Use DescriptorProvider to derive the key from the xpub."
        );
    }

    if (!key?.pubkey) {
        throw new Error("Cannot extract pubkey from descriptor: no key found.");
    }

    return hex.encode(key.pubkey);
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
export function parseHDDescriptor(
    descriptor: string
): ParsedHDDescriptor | null {
    if (!isDescriptor(descriptor)) {
        return null;
    }

    let expansion;
    try {
        const network = isMainnetDescriptor(descriptor)
            ? networks.bitcoin
            : networks.testnet;
        expansion = expand({ descriptor, network });
    } catch {
        return null;
    }

    const key = expansion.expansionMap?.["@0"];
    if (
        !key?.masterFingerprint ||
        !key.originPath ||
        !key.keyPath ||
        !key.bip32
    ) {
        return null;
    }

    return {
        fingerprint: hex.encode(key.masterFingerprint),
        basePath: key.originPath.replace(/^\//, ""),
        xpub: key.bip32.toBase58(),
        derivationPath: key.keyPath.replace(/^\//, ""),
    };
}
