/**
 * ClaimPacket sealing: P encrypted to the Executor so the user can go offline
 * after funding. The solver carries the packet blindly and cannot decrypt it.
 *
 * Scheme (the Executor's `pkg/template/ecies`):
 * - ephemeral secp256k1 key; ECDH with the Executor's encryption key (x coordinate);
 * - HKDF-SHA256, info `covclaimd/preimage/v1`, salt = the ephemeral pubkey;
 * - AES-256-GCM, additional data `ephPub(33) ‖ utf8(templateId)`, `‖ u64be(minAmount)` when bound;
 * - value layout `ephPub(33) ‖ nonce(12) ‖ ciphertext`, TLV `0x01`.
 */
import { base64 } from "@scure/base";
import { arkade } from "@arkade-os/sdk";
import { concatBytes } from "@scure/btc-signer/utils.js";
import { gcm } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const HKDF_INFO = new TextEncoder().encode("covclaimd/preimage/v1");

/** Id of the Executor's `noninteractiveclaim` template. */
export const EXECUTOR_CLAIM_TEMPLATE_ID =
    "d321b3d9ff490a32c028842d57dd7974f271598f266847b29ffe01231ffaeb00";

/** The executor's template for a preimage, receiver program and minimum payout. */
export const EXECUTOR_RECEIVE_TEMPLATE_ID =
    "290b7a4364950677c1bab1ae25f9f757da864a71e54eb2ad74b3c43133e57e17";

/** Executor's receive template with an authenticated additional input predicate. */
export const EXECUTOR_PREDICATE_RECEIVE_TEMPLATE_ID =
    "9175f4917d1c2e90c4a70d8036e49679a94cef048860ea2f4f337c12ab68609a";

export interface SealedClaimPacket {
    /**
     * Base64 TLV body: `0x01` ciphertext, `0x03` encryption key and, when set, `0x04`: the amount,
     * or the predicate for a receive. **This is what `claim_packet` carries.** The solver stamps it
     * as Arkade extension packet `0x04`; the Executor matches on `0x03`, so the client alone
     * chooses which Executor.
     *
     * `0x02` arkade_script is deliberately absent: the covenant commits to
     * `taggedHash("ArkScriptHash", script)`, so only the funder's copy is guaranteed to
     * match (see {@link appendArkadeScript}); a client-derived one could strand the claim.
     */
    packet: string;
}

export interface ClaimPacketInput {
    preimage: Uint8Array;
    receive?: {
        receiverProgram: Uint8Array;
        minimumAmount: bigint;
        /** Public TLV `0x04` condition bytecode; 1..520 bytes in the restricted input-only profile.
         * Excludes {@link ClaimPacketInput.minAmount}, which uses the same TLV. */
        predicate?: Uint8Array;
    };
    /** The Executor's encryption public key, 33-byte compressed (from its `/v1/info`). */
    encryptionPubkey: Uint8Array;
    /** Defaults to the matching template; custom templates must support the selected terms layout. */
    templateId?: string;
    /** Sats the funded lockup must carry for the Executor to claim it, as TLV `0x04` and in the
     * AEAD's additional data so a courier cannot strip it. Unset: unbound. */
    minAmount?: bigint;
}

/**
 * Seal a preimage and optional receive terms to the Executor.
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
 * `ephemeralKey`/`nonce` breaks the AEAD outright, see {@link sealClaimPacket}.
 */
