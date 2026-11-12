/**
 * Test-side ClaimPacket helpers.
 *
 * These live here rather than in `src/claimPacket.ts` for two reasons. A full
 * ECIES *decrypt* next to production code is an invitation to misuse: nothing
 * in this package ever decrypts a packet, the executor does. And deterministic
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
    EXECUTOR_CLAIM_TEMPLATE_ID,
    sealWithEntropy,
    type ClaimPacketInput,
    type SealedClaimPacket,
} from "../../src/claimPacket";

/** Independently spelled from the wire spec: see the file header. */
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

/** The `0x01` value of a packet body: `ephPub ‖ nonce ‖ ciphertext`. */
export const ciphertextOf = (packetBase64: string): Uint8Array => {
    const raw = base64.decode(packetBase64);
    let offset = 0;
    while (offset < raw.length) {
        const type = raw[offset]!;
        const length = (raw[offset + 1]! << 8) | raw[offset + 2]!;
        if (type === 0x01) return raw.subarray(offset + 3, offset + 3 + length);
        offset += 3 + length;
    }
    throw new Error("no 0x01 TLV");
};

const amountBytes = (amount: bigint): Uint8Array => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, amount, false);
    return bytes;
};

/** The executor's side of the scheme: recover P from a sealed packet. */
export async function openClaimPacket(
    packetBase64: string,
    recipientSecretKey: Uint8Array,
    templateId: string = EXECUTOR_CLAIM_TEMPLATE_ID,
    minAmount?: bigint,
): Promise<Uint8Array> {
    const sealedPacket = ciphertextOf(packetBase64);
    const ephemeralPub = sealedPacket.subarray(0, 33);
    const nonce = sealedPacket.subarray(33, 45);
    const sealed = sealedPacket.subarray(45);
    const sharedX = secp256k1.getSharedSecret(recipientSecretKey, ephemeralPub, true).subarray(1);
    const key = hkdf(sha256, sharedX, ephemeralPub, HKDF_INFO, 32);
    const aesKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
        "decrypt",
    ]);
    return new Uint8Array(
        await crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: nonce as BufferSource,
                additionalData: Uint8Array.from([
                    ...ephemeralPub,
                    ...new TextEncoder().encode(templateId),
                    ...(minAmount === undefined ? [] : amountBytes(minAmount)),
                ]) as BufferSource,
            },
            aesKey,
            sealed as BufferSource,
        ),
    );
}

/** The packet's raw wire bytes, for pinning a vector. */
export const claimPacketHex = (packetBase64: string): string =>
    hex.encode(base64.decode(packetBase64));
