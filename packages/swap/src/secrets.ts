/**
 * RFQ swap secrets, provided by the wallet instead of minted here.
 *
 * The VHTLC `sender` key always comes from the wallet — this package never
 * generates signing keys. `wallet.getNextSigningDescriptor()` is where the
 * policy lives: an HD wallet allocates a fresh descriptor per swap, a static
 * wallet answers with its one `tr(pubkey)` descriptor. The swap record keeps
 * the descriptor, which is public, and the signer is recovered later through
 * `wallet.signerForDescriptor()`.
 *
 * The preimage splits by descriptor shape, not by wallet type:
 * - A per-swap (HD) descriptor derives its preimage from a deterministic
 *   signature, so nothing secret is at rest and a wallet with the seed
 *   re-derives everything.
 * - A static descriptor is the same key for every swap, so a derived preimage
 *   would repeat across swaps — one counterparty learning its own preimage
 *   would learn every other swap's. Those swaps carry a random preimage
 *   stored on the record instead: one per-swap secret at rest, and never a
 *   private key.
 */
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { equalBytes } from "@scure/btc-signer/utils.js";
import {
    Identity,
    IWallet,
    ReadonlyIdentity,
    deriveDescriptorLeafPubKey,
    isHDAllocationCapable,
    isHDWalletCapable,
    normalizeToDescriptor,
    parseHDDescriptor,
} from "@arkade-os/sdk";

/**
 * Domain separator for the preimage derivation.
 *
 * NArk scopes its tag by protocol+provider (`Arkade-Boltz-Preimage-v1`,
 * `SwapsManagementService.cs:128`) so any Arkade SDK reproduces the same
 * preimage. NArk has no RFQ corridor yet, so this tag defines the scheme
 * rather than mirroring one; it is deliberately distinct from the Boltz tag,
 * or the same wallet key would derive one preimage for both corridors.
 */
export const RFQ_PREIMAGE_TAG = "Arkade-RFQ-Preimage-v1";

/**
 * `TAG ‖ xonly(32) ‖ u32le(index)` — the message that gets BIP-340 signed.
 *
 * Anchored on the canonical x-only key rather than the descriptor string:
 * restore reconstructs a bare descriptor that serialises differently from the
 * signing descriptor used at create time, and only the key agrees across both.
 */
export function buildPreimageMessage(xonly: Uint8Array, index: number): Uint8Array {
    if (xonly.length !== 32) {
        throw new Error(`x-only pubkey must be 32 bytes, got ${xonly.length}`);
    }
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
        throw new Error(`index must be a u32, got ${index}`);
    }
    const tag = new TextEncoder().encode(RFQ_PREIMAGE_TAG);
    const message = new Uint8Array(tag.length + 32 + 4);
    message.set(tag, 0);
    message.set(xonly, tag.length);
    new DataView(message.buffer).setUint32(tag.length + 32, index, true);
    return message;
}

/**
 * Preimage derivation is only safe when the key is unique to the swap, so the
 * message index can stay pinned. Kept as a parameter of
 * {@link buildPreimageMessage} for cross-SDK vectors.
 */
const PREIMAGE_INDEX = 0;

/**
 * True iff `descriptor` is an HD child — unique to the swap that allocated
 * it. A bare `tr(pubkey)` (a static wallet's answer) is the same key for
 * every swap, so anything deriving per-swap secrets must branch on this —
 * the descriptor's shape, never the wallet's type.
 */
export function isPerSwapDescriptor(descriptor: string): boolean {
    return parseHDDescriptor(descriptor) !== null;
}

/**
 * The wallet-provided secrets for one swap. Persist both fields on the swap
 * record.
 *
 * The sender key is never among them: it re-derives from the wallet through
 * `signingDescriptor`, which is public. `preimage` is the only secret this
 * package ever puts at rest, and only when it cannot be re-derived — the
 * caller supplied it, or the descriptor is shared across swaps.
 */
export interface SwapSecrets {
    /** Public. Persist it on the swap record; it is what restore keys off. */
    signingDescriptor: string;
    /**
     * Present when the preimage cannot be re-derived from the seed: caller
     * supplied it, or the descriptor is static (shared across swaps, so a
     * derived preimage would collide). A real secret — persist it.
     */
    preimage?: Uint8Array;
}

/**
 * Ask the wallet for one swap's secrets. Always answers, and never mints a
 * signing key: the wallet decides whether the descriptor is fresh (HD) or its
 * static key; a wallet that predates the descriptor API contributes its
 * identity key. The only randomness ever produced here is a stored preimage
 * for swaps whose descriptor cannot derive one safely.
 *
 * `opts.preimage` — pass `true` when this swap needs a preimage we hold (the
 * claim secret of a receive, the HTLC secret of an onchain send), or supply a
 * caller-owned 32-byte `P`. On a per-swap descriptor a requested preimage is
 * left implicit and re-derived on demand ({@link preimageForRfqSecrets}); on
 * a static descriptor it is minted once and returned for the caller to
 * persist.
 *
 * Cost of allocating on an HD wallet: the index is consumed even when the
 * quote is later refused, and a swap index never turns into a funded receive
 * contract, so a long run of swaps widens the "unused" gap a seed-only
 * `restore()` scan sees (see the README's gap-limit note). Restores that keep
 * the swap repository are unaffected — `adoptSwapDescriptor` re-claims each
 * record's index.
 */
