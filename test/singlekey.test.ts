import { describe, it, expect } from "vitest";
import { SingleKey } from "../src/identity/singleKey";

describe("SingleKey", () => {
    it("should create random keys with fromRandomBytes", async () => {
        const key1 = SingleKey.fromRandomBytes();
        const key2 = SingleKey.fromRandomBytes();

        // Get x-only public keys from both keys
        const pubKey1 = await key1.xOnlyPublicKey();
        const pubKey2 = await key2.xOnlyPublicKey();

        // Both should be Uint8Array instances of correct length (32 bytes)
        expect(pubKey1).toBeInstanceOf(Uint8Array);
        expect(pubKey1).toHaveLength(32);
        expect(pubKey2).toBeInstanceOf(Uint8Array);
        expect(pubKey2).toHaveLength(32);

        // Public key byte arrays should be different (not equal bytewise)
        expect(Array.from(pubKey1)).not.toEqual(Array.from(pubKey2));
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
