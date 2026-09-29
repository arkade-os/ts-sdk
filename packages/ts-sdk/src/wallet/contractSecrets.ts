/**
 * Secrets a contract needs in order to be spendable by us, provisioned by the wallet.
 *
 * A consumer names the leg it is building (a refund key for a leg it funds, a claim key and
 * preimage for one it claims); the wallet answers with a pubkey to bind into the covenant plus the
 * descriptor that recovers the signer later. Consumers never generate key material, never persist
 * a private key, and never branch on wallet type.
 *
 * The preimage rule keys off the **descriptor's shape**, not the wallet's type. An HD child
 * descriptor belongs to exactly one artifact, so its preimage is a deterministic signature over
 * the key — recoverable from the seed with nothing at rest. A bare `tr(pubkey)` repeats across
 * artifacts (the same derivation would give each the identical preimage), so it derives from a
 * **salted** message: 32 public bytes minted per artifact and stored in the clear. Only a signer
 * that cannot sign deterministically gets a random preimage, and `mustPersistPreimage` then says
 * it is the artifact's only claim secret.
 *
 * The shape test only picks the arm; collision safety never rests on it, so a custom
 * `DescriptorProvider` returning one constant descriptor still gets a distinct preimage per
 * artifact.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { equalBytes } from "@scure/btc-signer/utils.js";
import { Identity, ReadonlyIdentity, isSigningIdentity } from "../identity";
import {
    deriveDescriptorLeafPubKey,
    identityDescriptor,
    parseHDDescriptor,
} from "../identity/descriptor";
import {
    ForeignDescriptorError,
    isHDAllocationCapable,
    isHDWalletCapable,
} from "./hdWalletCapable";
import type { IWallet } from ".";
import { ArkAddress } from "../script/address";

/**
 * Domain separator for the preimage derivation. Protocol-scoped and versioned, mirroring NArk's
 * `Arkade-Boltz-Preimage-v1` (`SwapsManagementService.cs:128`), so any Arkade SDK reproduces the
 * same preimage and can recover another SDK's artifact. Deliberately distinct from the Boltz tag:
 * a shared tag would make one wallet key derive one preimage for both corridors.
 */
export const ARKADE_SWAP_PREIMAGE_TAG = "Arkade-RFQ-Preimage-v1";

/**
 * Domain separator for the **salted** derivation, used when the descriptor repeats across
 * artifacts. Corridor-generic, unlike {@link ARKADE_SWAP_PREIMAGE_TAG}, deliberately: v1 pins its
 * message index, so its tag is all that separates two corridors reaching the same key; here the
 * per-artifact salt carries that separation.
 */
export const ARKADE_SALTED_PREIMAGE_TAG = "Arkade-Contract-Preimage-Salted-v1";

/**
 * `TAG ‖ xonly(32) ‖ u32le(index)` — the message that gets BIP-340 signed. Anchored on the x-only
 * key, not the descriptor string: a restore rebuilds a descriptor that serialises differently from
 * the one used at creation, and only the key agrees across both.
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
 * `TAG ‖ xonly(32) ‖ salt(32)` — the salted message that gets BIP-340 signed. The salt replaces
 * v1's pinned index as the per-artifact uniqueness source; it is public, useless without the seed.
 */
export function buildSaltedPreimageMessage(xonly: Uint8Array, salt: Uint8Array): Uint8Array {
    if (xonly.length !== 32) {
        throw new Error(`x-only pubkey must be 32 bytes, got ${xonly.length}`);
    }
    if (salt.length !== 32) {
        throw new Error(`preimage salt must be 32 bytes, got ${salt.length}`);
    }
    const tag = new TextEncoder().encode(ARKADE_SALTED_PREIMAGE_TAG);
    const message = new Uint8Array(tag.length + 32 + 32);
    message.set(tag, 0);
    message.set(xonly, tag.length);
    message.set(salt, tag.length + 32);
    return message;
}

