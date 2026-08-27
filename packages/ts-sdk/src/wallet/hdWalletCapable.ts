import { equalBytes } from "@scure/btc-signer/utils.js";
import { Identity } from "../identity";
import { DescriptorIdentity } from "../identity/descriptorIdentity";
import { deriveDescriptorLeafPubKey, parseHDDescriptor } from "../identity/descriptor";
import { isHDCapableIdentity } from "../identity/hdCapableIdentity";
import type { DescriptorProvider } from "../identity/descriptorProvider";

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
     * Returns the wallet identity itself when `descriptor` is the identity's
     * own key (a static wallet's descriptor, or an HD wallet's baseline key).
     *
     * Throws {@link ForeignDescriptorError} for a descriptor this wallet
     * cannot sign for. Never silently substitutes another key: an identity
     * handed out for a foreign descriptor signs happily with the wrong key,
     * and that surfaces only as a rejected transaction or a dead script —
     * far from the call that caused it.
     *
     * The returned identity must actually sign — `sign`, `signMessage` and
     * `signerSession`, not just `xOnlyPublicKey`. A watch-only identity
     * carrying the right key is not a signer, and `contractSigner` refuses it
     * as `WalletCannotSignError`: returning one here would otherwise pass
     * every check and throw at push time, after the contract is funded.
     */
    signerForDescriptor(descriptor: string): Promise<Identity>;
}

/**
 * Thrown by {@link HDWalletCapable.signerForDescriptor} when the wallet holds
 * no key for the requested descriptor — it belongs to another seed, or to an
 * identity this wallet does not carry. A typed refusal so callers can tell
 * "not my key" from transient signing failures.
 */
export class ForeignDescriptorError extends Error {
    override readonly name = "ForeignDescriptorError";
    constructor(
        readonly descriptor: string,
        options?: { cause?: unknown },
    ) {
        super(`this wallet holds no key for descriptor: ${descriptor}`, options);
    }
}

/**
 * Thrown by `Wallet.getNewAddresses({ forceNew: true })` when the wallet has
 * no HD stream to advance — `walletMode: 'static'` / `'auto'`, or a
 * {@link DescriptorProvider} that declined to allocate.
 *
 * A typed refusal rather than a silent repeat: a caller that asked for a
 * *fresh* address is issuing one per counterparty, and quietly returning the
 * address it already handed out surfaces only as two payers sharing a script.
 */
export class WalletCannotAllocateAddressError extends Error {
    override readonly name = "WalletCannotAllocateAddressError";
    constructor(reason: string, options?: { cause?: unknown }) {
        super(`cannot allocate a fresh address: ${reason}`, options);
    }
}

/** Anything that can derive and sign for a descriptor it claims. */
type DescriptorOwner = Pick<
    DescriptorProvider,
    "isOurs" | "signWithDescriptor" | "signMessageWithDescriptor"
>;

/**
 * The identity that signs `descriptor`, or {@link ForeignDescriptorError}.
 *
 * Shared by every {@link HDWalletCapable.signerForDescriptor} implementation
 * so they cannot drift: the page-side and worker-side wallets answering
 * differently for one descriptor is a signer that passes a public-key check
 * and then throws on every signature — after the artifact is funded.
 */
export async function resolveDescriptorSigner(
    descriptor: string,
    identity: Identity,
    provider?: DescriptorOwner,
): Promise<Identity> {
    // Whoever owns the derivation signs it: the wallet's descriptor provider,
    // or — on a wallet configured without one — a seed-backed identity that
    // owns the descriptor itself.
    const owner = provider?.isOurs(descriptor)
        ? provider
        : isHDCapableIdentity(identity) && identity.isOurs(descriptor)
          ? identity
          : undefined;
    // Only a descriptor carrying a derivation path has anything to derive.
    // It wins over the identity even when its leaf key aliases the identity
    // key (a fresh HD wallet's index 0), because the identity cannot sign
    // deterministically for an index.
    if (owner && parseHDDescriptor(descriptor)) {
        return new DescriptorIdentity({ descriptor, signer: owner, base: identity });
    }
    // A pathless `tr(pubkey)` has no derivation to perform, so the identity
    // signs it directly when it holds that key — and a descriptor we cannot
    // read a key out of is one no wallet can claim.
    let key: Uint8Array;
    try {
        key = deriveDescriptorLeafPubKey(descriptor);
    } catch {
        throw new ForeignDescriptorError(descriptor);
    }
    // Deliberately outside the try: a signer that fails to answer is an error
    // to propagate, not evidence that the key is someone else's.
    if (equalBytes(await identity.xOnlyPublicKey(), key)) return identity;
    throw new ForeignDescriptorError(descriptor);
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
     * The signing descriptor a new artifact (a swap, an invoice, a contract)
     * should bind to. **The wallet decides what that means**: an HD wallet
     * allocates a fresh index, advancing the watermark; a static wallet
     * answers with its one `tr(pubkey)` descriptor every time. Consumers must
     * not probe the wallet's shape or mint key material of their own — they
     * ask, and use what comes back with
     * {@link HDWalletCapable.signerForDescriptor}.
     *
     * `undefined` only for implementations that genuinely cannot answer;
     * `Wallet` always answers. Callers that must work against such wallets
     * fall back to the identity key — never to a random one.
     *
     * Distinct from {@link HDWalletCapable.getCurrentSigningDescriptor}, which
     * peeks: on an HD wallet, two artifacts bound to a peek share a key.
     * Whether the returned descriptor is unique per call is a property of the
     * wallet, not of this method — anything deriving per-artifact secrets
     * from the descriptor must check the descriptor's shape, not the wallet's.
     */
    getNextSigningDescriptor(): Promise<string | undefined>;

    /**
     * Move the allocation watermark to `descriptor`'s index so later
     * allocations cannot reissue it. Monotonic — a lower index is a no-op.
     * On a static wallet there is no watermark: the wallet's own descriptor
     * is accepted as a no-op.
     *
     * Throws on a descriptor this wallet cannot derive, or an HD descriptor
     * with no parseable trailing child index: silently mapping those to index
     * 0 would move the watermark nowhere and let a restored artifact's index
     * be handed out again.
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
