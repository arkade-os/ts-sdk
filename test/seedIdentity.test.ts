import { describe, it, expect } from "vitest";
import {
    SeedIdentity,
    MnemonicIdentity,
    ReadonlyDescriptorIdentity,
} from "../src/identity/seedIdentity";
import { mnemonicToSeedSync } from "@scure/bip39";
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

        it("should require network selection", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            // @ts-expect-error opts is required
            expect(() => SeedIdentity.fromSeed(seed)).toThrow();
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

        it("should accept custom descriptor in options", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const reference = SeedIdentity.fromSeed(seed, { isMainnet: true });

            const identity = SeedIdentity.fromSeed(seed, {
                descriptor: reference.descriptor,
            });

            const refPubKey = await reference.xOnlyPublicKey();
            const pubKey = await identity.xOnlyPublicKey();
            expect(Array.from(pubKey)).toEqual(Array.from(refPubKey));
            expect(identity.descriptor).toBe(reference.descriptor);
        });

        it("should use custom descriptor instead of default BIP86", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const mainnet = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const testnet = SeedIdentity.fromSeed(seed, {
                isMainnet: false,
            });

            // Pass the mainnet descriptor explicitly — should match mainnet, not testnet
            const identity = SeedIdentity.fromSeed(seed, {
                descriptor: mainnet.descriptor,
            });

            const mainnetPubKey = await mainnet.xOnlyPublicKey();
            const testnetPubKey = await testnet.xOnlyPublicKey();
            const pubKey = await identity.xOnlyPublicKey();
            expect(Array.from(pubKey)).toEqual(Array.from(mainnetPubKey));
            expect(Array.from(pubKey)).not.toEqual(Array.from(testnetPubKey));
        });
    });

    describe("constructor", () => {
        it("should create identity from seed and explicit descriptor", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const reference = SeedIdentity.fromSeed(seed, { isMainnet: true });

            const identity = new SeedIdentity(seed, reference.descriptor);

            const refPubKey = await reference.xOnlyPublicKey();
            const pubKey = await identity.xOnlyPublicKey();
            expect(Array.from(pubKey)).toEqual(Array.from(refPubKey));
        });

        it("should throw if xpub does not match seed", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            // Use mainnet descriptor with a different seed
            const otherSeed = mnemonicToSeedSync(TEST_MNEMONIC, "different");

            expect(
                () => new SeedIdentity(otherSeed, identity.descriptor)
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

    describe("descriptor", () => {
        it("should include correct coin type for testnet", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: false });
            expect(identity.descriptor).toMatch(/\/86'\/1'\/0'\]/);
        });

        it("should include correct coin type for mainnet", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            expect(identity.descriptor).toMatch(/\/86'\/0'\/0'\]/);
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

        it("should require network selection", () => {
            // @ts-expect-error opts is required
            expect(() =>
                MnemonicIdentity.fromMnemonic(TEST_MNEMONIC)
            ).toThrow();
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
            const withoutPassphrase = MnemonicIdentity.fromMnemonic(
                TEST_MNEMONIC,
                { isMainnet: false }
            );
            const withPassphrase = MnemonicIdentity.fromMnemonic(
                TEST_MNEMONIC,
                { isMainnet: false, passphrase: "secret" }
            );

            const pubKey1 = await withoutPassphrase.xOnlyPublicKey();
            const pubKey2 = await withPassphrase.xOnlyPublicKey();

            expect(Array.from(pubKey1)).not.toEqual(Array.from(pubKey2));
        });

        it("should throw for invalid mnemonic", () => {
            expect(() =>
                MnemonicIdentity.fromMnemonic("invalid mnemonic words here", {
                    isMainnet: false,
                })
            ).toThrow("Invalid mnemonic");
        });

        it("should accept custom descriptor in options", async () => {
            const reference = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });

            const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
                descriptor: reference.descriptor,
            });

            const refPubKey = await reference.xOnlyPublicKey();
            const pubKey = await identity.xOnlyPublicKey();
            expect(Array.from(pubKey)).toEqual(Array.from(refPubKey));
            expect(identity.descriptor).toBe(reference.descriptor);
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