/**
 * Pinned: unsalted derivation is only safe when the key belongs to one artifact. Still a
 * parameter of {@link buildPreimageMessage} for cross-SDK vectors.
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
    /**
     * The pkScript of the wallet's current receive address, so callers building the lockup need
     * no separate {@link IWallet.getAddress} or `ArkAddress.decode`.
     */
    pkScript: Uint8Array;
    /**
     * The receive address {@link pkScript} was decoded from, in the same {@link IWallet.getAddress}
     * read. The quote-time refund address and the covenant's `refundPkScript` must name the same
     * script, and two reads of a rotating wallet need not agree — reuse this, never a second
     * `getAddress()` call.
     */
    address: string;
}

/**
 * A claim key together with the preimage it claims with. `pkScript` and
 * `address` are excluded: a claim leg funds nothing, so it names no refund
 * destination.
 */
export interface ProvisionedClaimSecret extends Omit<ProvisionedKey, "pkScript" | "address"> {
    preimage: Uint8Array;
    /** `sha256(preimage)` — what the contract commits to. */
    paymentHash: Uint8Array;
    /**
     * The salt {@link preimage} was derived from, on the salted arm. **Public**, unlike
     * {@link preimage}: persist it in the clear with the artifact — without it even the seed
     * cannot re-derive P. Absent on the other arms.
     */
    preimageSalt?: Uint8Array;
    /**
     * Persist `preimage` with the artifact: this wallet cannot re-derive it (caller-supplied P,
     * or a signer that cannot sign deterministically). When false, P re-derives from the seed
     * (given {@link preimageSalt}, if any) and nothing secret needs storing.
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
    return allocated ?? (await identityDescriptor(wallet.identity));
}

/**
 * The key that spends a leg we fund — an HTLC's refund key, a covenant's cancel-path user key.
 *
 * `pubkey` comes from a signer the wallet produced, never the descriptor string alone: parsing
 * succeeds just as well for a key this wallet cannot sign for (a worker rebound to another
 * identity, a record restored onto the wrong seed), and the failure would surface at refund time
 * with the money committed. Throws {@link ForeignDescriptorError} instead, before any quote.
 *
 * Reuses the identity key rather than a fresh HD child, so no index is consumed for an artifact
 * never built, and the refund path is on the same key as the quote-time refund address.
 */
export async function provisionRefundKey(wallet: IWallet): Promise<ProvisionedKey> {
    const descriptor = await identityDescriptor(wallet.identity);
    const signer = await contractSigner(wallet, descriptor);
    const pubkey = await signer.xOnlyPublicKey();
    // The refund path and refund destination must be one key, or the user cannot recover funds.
    const identityPubkey = await wallet.identity.xOnlyPublicKey();
    if (!equalBytes(pubkey, identityPubkey)) {
        throw new Error(
            "provisionRefundKey: descriptor pubkey does not match wallet identity — " +
                "the refund key and the refund address would be on different keys",
        );
    }
    // One getAddress() answer for both `address` (refund destination) and `pkScript` (covenant).
    const address = await wallet.getAddress();
    const { pkScript } = ArkAddress.decode(address);
    return { descriptor, pubkey, pkScript, address };
}

/**
 * The key that spends a leg we claim, plus the preimage that unlocks it. Three arms:
 *
 * 1. **Caller-supplied `opts.preimage`** (32 bytes). Returned verbatim with
 *    `mustPersistPreimage: true`, since the wallet cannot re-derive what it did not choose.
 * 2. **Per-artifact descriptor** (an HD child). Derives from the key alone at the pinned index;
 *    nothing at rest. Raises if the signer cannot sign deterministically — that is a broken HD
 *    wallet, not a fallback case.
 * 3. **Anything else** (a static `tr(pubkey)`, a custom provider's constant descriptor). Mints a
 *    public per-artifact salt and derives from it. Only this arm falls back to a stored random
 *    preimage, and only when the signer refuses — discovered by deriving, never by probing.
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
    // A fresh HD index, so each artifact's preimage is uniquely derivable (unlike the refund key).
    const descriptor = await provisionDescriptor(wallet);
    const signer = await contractSigner(wallet, descriptor);
    const pubkey = await signer.xOnlyPublicKey();
    const claim = async (): Promise<
        Pick<ProvisionedClaimSecret, "preimage" | "preimageSalt" | "mustPersistPreimage">
    > => {
        if (opts.preimage) return { preimage: opts.preimage, mustPersistPreimage: true };
        if (isPerArtifactDescriptor(descriptor)) {
            return {
                preimage: await derivePreimage(wallet, descriptor),
                mustPersistPreimage: false,
            };
        }
        const preimageSalt = randomBytes(32);
        try {
            return {
                preimage: await derivePreimage(wallet, descriptor, preimageSalt),
                preimageSalt,
                mustPersistPreimage: false,
            };
        } catch (cause) {
            // Only "cannot sign deterministically" may be absorbed: degrading a foreign key or a
            // non-signing wallet to a stored preimage would fund a leg nothing can spend and
            // report success. (Reaching those here means the signer changed under us.)
            if (cause instanceof ForeignDescriptorError || cause instanceof WalletCannotSignError) {
                throw cause;
            }
            // The probe IS the use: DescriptorIdentity only refuses at call time. Discard the
            // salt — a record carrying one it cannot derive from is worse than none.
            return { preimage: randomBytes(32), mustPersistPreimage: true };
        }
    };
    const { preimage, preimageSalt, mustPersistPreimage } = await claim();
    return {
        descriptor,
        pubkey,
        preimage,
        paymentHash: sha256(preimage),
        ...(preimageSalt ? { preimageSalt } : {}),
        mustPersistPreimage,
    };
}

/**
 * The signer for a provisioned descriptor, verified by public-key equality (never a wallet-type
 * probe) to be that descriptor's key: a wallet answering with another seed's key would sign
 * happily and fail only as a counterparty rejection or a dead script.
 *
 * Limit: this catches a wallet substituting its *baseline* identity. A descriptor-scoped identity
 * over the same descriptor reads its pubkey back from the string, making the check a tautology;
 * {@link resolveDescriptorSigner}'s `isOurs` test (used by both shipped wallets) rules that out,
 * so this is the backstop for a hand-rolled `IWallet`, not the primary guarantee.
 */
export async function contractSigner(wallet: IWallet, descriptor: string): Promise<Identity> {
    const signer = isHDWalletCapable(wallet)
        ? await wallet.signerForDescriptor(descriptor)
        : wallet.identity;
    // An unreadable key is one no wallet can prove it holds — typed the same as a mismatch.
    let expected: Uint8Array;
    try {
        expected = deriveDescriptorLeafPubKey(descriptor);
    } catch (cause) {
        throw new ForeignDescriptorError(descriptor, { cause });
    }
    // Outside the try: a signer failing to answer is a retryable outage, not evidence of a
    // foreign key — typing it foreign would make a transient failure terminal.
    const actual = await signer.xOnlyPublicKey();
    // Baseline-substitution check only; see the docstring for its limit.
    if (!equalBytes(actual, expected)) throw new ForeignDescriptorError(descriptor);
    if (!isSigningIdentity(signer)) throw new WalletCannotSignError(descriptor);
    return signer;
}

/**
 * A wallet that holds a contract's key but cannot sign with it (watch-only, or a remote signer
 * without its transport). Distinct from {@link ForeignDescriptorError} ("wrong wallet") because
 * the remedy differs. Raised at provisioning too, so a wallet that could never spend a leg finds
 * out before funding it.
 */
export class WalletCannotSignError extends Error {
    override readonly name = "WalletCannotSignError";
    constructor(readonly descriptor: string) {
        super(`this wallet holds the key for ${descriptor} but cannot sign with it`);
    }
}

/**
 * The preimage for a provisioned descriptor, in the precedence {@link provisionClaimSecret} chose:
 *
 * 1. `opts.stored` — a caller-supplied P, or one a wallet could not derive; always the artifact's.
 * 2. a per-artifact descriptor — derive at the pinned index.
 * 3. `opts.salt` — derive from the salted message.
 * 4. otherwise throw: a repeating descriptor with neither has nothing collision-free to derive.
 */
export async function contractPreimage(
    wallet: IWallet,
    descriptor: string,
    opts: { stored?: Uint8Array; salt?: Uint8Array } = {},
): Promise<Uint8Array> {
    if (opts.stored) {
        // OP_SIZE 32, as provisioning enforces: a truncated column would otherwise restore
        // silently and fail only at claim time, with the timeout margin spent.
        if (opts.stored.length !== 32) {
            throw new Error(`stored preimage must be 32 bytes, got ${opts.stored.length}`);
        }
        return opts.stored;
    }
    if (isPerArtifactDescriptor(descriptor)) return derivePreimage(wallet, descriptor);
    if (opts.salt) return derivePreimage(wallet, descriptor, opts.salt);
    throw new Error(
        `descriptor ${descriptor} names no single artifact, so its preimage cannot be derived; no salt and no stored preimage were given`,
    );
}

/** An identity that signs with `aux_rand = 0`, which is what makes the
 * derivation reproducible. `DescriptorIdentity` satisfies it, and throws
 * rather than degrading to a random-aux signer. */
export interface DeterministicSigner extends ReadonlyIdentity {
    /**
     * Implementors wrapping a remote: throw only for a refusal that will repeat.
     * {@link provisionClaimSecret} reads any throw (even a network hiccup) as "cannot derive" and
     * silently falls back to a stored random preimage for the artifact's whole life.
     */
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
 * `sha256(sign_det(sha256(TAG ‖ xonly ‖ index)))`, or its salted variant when
 * `salt` is given — where the signing key and the message key are the same
 * identity. Passing a key in separately is how this silently derives an
 * unrecoverable preimage.
 */
async function derivePreimage(
    wallet: IWallet,
    descriptor: string,
    salt?: Uint8Array,
): Promise<Uint8Array> {
    const signer = await contractSigner(wallet, descriptor);
    if (!isDeterministicSigner(signer)) {
        // Loud: a preimage from a random-aux signature is unrecoverable, and
        // the failure would otherwise only surface at claim time.
        throw new Error(
            `wallet cannot sign deterministically for ${descriptor}; its preimage is not derivable`,
        );
    }
    const xonly = await signer.xOnlyPublicKey();
    const message = salt
        ? buildSaltedPreimageMessage(xonly, salt)
        : buildPreimageMessage(xonly, PREIMAGE_INDEX);
    try {
        return sha256(await signer.signSchnorrDeterministic(sha256(message)));
    } catch (cause) {
        // The structural guard can't see call-time refusals: DescriptorIdentity always exposes
        // the method.
        throw new Error(
            `wallet cannot sign deterministically for ${descriptor}; its preimage is not derivable`,
            { cause },
        );
    }
}

/**
 * Claim a restored artifact's index so a later allocation cannot reissue it (which would derive
 * that artifact's preimage again, for a different one).
 *
 * Monotonic, and a no-op wherever there is no index to reserve (a shared-key descriptor, another
 * seed's artifact), since restores iterate whole histories. Recognising "another seed's" needs
 * {@link HDWalletCapable.signerForDescriptor}; without it a foreign artifact surfaces as the
 * watermark call's untyped error. Every shipped wallet implements both.
 */
export async function adoptContractDescriptor(wallet: IWallet, descriptor: string): Promise<void> {
    if (!isHDAllocationCapable(wallet)) return;
    if (!isPerArtifactDescriptor(descriptor)) return;
    if (isHDWalletCapable(wallet)) {
        try {
            await wallet.signerForDescriptor(descriptor);
        } catch (error) {
            // Checked here: the watermark call's refusal is untyped on some transports (the SW
            // bus flattens it). Only the typed "not my key" is a no-op; other failures propagate
            // so they are retried, not skipped.
            if (error instanceof ForeignDescriptorError) return;
            throw error;
        }
    }
    await wallet.advanceSigningDescriptorWatermark(descriptor);
}
