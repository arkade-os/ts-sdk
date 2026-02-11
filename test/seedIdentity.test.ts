import { describe, it, expect } from "vitest";
import {
    SeedIdentity,
    MnemonicIdentity,
    ReadonlyDescriptorIdentity,
} from "../src/identity/seedIdentity";
import { mnemonicToSeedSync } from "@scure/bip39";
import { hex } from "@scure/base";
import { schnorr, verifyAsync } from "@noble/secp256k1";

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

        it("should default to testnet when no options provided", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const defaultIdentity = SeedIdentity.fromSeed(seed);
            const testnetIdentity = SeedIdentity.fromSeed(seed, {
                isMainnet: false,
            });

            const defaultPubKey = await defaultIdentity.xOnlyPublicKey();
            const testnetPubKey = await testnetIdentity.xOnlyPublicKey();
            expect(Array.from(defaultPubKey)).toEqual(
                Array.from(testnetPubKey)
            );
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
            const invalidSeed = new Uint8Array(32);
            expect(() =>
                SeedIdentity.fromSeed(invalidSeed, { isMainnet: true })
            ).toThrow("Seed must be 64 bytes");
        });

        it("should expose descriptor with specific child derivation index", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            expect(identity.descriptor).toMatch(
                /^tr\(\[[\da-f]{8}\/86'\/0'\/0'\]xpub.+\/0\/0\)$/
            );
        });
    });

    describe("fromDescriptor", () => {
        it("should create identity from seed and explicit descriptor", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const reference = SeedIdentity.fromSeed(seed, { isMainnet: true });

            const identity = SeedIdentity.fromDescriptor(
                seed,
                reference.descriptor
            );

            const refPubKey = await reference.xOnlyPublicKey();
            const pubKey = await identity.xOnlyPublicKey();
            expect(Array.from(pubKey)).toEqual(Array.from(refPubKey));
        });

        it("should throw if xpub does not match seed", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            // Use mainnet descriptor with a different seed
            const otherSeed = mnemonicToSeedSync(TEST_MNEMONIC, "different");

            expect(() =>
                SeedIdentity.fromDescriptor(otherSeed, identity.descriptor)
            ).toThrow("xpub mismatch");
        });
    });

    describe("signing", () => {
        it("should sign message with schnorr signature", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
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
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
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
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
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
        it("should serialize with seed and descriptor", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const json = identity.toJSON();
            const parsed = JSON.parse(json);

            expect(parsed.seed).toBe(hex.encode(seed));
            expect(parsed.descriptor).toMatch(
                /^tr\(\[[\da-f]{8}\/86'\/0'\/0'\]xpub.+\/0\/0\)$/
            );
            expect(parsed.mnemonic).toBeUndefined();
        });

        it("should include correct coin type in descriptor for testnet", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: false });
            const json = identity.toJSON();
            const parsed = JSON.parse(json);

            expect(parsed.descriptor).toMatch(/\/86'\/1'\/0'\]/);
        });
    });

    describe("fromJSON", () => {
        it("should round-trip through JSON", async () => {
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

        it("should throw for missing seed", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const parsed = JSON.parse(identity.toJSON());
            delete parsed.seed;

            expect(() => SeedIdentity.fromJSON(JSON.stringify(parsed))).toThrow(
                "Missing seed"
            );
        });

        it("should throw for missing descriptor", () => {
            expect(() =>
                SeedIdentity.fromJSON(JSON.stringify({ seed: "abcd" }))
            ).toThrow("Missing descriptor");
        });

        it("should throw for invalid JSON", () => {
            expect(() => SeedIdentity.fromJSON("not json")).toThrow();
        });
    });
});

