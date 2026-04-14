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
 * - StaticDescriptorProvider: wraps a legacy Identity with a single key
 * - SeedIdentity: HD wallet with multi-index derivation (implements this directly)
 */
export interface DescriptorProvider {
    /** Returns the current signing descriptor. */
    getSigningDescriptor(): string;

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
