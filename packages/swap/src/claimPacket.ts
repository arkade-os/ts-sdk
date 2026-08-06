/**
 * ClaimPacket sealing: P encrypted to covclaimd so the maker can go offline
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
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const HKDF_INFO = new TextEncoder().encode("covclaimd/preimage/v1");

export interface SealedClaimPacket {
    /** `ephPub(33) ‖ nonce(12) ‖ ciphertext`, base64 — wire-ready. */
    ciphertext: string;
    /** The arkade script the packet is bound to, base64 — wire-ready. */
    arkade_script: string;
}

/**
 * Seal a preimage to covclaimd. WebCrypto AES-GCM, hence async. The
 * `ephemeralKey`/`nonce` inputs exist for deterministic tests ONLY — never
 * pass them in production; fresh randomness per packet is what keeps one
 * leaked packet from weakening another.
 */
export async function sealClaimPacket(input: {
    preimage: Uint8Array;
    /** covclaimd's public key, 33-byte compressed (from its /v1 info). */
    covclaimdPubkey: Uint8Array;
    arkadeScript: Uint8Array;
    ephemeralKey?: Uint8Array;
    nonce?: Uint8Array;
}): Promise<SealedClaimPacket> {
    if (input.preimage.length !== 32) throw new Error("preimage must be 32 bytes");
    if (input.covclaimdPubkey.length !== 33) {
        throw new Error("covclaimd pubkey must be 33-byte compressed");
    }
    const ephemeralKey = input.ephemeralKey ?? secp256k1.utils.randomSecretKey();
    const ephemeralPub = secp256k1.getPublicKey(ephemeralKey, true);
    // shared secret = x coordinate of the ECDH point
    const sharedX = secp256k1
        .getSharedSecret(ephemeralKey, input.covclaimdPubkey, true)
        .subarray(1);
    const key = hkdf(sha256, sharedX, ephemeralPub, HKDF_INFO, 32);

    const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(12));
    if (nonce.length !== 12) throw new Error("nonce must be 12 bytes");
    const aesKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
        "encrypt",
    ]);
    const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
            {
                name: "AES-GCM",
                iv: nonce as BufferSource,
                additionalData: ephemeralPub as BufferSource,
            },
            aesKey,
            input.preimage as BufferSource,
        ),
    );

    const packet = new Uint8Array(33 + 12 + sealed.length);
    packet.set(ephemeralPub, 0);
    packet.set(nonce, 33);
    packet.set(sealed, 45);
    return { ciphertext: base64.encode(packet), arkade_script: base64.encode(input.arkadeScript) };
}

/** Test-only inverse of {@link sealClaimPacket}, proving the AEAD round-trips
 * with the derivation above. covclaimd is the real decryptor in production. */
export async function openClaimPacketForTest(
    packetBase64: string,
    covclaimdSecretKey: Uint8Array,
): Promise<Uint8Array> {
    const packet = base64.decode(packetBase64);
    const ephemeralPub = packet.subarray(0, 33);
    const nonce = packet.subarray(33, 45);
    const sealed = packet.subarray(45);
    const sharedX = secp256k1.getSharedSecret(covclaimdSecretKey, ephemeralPub, true).subarray(1);
    const key = hkdf(sha256, sharedX, ephemeralPub, HKDF_INFO, 32);
    const aesKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
        "decrypt",
    ]);
    return new Uint8Array(
        await crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: nonce as BufferSource,
                additionalData: ephemeralPub as BufferSource,
            },
            aesKey,
            sealed as BufferSource,
        ),
    );
}

/** @internal exported for the deterministic vector test */
export const claimPacketHexForTest = (packetBase64: string): string =>
    hex.encode(base64.decode(packetBase64));
