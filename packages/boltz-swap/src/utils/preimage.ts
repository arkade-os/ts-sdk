import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { isDeterministicSignCapable, type Identity, type ReadonlyIdentity } from "@arkade-os/sdk";

export const PREIMAGE_TAG = "Arkade-Boltz-Preimage-v1";
const PREIMAGE_TAG_BYTES = new TextEncoder().encode(PREIMAGE_TAG);

/**
 * Builds the message that gets hashed and Schnorr-signed to derive a preimage.
 * Format: UTF8(tag) || x-only-pubkey (32B) || u32le(index)
 */
export function buildPreimageMessage(xonlyPubkey: Uint8Array, index: number): Uint8Array {
    const idx = new Uint8Array(4);
    new DataView(idx.buffer).setUint32(0, index, true);
    const out = new Uint8Array(PREIMAGE_TAG_BYTES.length + 32 + 4);
    out.set(PREIMAGE_TAG_BYTES, 0);
    out.set(xonlyPubkey, PREIMAGE_TAG_BYTES.length);
    out.set(idx, PREIMAGE_TAG_BYTES.length + 32);
    return out;
}

/**
 * Derives a reproducible 32-byte preimage rooted in the wallet's signing key.
 *
 *   preimage = SHA256(BIP340_sign(key, SHA256(buildPreimageMessage(xonly, index)), aux=0x00…00))
 *
 * Falls back to random bytes for identities that cannot guarantee determinism.
 */
export async function derivePreimage(
    identity: Identity | ReadonlyIdentity,
    index: number,
): Promise<Uint8Array> {
    if (!isDeterministicSignCapable(identity)) {
        return randomBytes(32);
    }
    const xonly = await identity.xOnlyPublicKey();
    const sig = await identity.signSchnorrDeterministic(sha256(buildPreimageMessage(xonly, index)));
    return sha256(sig);
}
