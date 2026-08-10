/**
 * RFQ swap secrets, derived from the wallet seed instead of stored.
 *
 * Both secrets an RFQ corridor needs — the VHTLC `sender` key and, for an
 * onchain send, the preimage — become functions of one HD-allocated
 * descriptor. The record keeps only that descriptor, which is public, so a
 * copied profile or a device backup yields nothing spendable and a wallet with
 * the seed can re-derive everything.
 *
 * Wallets that cannot allocate (static / `auto` / custom signers) get the
 * fallback arm instead, which carries real secrets the caller must store. That
 * arm is built by the caller, never in here: a restore probing for a derived
 * preimage must be able to come back empty rather than be handed a fresh
 * random one that will never match the chain.
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
 * Which arm a swap got. The discriminant makes the persistence obligation a
 * type-level fact: a consumer written against {@link DerivedSwapSecrets} alone
 * fails to compile when handed the stored arm.
 */
export type SwapSecrets = DerivedSwapSecrets | StoredSwapSecrets;

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
export async function deriveSwapSecrets(wallet: IWallet): Promise<DerivedSwapSecrets | undefined> {
    if (!isHDAllocationCapable(wallet)) return undefined;
    const signingDescriptor = await wallet.getNextSigningDescriptor();
    if (!signingDescriptor) return undefined;
    return { derivable: true, signingDescriptor };
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
    preimageHex?: string;
    fallbackSecrets?: AssetSwapFallbackSecrets;
} {
    if (secrets.derivable) {
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
    preimageHex?: string;
    fallbackSecrets?: AssetSwapFallbackSecrets;
}): SwapSecrets | undefined {
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
    const signer = isHDWalletCapable(wallet)
        ? await wallet.signerForDescriptor(secrets.signingDescriptor)
        : undefined;
    if (!signer || !isDeterministicSigner(signer)) {
        throw new Error(
            `this wallet cannot derive ${secrets.signingDescriptor}; the swap was created on another wallet`,
        );
    }
    return signer;
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
