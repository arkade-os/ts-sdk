/**
 * RFQ swap secrets, derived from the wallet seed instead of stored.
 *
 * Both secrets an RFQ corridor needs — the VHTLC `sender` key and, for an
 * onchain send, the preimage — become functions of one HD-allocated
 * descriptor. The record keeps only that descriptor, which is public, so a
 * copied profile or a device backup yields nothing spendable and a wallet with
 * the seed can re-derive everything.
 *
 * Wallets that cannot allocate (static / `auto` / custom signers) still have a
 * key, and that key is as recoverable as a descriptor is, so they get the
 * identity arm: the wallet's own signing key is the swap's sender key and the
 * record again carries nothing secret. Only a wallet that cannot sign at all
 * reaches the stored arm, which carries real secrets the caller must persist.
 * That arm is built by the caller, never in here: a restore probing for a
 * derived preimage must be able to come back empty rather than be handed a
 * fresh random one that will never match the chain.
 */
import { hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    Identity,
    IWallet,
    ReadonlyIdentity,
    SingleKey,
    isHDAllocationCapable,
    isHDWalletCapable,
} from "@arkade-os/sdk";
import type { AssetSwapFallbackSecrets } from "./store";

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
 * Every swap allocates its own descriptor, so the key alone separates two
 * swaps and the message index stays pinned. Kept as a parameter of
 * {@link buildPreimageMessage} for cross-SDK vectors.
 */
const PREIMAGE_INDEX = 0;

/** No secrets at rest: everything re-derives from the seed plus this. */
export interface DerivedSwapSecrets {
    derivable: true;
    /** Public. Persist it on the swap record; it is what restore keys off. */
    signingDescriptor: string;
    /** Onchain-send only, when the caller supplied P instead of deriving it. */
    preimage?: Uint8Array;
}

/** The wallet could not allocate. These are real secrets — persist them. */
export interface StoredSwapSecrets {
    derivable: false;
    senderPrivateKey: Uint8Array;
    /** Onchain-send only. A lightning send's preimage belongs to the payee. */
    preimage?: Uint8Array;
}

/**
 * The wallet's own identity key is the sender key. Nothing to persist for the
 * key — the key IS the wallet — at the cost of reusing one x-only key across
 * swaps, the same tradeoff the Boltz integration shipped for years (its signer
 * fell back to `wallet.identity`). Never used to DERIVE a preimage:
 * {@link derivePreimage} is key-only, so a reused key would repeat P across
 * swaps and one solver could claim another's lockup. Preimage-bearing flows
 * attach a per-swap random `preimage` instead, which MUST be persisted (the
 * record's `preimageHex` carries it).
 */
export interface IdentitySwapSecrets {
    derivable: true;
    identityKey: true;
    preimage?: Uint8Array;
}

/**
 * Which arm a swap got. The discriminant makes the persistence obligation a
 * type-level fact: a consumer written against {@link DerivedSwapSecrets} alone
 * fails to compile when handed the stored arm.
 */
export type SwapSecrets = DerivedSwapSecrets | IdentitySwapSecrets | StoredSwapSecrets;

/** The identity arm — the sender key needs no persistence, an attached
 * preimage still does. */
export function isIdentitySwapSecrets(secrets: SwapSecrets): secrets is IdentitySwapSecrets {
    return secrets.derivable && "identityKey" in secrets;
}

/**
 * The wallet's own signing identity, when it has one — `Wallet` and a
 * signing-configured `ServiceWorkerWallet` both satisfy this structurally.
 *
 * The full `Identity` contract, not just `sign`: an interactive refund needs
 * `signerSession` for the Arkade round, and a half-identity would fail there
 * as a `TypeError` deep in the push rather than as the typed refusal callers
 * handle. `ServiceWorkerWallet.identity` is typed `ReadonlyIdentity`, so this
 * is the same check its own constructor makes before accepting a signer.
 */
const signingIdentityOf = (wallet: IWallet): Identity | undefined => {
    const identity = (wallet as { identity?: unknown }).identity as Partial<Identity> | undefined;
    if (
        identity &&
        typeof identity.sign === "function" &&
        typeof identity.signMessage === "function" &&
        typeof identity.signerSession === "function" &&
        typeof identity.xOnlyPublicKey === "function"
    ) {
        return identity as Identity;
    }
    return undefined;
};

/**
 * Allocate a descriptor for one swap, or `undefined` when the wallet cannot.
 *
 * Allocates — never peeks. `getCurrentSigningDescriptor` returns the same
 * descriptor until the wallet rotates, and two swaps sharing a descriptor
 * derive the *identical* preimage, so one solver learning its own preimage
 * would learn the other swap's.
 *
 * Cost of allocating: the index is consumed even when the quote is later
 * refused, and a swap index never turns into a funded receive contract, so a
 * long run of swaps widens the "unused" gap a seed-only `restore()` scan sees
 * (see the README's gap-limit note). Restores that keep the swap repository
 * are unaffected — `adoptSwapDescriptor` re-claims each record's index.
 */
