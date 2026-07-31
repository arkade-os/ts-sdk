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
     */
    getUsedSigningDescriptors(): Promise<string[]>;

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
