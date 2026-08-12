/**
 * Secrets a contract needs in order to be spendable by us, provisioned by the
 * wallet.
 *
 * A consumer names the leg it is building — a refund key for a leg it funds, a
 * claim key and preimage for one it claims — and the wallet answers with a
 * public key to bind into the covenant plus the descriptor that recovers the
 * signer later. Consumers never generate key material, never persist a private
 * key, and never branch on wallet type: the wallet decides whether the
 * descriptor is a fresh HD child or its one static key, and that decision is
 * invisible here.
 *
 * The preimage rule keys off the **descriptor's shape**, not the wallet's
 * type. An HD child descriptor belongs to exactly one artifact, so its
 * preimage can be a deterministic signature over the key — recoverable from
 * the seed with nothing at rest. A bare `tr(pubkey)` repeats across artifacts,
 * so the same derivation would hand every artifact the identical preimage;
 * those get a random one, and `mustPersistPreimage` tells the caller it is now
 * the artifact's only claim secret.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import { Identity, ReadonlyIdentity } from "../identity";
import {
    deriveDescriptorLeafPubKey,
    normalizeToDescriptor,
    parseHDDescriptor,
} from "../identity/descriptor";
import {
    ForeignDescriptorError,
    isHDAllocationCapable,
    isHDWalletCapable,
} from "./hdWalletCapable";
import type { IWallet } from ".";

/**
 * Domain separator for the preimage derivation.
 *
 * Protocol-scoped and versioned, mirroring NArk's `Arkade-Boltz-Preimage-v1`
 * (`SwapsManagementService.cs:128`), so any Arkade SDK implementing this
 * scheme reproduces the same preimage and can recover an artifact another
 * SDK created. Deliberately distinct from the Boltz tag: a shared tag would
 * make one wallet key derive one preimage for both corridors.
 */
export const ARKADE_SWAP_PREIMAGE_TAG = "Arkade-RFQ-Preimage-v1";

/**
 * `TAG ‖ xonly(32) ‖ u32le(index)` — the message that gets BIP-340 signed.
 *
 * Anchored on the canonical x-only key rather than the descriptor string: a
 * restore reconstructs a bare descriptor that serialises differently from the
 * signing descriptor used at creation, and only the key agrees across both.
 */
export function buildPreimageMessage(xonly: Uint8Array, index: number): Uint8Array {
    if (xonly.length !== 32) {
        throw new Error(`x-only pubkey must be 32 bytes, got ${xonly.length}`);
    }
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
        throw new Error(`index must be a u32, got ${index}`);
    }
    const tag = new TextEncoder().encode(ARKADE_SWAP_PREIMAGE_TAG);
    const message = new Uint8Array(tag.length + 32 + 4);
    message.set(tag, 0);
    message.set(xonly, tag.length);
    new DataView(message.buffer).setUint32(tag.length + 32, index, true);
    return message;
}

/**
 * Deriving is only safe when the key belongs to one artifact, so the message
 * index stays pinned. Kept a parameter of {@link buildPreimageMessage} for
 * cross-SDK vectors.
 */
const PREIMAGE_INDEX = 0;

/**
 * True iff `descriptor` names one artifact — an HD child. A bare `tr(pubkey)`
 * is the same key every time it is handed out, so anything deriving
 * per-artifact secrets must branch on this, never on the wallet's type.
 */
export function isPerArtifactDescriptor(descriptor: string): boolean {
    return parseHDDescriptor(descriptor) !== null;
}

/** A key the wallet provisioned for a contract we must be able to spend. */
export interface ProvisionedKey {
    /** x-only pubkey to bind into the covenant. */
    pubkey: Uint8Array;
    /**
     * The wallet descriptor it came from. Public — persist it with the
     * artifact; {@link contractSigner} resolves it back to a signer.
     */
    descriptor: string;
}

/** A claim key together with the preimage it claims with. */
export interface ProvisionedClaimSecret extends ProvisionedKey {
    preimage: Uint8Array;
    /** `sha256(preimage)` — what the contract commits to. */
    paymentHash: Uint8Array;
    /**
     * Persist `preimage` with the artifact: this wallet cannot re-derive it.
     * True when the caller supplied P, or when the descriptor is shared across
     * artifacts. When false the preimage re-derives from the seed and nothing
     * secret needs to be stored.
     */
    mustPersistPreimage: boolean;
}

/**
 * A descriptor for one artifact. HD wallets allocate a fresh index; static
 * wallets answer with their identity key, which is their whole policy.
 */
