/**
 * Descriptor utility functions for working with output descriptors.
 *
 * Output descriptors provide a standardized way to represent Bitcoin addresses
 * and their spending conditions. This module supports:
 * - Simple descriptors: tr(pubkey) — for static/external keys
 * - HD descriptors: tr([fingerprint/path']xpub/derivation) — for HD wallets
 *
 * @module
 */

/**
 * Check if a string is a descriptor (starts with "tr(").
 */
export function isDescriptor(value: string): boolean {
    return value.startsWith("tr(");
}

/**
 * Normalize a value to descriptor format.
 * If already a descriptor, return as-is. If hex pubkey, wrap as tr(pubkey).
 */
export function normalizeToDescriptor(value: string): string {
    if (isDescriptor(value)) {
        return value;
    }
    return `tr(${value})`;
}

/**
 * Extract the public key from a simple descriptor.
 * For simple descriptors (tr(64-hex-chars)), extracts the pubkey directly.
 * For HD descriptors, throws — use DescriptorProvider to derive the key.
 */
export function extractPubKey(descriptor: string): string {
    if (!isDescriptor(descriptor)) {
        return descriptor;
    }

    const simpleMatch = descriptor.match(/^tr\(([0-9a-fA-F]{64})\)$/);
    if (simpleMatch) {
        return simpleMatch[1];
    }

    throw new Error(
        "Cannot extract pubkey from HD descriptor without derivation. " +
            "Use DescriptorProvider to derive the key from the xpub."
    );
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
