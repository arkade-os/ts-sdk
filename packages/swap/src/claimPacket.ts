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
 * Byte-exactness is confirmed against covclaimd@56cfd78's `preimage.Decrypt` and
 * `DeserializeClaim` via the vectors in `test/claimPacket*.test.ts`.
 */
import { base64 } from "@scure/base";
import { concatBytes } from "@scure/btc-signer/utils.js";
import { gcm } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const HKDF_INFO = new TextEncoder().encode("covclaimd/preimage/v1");

export interface SealedClaimPacket {
    /** `ephPub(33) ‖ nonce(12) ‖ ciphertext`, base64 (93 bytes decoded). The legacy
     * `claim_packet` shape: usable only via covclaimd's Reveal API, which silently
     * needs both sides on the SAME covclaimd. Prefer {@link SealedClaimPacket.packet}. */
    ciphertext: string;
    /**
     * covclaimd's serialised `ClaimPacket` body, base64: TLV `0x01` ciphertext and `0x03`
     * covclaimd_pub_key. **This is what `claim_packet` should carry** (§ 7.1.2). The
     * solver stamps it as Arkade extension packet `0x04`; covclaimd filters on `0x03`, so
     * the client alone chooses which covclaimd.
     *
     * `0x02` arkade_script is deliberately absent: the covenant commits to
     * `taggedHash("ArkScriptHash", script)`, so only the funder's copy is guaranteed to
     * match (see {@link appendArkadeScript}); a client-derived one could strand the claim.
     */
    packet: string;
}

export interface ClaimPacketInput {
    preimage: Uint8Array;
    /** covclaimd's public key, 33-byte compressed (from its /v1 info). */
    covclaimdPubkey: Uint8Array;
}

/**
 * Seal a preimage to covclaimd.
 *
 * The ephemeral key and nonce CANNOT be caller-supplied: AES-GCM under a repeated
 * (key, nonce) pair is a total break (forgery and plaintext recovery).
 */
export async function sealClaimPacket(input: ClaimPacketInput): Promise<SealedClaimPacket> {
    return sealWithEntropy(
        input,
        secp256k1.utils.randomSecretKey(),
        crypto.getRandomValues(new Uint8Array(12)),
    );
}

/**
 * @internal The sealing with entropy passed in; not re-exported. Reusing
 * `ephemeralKey`/`nonce` breaks the AEAD outright — see {@link sealClaimPacket}.
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

    const ciphertext = concatBytes(ephemeralPub, nonce, sealed);
    return {
        ciphertext: base64.encode(ciphertext),
        packet: base64.encode(
            concatBytes(
                tlv(TLV_CIPHERTEXT, ciphertext),
                tlv(TLV_COVCLAIMD_PUBKEY, input.covclaimdPubkey),
            ),
        ),
    };
}

const TLV_CIPHERTEXT = 0x01;
const TLV_ARKADE_SCRIPT = 0x02;
const TLV_COVCLAIMD_PUBKEY = 0x03;

const COMPRESSED_PUBKEY_LENGTH = 33;

/** `ephPub(33) ‖ nonce(12) ‖ preimage(32) ‖ GCM tag(16)`. Distinguishes the two
 * `claim_packet` shapes: a TLV body carrying it is ≥96 bytes, so lengths cannot collide. */
export const SEALED_CIPHERTEXT_LENGTH = 93;

/** The Arkade extension packet type covclaimd scans the arkd tx stream for. */
export const CLAIM_PACKET_TYPE = 0x04;

/** `type(1) ‖ length(2, big-endian) ‖ value`, covclaimd's own framing. The
 * length is two bytes even for a 33-byte key: the format is fixed, not minimal. */
const tlv = (type: number, value: Uint8Array): Uint8Array =>
    Uint8Array.from([type, (value.length >> 8) & 0xff, value.length & 0xff, ...value]);

/**
 * Stamp the covenant script into a client's packet — the solver's half.
 *
 * Appending rather than rebuilding is safe: covclaimd's `DeserializeClaim` is
 * order-agnostic, so `0x01, 0x03, 0x02` reads back like its own `0x01, 0x02, 0x03`.
 */
export const appendArkadeScript = (body: Uint8Array, arkadeScript: Uint8Array): Uint8Array =>
    Uint8Array.from([...body, ...tlv(TLV_ARKADE_SCRIPT, arkadeScript)]);

export type ClaimPacketShape =
    | { kind: "ciphertext" }
    | {
          kind: "packet";
          body: Uint8Array;
          covclaimdPubkey?: Uint8Array;
          needsArkadeScript: boolean;
      };

/** Transcribed from covclaimd's `DeserializeClaim` (tolerates unknown and repeated types),
 * minus its requirement that `0x01` and `0x02` both be present: {@link claimPacketShape}
 * decides what a partial body means. */
const parseTlv = (
    data: Uint8Array,
): { ciphertextLength?: number; hasArkadeScript: boolean; pubkey?: Uint8Array } => {
    let ciphertextLength: number | undefined;
    let hasArkadeScript = false;
    let pubkey: Uint8Array | undefined;
    let offset = 0;
    while (offset < data.length) {
        if (offset + 3 > data.length) throw new Error("truncated TLV header");
        const type = data[offset]!;
        const length = (data[offset + 1]! << 8) | data[offset + 2]!;
        offset += 3;
        if (offset + length > data.length) {
            throw new Error(`TLV type 0x${type.toString(16)} overruns the buffer`);
        }
        const value = data.subarray(offset, offset + length);
        offset += length;
        if (type === TLV_CIPHERTEXT) ciphertextLength = value.length;
        else if (type === TLV_ARKADE_SCRIPT) hasArkadeScript = true;
        else if (type === TLV_COVCLAIMD_PUBKEY) {
            if (value.length !== COMPRESSED_PUBKEY_LENGTH) {
                throw new Error(
                    `covclaimd_pub_key TLV is ${value.length} bytes, want ${COMPRESSED_PUBKEY_LENGTH}`,
                );
            }
            pubkey = value;
        }
    }
    return { ciphertextLength, hasArkadeScript, pubkey };
};

/**
 * Which of the two `claim_packet` shapes a base64 field carries.
 *
 * Never throws: anything not unambiguously a packet reads as the legacy ciphertext,
 * keeping the Reveal-API path rather than failing a swap over an unfamiliar field.
 */
export const claimPacketShape = (b64: string): ClaimPacketShape => {
    try {
        const raw = base64.decode(b64);
        if (raw.length === SEALED_CIPHERTEXT_LENGTH) return { kind: "ciphertext" };
        const { ciphertextLength, hasArkadeScript, pubkey } = parseTlv(raw);
        // A wrong length fails to decrypt either way, so take the loud path.
        if (ciphertextLength !== SEALED_CIPHERTEXT_LENGTH || pubkey === undefined) {
            return { kind: "ciphertext" };
        }
        return {
            kind: "packet",
            body: raw,
            needsArkadeScript: !hasArkadeScript,
            covclaimdPubkey: pubkey,
        };
    } catch {
        return { kind: "ciphertext" };
    }
};
