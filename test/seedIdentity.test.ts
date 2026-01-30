import { describe, it, expect } from "vitest";
import { SeedIdentity, ReadonlySeedIdentity } from "../src/identity/seedIdentity";
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
            expect(() =>
                SeedIdentity.fromJSON(
                    '{"descriptor": "tr([12345678/86\'/0\'/0\']xpub.../0/*)"}'
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
});
