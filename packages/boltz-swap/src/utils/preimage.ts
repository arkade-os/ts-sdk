import { Identity } from "@arkade-os/sdk";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Domain separation tag for the swap preimage scheme. Protocol+provider
 * scoped rather than SDK scoped: every Arkade SDK implementing this derives
 * the same preimage, so a swap created by one is recoverable by another.
 * `-v1` leaves room for a scheme bump.
 */
const PREIMAGE_TAG = "Arkade-Boltz-Preimage-v1";
const PREIMAGE_TAG_BYTES = new TextEncoder().encode(PREIMAGE_TAG);

/** An {@link Identity} that can produce a deterministic BIP-340 signature. */
export interface DeterministicSigner {
    signSchnorrDeterministic(messageHash: Uint8Array): Promise<Uint8Array>;
}

/** Structural probe for {@link DeterministicSigner}. */
export function isDeterministicSigner(value: unknown): value is DeterministicSigner {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as DeterministicSigner).signSchnorrDeterministic === "function"
    );
}

/**
 * The message that gets BIP-340 signed: `tag ‖ xonly(32) ‖ u32le(index)`.
 *
 * Anchored on the canonical x-only key rather than the descriptor string: a
 * restore reconstructs a *bare* receiver descriptor, which serialises
 * differently from the HD signing descriptor used at create time, so only the
 * key makes both sides agree.
 */
export function buildPreimageMessage(xonly: Uint8Array, index: number): Uint8Array {
    if (xonly.length !== 32) {
        throw new Error(`Preimage message needs a 32-byte x-only key, got ${xonly.length}`);
    }
    if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
        throw new Error(`Preimage index must fit a u32, got ${index}`);
    }
    const message = new Uint8Array(PREIMAGE_TAG_BYTES.length + 32 + 4);
    message.set(PREIMAGE_TAG_BYTES, 0);
    message.set(xonly, PREIMAGE_TAG_BYTES.length);
    new DataView(message.buffer).setUint32(PREIMAGE_TAG_BYTES.length + 32, index, true);
    return message;
}

/**
 * Derive a swap preimage from the key owned by `identity`:
 * `sha256(BIP340_sign(sha256(message), aux_rand = 0))`.
 *
 * Same identity always yields the same preimage, so a wallet restored from seed
 * can re-derive the secret a rediscovered swap needs. The signing key and the
 * key in the message are necessarily the same one; passing a key in separately
 * would let create-time and restore-time diverge.
 *
 * Live swaps intentionally fix the message index to 0. If a future live scheme
 * needs another derivation dimension, bump the preimage tag and persist enough
 * metadata to restore it instead of selecting another index here. Never falls
 * back to randomness: that policy belongs to the caller.
 *
 * @throws if `identity` cannot sign deterministically.
 */
export async function derivePreimage(identity: Identity): Promise<Uint8Array> {
    return derivePreimageForMessageIndex(identity, 0);
}

/**
 * Derive a preimage for a specific message index.
 *
 * @param index Message-format index. Must be 0 for live swaps; non-zero values
 * are cross-SDK vector coverage only.
 * @internal Live swap callers must use {@link derivePreimage}, which fixes the
 * index to 0.
 */
export async function derivePreimageForMessageIndex(
    identity: Identity,
    index: number,
): Promise<Uint8Array> {
    if (!isDeterministicSigner(identity)) {
        throw new Error("Identity cannot derive a deterministic preimage");
    }
    const message = buildPreimageMessage(await identity.xOnlyPublicKey(), index);
    return sha256(await identity.signSchnorrDeterministic(sha256(message)));
}