export async function deriveSwapSecrets(
    wallet: IWallet,
    opts: { preimage?: boolean | Uint8Array } = {},
): Promise<SwapSecrets> {
    if (opts.preimage instanceof Uint8Array && opts.preimage.length !== 32) {
        // The HTLC claim leaf pins OP_SIZE 32: any other length is unclaimable.
        throw new Error(`preimage must be 32 bytes, got ${opts.preimage.length}`);
    }
    const allocated = isHDAllocationCapable(wallet)
        ? await wallet.getNextSigningDescriptor()
        : undefined;
    // A wallet that cannot answer still provides its key — the identity. The
    // one thing that never happens here is a key the wallet doesn't hold.
    const signingDescriptor =
        allocated ?? normalizeToDescriptor(hex.encode(await wallet.identity.xOnlyPublicKey()));

    if (opts.preimage instanceof Uint8Array) {
        return { signingDescriptor, preimage: opts.preimage };
    }
    if (opts.preimage && !isPerSwapDescriptor(signingDescriptor)) {
        // Static key: a derived preimage would repeat across swaps. Mint one
        // for this swap only; the caller must persist it with the record.
        return { signingDescriptor, preimage: randomBytes(32) };
    }
    return { signingDescriptor };
}

/**
 * The record fields that carry a swap's secrets: the public descriptor, plus
 * `preimageHex` for the swaps whose P cannot be re-derived.
 */
export function rfqSecretsToRecord(secrets: SwapSecrets): {
    signingDescriptor: string;
    preimageHex?: string;
} {
    return {
        signingDescriptor: secrets.signingDescriptor,
        ...(secrets.preimage ? { preimageHex: hex.encode(secrets.preimage) } : {}),
    };
}

export function rfqSecretsOfRecord(record: {
    signingDescriptor?: string;
    preimageHex?: string;
}): SwapSecrets | undefined {
    // Total on purpose: consumers call this while iterating swap history,
    // which includes offer-corridor records that carry no secrets at all, and
    // a throw on one would abort the whole loop.
    if (!record.signingDescriptor) return undefined;
    return {
        signingDescriptor: record.signingDescriptor,
        ...(record.preimageHex ? { preimage: decodeHex32(record.preimageHex, "preimageHex") } : {}),
    };
}

function decodeHex32(value: string, label: string): Uint8Array {
    const bytes = hex.decode(value);
    if (bytes.length !== 32) {
        throw new Error(label + " must be 32 bytes, got " + bytes.length);
    }
    return bytes;
}

/**
 * Claim a restored swap's index so a later allocation cannot reissue it —
 * which would derive that swap's preimage a second time, for a different swap.
 *
 * Monotonic, and a no-op wherever there is no index to reserve: a wallet with
 * no allocation API, a static descriptor, or an HD descriptor a wallet
 * running without an index stream cannot place. Restores iterate whole
 * histories, so a record this wallet has nothing to adopt for must not abort
 * the loop.
 */
export async function adoptSwapDescriptor(
    wallet: IWallet,
    signingDescriptor: string,
): Promise<void> {
    if (!isHDAllocationCapable(wallet)) return;
    if (!isPerSwapDescriptor(signingDescriptor)) return;
    await wallet.advanceSigningDescriptorWatermark(signingDescriptor);
}

/** Why a wallet cannot produce a swap's sender key. Different instructions to
 * a user: restore the other wallet, or accept that this record never carried
 * a descriptor at all. */
export type RefundBlockedReason =
    /** The record carries no `signingDescriptor`. */
    | "no-secrets"
    /** The descriptor belongs to another wallet's key. */
    | "foreign-descriptor";

/**
 * The wallet cannot produce this swap's sender key, so no local refund is
 * possible: not a failure to retry, a capability this wallet does not have.
 *
 * Thrown where the cause is discovered rather than translated at the edge, so
 * a `refundArkade` wired through {@link senderIdentityForSwapRecord} reports it
 * to `RfqSwapManager` unwrapped — which is what stops the manager grinding
 * against a push that can never work for the whole refund window.
 */
export class RefundNotLocallyPossibleError extends Error {
    override readonly name = "RefundNotLocallyPossibleError";
    constructor(
        readonly reason: RefundBlockedReason,
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message, options);
    }
}

/**
 * The VHTLC `sender` identity — the signer for every interactive refund.
 *
 * The check that matters is on what comes back, and it is a public-key
 * equality, never a wallet-type probe: whatever identity the wallet answers
 * with must BE the descriptor's key. A wallet that answers with the wrong key
 * — another seed's, after a restore mix-up — would sign happily, and the
 * failure would surface only as a solver rejection or a dead claim script.
 */
