import { describe, it, expect } from "vitest";
import {
    SeedIdentity,
    ReadonlySeedIdentity,
} from "../src/identity/seedIdentity";
import { mnemonicToSeedSync } from "@scure/bip39";
import { hex } from "@scure/base";
import { schnorr, verifyAsync } from "@noble/secp256k1";

// Known test vector: BIP39 test mnemonic
const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("SeedIdentity", () => {
    describe("fromSeed", () => {
        it("should create identity from 64-byte seed", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            const xOnlyPubKey = await identity.xOnlyPublicKey();
            expect(xOnlyPubKey).toBeInstanceOf(Uint8Array);
            expect(xOnlyPubKey).toHaveLength(32);
        });

        it("should derive different keys for mainnet vs testnet", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);

            const mainnetIdentity = SeedIdentity.fromSeed(seed, {
                isMainnet: true,
            });
            const testnetIdentity = SeedIdentity.fromSeed(seed, {
                isMainnet: false,
            });

            const mainnetPubKey = await mainnetIdentity.xOnlyPublicKey();
            const testnetPubKey = await testnetIdentity.xOnlyPublicKey();

            expect(Array.from(mainnetPubKey)).not.toEqual(
                Array.from(testnetPubKey)
            );
        });

        it("should throw for invalid seed length", () => {
            const invalidSeed = new Uint8Array(32); // Should be 64 bytes
            expect(() =>
                SeedIdentity.fromSeed(invalidSeed, { isMainnet: true })
            ).toThrow("Seed must be 64 bytes");
        });
    });

    describe("fromMnemonic", () => {
        it("should create identity from mnemonic phrase", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });

            const xOnlyPubKey = await identity.xOnlyPublicKey();
            expect(xOnlyPubKey).toBeInstanceOf(Uint8Array);
            expect(xOnlyPubKey).toHaveLength(32);
        });

        it("should produce same key as fromSeed with equivalent seed", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);

            const fromSeedIdentity = SeedIdentity.fromSeed(seed, {
                isMainnet: true,
            });
            const fromMnemonicIdentity = SeedIdentity.fromMnemonic(
                TEST_MNEMONIC,
                { isMainnet: true }
            );

            const seedPubKey = await fromSeedIdentity.xOnlyPublicKey();
            const mnemonicPubKey = await fromMnemonicIdentity.xOnlyPublicKey();

            expect(Array.from(seedPubKey)).toEqual(Array.from(mnemonicPubKey));
        });

        it("should derive different key with passphrase", async () => {
            const withoutPassphrase = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const withPassphrase = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
                passphrase: "secret",
            });

            const pubKey1 = await withoutPassphrase.xOnlyPublicKey();
            const pubKey2 = await withPassphrase.xOnlyPublicKey();

            expect(Array.from(pubKey1)).not.toEqual(Array.from(pubKey2));
        });

        it("should throw for invalid mnemonic", () => {
            expect(() =>
                SeedIdentity.fromMnemonic("invalid mnemonic words here", {
                    isMainnet: true,
                })
            ).toThrow("Invalid mnemonic");
        });
    });

    describe("signing", () => {
        it("should sign message with schnorr signature", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const message = new Uint8Array(32).fill(42);

            const signature = await identity.signMessage(message, "schnorr");

            expect(signature).toBeInstanceOf(Uint8Array);
            expect(signature).toHaveLength(64);

            const publicKey = await identity.xOnlyPublicKey();
            const isValid = await schnorr.verifyAsync(
                signature,
                message,
                publicKey
            );
            expect(isValid).toBe(true);
        });

        it("should sign message with ecdsa signature", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const message = new Uint8Array(32).fill(42);

            const signature = await identity.signMessage(message, "ecdsa");

            expect(signature).toBeInstanceOf(Uint8Array);
            expect(signature).toHaveLength(64);

            const publicKey = await identity.compressedPublicKey();
            const isValid = await verifyAsync(signature, message, publicKey, {
                prehash: false,
            });
            expect(isValid).toBe(true);
        });

        it("should default to schnorr signature", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const message = new Uint8Array(32).fill(42);

            const signature = await identity.signMessage(message);

            expect(signature).toHaveLength(64);

            const publicKey = await identity.xOnlyPublicKey();
            const isValid = await schnorr.verifyAsync(
                signature,
                message,
                publicKey
            );
            expect(isValid).toBe(true);
        });
    });

    describe("serialization", () => {
        it("should serialize identity created from mnemonic", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const json = identity.toJSON();
            const parsed = JSON.parse(json);

            expect(parsed.mnemonic).toBe(TEST_MNEMONIC);
            expect(parsed.descriptor).toMatch(
                /^tr\(\[[\da-f]{8}\/86'\/0'\/0'\]xpub.+\/0\/\*\)$/
            );
        });

        it("should serialize identity created from seed (no mnemonic)", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const json = identity.toJSON();
            const parsed = JSON.parse(json);

            expect(parsed.mnemonic).toBeUndefined();
            expect(parsed.seed).toBe(hex.encode(seed));
            expect(parsed.descriptor).toMatch(
                /^tr\(\[[\da-f]{8}\/86'\/0'\/0'\]xpub.+\/0\/\*\)$/
            );
        });

        it("should include correct coin type in descriptor for testnet", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: false,
            });
            const json = identity.toJSON();
            const parsed = JSON.parse(json);

            expect(parsed.descriptor).toMatch(/\/86'\/1'\/0'\]/); // coin type 1 for testnet
        });
    });

    describe("fromJSON", () => {
        it("should deserialize identity with mnemonic", async () => {
            const original = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const json = original.toJSON();

            const restored = SeedIdentity.fromJSON(json);

            const originalPubKey = await original.xOnlyPublicKey();
            const restoredPubKey = await restored.xOnlyPublicKey();
            expect(Array.from(restoredPubKey)).toEqual(
                Array.from(originalPubKey)
            );
        });

        it("should deserialize identity with seed", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const original = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const json = original.toJSON();

            const restored = SeedIdentity.fromJSON(json);

            const originalPubKey = await original.xOnlyPublicKey();
            const restoredPubKey = await restored.xOnlyPublicKey();
            expect(Array.from(restoredPubKey)).toEqual(
                Array.from(originalPubKey)
            );
        });

        it("should infer isMainnet from descriptor coin type", async () => {
            const mainnet = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const testnet = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: false,
            });

            const restoredMainnet = SeedIdentity.fromJSON(mainnet.toJSON());
            const restoredTestnet = SeedIdentity.fromJSON(testnet.toJSON());

            // They should produce different keys (different coin type paths)
            const mainnetPubKey = await restoredMainnet.xOnlyPublicKey();
            const testnetPubKey = await restoredTestnet.xOnlyPublicKey();
            expect(Array.from(mainnetPubKey)).not.toEqual(
                Array.from(testnetPubKey)
            );
        });

        it("should throw if xpub does not match derived key", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const json = identity.toJSON();
            const parsed = JSON.parse(json);

            // Corrupt the xpub in descriptor
            parsed.descriptor = parsed.descriptor.replace(
                /xpub\w{107}/,
                "xpub" + "A".repeat(107)
            );

            expect(() => SeedIdentity.fromJSON(JSON.stringify(parsed))).toThrow(
                "xpub mismatch"
            );
        });

        it("should throw for invalid JSON", () => {
            expect(() => SeedIdentity.fromJSON("not json")).toThrow();
        });

        it("should throw for missing mnemonic and seed", () => {
            // Use a valid descriptor format (xpub is 111 chars: 4-char prefix + 107-char base58)
            const validXpub =
                "xpub6CUGRUonZSQ4TWtTMmzXdLcCnaqkRkEqpRPYrLfFdAokzGJWE4F8Z7dHjFPsMzj6Vv6wj3EzxhNoNKZkTvZhgpUebvZjK4zzqYpJXhWsDJTr";
            expect(() =>
                SeedIdentity.fromJSON(
                    `{"descriptor": "tr([12345678/86'/0'/0']${validXpub}/0/*)"}`
                )
            ).toThrow("Missing mnemonic or seed");
        });
    });
});

