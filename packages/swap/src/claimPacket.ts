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
const TLV_COVCLAIMD_PUBKEY = 0x03;

/** `type(1) ‖ length(2, big-endian) ‖ value`, covclaimd's own framing. The
 * length is two bytes even for a 33-byte key: the format is fixed, not minimal. */
const tlv = (type: number, value: Uint8Array): Uint8Array =>
    Uint8Array.from([type, (value.length >> 8) & 0xff, value.length & 0xff, ...value]);
