/**
 * Test-side ClaimPacket helpers.
 *
 * These live here rather than in `src/claimPacket.ts` for two reasons. A full
 * ECIES *decrypt* next to production code is an invitation to misuse — nothing
 * in this package ever decrypts a packet, covclaimd does. And deterministic
 * sealing must not be reachable from a production import path at all: AES-GCM
 * under a repeated (key, nonce) pair is a total break, so the only safe place
 * for a fixed nonce is a file that ships with the tests.
 *
 * The decrypt below re-derives the scheme from the wire spec instead of
 * importing the sealing side's constants, so the round-trip test proves the
 * two halves agree rather than proving one constant equals itself.
 */
import { base64, hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
    sealWithEntropy,
    type ClaimPacketInput,
    type SealedClaimPacket,
} from "../../src/claimPacket";

/** Independently spelled from the wire spec — see the file header. */
const HKDF_INFO = new TextEncoder().encode("covclaimd/preimage/v1");

/**
 * Seal with caller-supplied entropy, so a vector can be pinned.
 *
 * Both fields are REQUIRED: there is no way to call this and accidentally get
 * production behaviour, and no way to call the production function and
 * accidentally get this.
 */
export const sealClaimPacketDeterministic = (
    input: ClaimPacketInput,
    ephemeralKey: Uint8Array,
    nonce: Uint8Array,
): Promise<SealedClaimPacket> => sealWithEntropy(input, ephemeralKey, nonce);

/** covclaimd's side of the scheme: recover P from a sealed packet. */
export async function openClaimPacket(
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

/** The packet's raw wire bytes, for pinning a vector. */
export const claimPacketHex = (packetBase64: string): string =>
    hex.encode(base64.decode(packetBase64));