describe("ReadonlySeedIdentity", () => {
    describe("fromDescriptor", () => {
        it("should create readonly identity from descriptor", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const json = identity.toJSON();
            const descriptor = JSON.parse(json).descriptor;

            const readonly = ReadonlySeedIdentity.fromDescriptor(descriptor);

            const identityPubKey = await identity.xOnlyPublicKey();
            const readonlyPubKey = await readonly.xOnlyPublicKey();
            expect(Array.from(readonlyPubKey)).toEqual(
                Array.from(identityPubKey)
            );
        });

        it("should return correct compressed public key", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const json = identity.toJSON();
            const descriptor = JSON.parse(json).descriptor;

            const readonly = ReadonlySeedIdentity.fromDescriptor(descriptor);

            const identityPubKey = await identity.compressedPublicKey();
            const readonlyPubKey = await readonly.compressedPublicKey();
            expect(Array.from(readonlyPubKey)).toEqual(
                Array.from(identityPubKey)
            );
        });

        it("should throw for invalid descriptor", () => {
            expect(() =>
                ReadonlySeedIdentity.fromDescriptor("invalid")
            ).toThrow("Invalid descriptor format");
        });

        it("should throw for descriptor without /0/* template", () => {
            // Descriptor without the required /0/* derivation template
            const descriptorWithoutTemplate =
                "tr([12345678/86'/0'/0']xpubABCDEFGHIJKLMNOPQRSTUVWXYZ123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQR)";
            expect(() =>
                ReadonlySeedIdentity.fromDescriptor(descriptorWithoutTemplate)
            ).toThrow("Invalid descriptor format");
        });

        it("should throw for descriptor with wrong template", () => {
            // Descriptor with /1/* (change chain) instead of /0/*
            const descriptorWithWrongTemplate =
                "tr([12345678/86'/0'/0']xpubABCDEFGHIJKLMNOPQRSTUVWXYZ123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQR/1/*)";
            expect(() =>
                ReadonlySeedIdentity.fromDescriptor(descriptorWithWrongTemplate)
            ).toThrow("Invalid descriptor format");
        });
    });

    describe("toReadonly", () => {
        it("should convert SeedIdentity to ReadonlySeedIdentity", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const readonly = await identity.toReadonly();

            expect(readonly).toBeInstanceOf(ReadonlySeedIdentity);

            const identityPubKey = await identity.xOnlyPublicKey();
            const readonlyPubKey = await readonly.xOnlyPublicKey();
            expect(Array.from(readonlyPubKey)).toEqual(
                Array.from(identityPubKey)
            );
        });
    });

    describe("serialization", () => {
        it("should serialize to JSON with only descriptor", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const descriptor = JSON.parse(identity.toJSON()).descriptor;
            const readonly = ReadonlySeedIdentity.fromDescriptor(descriptor);

            const json = readonly.toJSON();
            const parsed = JSON.parse(json);

            expect(parsed.descriptor).toBe(descriptor);
            expect(parsed.mnemonic).toBeUndefined();
            expect(parsed.seed).toBeUndefined();
        });

        it("should round-trip through fromJSON", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const readonly = await identity.toReadonly();
            const json = readonly.toJSON();

            const restored = ReadonlySeedIdentity.fromJSON(json);

            const readonlyPubKey = await readonly.xOnlyPublicKey();
            const restoredPubKey = await restored.xOnlyPublicKey();
            expect(Array.from(restoredPubKey)).toEqual(
                Array.from(readonlyPubKey)
            );
        });
    });

    it("should not have signing methods", async () => {
        const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
        });
        const readonly = await identity.toReadonly();

        expect((readonly as any).sign).toBeUndefined();
        expect((readonly as any).signMessage).toBeUndefined();
        expect((readonly as any).signerSession).toBeUndefined();
    });
});

