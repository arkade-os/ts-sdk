import { equalBytes } from "@scure/btc-signer/utils.js";
import { Identity } from "../identity";
import { DescriptorIdentity } from "../identity/descriptorIdentity";
import { deriveDescriptorLeafPubKey, parseHDDescriptor } from "../identity/descriptor";
import { isHDCapableIdentity } from "../identity/hdCapableIdentity";
import type { DescriptorProvider } from "../identity/descriptorProvider";
import type { GetNewAddressesOptions, NewAddress } from "./index";

/**
 * Capability a wallet exposes so descriptor-blind consumers (Boltz swaps, other plugins) can bind
 * artifacts to the wallet's current HD index and later enumerate every used index. Probed
 * structurally ({@link isHDWalletCapable}) rather than widening `IWallet`, so plugins keep working
 * against older wallets; a static wallet answers "no HD state" through the same methods.
 */
export interface HDWalletCapable {
    /**
     * The descriptor at the wallet's current receive index, or `undefined` for
     * static / `auto` wallets and HD wallets that have never rotated. Callers
     * fall back to the identity key.
     */
    getCurrentSigningDescriptor(): Promise<string | undefined>;

    /**
     * Every descriptor the wallet may hold keys under, ascending by index: the allocation
     * watermark's band plus any descriptor persisted on a contract. Empty for static wallets.
     * `lookAhead` appends that many past the watermark without advancing it, for restore probing.
     */
    getUsedSigningDescriptors(opts?: { lookAhead?: number }): Promise<string[]>;

    /**
     * An {@link Identity} whose keys and signatures are those of `descriptor`; the wallet
     * identity itself when `descriptor` is the identity's own key.
     *
     * Throws {@link ForeignDescriptorError} for a descriptor this wallet cannot sign for — never
     * substitutes another key, which would sign happily and surface only as a rejected tx or a
     * dead script. The returned identity must actually sign (`sign`, `signMessage`,
     * `signerSession`): `contractSigner` refuses a watch-only one as `WalletCannotSignError`,
     * which would otherwise pass every check and throw after the contract is funded.
     */
    signerForDescriptor(descriptor: string): Promise<Identity>;
}

/**
 * Thrown by {@link HDWalletCapable.signerForDescriptor} when the wallet holds no key for the
 * descriptor, so callers can tell "not my key" from transient signing failures.
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
 * Thrown by `Wallet.getNewAddresses({ forceNew: true })` when there is no HD stream to advance
 * (`walletMode: 'static'` / `'auto'`, or a {@link DescriptorProvider} that declined). Typed
 * rather than a silent repeat, which would surface only as two payers sharing a script.
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
 * The identity that signs `descriptor`, or {@link ForeignDescriptorError}. Shared by every
 * {@link HDWalletCapable.signerForDescriptor} so page- and worker-side wallets cannot drift into
 * a signer that passes a pubkey check and then throws on every signature, after funding.
 */
export async function resolveDescriptorSigner(
    descriptor: string,
    identity: Identity,
    provider?: DescriptorOwner,
): Promise<Identity> {
    const providerOwner = provider?.isOurs(descriptor) ? provider : undefined;
    const identityOwner =
        !providerOwner && isHDCapableIdentity(identity) && identity.ownsDescriptor(descriptor)
            ? ({
                  signWithDescriptor: (requests) => identity.signDescriptorTransactions(requests),
                  signMessageWithDescriptor: (ownedDescriptor, message, signatureType) =>
                      identity.signDescriptorMessage(ownedDescriptor, message, signatureType),
              } satisfies Pick<
                  DescriptorProvider,
                  "signWithDescriptor" | "signMessageWithDescriptor"
              >)
            : undefined;
    const owner = providerOwner ?? identityOwner;
    // A pathed descriptor wins even when its leaf aliases the identity key (a fresh HD wallet's
    // index 0): the identity cannot sign deterministically for an index.
    if (owner && parseHDDescriptor(descriptor)) {
        return new DescriptorIdentity({ descriptor, signer: owner, base: identity });
    }
    // Pathless `tr(pubkey)`: the identity signs it directly if it holds that key.
    let key: Uint8Array;
    try {
        key = deriveDescriptorLeafPubKey(descriptor);
    } catch {
        throw new ForeignDescriptorError(descriptor);
    }
    // Outside the try: a signer failing to answer propagates rather than reading as foreign.
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
 * Allocating a *fresh* index — strictly more than {@link HDWalletCapable}'s descriptor awareness.
 * A separate probe because widening that guard would silently demote every wallet implementing
 * only its original surface (including older SDKs') from HD-capable to static.
 */
export interface HDAllocationCapable {
    /**
     * The signing descriptor a new artifact (swap, invoice, contract) should bind to. **The
     * wallet decides**: an HD wallet allocates a fresh index, advancing the watermark; a static
     * wallet answers with its one `tr(pubkey)` every time. Consumers must not probe the wallet's
     * shape or mint key material; they use the answer with
     * {@link HDWalletCapable.signerForDescriptor}.
     *
     * `undefined` only for implementations that genuinely cannot answer (`Wallet` always
     * answers); callers then fall back to the identity key — never a random one.
     *
     * Unlike {@link HDWalletCapable.getCurrentSigningDescriptor}, which peeks (two artifacts bound
     * to a peek share a key). Per-call uniqueness is a wallet property, so anything deriving
     * per-artifact secrets must check the descriptor's shape, not the wallet's.
     */
    getNextSigningDescriptor(): Promise<string | undefined>;

    /**
     * Move the allocation watermark to `descriptor`'s index so later allocations cannot reissue
     * it. Monotonic; a static wallet accepts its own descriptor as a no-op.
     *
     * Throws on a descriptor this wallet cannot derive, or an HD descriptor with no parseable
     * trailing index: mapping those to index 0 would let a restored artifact's index be reissued.
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

/**
 * Minting addresses to hand out: beyond {@link HDAllocationCapable}'s bare index, the wallet
 * builds the scripts, persists them as watched contracts, and reports the rows. A third probe
 * for the same no-silent-demotion reason.
 */
export interface AddressAllocationCapable {
    /**
     * Fresh addresses of each requested type from one newly allocated HD index, persisted and
     * watched. An HD wallet burns an index; a wallet with no stream answers with its existing
     * display addresses or, under `forceNew`, throws {@link WalletCannotAllocateAddressError}.
     *
     * Unlike {@link HDAllocationCapable.getNextSigningDescriptor}, allocation and script
     * registration happen together: split across a process boundary, a failed registration
     * leaves a burnt index and an unwatched address.
     */
    getNewAddresses(opts?: GetNewAddressesOptions): Promise<NewAddress[]>;
}

/** Structural type guard for {@link AddressAllocationCapable}. */
export function isAddressAllocationCapable(value: unknown): value is AddressAllocationCapable {
    if (typeof value !== "object" || value === null) return false;
    return typeof (value as Record<string, unknown>).getNewAddresses === "function";
}
