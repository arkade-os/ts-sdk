import {
    expand,
    networks,
    type Network,
} from "@bitcoinerlab/descriptors-scure";
import { hex } from "@scure/base";

function inferNetwork(descriptor: string): Network {
    return descriptor.includes("tpub") ? networks.testnet : networks.bitcoin;
}

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
 * For simple descriptors (tr(pubkey)), extracts the pubkey using the library.
 * For HD descriptors, throws — use DescriptorProvider to derive the key.
 */
export function extractPubKey(descriptor: string): string {
    if (!isDescriptor(descriptor)) {
        return descriptor;
    }

    const network = inferNetwork(descriptor);
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
        const network = inferNetwork(descriptor);
        expansion = expand({ descriptor, network });
    } catch {
        return null;
    }

    if (!expansion.expansionMap) {
        return null;
    }

    const key = expansion.expansionMap["@0"];
    if (!key) {
        return null;
    }

    // HD descriptors have originPath and keyPath; simple pubkey descriptors do not
    if (!key.masterFingerprint || !key.originPath || !key.keyPath) {
        return null;
    }

    // Extract xpub from the key expression: strip origin prefix and key path suffix
    const keyExpr = key.keyExpression;
    const originEnd = keyExpr.indexOf("]");
    const afterOrigin = originEnd >= 0 ? keyExpr.slice(originEnd + 1) : keyExpr;
    const keyPathStart = afterOrigin.indexOf(key.keyPath);
    const xpub =
        keyPathStart > 0 ? afterOrigin.slice(0, keyPathStart) : afterOrigin;

    // keyPath comes back as "/0/5" — strip leading slash for our format
    const derivationPath = key.keyPath.startsWith("/")
        ? key.keyPath.slice(1)
        : key.keyPath;

    return {
        fingerprint: hex.encode(key.masterFingerprint),
        basePath: key.originPath.startsWith("/")
            ? key.originPath.slice(1)
            : key.originPath,
        xpub,
        derivationPath,
    };
}
