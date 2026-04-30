import {
    expand,
    networks,
    type Network,
} from "@bitcoinerlab/descriptors-scure";
import { hex } from "@scure/base";

/**
 * Pick the BIP32 network from a descriptor by inspecting its key prefix.
 * `tpub` → testnet, anything else → mainnet. Cheaper and more permissive
 * than fully expanding the descriptor; safe because it's only used to
 * tell {@link expand} which network constants to apply.
 */
export function detectNetwork(descriptor: string): Network {
    return descriptor.includes("tpub") ? networks.testnet : networks.bitcoin;
}

/** True iff `descriptor` ends with the HD wildcard suffix `/*)`. */
export function isWildcardTemplate(descriptor: string): boolean {
    return descriptor.endsWith("/*)");
}

/**
 * Substitute the wildcard in `template` with a concrete derivation
 * index. Throws if the input is not a wildcard template, or if `index`
 * falls outside the BIP-32 non-hardened range.
 */
export function materializeAtIndex(template: string, index: number): string {
    if (!isWildcardTemplate(template)) {
        throw new Error(
            `Descriptor is not a wildcard template (must end in "/*)")`
        );
    }
    if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
        throw new Error("Derivation index must be an integer in [0, 2^31)");
    }
    return template.replace("/*)", `/${index})`);
}

/**
 * Returns the wildcard-template form of `descriptor`. If already a
 * template, returns it unchanged. If concrete (`.../N)`), chops the
 * trailing numeric index and replaces it with `*`. Throws otherwise.
 */
export function templateOf(descriptor: string): string {
    if (isWildcardTemplate(descriptor)) return descriptor;
    if (!descriptor.endsWith(")")) {
        throw new Error(
            "Cannot derive account descriptor template: descriptor must end with ')'"
        );
    }
    const lastSlash = descriptor.lastIndexOf("/");
    if (lastSlash === -1) {
        throw new Error(
            "Cannot derive account descriptor template: descriptor has no path"
        );
    }
    const trailing = descriptor.slice(lastSlash + 1, -1);
    const idx = Number(trailing);
    if (!Number.isInteger(idx) || idx < 0 || trailing !== String(idx)) {
        throw new Error(
            "Cannot derive account descriptor template: trailing path segment is not a non-negative integer"
        );
    }
    return `${descriptor.slice(0, lastSlash + 1)}*)`;
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
 * Wildcard candidates are accepted: the library handles wildcard
 * resolution via the `index` parameter to {@link expand}, so we don't
 * have to substitute the descriptor manually before parsing. The
 * actual index doesn't matter for the xpub comparison since every
 * index under the same template shares the account xpub.
 */
export function descriptorIsOurs(
    descriptor: string,
    accountXpub: string | undefined,
    xOnlyPubkey: Uint8Array
): boolean {
    if (!isDescriptor(descriptor)) return false;
    try {
        const network = detectNetwork(descriptor);
        const expansion = expand({
            descriptor,
            network,
            // expand() rejects `index` for non-ranged descriptors, so
            // only set it when the candidate carries the wildcard.
            ...(isWildcardTemplate(descriptor) ? { index: 0 } : {}),
        });
        const keyInfo = expansion.expansionMap?.["@0"];
        if (!keyInfo) return false;

        if (keyInfo.bip32 && accountXpub) {
            return keyInfo.bip32.toBase58() === accountXpub;
        }
        if (keyInfo.pubkey) {
            return hex.encode(keyInfo.pubkey) === hex.encode(xOnlyPubkey);
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

    const network = detectNetwork(descriptor);
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
        const network = detectNetwork(descriptor);
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
