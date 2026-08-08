import { Identity } from "../identity";

/**
 * Capability a wallet exposes so descriptor-blind consumers — Boltz swaps and
 * other plugins — can bind the artifacts they create to the wallet's current
 * HD index and later enumerate every index that has been used.
 *
 * Probed structurally ({@link isHDWalletCapable}) rather than widening
 * `IWallet`: plugins must keep working against wallets that predate it, and a
 * static wallet answers "no HD state" through the same three methods.
 */
export interface HDWalletCapable {
    /**
     * The descriptor at the wallet's current receive index, or `undefined` for
     * static / `auto` wallets and HD wallets that have never rotated. Callers
     * fall back to the identity key.
     */
    getCurrentSigningDescriptor(): Promise<string | undefined>;

    /**
     * Every descriptor the wallet may hold keys under, ascending by index:
     * the allocation watermark's band plus any descriptor persisted on a
     * contract. Empty for static wallets.
     *
     * `lookAhead` appends that many descriptors past the watermark without
     * advancing it, for a restore that must probe indices no local state
     * mentions yet.
     */
    getUsedSigningDescriptors(opts?: { lookAhead?: number }): Promise<string[]>;

    /**
     * An {@link Identity} whose keys and signatures are those of `descriptor`.
     * Returns the wallet identity itself when the wallet has no descriptor
     * signer.
     */
    signerForDescriptor(descriptor: string): Promise<Identity>;
}

/** Structural type guard for {@link HDWalletCapable}. */
export function isHDWalletCapable(value: unknown): value is HDWalletCapable {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.getCurrentSigningDescriptor === "function" &&
        typeof v.getUsedSigningDescriptors === "function" &&
        typeof v.signerForDescriptor === "function"
    );
}

/**
 * Allocating a *fresh* index, which is strictly more than
 * {@link HDWalletCapable}'s descriptor awareness.
 *
 * Deliberately a separate probe rather than three more methods on
 * `HDWalletCapable`: widening that guard would silently demote every wallet
 * implementing only its original surface — including one built by an older
 * SDK — from HD-capable to static, which is exactly the breakage it documents
 * itself as avoiding. Consumers that only read descriptors keep the narrow
 * probe; anything deriving per-artifact secrets asks for this one.
 */
export interface HDAllocationCapable {
    /**
     * Allocate the next descriptor, advancing the watermark. `undefined` for
     * static / `auto` wallets, which cannot allocate.
     *
     * Distinct from {@link HDWalletCapable.getCurrentSigningDescriptor}, which
     * peeks: two artifacts bound to a peek share a key.
     */
    getNextSigningDescriptor(): Promise<string | undefined>;

    /**
     * Move the allocation watermark to `descriptor`'s index so later
     * allocations cannot reissue it. Monotonic — a lower index is a no-op.
     *
     * Throws on a descriptor this wallet cannot derive, or one with no
     * parseable trailing child index: silently mapping those to index 0 would
     * move the watermark nowhere and let a restored artifact's index be handed
     * out again.
     */
    advanceSigningDescriptorWatermark(descriptor: string): Promise<void>;
}

/** Structural type guard for {@link HDAllocationCapable}. */
export function isHDAllocationCapable(value: unknown): value is HDAllocationCapable {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.getNextSigningDescriptor === "function" &&
        typeof v.advanceSigningDescriptorWatermark === "function"
    );
}
