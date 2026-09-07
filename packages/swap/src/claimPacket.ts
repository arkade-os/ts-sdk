/**
 * ClaimPacket sealing: P encrypted to covclaimd so the user can go offline
 * after funding — the solver carries the packet blindly and cannot decrypt it.
 *
 * Scheme (per the covclaimd wire protocol):
 * - ephemeral secp256k1 key; ECDH with covclaimd's public key (x coordinate);
 * - HKDF-SHA256, info `covclaimd/preimage/v1`, salt = the ephemeral pubkey;
 * - AES-256-GCM with the ephemeral pubkey as additional data;
 * - wire layout `ephPub(33) ‖ nonce(12) ‖ ciphertext`, base64.
 *
 * TODO(claim-packet-vectors): byte-exactness against covclaimd's reference
 * implementation is pinned here only by our own generated vectors — confirm
 * against covclaimd's before production use (see the package README).
 */
import { base64 } from "@scure/base";
import { gcm } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const HKDF_INFO = new TextEncoder().encode("covclaimd/preimage/v1");

export interface SealedClaimPacket {
    /** `ephPub(33) ‖ nonce(12) ‖ ciphertext`, base64 — wire-ready. This is
     * the whole packet: the RFQ request's `claim_packet` field carries
     * exactly this string. */
    ciphertext: string;
}

export interface ClaimPacketInput {
    preimage: Uint8Array;
    /** covclaimd's public key, 33-byte compressed (from its /v1 info). */
    covclaimdPubkey: Uint8Array;
}

/**
 * Seal a preimage to covclaimd.
 *
 * The ephemeral key and nonce are generated here and CANNOT be supplied by a
 * caller. That is the point of this signature: AES-GCM under a repeated
 * (key, nonce) pair is a total break — forgery and plaintext recovery, not a
 * degradation — so an optional `nonce` on a production export is a loaded gun
 * whatever the doc comment says. Deterministic sealing lives in the test
 * helper, where no consumer reaches it by accident.
 */
export async function sealClaimPacket(input: ClaimPacketInput): Promise<SealedClaimPacket> {
    return sealWithEntropy(
        input,
        secp256k1.utils.randomSecretKey(),
        crypto.getRandomValues(new Uint8Array(12)),
    );
}

/**
 * @internal The sealing itself, with entropy passed in. Not re-exported from
 * the package entrypoint. Reusing `ephemeralKey`/`nonce` across two packets
 * breaks the AEAD outright — see {@link sealClaimPacket}.
 */
export async function sealWithEntropy(
    input: ClaimPacketInput,
    ephemeralKey: Uint8Array,
    nonce: Uint8Array,
): Promise<SealedClaimPacket> {
    if (input.preimage.length !== 32) throw new Error("preimage must be 32 bytes");
    if (input.covclaimdPubkey.length !== 33) {
        throw new Error("covclaimd pubkey must be 33-byte compressed");
    }
    const ephemeralPub = secp256k1.getPublicKey(ephemeralKey, true);
    // shared secret = x coordinate of the ECDH point
    const sharedX = secp256k1
        .getSharedSecret(ephemeralKey, input.covclaimdPubkey, true)
        .subarray(1);
    const key = hkdf(sha256, sharedX, ephemeralPub, HKDF_INFO, 32);

    if (nonce.length !== 12) throw new Error("nonce must be 12 bytes");
    const sealed = gcm(key, nonce, ephemeralPub).encrypt(input.preimage);

    const packet = new Uint8Array(33 + 12 + sealed.length);
    packet.set(ephemeralPub, 0);
    packet.set(nonce, 33);
    packet.set(sealed, 45);
    return { ciphertext: base64.encode(packet) };
}
