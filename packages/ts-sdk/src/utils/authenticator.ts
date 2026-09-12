import { pbkdf2 } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

/**
 * Wallet Authenticator for the Arkade SDK.
 * Implements PBKDF2 for robust wallet key derivation.
 */
export class WalletAuthenticator {
    private static readonly ITERATIONS = 100000;
    private static readonly KEY_LENGTH = 32; // 256 bits for AES-256

    /**
     * Derives a High-Entropy Master Key from a password and salt.
     *
     * @param password User's secret password.
     * @param salt Cryptographic salt (must be at least 16 bytes).
     * @returns Derived 32-byte Uint8Array key.
     */
    static deriveMasterKey(password: string, salt: Uint8Array): Uint8Array {
        if (salt.length < 16) {
            throw new Error("Security Error: Robust salt must be at least 16 bytes.");
        }

        const passwordBytes = new TextEncoder().encode(password);
        return pbkdf2(sha256, passwordBytes, salt, {
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
