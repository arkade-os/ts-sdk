/**
 * Descriptor utility functions for working with output descriptors.
 *
 * Output descriptors provide a standardized way to represent Bitcoin addresses
 * and their spending conditions. This module supports:
 * - Simple descriptors: tr(pubkey) - for static/external keys
 * - HD descriptors: tr([fingerprint/path']xpub/derivation) - for HD wallets
 *
 * @module
 */

/**
 * Check if a string is a descriptor (starts with "tr(").
 *
 * @param value - String to check
 * @returns true if the value is in descriptor format
 *
 * @example
 * ```typescript
 * isDescriptor("tr(abc123)") // true
 * isDescriptor("abc123")     // false
 * ```
 */
export function isDescriptor(value: string): boolean {
    return value.startsWith("tr(");
}

/**
 * Normalize a value to descriptor format.
 *
 * - If already a descriptor, return as-is
 * - If hex pubkey, wrap as tr(pubkey)
 *
 * This provides backwards compatibility for legacy hex pubkeys
 * stored in contract parameters.
 *
 * @param value - Descriptor or hex pubkey
 * @returns Value in descriptor format
 *
 * @example
 * ```typescript
 * normalizeToDescriptor("tr(abc123)")  // "tr(abc123)"
 * normalizeToDescriptor("abc123")       // "tr(abc123)"
 * ```
 */
export function normalizeToDescriptor(value: string): string {
    if (isDescriptor(value)) {
        return value;
    }
    return `tr(${value})`;
}

/**
 * Extract the public key from a descriptor.
 *
 * For simple descriptors (tr(pubkey)), extracts the pubkey directly.
 * For HD descriptors, throws an error - use the DescriptorProvider
 * to derive the key from the xpub instead.
 *
 * @param descriptor - Descriptor or raw hex pubkey
 * @returns 64-character hex public key
 * @throws Error if descriptor is HD format (cannot derive without xpub)
 *
 * @example
 * ```typescript
 * extractPubKey("tr(abc...)")  // "abc..."
 * extractPubKey("abc...")      // "abc..."
 * extractPubKey("tr([fp/path]xpub/0/5)")  // throws
 * ```
 */
export function extractPubKey(descriptor: string): string {
    if (!isDescriptor(descriptor)) {
        // Already a raw pubkey
        return descriptor;
    }

    // Simple descriptor: tr(pubkey) - 64 hex chars
    const simpleMatch = descriptor.match(/^tr\(([0-9a-fA-F]{64})\)$/);
    if (simpleMatch) {
        return simpleMatch[1];
    }

    throw new Error(
        "Cannot extract pubkey from HD descriptor without derivation. " +
            "Use DescriptorProvider to derive the key from the xpub."
    );
}

/**
 * Parsed HD descriptor components.
 */
export interface ParsedHDDescriptor {
    /** 8-character hex fingerprint of the master key */
    fingerprint: string;

    /** BIP32 derivation path (e.g., "86'/0'/0'") */
    basePath: string;

    /** Extended public key (xpub or tpub) */
    xpub: string;

    /** Final derivation path from xpub (e.g., "0/5") */
    derivationPath: string;
}

/**
 * Parse an HD descriptor into its components.
 *
 * HD descriptors have the format: tr([fingerprint/path']xpub/derivation)
 *
 * @param descriptor - Descriptor string to parse
 * @returns Parsed components, or null if not an HD descriptor
 *
 * @example
 * ```typescript
 * const parsed = parseHDDescriptor("tr([12345678/86'/0'/0']xpub.../0/5)");
 * // {
 * //   fingerprint: "12345678",
 * //   basePath: "86'/0'/0'",
 * //   xpub: "xpub...",
 * //   derivationPath: "0/5"
 * // }
 * ```
 */
export function parseHDDescriptor(
    descriptor: string
): ParsedHDDescriptor | null {
    // tr([fingerprint/path]xpub/derivation)
    const match = descriptor.match(
        /^tr\(\[([0-9a-fA-F]{8})\/([^\]]+)\]([a-zA-Z0-9]+)\/(.+)\)$/
    );

    if (!match) {
        return null;
    }

    return {
        fingerprint: match[1],
        basePath: match[2],
        xpub: match[3],
        derivationPath: match[4],
    };
}
