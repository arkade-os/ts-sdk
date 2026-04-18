import { describe, it, expect } from "vitest";
import { SingleKey, ReadonlySingleKey } from "../src/identity/singleKey";
import { InMemoryStorageAdapter } from "../src/storage/inMemory";
import { schnorr, verifyAsync } from "@noble/secp256k1";

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
        await expect(key.compressedPublicKey()).resolves.toBeInstanceOf(
            Uint8Array
        );
    });

    it("should create keys from private key bytes", async () => {
        const privateKeyBytes = new Uint8Array(32).fill(1);
        const key = SingleKey.fromPrivateKey(privateKeyBytes);

        await expect(key.xOnlyPublicKey()).resolves.toBeInstanceOf(Uint8Array);
        await expect(key.compressedPublicKey()).resolves.toBeInstanceOf(
            Uint8Array
        );
    });

    it("should export private key as hex with toHex()", () => {
        const privateKeyHex =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const key = SingleKey.fromHex(privateKeyHex);

        // Should be able to export the same hex
        const exportedHex = key.toHex();
        expect(exportedHex).toBe(privateKeyHex);
    });

    it("should round-trip from hex to storage and back", async () => {
        const originalHex =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const storage = new InMemoryStorageAdapter();

        // Create key from hex
        const key1 = SingleKey.fromHex(originalHex);

        // Store it using toHex()
        await storage.setItem("test-key", key1.toHex());

        // Load it back using simple pattern: storage.getItem + fromHex
        const storedHex = await storage.getItem("test-key");
        expect(storedHex).toBeTruthy(); // Ensure it's not null
        const key2 = SingleKey.fromHex(storedHex!);

        // Should have the same x-only public key
        const pubKey1 = await key1.xOnlyPublicKey();
        const pubKey2 = await key2.xOnlyPublicKey();
        expect(Array.from(pubKey1)).toEqual(Array.from(pubKey2));

        // Should have the same compressed public key
        const compPubKey1 = await key1.compressedPublicKey();
        const compPubKey2 = await key2.compressedPublicKey();
        expect(Array.from(compPubKey1)).toEqual(Array.from(compPubKey2));

        // Should export the same hex
        expect(key2.toHex()).toBe(originalHex);
    });

    it("should sign message with schnorr signature", async () => {
        const privateKeyHex =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const key = SingleKey.fromHex(privateKeyHex);
        const message = new Uint8Array(32).fill(42); // 32-byte message

        const signature = await key.signMessage(message, "schnorr");

        // Schnorr signatures are 64 bytes
        expect(signature).toBeInstanceOf(Uint8Array);
        expect(signature).toHaveLength(64);

        // Verify that the signature is correct
        const publicKey = await key.xOnlyPublicKey();
        const isValid = await schnorr.verifyAsync(
            signature,
            message,
            publicKey
        );
        expect(isValid).toBe(true);
    });

    it("should default to schnorr signature when type not specified", async () => {
        const privateKeyHex =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const key = SingleKey.fromHex(privateKeyHex);
        const message = new Uint8Array(32).fill(42); // 32-byte message

        const signature = await key.signMessage(message);

        // Should produce schnorr signature by default (64 bytes)
        expect(signature).toBeInstanceOf(Uint8Array);
        expect(signature).toHaveLength(64);

        // Verify that the signature is correct
        const publicKey = await key.xOnlyPublicKey();
        const isValid = await schnorr.verifyAsync(
            signature,
            message,
            publicKey
        );
        expect(isValid).toBe(true);
    });

    it("should sign message with ecdsa signature", async () => {
        const privateKeyHex =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const key = SingleKey.fromHex(privateKeyHex);
        const message = new Uint8Array(32).fill(42); // 32-byte message

        const signature = await key.signMessage(message, "ecdsa");

        // ECDSA signatures are 64 bytes (compact format)
        expect(signature).toBeInstanceOf(Uint8Array);
        expect(signature).toHaveLength(64);

        // Verify that the signature is correct
        // ECDSA uses compressed public key (not x-only)
        const publicKey = await key.compressedPublicKey();
        const isValid = await verifyAsync(signature, message, publicKey, {
            prehash: false,
        });
        expect(isValid).toBe(true);
    });

    describe("toReadonly", () => {
        it("should convert SingleKey to ReadonlySingleKey", async () => {
            const privateKeyHex =
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
            const key = SingleKey.fromHex(privateKeyHex);

            const readonlyKey = await key.toReadonly();

            // Should be instance of ReadonlySingleKey
            expect(readonlyKey).toBeInstanceOf(ReadonlySingleKey);

            // Should have the same public keys
            const xOnlyPubKey = await key.xOnlyPublicKey();
            const readonlyXOnlyPubKey = await readonlyKey.xOnlyPublicKey();
            expect(Array.from(xOnlyPubKey)).toEqual(
                Array.from(readonlyXOnlyPubKey)
            );

            const compressedPubKey = await key.compressedPublicKey();
            const readonlyCompressedPubKey =
                await readonlyKey.compressedPublicKey();
            expect(Array.from(compressedPubKey)).toEqual(
                Array.from(readonlyCompressedPubKey)
            );
        });
    });
});

