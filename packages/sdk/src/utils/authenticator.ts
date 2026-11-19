import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

/**
 * PBKDF2-SHA256 key derivation helper for local at-rest storage encryption.
 *
 * Ownership boundary: derives 256-bit symmetric keys for encrypting local client
 * records (such as persisted exit packages) from a user- or application-managed
 * unlock passphrase. It does not manage or derive Bitcoin signing keys; never pass
 * a wallet seed, BIP-39 mnemonic, or private signing key as `passphrase`.
 */
export class WalletAuthenticator {
    private static readonly ITERATIONS = 100000;
    private static readonly KEY_LENGTH = 32; // 256 bits for AES-256

    /**
     * Derives a 256-bit local storage encryption key from an application/user
     * passphrase and salt using PBKDF2-SHA256.
     *
     * Never pass a Bitcoin wallet seed, BIP-39 mnemonic, or private signing key.
     *
     * @param passphrase Caller-managed unlock passphrase for local storage encryption.
     * @param salt Cryptographic salt (must be at least 16 bytes).
     * @returns Derived 32-byte AES-256 storage encryption key.
     */
    static deriveMasterKey(passphrase: string, salt: Uint8Array): Uint8Array {
        if (salt.length < 16) {
            throw new Error("Security Error: Robust salt must be at least 16 bytes.");
        }

        const passphraseBytes = new TextEncoder().encode(passphrase);
        return pbkdf2(sha256, passphraseBytes, salt, {
            c: this.ITERATIONS,
            dkLen: this.KEY_LENGTH,
        });
    }

    /**
     * Helper to generate a new robust random salt.
     */
    static generateRandomSalt(length = 32): Uint8Array {
        return randomBytes(length);
    }
}