async function provisionDescriptor(wallet: IWallet): Promise<string> {
    const allocated = isHDAllocationCapable(wallet)
        ? await wallet.getNextSigningDescriptor()
        : undefined;
    // A wallet that cannot allocate still provides a key it holds.
    return allocated ?? normalizeToDescriptor(hex.encode(await wallet.identity.xOnlyPublicKey()));
}

/**
 * The key that spends a leg we fund — the refund key of an HTLC, the user key
 * of a covenant's cancel path.
 *
 * The returned `pubkey` is taken from a signer the wallet produced, never
 * from the descriptor string alone. That is the difference between an
 * invariant and a comment: deriving the leaf key is pure parsing and would
 * succeed just as well for a key this wallet cannot sign for — a descriptor
 * allocated by a worker rebound to another identity, a record restored onto
 * the wrong seed — and the covenant would bind it, the leg would fund, and
 * the failure would surface at refund time with the money already committed.
 * Throws {@link ForeignDescriptorError} instead, before there is a quote.
 *
 * On an HD wallet this consumes an index even if the artifact is never built,
 * and a swap index never becomes a funded receive contract, so a long run of
 * them widens the gap a seed-only restore scan sees.
 */
export async function provisionRefundKey(wallet: IWallet): Promise<ProvisionedKey> {
    const descriptor = await provisionDescriptor(wallet);
    const signer = await contractSigner(wallet, descriptor);
    return { descriptor, pubkey: await signer.xOnlyPublicKey() };
}

/**
 * The key that spends a leg we claim, plus the preimage that unlocks it.
 *
 * Pass `opts.preimage` to bring your own 32-byte P; it comes back verbatim
 * with `mustPersistPreimage` set, since the wallet cannot re-derive what it
 * did not choose.
 */
export async function provisionClaimSecret(
    wallet: IWallet,
    opts: { preimage?: Uint8Array } = {},
): Promise<ProvisionedClaimSecret> {
    if (opts.preimage && opts.preimage.length !== 32) {
        // HTLC claim leaves pin OP_SIZE 32: any other length is unclaimable.
        // Refused before an HD index is consumed.
        throw new Error(`preimage must be 32 bytes, got ${opts.preimage.length}`);
    }
    const { descriptor, pubkey } = await provisionRefundKey(wallet);
    const derivable = !opts.preimage && isPerArtifactDescriptor(descriptor);
    const preimage =
        opts.preimage ?? (derivable ? await derivePreimage(wallet, descriptor) : randomBytes(32));
    return {
        descriptor,
        pubkey,
        preimage,
        paymentHash: sha256(preimage),
        mustPersistPreimage: !derivable,
    };
}

/**
 * The signer for a provisioned descriptor, verified to actually be that
 * descriptor's key.
 *
 * The verification is a public-key equality, never a wallet-type probe: a
 * wallet that answers with the wrong key — another seed's, after a restore
 * mix-up — would sign happily, and the failure would surface only as a
 * counterparty rejection or a dead script.
 *
 * Know its limit. It catches a wallet that substitutes its *baseline*
 * identity, which is the failure this exists for. It cannot catch one that
 * returns a descriptor-scoped identity built over the same descriptor, since
 * such an identity reads its pubkey back out of the descriptor string and the
 * comparison becomes a tautology. What rules that case out is
 * {@link resolveDescriptorSigner}'s `isOurs` test, which both shipped wallets
 * resolve through — so this is the backstop for a hand-rolled `IWallet`, not
 * the primary guarantee.
 */
export async function contractSigner(wallet: IWallet, descriptor: string): Promise<Identity> {
    const signer = isHDWalletCapable(wallet)
        ? await wallet.signerForDescriptor(descriptor)
        : wallet.identity;
    // A descriptor whose key cannot be read is one no wallet can prove it
    // holds — the same verdict as a mismatch, and typed the same way.
    let expected: Uint8Array;
    try {
        expected = deriveDescriptorLeafPubKey(descriptor);
    } catch (cause) {
        throw new ForeignDescriptorError(descriptor, { cause });
    }
    // Deliberately outside any wrapping: a signer that fails to answer is an
    // operational failure to retry, not evidence the key belongs to someone
    // else. Typing it as foreign would make a transient outage terminal.
    const actual = await signer.xOnlyPublicKey();
    if (!equalBytes(actual, expected)) throw new ForeignDescriptorError(descriptor);
    if (!isSigningIdentity(signer)) throw new WalletCannotSignError(descriptor);
    return signer;
}

