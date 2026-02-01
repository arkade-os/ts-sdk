import { Transaction } from "../utils/transaction";

/**
 * A signing request for a transaction with optional specific input indexes.
 */
export interface DescriptorSigningRequest {
    /** Transaction to sign */
    tx: Transaction;
    /** Specific input indexes to sign (signs all if omitted) */
    inputIndexes?: number[];
}

/**
 * Provides signing capabilities using output descriptors.
 *
 * This interface abstracts whether keys come from HD derivation or static
 * sources, allowing the wallet to work with both SeedIdentity (HD) and
 * SingleKeyIdentity (static) implementations uniformly.
 *
 * Implementations:
 * - SeedIdentity: HD wallet with `tr([fp/path']xpub/0/{index})` descriptors
 * - StaticDescriptorProvider: Wraps legacy Identity with `tr(pubkey)` format
 *
 * @example
 * ```typescript
 * // HD wallet
 * const provider: DescriptorProvider = seedIdentity;
 * const descriptor = provider.getSigningDescriptor();
 * // → "tr([12345678/86'/0'/0']xpub.../0/5)"
 *
 * // Static key wrapper
 * const provider: DescriptorProvider = new StaticDescriptorProvider(identity);
 * const descriptor = provider.getSigningDescriptor();
 * // → "tr(abc123...)"
 * ```
 */
export interface DescriptorProvider {
    /**
     * Get the current signing descriptor.
     *
     * For HD wallets: returns full descriptor with derivation path
     * For static keys: returns tr(pubkey) format
     *
     * @returns Output descriptor string
     */
    getSigningDescriptor(): string;

    /**
     * Check if a descriptor belongs to this provider.
     *
     * Used to identify which contracts belong to this wallet.
     *
     * @param descriptor - Descriptor to check (tr(...) format or raw hex)
     * @returns true if descriptor was derived from this provider
     */
    isOurs(descriptor: string): boolean;

    /**
     * Sign transactions using a specific descriptor.
     *
     * Provider derives the appropriate key from the descriptor
     * and signs the specified inputs.
     *
     * @param descriptor - Signing descriptor specifying which key to use
     * @param requests - Array of signing requests
     * @returns Array of signed transactions (same order as requests)
     * @throws Error if descriptor doesn't belong to this provider
     */
    signWithDescriptor(
        descriptor: string,
        requests: DescriptorSigningRequest[]
    ): Promise<Transaction[]>;

    /**
     * Sign a message using a specific descriptor.
     *
     * @param descriptor - Signing descriptor specifying which key to use
     * @param message - 32-byte message to sign
     * @param type - Signature algorithm (defaults to "schnorr")
     * @returns 64-byte signature
     * @throws Error if descriptor doesn't belong to this provider
     */
    signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        type?: "schnorr" | "ecdsa"
    ): Promise<Uint8Array>;

    /**
     * Derive a signing descriptor at a specific index.
     *
     * For HD wallets: returns tr([fp/path']xpub/0/{index})
     * For static keys: always returns the same tr(pubkey) regardless of index
     *
     * @param index - The derivation index (0, 1, 2, ...)
     * @returns Output descriptor string for signing at this index
     */
    deriveSigningDescriptor(index: number): string;
}
