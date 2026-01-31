import { hex } from "@scure/base";
import { Identity } from ".";
import {
    DescriptorProvider,
    DescriptorSigningRequest,
} from "./descriptorProvider";
import { normalizeToDescriptor, extractPubKey } from "./descriptor";
import { Transaction } from "../utils/transaction";

/**
 * Wraps a legacy Identity to provide DescriptorProvider interface.
 *
 * Always returns the same static public key as a tr(pubkey) descriptor.
 * This enables existing Identity implementations to work with the new
 * descriptor-based contract system.
 *
 * @example
 * ```typescript
 * const identity = SingleKey.fromHex(privateKeyHex);
 * const provider = await StaticDescriptorProvider.create(identity);
 *
 * // Now use descriptor-based APIs
 * const descriptor = provider.getSigningDescriptor();
 * // → "tr(abc123...)"
 *
 * const signature = await provider.signMessageWithDescriptor(
 *     descriptor,
 *     message
 * );
 * ```
 */
export class StaticDescriptorProvider implements DescriptorProvider {
    private readonly identity: Identity;
    private readonly descriptor: string;
    private readonly pubKeyHex: string;

    /**
     * Creates a StaticDescriptorProvider.
     * Use the static `create()` method for async creation from Identity.
     *
     * @internal
     */
    constructor(identity: Identity, pubKeyHex: string) {
        this.identity = identity;
        this.pubKeyHex = pubKeyHex;
        this.descriptor = `tr(${pubKeyHex})`;
    }

    /**
     * Creates a StaticDescriptorProvider from an Identity.
     *
     * @param identity - The Identity to wrap
     * @returns Promise resolving to StaticDescriptorProvider
     *
     * @example
     * ```typescript
     * const identity = SingleKey.fromHex(privateKeyHex);
     * const provider = await StaticDescriptorProvider.create(identity);
     * ```
     */
    static async create(identity: Identity): Promise<StaticDescriptorProvider> {
        const pubKey = await identity.xOnlyPublicKey();
        return new StaticDescriptorProvider(identity, hex.encode(pubKey));
    }

    /**
     * Get the signing descriptor (tr(pubkey) format).
     */
    getSigningDescriptor(): string {
        return this.descriptor;
    }

    /**
     * Check if a descriptor belongs to this provider.
     *
     * Returns true for:
     * - The exact descriptor from getSigningDescriptor()
     * - Raw hex pubkey (legacy format)
     * - tr(pubkey) with case-insensitive matching
     */
    isOurs(descriptor: string): boolean {
        const normalized = normalizeToDescriptor(descriptor);
        try {
            const pubKey = extractPubKey(normalized);
            return pubKey.toLowerCase() === this.pubKeyHex.toLowerCase();
        } catch {
            // HD descriptor or invalid format
            return false;
        }
    }

    /**
     * Sign transactions using the wrapped Identity.
     */
    async signWithDescriptor(
        descriptor: string,
        requests: DescriptorSigningRequest[]
    ): Promise<Transaction[]> {
        if (!this.isOurs(descriptor)) {
            throw new Error(
                `Descriptor ${descriptor} does not belong to this provider`
            );
        }

        const results: Transaction[] = [];
        for (const request of requests) {
            const signed = await this.identity.sign(
                request.tx,
                request.inputIndexes
            );
            results.push(signed);
        }
        return results;
    }

    /**
     * Sign a message using the wrapped Identity.
     */
    async signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        type: "schnorr" | "ecdsa" = "schnorr"
    ): Promise<Uint8Array> {
        if (!this.isOurs(descriptor)) {
            throw new Error(
                `Descriptor ${descriptor} does not belong to this provider`
            );
        }
        return this.identity.signMessage(message, type);
    }
}