/**
 * A wallet that holds a contract's key but cannot sign with it: a watch-only
 * identity, or a remote signer whose transport is absent.
 *
 * Distinct from {@link ForeignDescriptorError} because the remedy differs —
 * that one says "wrong wallet", this one says "this wallet, without its
 * signer". Raised at provisioning as well as at signing, so a wallet that
 * could never spend the leg finds out before it funds one.
 */
export class WalletCannotSignError extends Error {
    override readonly name = "WalletCannotSignError";
    constructor(readonly descriptor: string) {
        super(`this wallet holds the key for ${descriptor} but cannot sign with it`);
    }
}

/**
 * Whether `value` is a complete {@link Identity} rather than the read-only
 * half of one.
 *
 * All four members are checked because all four are load-bearing downstream —
 * `signerSession` in particular, which an interactive refund needs and which a
 * watch-only identity lacks. A partial identity passes a pubkey check happily
 * and then fails as a `TypeError` deep inside a push, where the swap layer
 * reads it as retryable and grinds against it for the whole refund window.
 */
function isSigningIdentity(value: unknown): value is Identity {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.sign === "function" &&
        typeof v.signMessage === "function" &&
        typeof v.signerSession === "function" &&
        typeof v.xOnlyPublicKey === "function"
    );
}

/**
 * The preimage for a provisioned descriptor: `stored` when the artifact kept
 * one, otherwise re-derived from the seed.
 *
 * Throws for a descriptor shared across artifacts and no stored preimage —
 * deriving there would hand two artifacts one preimage, and the caller was
 * told to persist it (`mustPersistPreimage`).
 */
export async function contractPreimage(
    wallet: IWallet,
    descriptor: string,
    stored?: Uint8Array,
): Promise<Uint8Array> {
    if (stored) return stored;
    if (!isPerArtifactDescriptor(descriptor)) {
        throw new Error(
            `descriptor ${descriptor} names no single artifact, so its preimage cannot be derived; none was stored`,
        );
    }
    return derivePreimage(wallet, descriptor);
}

/** An identity that signs with `aux_rand = 0`, which is what makes the
 * derivation reproducible. `DescriptorIdentity` satisfies it, and throws
 * rather than degrading to a random-aux signer. */
export interface DeterministicSigner extends ReadonlyIdentity {
    signSchnorrDeterministic(messageHash: Uint8Array): Promise<Uint8Array>;
}

export function isDeterministicSigner(value: unknown): value is DeterministicSigner {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.signSchnorrDeterministic === "function" && typeof v.xOnlyPublicKey === "function"
    );
}

/**
 * `sha256(sign_det(sha256(TAG ‖ xonly ‖ index)))`, where the signing key and
 * the message key are the same identity — passing a key in separately is how
 * this silently derives an unrecoverable preimage.
 */
async function derivePreimage(wallet: IWallet, descriptor: string): Promise<Uint8Array> {
    const signer = await contractSigner(wallet, descriptor);
    if (!isDeterministicSigner(signer)) {
        // Loud: a preimage from a random-aux signature is unrecoverable, and
        // the failure would otherwise only surface at claim time.
        throw new Error(
            `wallet cannot sign deterministically for ${descriptor}; its preimage is not derivable`,
        );
    }
    const message = buildPreimageMessage(await signer.xOnlyPublicKey(), PREIMAGE_INDEX);
    try {
        return sha256(await signer.signSchnorrDeterministic(sha256(message)));
    } catch (cause) {
        // The structural guard cannot see call-time refusals: DescriptorIdentity
        // always exposes the method and only throws when its base cannot
        // actually sign deterministically.
        throw new Error(
            `wallet cannot sign deterministically for ${descriptor}; its preimage is not derivable`,
            { cause },
        );
    }
}

/**
 * Claim a restored artifact's index so a later allocation cannot reissue it —
 * which would derive that artifact's preimage a second time, for a different
 * one.
 *
 * Monotonic, and a no-op wherever there is no index to reserve. Restores
 * iterate whole histories, so an artifact this wallet has nothing to adopt for
 * must not abort the loop.
 */
export async function adoptContractDescriptor(wallet: IWallet, descriptor: string): Promise<void> {
    if (!isHDAllocationCapable(wallet)) return;
    if (!isPerArtifactDescriptor(descriptor)) return;
    await wallet.advanceSigningDescriptorWatermark(descriptor);
}
