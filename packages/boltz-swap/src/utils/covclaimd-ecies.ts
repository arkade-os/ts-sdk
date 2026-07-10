import { secp256k1 } from "@noble/curves/secp256k1.js";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { gcm } from "@noble/ciphers/aes.js";

const EPH_PUB_LEN = 33;
const NONCE_LEN = 12;
const HKDF_INFO = utf8ToBytes("covclaimd/preimage/v1");

function deriveKey(ephPub: Uint8Array, shared: Uint8Array): Uint8Array {
    return hkdf(sha256, shared, ephPub, HKDF_INFO, 32);
}

export function eciesEncrypt(recipientPubkey: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const ephSk = randomPrivateKeyBytes();
    const ephPub = secp256k1.getPublicKey(ephSk, true);
    const shared = secp256k1.getSharedSecret(ephSk, recipientPubkey).slice(1);
    const key = deriveKey(ephPub, shared);
    const nonce = randomBytes(NONCE_LEN);
    const ct = gcm(key, nonce, ephPub).encrypt(plaintext);
    const out = new Uint8Array(EPH_PUB_LEN + NONCE_LEN + ct.length);
    out.set(ephPub, 0);
    out.set(nonce, EPH_PUB_LEN);
    out.set(ct, EPH_PUB_LEN + NONCE_LEN);
    return out;
}

export function eciesDecrypt(secretKey: Uint8Array, blob: Uint8Array): Uint8Array {
    if (blob.length < EPH_PUB_LEN + NONCE_LEN + 16) throw new Error("ecies: blob too short");
    const ephPub = blob.slice(0, EPH_PUB_LEN);
    const nonce = blob.slice(EPH_PUB_LEN, EPH_PUB_LEN + NONCE_LEN);
    const ct = blob.slice(EPH_PUB_LEN + NONCE_LEN);
    const shared = secp256k1.getSharedSecret(secretKey, ephPub).slice(1);
    const key = deriveKey(ephPub, shared);
    return gcm(key, nonce, ephPub).decrypt(ct);
}