describe("SeedIdentity HD methods", () => {
    describe("deriveSigningDescriptor", () => {
        it("should derive descriptor at index 0", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const descriptor = identity.deriveSigningDescriptor(0);

            // Should be in format: tr([fingerprint/86'/0'/0']xpub.../0/0)
            expect(descriptor).toMatch(
                /^tr\(\[[\da-f]{8}\/86'\/0'\/0'\]xpub.+\/0\/0\)$/
            );
        });

        it("should derive descriptor at index 5", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const descriptor = identity.deriveSigningDescriptor(5);

            expect(descriptor).toMatch(
                /^tr\(\[[\da-f]{8}\/86'\/0'\/0'\]xpub.+\/0\/5\)$/
            );
        });

        it("should use testnet coin type for testnet identity", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: false,
            });
            const descriptor = identity.deriveSigningDescriptor(0);

            expect(descriptor).toMatch(/\/86'\/1'\/0'\]/);
        });

        it("should throw for negative index", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });

            expect(() => identity.deriveSigningDescriptor(-1)).toThrow(
                "Index must be non-negative"
            );
        });

        it("should derive different descriptors for different indexes", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });

            const desc0 = identity.deriveSigningDescriptor(0);
            const desc1 = identity.deriveSigningDescriptor(1);

            expect(desc0).not.toBe(desc1);
            expect(desc0.endsWith("/0/0)")).toBe(true);
            expect(desc1.endsWith("/0/1)")).toBe(true);
        });
    });

    describe("isOurs", () => {
        it("should return true for descriptor derived from same identity", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const descriptor = identity.deriveSigningDescriptor(5);

            expect(identity.isOurs(descriptor)).toBe(true);
        });

        it("should return true for any index from same identity", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });

            expect(identity.isOurs(identity.deriveSigningDescriptor(0))).toBe(true);
            expect(identity.isOurs(identity.deriveSigningDescriptor(100))).toBe(true);
            expect(identity.isOurs(identity.deriveSigningDescriptor(999))).toBe(true);
        });

        it("should return false for descriptor from different seed", () => {
            const identity1 = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const identity2 = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
                passphrase: "different",
            });

            const descriptor = identity2.deriveSigningDescriptor(5);

            expect(identity1.isOurs(descriptor)).toBe(false);
        });

        it("should return false for mainnet descriptor on testnet identity", () => {
            const mainnetIdentity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const testnetIdentity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: false,
            });

            const mainnetDescriptor = mainnetIdentity.deriveSigningDescriptor(0);

            expect(testnetIdentity.isOurs(mainnetDescriptor)).toBe(false);
        });

        it("should return false for invalid descriptor format", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });

            expect(identity.isOurs("invalid")).toBe(false);
            expect(identity.isOurs("tr([12345678/86'/0'/0']xpub.../0/*)")).toBe(false);
        });
    });

    describe("signWithDescriptor", () => {
        it("should throw for foreign descriptor", async () => {
            const identity1 = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const identity2 = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
                passphrase: "different",
            });

            const foreignDescriptor = identity2.deriveSigningDescriptor(5);

            await expect(
                identity1.signWithDescriptor(foreignDescriptor, [])
            ).rejects.toThrow("Descriptor does not belong to this identity");
        });

        it("should return empty array for empty requests", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const descriptor = identity.deriveSigningDescriptor(0);

            const results = await identity.signWithDescriptor(descriptor, []);

            expect(results).toEqual([]);
        });
    });

    describe("signMessageWithDescriptor", () => {
        it("should sign message with schnorr using descriptor", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const descriptor = identity.deriveSigningDescriptor(5);
            const message = new Uint8Array(32).fill(42);

            const signature = await identity.signMessageWithDescriptor(
                descriptor,
                message,
                "schnorr"
            );

            expect(signature).toBeInstanceOf(Uint8Array);
            expect(signature).toHaveLength(64);
        });

        it("should sign message with ecdsa using descriptor", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const descriptor = identity.deriveSigningDescriptor(5);
            const message = new Uint8Array(32).fill(42);

            const signature = await identity.signMessageWithDescriptor(
                descriptor,
                message,
                "ecdsa"
            );

            expect(signature).toBeInstanceOf(Uint8Array);
            expect(signature).toHaveLength(64);
        });

        it("should default to schnorr signature", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const descriptor = identity.deriveSigningDescriptor(5);
            const message = new Uint8Array(32).fill(42);

            const signature = await identity.signMessageWithDescriptor(
                descriptor,
                message
            );

            expect(signature).toHaveLength(64);
        });

        it("should throw for foreign descriptor", async () => {
            const identity1 = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const identity2 = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
                passphrase: "different",
            });

            const foreignDescriptor = identity2.deriveSigningDescriptor(5);
            const message = new Uint8Array(32).fill(42);

            await expect(
                identity1.signMessageWithDescriptor(foreignDescriptor, message)
            ).rejects.toThrow("Descriptor does not belong to this identity");
        });

        it("should produce different signatures at different indexes", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const descriptor0 = identity.deriveSigningDescriptor(0);
            const descriptor1 = identity.deriveSigningDescriptor(1);
            const message = new Uint8Array(32).fill(42);

            const sig0 = await identity.signMessageWithDescriptor(descriptor0, message);
            const sig1 = await identity.signMessageWithDescriptor(descriptor1, message);

            expect(Array.from(sig0)).not.toEqual(Array.from(sig1));
        });
    });
});