describe("ReadonlySingleKey", () => {
    it("should create from compressed public key", async () => {
        // First create a regular key to get its public key
        const privateKeyHex =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const key = SingleKey.fromHex(privateKeyHex);
        const compressedPubKey = await key.compressedPublicKey();

        // Create readonly key from public key
        const readonlyKey = ReadonlySingleKey.fromPublicKey(compressedPubKey);

        // Should be instance of ReadonlySingleKey
        expect(readonlyKey).toBeInstanceOf(ReadonlySingleKey);

        // Should have the same public keys
        const xOnlyPubKey = await key.xOnlyPublicKey();
        const readonlyXOnlyPubKey = await readonlyKey.xOnlyPublicKey();
        expect(Array.from(xOnlyPubKey)).toEqual(
            Array.from(readonlyXOnlyPubKey)
        );

        const readonlyCompressedPubKey =
            await readonlyKey.compressedPublicKey();
        expect(Array.from(compressedPubKey)).toEqual(
            Array.from(readonlyCompressedPubKey)
        );
    });

    it("should throw error for invalid public key length", () => {
        const invalidPubKey = new Uint8Array(32); // 32 bytes instead of 33

        expect(() => ReadonlySingleKey.fromPublicKey(invalidPubKey)).toThrow(
            "Invalid public key length"
        );
    });

    it("should return correct x-only public key (without prefix)", async () => {
        // Create a key with known public key
        const privateKeyHex =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const key = SingleKey.fromHex(privateKeyHex);
        const compressedPubKey = await key.compressedPublicKey();

        const readonlyKey = ReadonlySingleKey.fromPublicKey(compressedPubKey);
        const xOnlyPubKey = await readonlyKey.xOnlyPublicKey();

        // x-only should be 32 bytes (without the 02/03 prefix)
        expect(xOnlyPubKey).toHaveLength(32);

        // x-only should be the compressed key without the first byte
        expect(Array.from(xOnlyPubKey)).toEqual(
            Array.from(compressedPubKey.slice(1))
        );
    });

    it("should not have signing methods", () => {
        const compressedPubKey = new Uint8Array(33).fill(2);
        compressedPubKey[0] = 0x02; // Set prefix
        const readonlyKey = ReadonlySingleKey.fromPublicKey(compressedPubKey);

        // Should not have sign or signMessage methods
        expect((readonlyKey as any).sign).toBeUndefined();
        expect((readonlyKey as any).signMessage).toBeUndefined();
        expect((readonlyKey as any).toHex).toBeUndefined();
    });

    it("should work with different public key prefixes", async () => {
        const privateKeyHex =
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        const key = SingleKey.fromHex(privateKeyHex);
        const compressedPubKey = await key.compressedPublicKey();

        // Should work with both 0x02 and 0x03 prefixes
        expect(compressedPubKey[0]).toBeGreaterThanOrEqual(2);
        expect(compressedPubKey[0]).toBeLessThanOrEqual(3);

        const readonlyKey = ReadonlySingleKey.fromPublicKey(compressedPubKey);
        const xOnlyPubKey = await readonlyKey.xOnlyPublicKey();

        expect(xOnlyPubKey).toHaveLength(32);
        expect(xOnlyPubKey).toBeInstanceOf(Uint8Array);
    });
});
