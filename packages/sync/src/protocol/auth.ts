import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

/**
 * The minimal identity surface the client needs to authenticate: an x-only
 * public key and a BIP-340 Schnorr signer over a raw 32-byte message. The
 * Arkade SDK's `Identity` satisfies this structurally
 * (`signMessage(msg, "schnorr")` → `schnorr.signAsync(msg, key)`), so callers
 * pass their existing wallet identity — no separate sync key.
 */
export interface SchnorrSigner {
    xOnlyPublicKey(): Promise<Uint8Array>;
    signMessage(message: Uint8Array, signatureType: "schnorr"): Promise<Uint8Array>;
}

/** Domain-separation tag the server prepends before hashing the nonce. */
const AUTH_TAG = new TextEncoder().encode("bucket-sync:auth:v1");

/**
 * Compute the BIP-340 message the server expects a client to sign:
 * `SHA-256(tag || nonceBytes)`, 32 bytes. Mirrors `AuthChallengeMessage.Compute`
 * in the server. `nonceHex` is the 64-char hex nonce from the challenge.
 */
export function authMessage(nonceHex: string): Uint8Array {
    const nonce = hex.decode(nonceHex);
    if (nonce.length !== 32) throw new Error("nonce must be 32 bytes");
    const buf = new Uint8Array(AUTH_TAG.length + nonce.length);
    buf.set(AUTH_TAG, 0);
    buf.set(nonce, AUTH_TAG.length);
    return sha256(buf);
}