describe("MnemonicIdentity", () => {
    describe("fromMnemonic", () => {
        it("should create identity from mnemonic phrase", async () => {
            const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });

            const xOnlyPubKey = await identity.xOnlyPublicKey();
            expect(xOnlyPubKey).toBeInstanceOf(Uint8Array);
            expect(xOnlyPubKey).toHaveLength(32);
        });

        it("should default to testnet", async () => {
            const defaultIdentity =
                MnemonicIdentity.fromMnemonic(TEST_MNEMONIC);
            const testnetIdentity = MnemonicIdentity.fromMnemonic(
                TEST_MNEMONIC,
                { isMainnet: false }
            );

            const defaultPubKey = await defaultIdentity.xOnlyPublicKey();
            const testnetPubKey = await testnetIdentity.xOnlyPublicKey();
            expect(Array.from(defaultPubKey)).toEqual(
                Array.from(testnetPubKey)
            );
        });

        it("should produce same key as SeedIdentity.fromSeed with equivalent seed", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);

            const fromSeedIdentity = SeedIdentity.fromSeed(seed, {
                isMainnet: true,
            });
            const fromMnemonicIdentity = MnemonicIdentity.fromMnemonic(
                TEST_MNEMONIC,
                { isMainnet: true }
            );

            const seedPubKey = await fromSeedIdentity.xOnlyPublicKey();
            const mnemonicPubKey = await fromMnemonicIdentity.xOnlyPublicKey();

            expect(Array.from(seedPubKey)).toEqual(Array.from(mnemonicPubKey));
        });

        it("should derive different key with passphrase", async () => {
            const withoutPassphrase =
                MnemonicIdentity.fromMnemonic(TEST_MNEMONIC);
            const withPassphrase = MnemonicIdentity.fromMnemonic(
                TEST_MNEMONIC,
                { passphrase: "secret" }
            );

            const pubKey1 = await withoutPassphrase.xOnlyPublicKey();
            const pubKey2 = await withPassphrase.xOnlyPublicKey();

            expect(Array.from(pubKey1)).not.toEqual(Array.from(pubKey2));
        });

        it("should throw for invalid mnemonic", () => {
            expect(() =>
                MnemonicIdentity.fromMnemonic("invalid mnemonic words here")
            ).toThrow("Invalid mnemonic");
        });
    });

    describe("serialization", () => {
        it("should serialize with mnemonic and descriptor", () => {
            const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const json = identity.toJSON();
            const parsed = JSON.parse(json);

            expect(parsed.mnemonic).toBe(TEST_MNEMONIC);
            expect(parsed.descriptor).toMatch(
                /^tr\(\[[\da-f]{8}\/86'\/0'\/0'\]xpub.+\/0\/0\)$/
            );
            expect(parsed.seed).toBeUndefined();
            expect(parsed.passphrase).toBeUndefined();
        });

        it("should include passphrase when provided", () => {
            const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
                passphrase: "secret",
            });
            const json = identity.toJSON();
            const parsed = JSON.parse(json);

            expect(parsed.mnemonic).toBe(TEST_MNEMONIC);
            expect(parsed.passphrase).toBe("secret");
        });
    });

    describe("fromJSON", () => {
        it("should round-trip without passphrase", async () => {
            const original = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const json = original.toJSON();

            const restored = MnemonicIdentity.fromJSON(json);

            const originalPubKey = await original.xOnlyPublicKey();
            const restoredPubKey = await restored.xOnlyPublicKey();
            expect(Array.from(restoredPubKey)).toEqual(
                Array.from(originalPubKey)
            );
        });

        it("should round-trip with passphrase", async () => {
            const original = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
                passphrase: "secret",
            });
            const json = original.toJSON();

            const restored = MnemonicIdentity.fromJSON(json);

            const originalPubKey = await original.xOnlyPublicKey();
            const restoredPubKey = await restored.xOnlyPublicKey();
            expect(Array.from(restoredPubKey)).toEqual(
                Array.from(originalPubKey)
            );
        });

        it("should throw for missing mnemonic", () => {
            const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const parsed = JSON.parse(identity.toJSON());
            delete parsed.mnemonic;

            expect(() =>
                MnemonicIdentity.fromJSON(JSON.stringify(parsed))
            ).toThrow("Missing mnemonic");
        });
    });
});

describe("ReadonlyDescriptorIdentity", () => {
    describe("fromDescriptor", () => {
        it("should create readonly identity from descriptor", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            const readonly = ReadonlyDescriptorIdentity.fromDescriptor(
                identity.descriptor
            );

            const identityPubKey = await identity.xOnlyPublicKey();
            const readonlyPubKey = await readonly.xOnlyPublicKey();
            expect(Array.from(readonlyPubKey)).toEqual(
                Array.from(identityPubKey)
            );
        });

        it("should return correct compressed public key", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            const readonly = ReadonlyDescriptorIdentity.fromDescriptor(
                identity.descriptor
            );

            const identityPubKey = await identity.compressedPublicKey();
            const readonlyPubKey = await readonly.compressedPublicKey();
            expect(Array.from(readonlyPubKey)).toEqual(
                Array.from(identityPubKey)
            );
        });

        it("should throw for invalid descriptor", () => {
            expect(() =>
                ReadonlyDescriptorIdentity.fromDescriptor("invalid")
            ).toThrow();
        });
    });

    describe("toReadonly", () => {
        it("should convert SeedIdentity to ReadonlyDescriptorIdentity", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = await identity.toReadonly();

            expect(readonly).toBeInstanceOf(ReadonlyDescriptorIdentity);

            const identityPubKey = await identity.xOnlyPublicKey();
            const readonlyPubKey = await readonly.xOnlyPublicKey();
            expect(Array.from(readonlyPubKey)).toEqual(
                Array.from(identityPubKey)
            );
        });

        it("should convert MnemonicIdentity to ReadonlyDescriptorIdentity", async () => {
            const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const readonly = await identity.toReadonly();

            expect(readonly).toBeInstanceOf(ReadonlyDescriptorIdentity);

            const identityPubKey = await identity.xOnlyPublicKey();
            const readonlyPubKey = await readonly.xOnlyPublicKey();
            expect(Array.from(readonlyPubKey)).toEqual(
                Array.from(identityPubKey)
            );
        });
    });

    describe("serialization", () => {
        it("should serialize to JSON with only descriptor", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = ReadonlyDescriptorIdentity.fromDescriptor(
                identity.descriptor
            );

            const json = readonly.toJSON();
            const parsed = JSON.parse(json);

            expect(parsed.descriptor).toBe(identity.descriptor);
            expect(parsed.mnemonic).toBeUndefined();
            expect(parsed.seed).toBeUndefined();
        });

        it("should round-trip through fromJSON", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = await identity.toReadonly();
            const json = readonly.toJSON();

            const restored = ReadonlyDescriptorIdentity.fromJSON(json);

            const readonlyPubKey = await readonly.xOnlyPublicKey();
            const restoredPubKey = await restored.xOnlyPublicKey();
            expect(Array.from(restoredPubKey)).toEqual(
                Array.from(readonlyPubKey)
            );
        });
    });

    it("should not have signing methods", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
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
        expect(typeof SeedIdentity.fromSeed).toBe("function");
    });

    it("should export MnemonicIdentity from identity module", async () => {
        const { MnemonicIdentity } = await import("../src/identity");
        expect(MnemonicIdentity).toBeDefined();
        expect(typeof MnemonicIdentity.fromMnemonic).toBe("function");
    });

    it("should export ReadonlyDescriptorIdentity from identity module", async () => {
        const { ReadonlyDescriptorIdentity } = await import("../src/identity");
        expect(ReadonlyDescriptorIdentity).toBeDefined();
        expect(typeof ReadonlyDescriptorIdentity.fromDescriptor).toBe(
            "function"
        );
    });
});