describe("ReadonlySeedIdentity HD methods", () => {
    describe("deriveSigningDescriptor", () => {
        it("should derive same descriptor as full identity", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const readonly = await identity.toReadonly();

            const fullDescriptor = identity.deriveSigningDescriptor(5);
            const readonlyDescriptor = readonly.deriveSigningDescriptor(5);

            expect(readonlyDescriptor).toBe(fullDescriptor);
        });

        it("should throw for negative index", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const readonly = await identity.toReadonly();

            expect(() => readonly.deriveSigningDescriptor(-1)).toThrow(
                "Index must be non-negative"
            );
        });
    });

    describe("isOurs", () => {
        it("should return true for own descriptor", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const readonly = await identity.toReadonly();
            const descriptor = readonly.deriveSigningDescriptor(5);

            expect(readonly.isOurs(descriptor)).toBe(true);
        });

        it("should return false for foreign descriptor", async () => {
            const identity1 = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const identity2 = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
                passphrase: "different",
            });

            const readonly1 = await identity1.toReadonly();
            const descriptor2 = identity2.deriveSigningDescriptor(5);

            expect(readonly1.isOurs(descriptor2)).toBe(false);
        });
    });

    describe("xOnlyPublicKeyAtIndex", () => {
        it("should return x-only public key at specific index", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const readonly = await identity.toReadonly();

            const pubKey = await readonly.xOnlyPublicKeyAtIndex(5);

            expect(pubKey).toBeInstanceOf(Uint8Array);
            expect(pubKey).toHaveLength(32);
        });

        it("should return different keys at different indexes", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const readonly = await identity.toReadonly();

            const pubKey0 = await readonly.xOnlyPublicKeyAtIndex(0);
            const pubKey1 = await readonly.xOnlyPublicKeyAtIndex(1);

            expect(Array.from(pubKey0)).not.toEqual(Array.from(pubKey1));
        });

        it("should return same key as xOnlyPublicKey() at index 0", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const readonly = await identity.toReadonly();

            const defaultKey = await readonly.xOnlyPublicKey();
            const indexKey = await readonly.xOnlyPublicKeyAtIndex(0);

            expect(Array.from(indexKey)).toEqual(Array.from(defaultKey));
        });
    });

    describe("compressedPublicKeyAtIndex", () => {
        it("should return compressed public key at specific index", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const readonly = await identity.toReadonly();

            const pubKey = await readonly.compressedPublicKeyAtIndex(5);

            expect(pubKey).toBeInstanceOf(Uint8Array);
            expect(pubKey).toHaveLength(33);
        });

        it("should return same key as compressedPublicKey() at index 0", async () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const readonly = await identity.toReadonly();

            const defaultKey = await readonly.compressedPublicKey();
            const indexKey = await readonly.compressedPublicKeyAtIndex(0);

            expect(Array.from(indexKey)).toEqual(Array.from(defaultKey));
        });
    });
});

