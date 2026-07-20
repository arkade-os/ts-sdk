import { DescriptorProvider, DescriptorSigningRequest } from "./descriptorProvider";
import { Transaction } from "../utils/transaction";

/**
 * A source of descriptor-scoped signing capability.
 *
 * Deliberately narrower than {@link DescriptorProvider}: a source signs,
 * it does not *allocate*. Receive descriptor allocation, HD rotation and
 * restore stay entirely with the wallet's `DescriptorProvider`, so a
 * source can never affect the receive index stream or be mistaken for an
 * HD provider during a gap scan.
 *
 * Ownership resolution is asynchronous on purpose. `DescriptorProvider.isOurs`
 * is synchronous, which forces any persisted implementation to keep an
 * in-memory mirror of storage and then keep that mirror coherent across
 * instances. With `canProvide` a persisted source just reads storage —
 * the system of record — on every question, and two sources over one
 * repository agree by construction.
 *
 * Sources expose signing operations, never raw key material.
 */
export interface DescriptorSigningSource {
    /** True iff this source can sign for `descriptor`. */
    canProvide(descriptor: string): Promise<boolean>;

    /** Signs transactions, each with its own descriptor-derived key. */
    signWithDescriptor(requests: DescriptorSigningRequest[]): Promise<Transaction[]>;

    /** Signs a message using the key the descriptor names. */
    signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        type?: "schnorr" | "ecdsa",
    ): Promise<Uint8Array>;
}

/**
 * Adapts an existing {@link DescriptorProvider} to the narrower
 * {@link DescriptorSigningSource} role.
 *
 * This is what keeps the phase non-breaking: the wallet's provider — HD,
 * static, or a custom implementation — keeps its full public interface and
 * its current behaviour, and only its signing half is composed with other
 * sources. Signing calls pass straight through, so a batch-signing
 * identity behind a `StaticDescriptorProvider` still sees exactly the
 * requests it saw before.
 */
export class ProviderSigningSource implements DescriptorSigningSource {
    constructor(private readonly provider: DescriptorProvider) {}

    async canProvide(descriptor: string): Promise<boolean> {
        return this.provider.isOurs(descriptor);
    }

    async signWithDescriptor(requests: DescriptorSigningRequest[]): Promise<Transaction[]> {
        return this.provider.signWithDescriptor(requests);
    }

    async signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        type: "schnorr" | "ecdsa" = "schnorr",
    ): Promise<Uint8Array> {
        return this.provider.signMessageWithDescriptor(descriptor, message, type);
    }
}
