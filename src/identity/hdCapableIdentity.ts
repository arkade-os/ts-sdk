import { Identity } from ".";
import { DescriptorSigningRequest } from "./descriptorProvider";
import { Transaction } from "../utils/transaction";

/**
 * Capability marker for identities that can be rotated through an HD
 * derivation tree. Exposes the wildcard-suffixed account descriptor
 * *template* plus the descriptor-based signing primitives that an HD
 * receive-rotation provider needs.
 *
 * Deliberately does NOT extend `DescriptorProvider`: if an HD-capable
 * identity were silently usable as a concrete descriptor source, callers
 * could bypass receive rotation and unknowingly reuse a single address
 * forever. To use this identity as a wallet's descriptor source, wrap
 * it explicitly:
 *
 *  - `HDDescriptorProvider` — rotating, recommended for new wallets.
 *  - `StaticDescriptorProvider` — pinned to a single key, for legacy or
 *    explicitly-non-rotating use cases.
 */
export interface HDCapableIdentity extends Identity {
    /**
     * Returns the wildcard-suffixed account descriptor template
     * (e.g. `tr([fp/86'/0'/0']xpub/0/*)`). Consumers materialize a
     * concrete descriptor by replacing the `*` with a derivation index.
     */
    getAccountDescriptor(): string;

    /** True iff `descriptor` derives from this identity's seed. */
    isOurs(descriptor: string): boolean;

    /** Signs each request with the key derived from its descriptor. */
    signWithDescriptor(
        requests: DescriptorSigningRequest[]
    ): Promise<Transaction[]>;

    /** Signs a message using the key derived from `descriptor`. */
    signMessageWithDescriptor(
        descriptor: string,
        message: Uint8Array,
        signatureType?: "schnorr" | "ecdsa"
    ): Promise<Uint8Array>;
}
