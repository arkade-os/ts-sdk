import { WalletAuthenticator } from "./authenticator.js";

/**
 * High-security utility for encrypting sensitive Arkade exit data at rest.
 * Uses AES-256-GCM via WebCrypto for authenticated encryption.
 */
export class StorageCrypto {
    private static readonly IV_LENGTH = 12;
    private static readonly AUTH_TAG_LENGTH = 16;

    /**
     * Derives a 256-bit storage key from a wallet secret using salted PBKDF2.
     */
    static deriveStorageKey(walletSecret: string, salt: Uint8Array): Uint8Array {
        return WalletAuthenticator.deriveMasterKey(walletSecret, salt);
    }

    /**
     * Encrypts a string payload and returns a combined Uint8Array: [IV (12)][Ciphertext + AuthTag (16)]
     */
    static async encrypt(plaintext: string, key: Uint8Array): Promise<Uint8Array> {
        const subtle = globalThis.crypto?.subtle;
        if (!subtle) {
            throw new Error("WebCrypto (crypto.subtle) is required for StorageCrypto");
        }
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(this.IV_LENGTH));
        const cryptoKey = await subtle.importKey(
            "raw",
            key as unknown as BufferSource,
            { name: "AES-GCM" },
            false,
            ["encrypt"],
        );
        const encoded = new TextEncoder().encode(plaintext);
        const encryptedBuf = await subtle.encrypt(
            {
                name: "AES-GCM",
                iv: iv as unknown as BufferSource,
                tagLength: this.AUTH_TAG_LENGTH * 8,
            },
            cryptoKey,
            encoded as unknown as BufferSource,
        );
        const encryptedBytes = new Uint8Array(encryptedBuf);
        const combined = new Uint8Array(this.IV_LENGTH + encryptedBytes.length);
        combined.set(iv, 0);
        combined.set(encryptedBytes, this.IV_LENGTH);
        return combined;
    }

    /**
     * Decrypts a combined buffer [IV (12)][Ciphertext + AuthTag (16)] back into the original string.
     */
    static async decrypt(combined: Uint8Array, key: Uint8Array): Promise<string> {
        const subtle = globalThis.crypto?.subtle;
        if (!subtle) {
            throw new Error("WebCrypto (crypto.subtle) is required for StorageCrypto");
        }
        if (combined.length < this.IV_LENGTH + this.AUTH_TAG_LENGTH) {
            throw new Error("Invalid encrypted payload length");
        }
        const iv = combined.subarray(0, this.IV_LENGTH);
        const ciphertextWithTag = combined.subarray(this.IV_LENGTH);
        const cryptoKey = await subtle.importKey(
            "raw",
            key as unknown as BufferSource,
            { name: "AES-GCM" },
            false,
            ["decrypt"],
        );
        const decryptedBuf = await subtle.decrypt(
            {
                name: "AES-GCM",
                iv: iv as unknown as BufferSource,
                tagLength: this.AUTH_TAG_LENGTH * 8,
            },
            cryptoKey,
            ciphertextWithTag as unknown as BufferSource,
        );
        return new TextDecoder().decode(new Uint8Array(decryptedBuf));
    }
}
