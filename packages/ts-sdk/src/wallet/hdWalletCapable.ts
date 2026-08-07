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
     * Allocate a fresh descriptor by advancing the wallet's HD watermark, or
     * `undefined` for static / `auto` wallets. Required by consumers that
     * derive a secret from the descriptor key — two artifacts sharing an index
     * would share that secret. Rides the same monotonic, mutex-guarded
     * allocator as receive rotation, so the bump is the reservation.
     */
    getNextSigningDescriptor(): Promise<string | undefined>;

    /**
     * Every descriptor the wallet may hold keys under, ascending by index:
     * the allocation watermark's band plus any descriptor persisted on a
     * contract. Empty for static wallets.
     *
     * `lookAhead` appends the descriptors just past the watermark, for
     * consumers whose indices leave no on-chain footprint (a swap burns an
     * index that the restore gap-scan cannot see) and so may sit above it.
     */
    getUsedSigningDescriptors(opts?: { lookAhead?: number }): Promise<string[]>;

    /**
     * Monotonically raise the allocation watermark to `descriptor`'s index so
     * a later allocation cannot reissue it. No-op for static wallets, for a
     * descriptor that is not ours, and for an index at or below the current
     * watermark. Throws on a descriptor with no parseable trailing index —
     * treating one as index 0 would silently drop the protection.
     */
    advanceSigningDescriptorWatermark(descriptor: string): Promise<void>;

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
        typeof v.getNextSigningDescriptor === "function" &&
        typeof v.getUsedSigningDescriptors === "function" &&
        typeof v.advanceSigningDescriptorWatermark === "function" &&
        typeof v.signerForDescriptor === "function"
    );
}
