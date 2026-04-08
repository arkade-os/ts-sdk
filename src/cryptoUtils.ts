import crypto from "node:crypto";

/**
 * High-security utility for encrypting sensitive Arkade exit data at rest.
 * Uses AES-256-GCM for authenticated encryption.
 */
export class StorageCrypto {
  private static readonly ALGORITHM = "aes-256-gcm";
  private static readonly IV_LENGTH = 12;
  private static readonly AUTH_TAG_LENGTH = 16;

  /**
   * Derives a deterministic 256-bit key from a wallet secret.
   * In a real SDK, this would use PBKDF2 or SCrypt with a local salt.
   */
  static deriveStorageKey(walletSecret: string): Buffer {
    return crypto.createHash("sha256").update(walletSecret).digest();
  }

  /**
   * Encrypts a string payload and returns a combined buffer: [IV][Tag][Ciphertext]
   */
  static encrypt(plaintext: string, key: Buffer): Buffer {
    const iv = crypto.randomBytes(this.IV_LENGTH);
    const cipher = crypto.createCipheriv(this.ALGORITHM, key, iv, {
      authTagLength: this.AUTH_TAG_LENGTH,
    });

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    return Buffer.concat([iv, tag, ciphertext]);
  }

  /**
   * Decrypts a combined buffer [IV][Tag][Ciphertext] back into the original string.
   */
  static decrypt(combined: Buffer, key: Buffer): string {
    const iv = combined.subarray(0, this.IV_LENGTH);
    const tag = combined.subarray(this.IV_LENGTH, this.IV_LENGTH + this.AUTH_TAG_LENGTH);
    const ciphertext = combined.subarray(this.IV_LENGTH + this.AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(this.ALGORITHM, key, iv, {
      authTagLength: this.AUTH_TAG_LENGTH,
    });

    decipher.setAuthTag(tag);

    return decipher.update(ciphertext) + decipher.final("utf8");
  }
}