export async function sealWithEntropy(
    input: ClaimPacketInput,
    ephemeralKey: Uint8Array,
    nonce: Uint8Array,
): Promise<SealedClaimPacket> {
    if (input.preimage.length !== 32) throw new Error("preimage must be 32 bytes");
    if (input.encryptionPubkey.length !== 33) {
        throw new Error("encryption pubkey must be 33-byte compressed");
    }
    if (nonce.length !== 12) throw new Error("nonce must be 12 bytes");
    const { minAmount } = input;
    if (
        minAmount !== undefined &&
        (typeof minAmount !== "bigint" || minAmount < 1n || minAmount >= 1n << 64n)
    ) {
        throw new Error("minAmount must be a bigint in [1, 2^64-1]");
    }
    const predicate = input.receive?.predicate;
    if (predicate !== undefined && (predicate.length === 0 || predicate.length > 520)) {
        throw new Error("receive predicate must contain 1..520 bytes");
    }
    if (predicate !== undefined && minAmount !== undefined) {
        throw new Error("minAmount and a receive predicate both use TLV 0x04");
    }
    let plaintext = input.preimage;
    if (input.receive) {
        const { receiverProgram, minimumAmount } = input.receive;
        if (receiverProgram.length !== 32) throw new Error("receiver program must be 32 bytes");
        if (minimumAmount <= 0n || minimumAmount > 2_100_000_000_000_000n) {
            throw new Error("minimum amount must be positive and within the Bitcoin supply");
        }
        plaintext = concatBytes(
            input.preimage,
            receiverProgram,
            ...(predicate === undefined ? [] : [sha256(predicate)]),
            arkade.BigNum.encode(minimumAmount),
        );
    }
    const ephemeralPub = secp256k1.getPublicKey(ephemeralKey, true);
    // shared secret = x coordinate of the ECDH point
    const sharedX = secp256k1
        .getSharedSecret(ephemeralKey, input.encryptionPubkey, true)
        .subarray(1);
    const key = hkdf(sha256, sharedX, ephemeralPub, HKDF_INFO, 32);
    const amount = new Uint8Array(8);
    if (minAmount !== undefined) new DataView(amount.buffer).setBigUint64(0, minAmount, false);
    const additionalData = concatBytes(
        ephemeralPub,
        new TextEncoder().encode(
            input.templateId ??
                (predicate !== undefined
                    ? EXECUTOR_PREDICATE_RECEIVE_TEMPLATE_ID
                    : input.receive
                      ? EXECUTOR_RECEIVE_TEMPLATE_ID
                      : EXECUTOR_CLAIM_TEMPLATE_ID),
        ),
        minAmount === undefined ? new Uint8Array() : amount,
    );
    const sealed = gcm(key, nonce, additionalData).encrypt(plaintext);

    return {
        packet: base64.encode(
            concatBytes(
                tlv(TLV_CIPHERTEXT, concatBytes(ephemeralPub, nonce, sealed)),
                tlv(TLV_ENCRYPTION_PUBKEY, input.encryptionPubkey),
                minAmount === undefined ? new Uint8Array() : tlv(TLV_MIN_AMOUNT, amount),
                ...(predicate === undefined ? [] : [tlv(TLV_PREDICATE, predicate)]),
            ),
        ),
    };
}

const TLV_CIPHERTEXT = 0x01;
const TLV_ARKADE_SCRIPT = 0x02;
const TLV_ENCRYPTION_PUBKEY = 0x03;
const TLV_MIN_AMOUNT = 0x04;
/** Same tag as {@link TLV_MIN_AMOUNT}: the predicate template reads TLV 4 as program bytes. */
const TLV_PREDICATE = 0x04;

const COMPRESSED_PUBKEY_LENGTH = 33;

/** `ephPub(33) ‖ nonce(12) ‖ preimage(32) ‖ GCM tag(16)`. */
const MIN_SEALED_CIPHERTEXT_LENGTH = 93;

/** The Arkade extension packet type the Executor scans the operator's transaction stream for. */
export const CLAIM_PACKET_TYPE = 0x04;

/** `type(1) ‖ length(2, big-endian) ‖ value`. The length is two bytes even for a
 * 33-byte key: the format is fixed, not minimal. */
const tlv = (type: number, value: Uint8Array): Uint8Array =>
    Uint8Array.from([type, (value.length >> 8) & 0xff, value.length & 0xff, ...value]);

/**
 * Stamp the covenant script into a client's packet: the solver's half.
 *
 * Appending rather than rebuilding is safe: the TLV decode is order-agnostic,
 * so `0x01, 0x03, 0x02` reads back like `0x01, 0x02, 0x03`.
 */
export const appendArkadeScript = (body: Uint8Array, arkadeScript: Uint8Array): Uint8Array =>
    Uint8Array.from([...body, ...tlv(TLV_ARKADE_SCRIPT, arkadeScript)]);

export type ClaimPacketShape =
    | {
          kind: "packet";
          body: Uint8Array;
          encryptionPubkey: Uint8Array;
          needsArkadeScript: boolean;
      }
    /** A bare ciphertext, a body without `0x03`, or a malformed one. */
    | { kind: "none" };

/** Tolerates unknown and repeated types. {@link claimPacketShape} decides what a
 * partial body means. */
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
        else if (type === TLV_ENCRYPTION_PUBKEY) {
            if (value.length !== COMPRESSED_PUBKEY_LENGTH) {
                throw new Error(
                    `encryption key TLV is ${value.length} bytes, want ${COMPRESSED_PUBKEY_LENGTH}`,
                );
            }
            pubkey = value;
        }
    }
    return { ciphertextLength, hasArkadeScript, pubkey };
};

/**
 * What a base64 `claim_packet` field carries. Never throws: anything not
 * unambiguously a sealed packet with an encryption key reads as `none`.
 */
export const claimPacketShape = (b64: string): ClaimPacketShape => {
    try {
        const raw = base64.decode(b64);
        const { ciphertextLength, hasArkadeScript, pubkey } = parseTlv(raw);
        if (
            ciphertextLength === undefined ||
            ciphertextLength < MIN_SEALED_CIPHERTEXT_LENGTH ||
            pubkey === undefined
        ) {
            return { kind: "none" };
        }
        return {
            kind: "packet",
            body: raw,
            needsArkadeScript: !hasArkadeScript,
            encryptionPubkey: pubkey,
        };
    } catch {
        return { kind: "none" };
    }
};
