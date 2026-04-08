import crypto from "node:crypto";

/**
 * Mock Authenticator for the Arkade SDK.
 * Implements PBKDF2 as requested for robust wallet key derivation.
 */
export class MockWalletAuthenticator {
  private static readonly ITERATIONS = 100000;
  private static readonly KEY_LENGTH = 32; // 256 bits for AES-256
  private static readonly DIGEST = "sha256";

  /**
   * Derives a High-Entropy Master Key from a simple password and salt.
   * 
   * @param password User's secret password.
   * @param salt Cryptographic salt (should be unique per wallet).
   * @returns Derived Buffer key.
   */
  static deriveMasterKey(password: string, salt: Buffer): Buffer {
    if (salt.length < 16) {
      throw new Error("Security Error: Robust salt must be at least 16 bytes.");
    }

    return crypto.pbkdf2Sync(
      password,
      salt,
      this.ITERATIONS,
      this.KEY_LENGTH,
      this.DIGEST
    );
  }

  /**
   * Helper to generate a new robust random salt.
   */
  static generateRandomSalt(length = 32): Buffer {
    return crypto.randomBytes(length);
  }
}
