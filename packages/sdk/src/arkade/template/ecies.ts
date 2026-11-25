import { gcm } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const PUBKEY_LENGTH = 33;
const NONCE_LENGTH = 12;
const MIN_LENGTH = PUBKEY_LENGTH + NONCE_LENGTH + 16;
const HKDF_INFO = utf8ToBytes("covclaimd/preimage/v1");

const deriveKey = (secretKey: Uint8Array, publicKey: Uint8Array, ephemeralPub: Uint8Array) =>
    hkdf(
        sha256,
        secp256k1.getSharedSecret(secretKey, publicKey, true).subarray(1),
        ephemeralPub,
        HKDF_INFO,
        32,
    );

const aad = (ephemeralPub: Uint8Array, templateId: string) =>
    concatBytes(ephemeralPub, utf8ToBytes(templateId));

export function seal(
    recipientPubkey: Uint8Array,
    plaintext: Uint8Array,
    templateId: string,
): Uint8Array {
    return sealWithRng(randomBytes, recipientPubkey, plaintext, templateId);
}

/** For known-answer tests only: a repeated ephemeral key and nonce breaks AES-GCM outright. */
export function sealWithRng(
    rng: (bytesLength: number) => Uint8Array,
    recipientPubkey: Uint8Array,
    plaintext: Uint8Array,
    templateId: string,
): Uint8Array {
    const ephemeralKey = rng(32);
    if (!secp256k1.utils.isValidSecretKey(ephemeralKey)) {
        throw new Error("ecies: generate ephemeral key: not a valid secp256k1 scalar");
    }
    const ephemeralPub = secp256k1.getPublicKey(ephemeralKey, true);
    const key = deriveKey(ephemeralKey, recipientPubkey, ephemeralPub);
    const nonce = rng(NONCE_LENGTH);
    if (nonce.length !== NONCE_LENGTH) {
        throw new Error(`ecies: generate nonce: got ${nonce.length} bytes, need ${NONCE_LENGTH}`);
    }
    const sealed = gcm(key, nonce, aad(ephemeralPub, templateId)).encrypt(plaintext);
    return concatBytes(ephemeralPub, nonce, sealed);
}

export function open(
    privateKey: Uint8Array,
    ciphertext: Uint8Array,
    templateId: string,
): Uint8Array {
    if (ciphertext.length < MIN_LENGTH) {
        throw new Error(
            `ecies: ciphertext too short: got ${ciphertext.length} bytes, need at least ${MIN_LENGTH}`,
        );
    }
    const ephemeralPub = ciphertext.subarray(0, PUBKEY_LENGTH);
    if (!secp256k1.utils.isValidPublicKey(ephemeralPub, true)) {
        throw new Error("ecies: invalid ephemeral public key");
    }
    const key = deriveKey(privateKey, ephemeralPub, ephemeralPub);
    const nonce = ciphertext.subarray(PUBKEY_LENGTH, PUBKEY_LENGTH + NONCE_LENGTH);
    try {
        return gcm(key, nonce, aad(ephemeralPub, templateId)).decrypt(
            ciphertext.subarray(PUBKEY_LENGTH + NONCE_LENGTH),
        );
    } catch (e) {
        throw new Error(`ecies: decrypt: ${(e as Error).message}`);
    }
}