export async function deriveSwapSecrets(
    wallet: IWallet,
    opts: {
        /** Attach a fresh random preimage on the identity arm — REQUIRED for
         * preimage-bearing flows there, since the identity key must never
         * derive one (see {@link IdentitySwapSecrets}). The HD arm ignores
         * this: a fresh descriptor derives its own. */
        preimage?: boolean;
    } = {},
): Promise<DerivedSwapSecrets | IdentitySwapSecrets | undefined> {
    if (isHDAllocationCapable(wallet)) {
        const signingDescriptor = await wallet.getNextSigningDescriptor();
        if (signingDescriptor) return { derivable: true, signingDescriptor };
    }
    // Single-key wallets: the identity IS the recoverable sender key, so the
    // random arm (a key that exists nowhere else) is a last resort, not the
    // default for every non-HD wallet.
    if (signingIdentityOf(wallet)) {
        return {
            derivable: true,
            identityKey: true,
            ...(opts.preimage ? { preimage: randomBytes(32) } : {}),
        };
    }
    return undefined;
}

/**
 * The fallback arm. Separate from {@link deriveSwapSecrets} so nothing can
 * fabricate a preimage while probing for a derived one.
 */
export function randomSwapSecrets(
    opts: { preimage?: boolean | Uint8Array } = {},
): StoredSwapSecrets {
    if (opts.preimage instanceof Uint8Array && opts.preimage.length !== 32) {
        // The HTLC claim leaf pins OP_SIZE 32: any other length is unclaimable.
        throw new Error(`preimage must be 32 bytes, got ${opts.preimage.length}`);
    }
    const preimage =
        opts.preimage instanceof Uint8Array
            ? opts.preimage
            : opts.preimage
              ? randomBytes(32)
              : undefined;
    return {
        derivable: false,
        senderPrivateKey: schnorr.utils.randomSecretKey(),
        ...(preimage ? { preimage } : {}),
    };
}

/**
 * Serialize or restore the secrets arm a persisted record describes. Normal
 * HD swaps store only `signingDescriptor`; caller-supplied preimages add
 * `preimageHex`; fallback swaps use `fallbackSecrets` so both P and the
 * sender identity survive a restart.
 */
export function rfqSecretsToRecord(secrets: SwapSecrets): {
    signingDescriptor?: string;
    identityKey?: true;
    preimageHex?: string;
    fallbackSecrets?: AssetSwapFallbackSecrets;
} {
    if (secrets.derivable) {
        if (isIdentitySwapSecrets(secrets)) {
            return {
                identityKey: true,
                ...(secrets.preimage ? { preimageHex: hex.encode(secrets.preimage) } : {}),
            };
        }
        return {
            signingDescriptor: secrets.signingDescriptor,
            ...(secrets.preimage ? { preimageHex: hex.encode(secrets.preimage) } : {}),
        };
    }
    return {
        fallbackSecrets: {
            version: 1,
            type: "stored",
            senderPrivateKeyHex: hex.encode(secrets.senderPrivateKey),
            ...(secrets.preimage ? { preimageHex: hex.encode(secrets.preimage) } : {}),
        },
    };
}