export async function senderIdentityForRfqSecrets(
    wallet: IWallet,
    secrets: SwapSecrets,
): Promise<Identity> {
    const refuse = (cause?: unknown) =>
        new RefundNotLocallyPossibleError(
            "foreign-descriptor",
            `this wallet cannot derive ${secrets.signingDescriptor}; the swap was created on another wallet`,
            cause ? { cause } : undefined,
        );
    // A wallet with no descriptor API has only its identity; the key check
    // below decides whether that is the right key for this record.
    let signer: Identity;
    try {
        signer = isHDWalletCapable(wallet)
            ? await wallet.signerForDescriptor(secrets.signingDescriptor)
            : wallet.identity;
        if (
            !equalBytes(
                await signer.xOnlyPublicKey(),
                deriveDescriptorLeafPubKey(secrets.signingDescriptor),
            )
        ) {
            throw refuse();
        }
    } catch (cause) {
        // Also catches an unparseable descriptor: a record whose key cannot be
        // read is one no wallet can prove it holds.
        throw cause instanceof RefundNotLocallyPossibleError ? cause : refuse(cause);
    }
    return signer;
}

/**
 * The VHTLC `sender` identity for a stored swap record, or a typed refusal.
 *
 * The record→identity composition {@link rfqSecretsOfRecord} deliberately does
 * not do: it stays total so history iteration can call it, so *this* is where
 * a record with no descriptor becomes a refusal rather than an `undefined` the
 * caller has to remember to check.
 *
 * **Wire `refundArkade` here, not to {@link senderIdentityForRfqSecrets}.** A
 * caller one level down skips that case silently and turns it into a
 * `TypeError` at the push site, which `RfqSwapManager` then treats as
 * retryable and grinds against for the whole refund window.
 */
export async function senderIdentityForSwapRecord(
    wallet: IWallet,
    record: { signingDescriptor?: string; preimageHex?: string },
): Promise<Identity> {
    const secrets = rfqSecretsOfRecord(record);
    if (!secrets) {
        throw new RefundNotLocallyPossibleError(
            "no-secrets",
            "this swap record carries no signing descriptor",
        );
    }
    return senderIdentityForRfqSecrets(wallet, secrets);
}

/** The `sender` x-only pubkey, the only half the request flow needs. */
export async function senderPubkeyForRfqSecrets(
    wallet: IWallet,
    secrets: SwapSecrets,
): Promise<Uint8Array> {
    return (await senderIdentityForRfqSecrets(wallet, secrets)).xOnlyPublicKey();
}

/**
 * An identity that signs with `aux_rand = 0`, which is what makes the
 * derivation reproducible. `DescriptorIdentity` satisfies it and throws rather
 * than degrading to a random-aux signer.
 */
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
 * `sha256(sign(sha256(msg)))`, with the signing key and the message key being
 * the same identity — passing a key in separately is how this silently derives
 * an unrecoverable preimage.
 */
export async function derivePreimage(signer: DeterministicSigner): Promise<Uint8Array> {
    const xonly = await signer.xOnlyPublicKey();
    const message = buildPreimageMessage(xonly, PREIMAGE_INDEX);
    return sha256(await signer.signSchnorrDeterministic(sha256(message)));
}

/** The onchain-send preimage, re-derived or read back off the stored arm. */
export async function preimageForRfqSecrets(
    wallet: IWallet,
    secrets: SwapSecrets,
): Promise<Uint8Array> {
    if (secrets.preimage) return secrets.preimage;
    if (!isPerSwapDescriptor(secrets.signingDescriptor)) {
        // A static descriptor is the same key for every swap, so deriving
        // here would hand two swaps one preimage. Two records reach this: a
        // lightning send, whose P belongs to the payee and was never ours,
        // and a corridor that stores P having lost it. Neither can produce
        // one, and the message must not accuse the first of losing anything.
        throw new Error(
            `swap descriptor ${secrets.signingDescriptor} is not per-swap, so its preimage cannot be derived; this record carries none`,
        );
    }
    const signer = await senderIdentityForRfqSecrets(wallet, secrets);
    if (!isDeterministicSigner(signer)) {
        // Loud: a preimage from a random-aux signature is unrecoverable, and
        // the failure would otherwise only surface at claim time.
        throw new Error(
            `wallet cannot sign deterministically for ${secrets.signingDescriptor}; its preimage is not derivable`,
        );
    }
    try {
        return await derivePreimage(signer);
    } catch (cause) {
        // The structural guard above cannot see call-time refusals:
        // `DescriptorIdentity` always exposes `signSchnorrDeterministic` and
        // only throws when its base cannot actually sign deterministically.
        throw new Error(
            `wallet cannot sign deterministically for ${secrets.signingDescriptor}; its preimage is not derivable`,
            { cause },
        );
    }
}
