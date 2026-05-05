import { Transaction } from "../utils/transaction";

/** A signing request that pairs a descriptor with a transaction. */
export interface DescriptorSigningRequest {
    /** Descriptor identifying which key to sign with */
    descriptor: string;
    /** Transaction to sign */
    tx: Transaction;
    /** Specific input indexes to sign (signs all if omitted) */
    inputIndexes?: number[];
}

/**
 * Provider interface for descriptor-based signing.
 *
 * Implementations include:
 * - {@link StaticDescriptorProvider}: wraps a legacy {@link Identity} with a single key.
 * - {@link HDDescriptorProvider}: rotates through HD-derived descriptors.
 *
 * The provider has no read accessor for "current" — it is a pure descriptor
 * allocator. "What addresses am I currently bound to?" is a question the
 * contract repository answers, not the provider.
 */
export interface DescriptorProvider {
    /**
     * Allocate a new signing descriptor. For HD providers each call advances
     * the internal index and returns a fresh descriptor; for single-key
     * providers each call returns the same descriptor.
     */
    getNextSigningDescriptor(): Promise<string>;

    /** Checks if a descriptor belongs to this provider. */
    isOurs(descriptor: string): boolean;

    /** Signs transactions, each with its own descriptor-derived key. */
    signWithDescriptor(
        requests: DescriptorSigningRequest[]
    ): Promise<Transaction[]>;

    /** Signs a message using the key derived from the descriptor. */
    signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        type?: "schnorr" | "ecdsa"
    ): Promise<Uint8Array>;
}