export function rfqSecretsOfRecord(record: {
    signingDescriptor?: string;
    identityKey?: true;
    preimageHex?: string;
    fallbackSecrets?: AssetSwapFallbackSecrets;
}): SwapSecrets | undefined {
    if (record.identityKey) {
        return {
            derivable: true,
            identityKey: true,
            ...(record.preimageHex
                ? { preimage: decodeHex32(record.preimageHex, "preimageHex") }
                : {}),
        };
    }
    if (record.signingDescriptor) {
        return {
            derivable: true,
            signingDescriptor: record.signingDescriptor,
            ...(record.preimageHex
                ? { preimage: decodeHex32(record.preimageHex, "preimageHex") }
                : {}),
        };
    }
    // Total on purpose: consumers call this while iterating swap history, where
    // a throw on one record would abort the whole loop.
    const fallback = record.fallbackSecrets;
    if (!fallback) return undefined;
    if (fallback.version !== 1 || fallback.type !== "stored") {
        throw new Error("unsupported RFQ fallback secrets record");
    }
    return {
        derivable: false,
        senderPrivateKey: decodeHex32(fallback.senderPrivateKeyHex, "senderPrivateKeyHex"),
        ...(fallback.preimageHex
            ? { preimage: decodeHex32(fallback.preimageHex, "preimageHex") }
            : {}),
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
 * Monotonic; a no-op on a wallet that cannot allocate.
 */
export async function adoptSwapDescriptor(
    wallet: IWallet,
    signingDescriptor: string,
): Promise<void> {
    if (!isHDAllocationCapable(wallet)) return;
    await wallet.advanceSigningDescriptorWatermark(signingDescriptor);
}

/** Why a wallet cannot produce a swap's sender key. Different instructions to
 * a user: restore the other wallet, or accept that this record never carried
 * the secrets at all. */
export type RefundBlockedReason =
    /** The record names no arm: neither `signingDescriptor` nor `fallbackSecrets`. */
    | "no-secrets"
    /** It names an arm this version cannot read. */
    | "unreadable-secrets"
    /** The descriptor belongs to another seed, or this wallet is static. */
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
 * The capability probe is not the check that matters: `signerForDescriptor`
 * falls back to the plain wallet identity for a descriptor it cannot derive —
 * a different seed, a static wallet — and that identity signs happily with the
 * wrong key, which surfaces only as a solver rejection or a dead claim script.
 * So the check is on what comes back: only a descriptor-bound signer carries
 * `signSchnorrDeterministic`.
 */
export async function senderIdentityForRfqSecrets(
    wallet: IWallet,
    secrets: SwapSecrets,
): Promise<Identity> {
    if (!secrets.derivable) return SingleKey.fromPrivateKey(secrets.senderPrivateKey);
    if (isIdentitySwapSecrets(secrets)) {
        const identity = signingIdentityOf(wallet);
        if (!identity) {
            throw new RefundNotLocallyPossibleError(
                "foreign-descriptor",
                "this swap's sender is the creating wallet's identity key, which this wallet instance cannot sign with",
            );
        }
        return identity;
    }
    const signer = isHDWalletCapable(wallet)
        ? await wallet.signerForDescriptor(secrets.signingDescriptor)
        : undefined;
    if (!signer || !isDeterministicSigner(signer)) {
        // Typed at the throw site, not in a translator: this is the function
        // that discovers the cause. A faithful `Error` subclass, so callers
        // matching on the message keep working.
        throw new RefundNotLocallyPossibleError(
            "foreign-descriptor",
            `this wallet cannot derive ${secrets.signingDescriptor}; the swap was created on another wallet`,
        );
    }
    return signer;
}

/**
 * The VHTLC `sender` identity for a stored swap record, or a typed refusal.
 *
 * The record→identity composition {@link rfqSecretsOfRecord} deliberately does
 * not do: it stays total so history iteration can call it, so *this* is where
 * "no secrets on the record" becomes a refusal rather than an `undefined` the
 * caller has to remember to check.
 *
 * **Wire `refundArkade` here, not to {@link senderIdentityForRfqSecrets}.**
 * Only two of the three causes are throws; a caller one level down would skip
 * the third silently and turn it into a `TypeError` at the push site, which
 * `RfqSwapManager` then treats as retryable and grinds against for the whole
 * refund window.
 *
 * Takes the record shape structurally, matching {@link rfqSecretsOfRecord}, so
 * either record type can be passed.
 */
export async function senderIdentityForSwapRecord(
    wallet: IWallet,
    record: {
        signingDescriptor?: string;
        identityKey?: true;
        preimageHex?: string;
        fallbackSecrets?: AssetSwapFallbackSecrets;
    },
): Promise<Identity> {
    let secrets: SwapSecrets | undefined;
    try {
        secrets = rfqSecretsOfRecord(record);
    } catch (error) {
        throw new RefundNotLocallyPossibleError(
            "unreadable-secrets",
            error instanceof Error ? error.message : String(error),
            // the record's own diagnosis, kept for a caller that wants more
            // than the message
            { cause: error },
        );
    }
    if (!secrets) {
        throw new RefundNotLocallyPossibleError(
            "no-secrets",
            "this swap record carries no signing descriptor and no fallback secrets",
        );
    }
    return senderIdentityForRfqSecrets(wallet, secrets);
}

/** The `sender` x-only pubkey, the only half the request flow needs. */
export async function senderPubkeyForRfqSecrets(
    wallet: IWallet,
    secrets: SwapSecrets,
): Promise<Uint8Array> {
    if (!secrets.derivable) return schnorr.getPublicKey(secrets.senderPrivateKey);
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
    if (!secrets.derivable) {
        if (!secrets.preimage) throw new Error("this swap carries no stored preimage");
        return secrets.preimage;
    }
    if (secrets.preimage) return secrets.preimage;
    if (isIdentitySwapSecrets(secrets)) {
        // Deriving from the identity key would repeat P across every swap —
        // the attached random preimage is mandatory on this arm.
        throw new Error(
            "identity-key swaps carry a stored preimage; none was attached to this one",
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