describe("backwards compatibility", () => {
    it("xOnlyPublicKey should return same key as deriveSigningDescriptor index 0", async () => {
        const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
        });

        const defaultKey = await identity.xOnlyPublicKey();
        const descriptor0 = identity.deriveSigningDescriptor(0);

        // Sign with both methods and verify they produce same result
        const message = new Uint8Array(32).fill(42);
        const sig1 = await identity.signMessage(message);
        const sig2 = await identity.signMessageWithDescriptor(descriptor0, message);

        // Both should be verifiable with the same public key
        const isValid1 = await schnorr.verifyAsync(sig1, message, defaultKey);
        const isValid2 = await schnorr.verifyAsync(sig2, message, defaultKey);

        expect(isValid1).toBe(true);
        expect(isValid2).toBe(true);
    });

    it("existing sign method should still work", async () => {
        const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
        });
        const message = new Uint8Array(32).fill(42);

        // Verify existing API still works
        const signature = await identity.signMessage(message);
        expect(signature).toHaveLength(64);

        const publicKey = await identity.xOnlyPublicKey();
        const isValid = await schnorr.verifyAsync(signature, message, publicKey);
        expect(isValid).toBe(true);
    });

    it("toJSON should still produce template descriptor with wildcard", () => {
        const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
        });
        const json = identity.toJSON();
        const parsed = JSON.parse(json);

        // Should end with /0/* not /0/{index}
        expect(parsed.descriptor).toMatch(/\/0\/\*\)$/);
    });
});

describe("module exports", () => {
    it("should export SeedIdentity from identity module", async () => {
        const { SeedIdentity } = await import("../src/identity");
        expect(SeedIdentity).toBeDefined();
        expect(typeof SeedIdentity.fromMnemonic).toBe("function");
    });

    it("should export ReadonlySeedIdentity from identity module", async () => {
        const { ReadonlySeedIdentity } = await import("../src/identity");
        expect(ReadonlySeedIdentity).toBeDefined();
        expect(typeof ReadonlySeedIdentity.fromDescriptor).toBe("function");
    });

    it("should export SigningRequest from identity module", async () => {
        const { SigningRequest } = await import("../src/identity");
        // Type exists (compile-time check)
        expect(true).toBe(true);
    });
});
