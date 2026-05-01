import { Identity, ReadonlyIdentity } from ".";
import { DescriptorSigningRequest } from "./descriptorProvider";
import { Transaction } from "../utils/transaction";

/**
 * Read-side HD capability marker. Exposes the wildcard-suffixed account
 * descriptor *template* and the descriptor-membership predicate, but no
 * signing primitives — suitable for watch-only identities backed by an
 * xpub.
 *
 * Extracted from {@link HDCapableIdentity} so that
 * `ReadonlyDescriptorIdentity` can stand in for an HD wallet's read-only
 * surface (template-aware, derives pubkeys at any index) without having
 * to claim signing capability it cannot honour.
 */
export interface ReadonlyHDCapableIdentity extends ReadonlyIdentity {
    /**
     * The wildcard-suffixed account descriptor template
     * (e.g. `tr([fp/86'/0'/0']xpub/0/*)`). Consumers materialize a
     * concrete descriptor by replacing the `*` with a derivation index.
     */
    readonly descriptor: string;

    /** True iff `descriptor` derives from this identity's xpub/seed. */
    isOurs(descriptor: string): boolean;
}

/**
 * Capability marker for identities that can be rotated through an HD
 * derivation tree AND can sign at each rotated index.
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
export interface HDCapableIdentity extends ReadonlyHDCapableIdentity, Identity {
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
