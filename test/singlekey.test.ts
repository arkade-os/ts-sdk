import { describe, it, expect } from "vitest";
import { SingleKey } from "../src/identity/singleKey";

describe("SingleKey", () => {
    it("should create random keys with fromRandomBytes", async () => {
        const key1 = SingleKey.fromRandomBytes();
        const key2 = SingleKey.fromRandomBytes();

        // Keys should be different
        expect(key1).not.toBe(key2);

        // Both should be able to generate public keys
        await expect(key1.xOnlyPublicKey()).resolves.toBeInstanceOf(Uint8Array);
        await expect(key2.xOnlyPublicKey()).resolves.toBeInstanceOf(Uint8Array);
    });

    it("should create keys from hex", async () => {
        const privateKeyHex =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const key = SingleKey.fromHex(privateKeyHex);

        await expect(key.xOnlyPublicKey()).resolves.toBeInstanceOf(Uint8Array);
    });

    it("should create keys from private key bytes", async () => {
        const privateKeyBytes = new Uint8Array(32).fill(1);
        const key = SingleKey.fromPrivateKey(privateKeyBytes);

        await expect(key.xOnlyPublicKey()).resolves.toBeInstanceOf(Uint8Array);
    });
});
