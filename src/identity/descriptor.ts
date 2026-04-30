import { expand, networks } from "@bitcoinerlab/descriptors-scure";
import { hex } from "@scure/base";

/**
 * True iff `descriptor` is a Bitcoin mainnet descriptor (xpub-prefixed
 * BIP32 key).
 *
 * Note: testnet, signet, regtest, mutinynet, and other non-mainnet
 * networks all share the same `tpub` BIP32 version bytes — they cannot
 * be distinguished from one another at the descriptor level. Callers
 * that need to pick a `Network` constants object for `expand()`
 * convert via `bip32NetworkOf` below; callers that need the *actual*
 * network the wallet is on must track that out-of-band.
 */
export function isMainnetDescriptor(descriptor: string): boolean {
    return !descriptor.includes("tpub");
}

/**
 * Pick the `Network` constants the descriptors library needs to parse
 * `descriptor` — `networks.bitcoin` for mainnet, otherwise
 * `networks.testnet`. The latter is shared across all non-mainnet
 * networks because they have identical BIP32 version bytes; this
 * function does not (and cannot) tell signet from regtest from
 * testnet. See {@link isMainnetDescriptor}.
 */
function bip32NetworkOf(descriptor: string) {
    return isMainnetDescriptor(descriptor)
        ? networks.bitcoin
        : networks.testnet;
}

/**
 * True iff `descriptor` is a ranged (wildcard) output descriptor.
 *
 * Delegates to `expand()`, reading the library's `Expansion.isRanged`
 * field — this catches checksum-suffixed templates like
 * `tr(...)/0/*)#abcdefgh` that a naive `endsWith("/*)")` check would
 * miss. Returns false on parse failure rather than propagating.
 */
export function isWildcardTemplate(descriptor: string): boolean {
    try {
        return expand({ descriptor, network: bip32NetworkOf(descriptor) })
            .isRanged;
    } catch {
        return false;
    }
}

/**
 * Substitute the wildcard in `template` with a concrete derivation
 * index. Throws if `template` is not a ranged descriptor (the library
 * raises "index passed for non-ranged descriptor"), or if `index` falls
 * outside the BIP-32 non-hardened range.
 *
 * Delegates the substitution to `expand()` and returns
 * `Expansion.canonicalExpression` — the library's authoritative,
 * checksum-stripped representation of the descriptor at the given
 * index. This handles any input the library accepts (including
 * checksum-suffixed templates like `tr(...)/0/*)#abcdefgh`) without
 * us needing to teach our string ops about each shape.
 */
export function materializeAtIndex(template: string, index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
        throw new Error("Derivation index must be an integer in [0, 2^31)");
    }
    return expand({
        descriptor: template,
        network: bip32NetworkOf(template),
        index,
    }).canonicalExpression;
}

/**
 * Returns the wildcard-template form of `descriptor`. If `descriptor`
 * is already a template, returns its canonical form (checksum
 * stripped). If concrete (`.../N)`), canonicalizes via the library and
 * chops the trailing numeric index, replacing it with `*`.
 *
 * Going from concrete → template has no library equivalent, but
 * leaning on `Expansion.canonicalExpression` first lets us accept
 * everything `expand()` does (including checksum-suffixed forms) and
 * operate on a known-clean string when chopping. Throws via the
 * library on any input it can't parse.
 */
export function templateOf(descriptor: string): string {
    const expansion = expand({
        descriptor,
        network: bip32NetworkOf(descriptor),
    });
    if (expansion.isRanged) return expansion.canonicalExpression;

    // canonicalExpression always ends in `)` and reflects the
    // descriptor's structure with no checksum, so chopping the
    // trailing /N) is unambiguous.
    const canonical = expansion.canonicalExpression;
    const lastSlash = canonical.lastIndexOf("/");
    if (lastSlash === -1) {
        throw new Error(
            `Cannot derive account descriptor template: "${canonical}" has no derivation path`
        );
    }
    return `${canonical.slice(0, lastSlash + 1)}*)`;
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
        const network = bip32NetworkOf(descriptor);
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

    const network = bip32NetworkOf(descriptor);
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
        const network = bip32NetworkOf(descriptor);
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
