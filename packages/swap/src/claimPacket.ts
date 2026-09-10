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
 * Byte-exactness is CONFIRMED against the reference, not self-pinned:
 * covclaimd's own `preimage.Decrypt` (at covclaimd@56cfd78) recovers exactly
 * the P behind the vector in `test/claimPacket.test.ts`, and its
 * `DeserializeClaim` accepts the TLV bodies in `test/claimPacketCodec.test.ts`.
 */
import { base64 } from "@scure/base";
import { concatBytes } from "@scure/btc-signer/utils.js";
import { gcm } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const HKDF_INFO = new TextEncoder().encode("covclaimd/preimage/v1");

export interface SealedClaimPacket {
    /** `ephPub(33) ‖ nonce(12) ‖ ciphertext`, base64 — the bare sealed bytes,
     * 93 decoded. The older of the two `claim_packet` shapes: a solver holding
     * it can only hand it to covclaimd over the Reveal API, which needs both
     * sides pointed at the SAME covclaimd — an agreement nothing on the wire
     * expresses. Prefer {@link SealedClaimPacket.packet}. */
    ciphertext: string;
    /**
     * covclaimd's serialised `ClaimPacket` body, base64 — TLV `0x01` ciphertext
     * and `0x03` covclaimd_pub_key. **This is what `claim_packet` should
     * carry** (§ 7.1.2: senders SHOULD prefer the packet shape).
     *
     * It is what lets the solver stamp the funding transaction as Arkade
     * extension packet `0x04`, which covclaimd finds on the arkd stream by
     * itself. The `0x03` TLV is what its filter selects on, so the client alone
     * chooses which covclaimd — the solver needs none configured or reachable.
     *
     * `0x02` arkade_script is deliberately absent: the covenant commits to
     * `taggedHash("ArkScriptHash", script)`, so the funder holds the only copy
     * guaranteed to match and appends it. A client deriving its own would add a
     * way for the two to disagree and strand the claim.
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

    const ciphertext = new Uint8Array(33 + 12 + sealed.length);
    ciphertext.set(ephemeralPub, 0);
    ciphertext.set(nonce, 33);
    ciphertext.set(sealed, 45);
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

/** `ephPub(33) ‖ nonce(12) ‖ preimage(32) ‖ GCM tag(16)` — fixed by the sealing
 * scheme, and what tells the two `claim_packet` shapes apart: a TLV body needs
 * 96 bytes to carry this much, so the two lengths cannot collide. */
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
 * The covenant commits to `taggedHash("ArkScriptHash", script)`, so its funder
 * holds the only copy guaranteed to match, which is why a client never sends
 * `0x02`. Appending rather than rebuilding is safe because covclaimd's
 * `DeserializeClaim` is an order-agnostic switch: the `0x01, 0x03, 0x02` this
 * produces and its own `Serialize`'s `0x01, 0x02, 0x03` read back identically.
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

/** Transcribed from covclaimd's `DeserializeClaim`, including its tolerance of
 * unknown and repeated types. It does NOT inherit the Go's requirement that
 * `0x01` and `0x02` both be present: what a partial body means is a decision
 * for {@link claimPacketShape}, which has a non-throwing contract to keep. */
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
 * Never throws: anything not unambiguously a packet reads as the legacy bare
 * ciphertext, which keeps the older Reveal-API path rather than failing a swap
 * over a field this side may simply not understand.
 */
export const claimPacketShape = (b64: string): ClaimPacketShape => {
    try {
        const raw = base64.decode(b64);
        if (raw.length === SEALED_CIPHERTEXT_LENGTH) return { kind: "ciphertext" };
        const { ciphertextLength, hasArkadeScript, pubkey } = parseTlv(raw);
        // A wrong length fails to decrypt either way, so take the loud path.
        if (ciphertextLength !== SEALED_CIPHERTEXT_LENGTH) return { kind: "ciphertext" };
        return {
            kind: "packet",
            body: raw,
            needsArkadeScript: !hasArkadeScript,
            ...(pubkey ? { covclaimdPubkey: pubkey } : {}),
        };
    } catch {
        return { kind: "ciphertext" };
    }
};
