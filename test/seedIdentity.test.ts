import { describe, it, expect } from "vitest";
import {
    SeedIdentity,
    MnemonicIdentity,
    ReadonlyDescriptorIdentity,
    ReadonlySeedIdentity,
} from "../src/identity/seedIdentity";
import type { SigningRequest } from "../src/identity/seedIdentity";
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

        it("should default to mainnet when isMainnet is omitted", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const explicit = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const defaulted = SeedIdentity.fromSeed(seed, {});
            expect(defaulted.descriptor).toBe(explicit.descriptor);
            expect(defaulted.descriptor).toMatch(/\/86'\/0'\/0'\]/);
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

        it("should default to mainnet when isMainnet is omitted", async () => {
            const explicit = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const defaulted = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {});

            const explicitPubKey = await explicit.xOnlyPublicKey();
            const defaultedPubKey = await defaulted.xOnlyPublicKey();

            expect(Array.from(defaultedPubKey)).toEqual(
                Array.from(explicitPubKey)
            );
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

    it("should export ReadonlySeedIdentity from identity module", async () => {
        const { ReadonlySeedIdentity } = await import("../src/identity");
        expect(ReadonlySeedIdentity).toBeDefined();
        expect(typeof ReadonlySeedIdentity.fromDescriptor).toBe("function");
    });

    it("should export SigningRequest type from identity module", async () => {
        // SigningRequest is a type, so we just verify it compiles
        const req: SigningRequest = { tx: null as any };
        expect(req).toBeDefined();
    });
});

// ============================================================
// New tests: SeedIdentity HD wallet methods
// ============================================================

describe("SeedIdentity HD methods", () => {
    describe("deriveSigningDescriptor", () => {
        it("should produce a valid descriptor at index 0", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const desc = identity.deriveSigningDescriptor(0);

            expect(desc).toMatch(
                /^tr\(\[[\da-f]{8}\/86'\/0'\/0'\]xpub.+\/0\/0\)$/
            );
        });

        it("should produce a valid descriptor at index 5", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const desc = identity.deriveSigningDescriptor(5);

            expect(desc).toMatch(/\/0\/5\)$/);
        });

        it("should use testnet coin type in descriptor", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: false });
            const desc = identity.deriveSigningDescriptor(0);

            expect(desc).toMatch(/\/86'\/1'\/0'\]/);
            expect(desc).toMatch(/tpub/);
        });

        it("should throw for negative index", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            expect(() => identity.deriveSigningDescriptor(-1)).toThrow(
                "Index must be non-negative"
            );
        });

        it("should produce different descriptors for different indexes", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            const desc0 = identity.deriveSigningDescriptor(0);
            const desc1 = identity.deriveSigningDescriptor(1);
            const desc5 = identity.deriveSigningDescriptor(5);

            expect(desc0).not.toBe(desc1);
            expect(desc0).not.toBe(desc5);
            expect(desc1).not.toBe(desc5);
        });

        it("should match the identity default descriptor at index 0", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const desc = identity.deriveSigningDescriptor(0);

            expect(desc).toBe(identity.descriptor);
        });
    });

    describe("isOurs", () => {
        it("should return true for own descriptor at index 0", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            expect(identity.isOurs(identity.descriptor)).toBe(true);
        });

        it("should return true for own descriptor at any index", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const desc5 = identity.deriveSigningDescriptor(5);
            const desc42 = identity.deriveSigningDescriptor(42);

            expect(identity.isOurs(desc5)).toBe(true);
            expect(identity.isOurs(desc42)).toBe(true);
        });

        it("should return false for a different seed", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            const otherSeed = mnemonicToSeedSync(TEST_MNEMONIC, "different");
            const otherIdentity = SeedIdentity.fromSeed(otherSeed, {
                isMainnet: true,
            });

            expect(identity.isOurs(otherIdentity.descriptor)).toBe(false);
        });

        it("should return false for cross-network descriptor", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const mainnet = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const testnet = SeedIdentity.fromSeed(seed, { isMainnet: false });

            // mainnet identity checking a testnet descriptor
            expect(mainnet.isOurs(testnet.descriptor)).toBe(false);
        });

        it("should return false for invalid format", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            expect(identity.isOurs("invalid")).toBe(false);
            expect(identity.isOurs("")).toBe(false);
        });
    });

    describe("signMessageWithDescriptor", () => {
        it("should sign a message via descriptor at index 0", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const desc0 = identity.deriveSigningDescriptor(0);
            const message = new Uint8Array(32).fill(42);

            const signature = await identity.signMessageWithDescriptor(
                desc0,
                message,
                "schnorr"
            );
            expect(signature).toBeInstanceOf(Uint8Array);
            expect(signature).toHaveLength(64);

            // Verify the signature against the public key at index 0
            const pubKey = await identity.xOnlyPublicKey();
            const isValid = await schnorr.verifyAsync(
                signature,
                message,
                pubKey
            );
            expect(isValid).toBe(true);
        });

        it("should throw for a foreign descriptor", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            const otherSeed = mnemonicToSeedSync(TEST_MNEMONIC, "other");
            const otherIdentity = SeedIdentity.fromSeed(otherSeed, {
                isMainnet: true,
            });

            const message = new Uint8Array(32).fill(42);
            await expect(
                identity.signMessageWithDescriptor(
                    otherIdentity.descriptor,
                    message
                )
            ).rejects.toThrow("Descriptor does not belong to this identity");
        });

        it("should produce different signatures for different indexes", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const message = new Uint8Array(32).fill(42);

            const desc0 = identity.deriveSigningDescriptor(0);
            const desc5 = identity.deriveSigningDescriptor(5);

            const sig0 = await identity.signMessageWithDescriptor(
                desc0,
                message,
                "schnorr"
            );
            const sig5 = await identity.signMessageWithDescriptor(
                desc5,
                message,
                "schnorr"
            );

            expect(Array.from(sig0)).not.toEqual(Array.from(sig5));
        });
    });

    describe("signWithDescriptor", () => {
        it("should throw for a foreign descriptor", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            const otherSeed = mnemonicToSeedSync(TEST_MNEMONIC, "other");
            const otherIdentity = SeedIdentity.fromSeed(otherSeed, {
                isMainnet: true,
            });

            await expect(
                identity.signWithDescriptor([
                    { descriptor: otherIdentity.descriptor, tx: null as any },
                ])
            ).rejects.toThrow("Descriptor does not belong to this identity");
        });

        it("should handle empty requests array", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            const results = await identity.signWithDescriptor([]);
            expect(results).toEqual([]);
        });
    });

    describe("isMainnet", () => {
        it("should be true for mainnet identity", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            expect(identity.isMainnet).toBe(true);
        });

        it("should be false for testnet identity", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: false });
            expect(identity.isMainnet).toBe(false);
        });
    });
});

// ============================================================
// New tests: SeedIdentity serialization
// ============================================================

describe("SeedIdentity serialization", () => {
    describe("toJSON", () => {
        it("should include mnemonic when created via fromMnemonic", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const json = identity.toJSON();

            expect(json.mnemonic).toBe(TEST_MNEMONIC);
            expect(json.seed).toBeUndefined();
            expect(json.descriptor).toBeDefined();
        });

        it("should include seed hex when created via fromSeed", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const json = identity.toJSON();

            expect(json.mnemonic).toBeUndefined();
            expect(json.seed).toBe(hex.encode(seed));
            expect(json.descriptor).toBeDefined();
        });

        it("should produce a wildcard descriptor with /0/*", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const json = identity.toJSON();

            expect(json.descriptor).toMatch(/\/0\/\*\)$/);
        });
    });

    describe("fromJSON", () => {
        it("should restore from mnemonic JSON", async () => {
            const original = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const json = original.toJSON();
            const restored = SeedIdentity.fromJSON(json);

            const origPubKey = await original.xOnlyPublicKey();
            const restoredPubKey = await restored.xOnlyPublicKey();
            expect(Array.from(restoredPubKey)).toEqual(Array.from(origPubKey));
            expect(restored.mnemonic).toBe(TEST_MNEMONIC);
        });

        it("should restore from seed JSON", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const original = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const json = original.toJSON();
            const restored = SeedIdentity.fromJSON(json);

            const origPubKey = await original.xOnlyPublicKey();
            const restoredPubKey = await restored.xOnlyPublicKey();
            expect(Array.from(restoredPubKey)).toEqual(Array.from(origPubKey));
            expect(restored.mnemonic).toBeUndefined();
        });

        it("should infer mainnet from descriptor coin type", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const mainnet = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const testnet = SeedIdentity.fromSeed(seed, { isMainnet: false });

            const restoredMainnet = SeedIdentity.fromJSON(mainnet.toJSON());
            const restoredTestnet = SeedIdentity.fromJSON(testnet.toJSON());

            expect(restoredMainnet.isMainnet).toBe(true);
            expect(restoredTestnet.isMainnet).toBe(false);
        });

        it("should throw on xpub mismatch", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const json = identity.toJSON();
            // Use a different seed to cause mismatch
            const otherSeed = mnemonicToSeedSync(TEST_MNEMONIC, "different");
            json.seed = hex.encode(otherSeed);
            delete (json as any).mnemonic;

            expect(() => SeedIdentity.fromJSON(json)).toThrow("xpub mismatch");
        });

        it("should throw on missing mnemonic and seed", () => {
            expect(() =>
                SeedIdentity.fromJSON({ descriptor: "tr(xpub.../0/0)" } as any)
            ).toThrow("JSON must contain either mnemonic or seed");
        });
    });

    describe("SeedIdentity.fromMnemonic", () => {
        it("should store the mnemonic on the identity", () => {
            const identity = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            expect(identity.mnemonic).toBe(TEST_MNEMONIC);
        });

        it("should produce same key as MnemonicIdentity.fromMnemonic", async () => {
            const fromSeed = SeedIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });
            const fromMnemonic = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
                isMainnet: true,
            });

            const pubKey1 = await fromSeed.xOnlyPublicKey();
            const pubKey2 = await fromMnemonic.xOnlyPublicKey();
            expect(Array.from(pubKey1)).toEqual(Array.from(pubKey2));
        });

        it("should throw for invalid mnemonic", () => {
            expect(() =>
                SeedIdentity.fromMnemonic("invalid mnemonic words here", {
                    isMainnet: false,
                })
            ).toThrow("Invalid mnemonic");
        });
    });
});

// ============================================================
// New tests: ReadonlySeedIdentity
// ============================================================

describe("ReadonlySeedIdentity", () => {
    describe("fromDescriptor", () => {
        it("should create identity from descriptor", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            const readonly = ReadonlySeedIdentity.fromDescriptor(
                identity.descriptor
            );

            const identityPubKey = await identity.xOnlyPublicKey();
            const readonlyPubKey = await readonly.xOnlyPublicKey();
            expect(Array.from(readonlyPubKey)).toEqual(
                Array.from(identityPubKey)
            );
        });
    });

    describe("fromJSON / toJSON", () => {
        it("should serialize and restore via JSON", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const original = ReadonlySeedIdentity.fromDescriptor(
                identity.descriptor
            );
            const json = original.toJSON();
            expect(json.descriptor).toBeDefined();

            // The serialized descriptor should have wildcard
            expect(json.descriptor).toMatch(/\/0\/\*\)$/);

            // Restore from JSON — wildcard gets resolved to index 0
            const restored = ReadonlySeedIdentity.fromJSON(json);
            const origPubKey = await original.xOnlyPublicKey();
            const restoredPubKey = await restored.xOnlyPublicKey();
            expect(Array.from(restoredPubKey)).toEqual(Array.from(origPubKey));
        });
    });

    describe("deriveSigningDescriptor", () => {
        it("should match SeedIdentity deriveSigningDescriptor", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = ReadonlySeedIdentity.fromDescriptor(
                identity.descriptor
            );

            const fullDesc = identity.deriveSigningDescriptor(3);
            const readonlyDesc = readonly.deriveSigningDescriptor(3);
            expect(readonlyDesc).toBe(fullDesc);
        });

        it("should produce descriptor at index 0 matching the identity descriptor", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = ReadonlySeedIdentity.fromDescriptor(
                identity.descriptor
            );

            expect(readonly.deriveSigningDescriptor(0)).toBe(
                identity.descriptor
            );
        });

        it("should throw for negative index", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = ReadonlySeedIdentity.fromDescriptor(
                identity.descriptor
            );

            expect(() => readonly.deriveSigningDescriptor(-1)).toThrow(
                "Index must be non-negative"
            );
        });
    });

    describe("isOurs", () => {
        it("should return true for own descriptors", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = ReadonlySeedIdentity.fromDescriptor(
                identity.descriptor
            );

            expect(readonly.isOurs(identity.descriptor)).toBe(true);
            expect(readonly.isOurs(identity.deriveSigningDescriptor(5))).toBe(
                true
            );
        });

        it("should return false for foreign descriptors", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = ReadonlySeedIdentity.fromDescriptor(
                identity.descriptor
            );

            const otherSeed = mnemonicToSeedSync(TEST_MNEMONIC, "other");
            const other = SeedIdentity.fromSeed(otherSeed, {
                isMainnet: true,
            });
            expect(readonly.isOurs(other.descriptor)).toBe(false);
        });

        it("should return false for invalid descriptor", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = ReadonlySeedIdentity.fromDescriptor(
                identity.descriptor
            );

            expect(readonly.isOurs("invalid")).toBe(false);
        });
    });

    describe("xOnlyPublicKeyAtIndex", () => {
        it("should return 32-byte key at index 0 matching xOnlyPublicKey", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = ReadonlySeedIdentity.fromDescriptor(
                identity.descriptor
            );

            const pubKey = await readonly.xOnlyPublicKeyAtIndex(0);
            const defaultPubKey = await readonly.xOnlyPublicKey();
            expect(pubKey).toHaveLength(32);
            expect(Array.from(pubKey)).toEqual(Array.from(defaultPubKey));
        });

        it("should return different keys for different indexes", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = ReadonlySeedIdentity.fromDescriptor(
                identity.descriptor
            );

            const pubKey0 = await readonly.xOnlyPublicKeyAtIndex(0);
            const pubKey5 = await readonly.xOnlyPublicKeyAtIndex(5);
            expect(Array.from(pubKey0)).not.toEqual(Array.from(pubKey5));
        });
    });

    describe("compressedPublicKeyAtIndex", () => {
        it("should return 33-byte key at index 0 matching compressedPublicKey", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = ReadonlySeedIdentity.fromDescriptor(
                identity.descriptor
            );

            const pubKey = await readonly.compressedPublicKeyAtIndex(0);
            const defaultPubKey = await readonly.compressedPublicKey();
            expect(pubKey).toHaveLength(33);
            expect(Array.from(pubKey)).toEqual(Array.from(defaultPubKey));
        });

        it("should return different keys for different indexes", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = ReadonlySeedIdentity.fromDescriptor(
                identity.descriptor
            );

            const pubKey0 = await readonly.compressedPublicKeyAtIndex(0);
            const pubKey5 = await readonly.compressedPublicKeyAtIndex(5);
            expect(Array.from(pubKey0)).not.toEqual(Array.from(pubKey5));
        });
    });
});

// ============================================================
// Backwards compatibility
// ============================================================

describe("backwards compatibility", () => {
    it("xOnlyPublicKey() should match deriveSigningDescriptor(0) key", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const desc0 = identity.deriveSigningDescriptor(0);

        // The default xOnlyPublicKey is the key at index 0
        expect(desc0).toBe(identity.descriptor);

        const defaultPubKey = await identity.xOnlyPublicKey();

        // Create a readonly from desc0 and compare
        const readonly0 = ReadonlySeedIdentity.fromDescriptor(desc0);
        const pubKeyFromDesc = await readonly0.xOnlyPublicKey();
        expect(Array.from(pubKeyFromDesc)).toEqual(Array.from(defaultPubKey));
    });

    it("existing sign() API still works", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const message = new Uint8Array(32).fill(99);

        const signature = await identity.signMessage(message);
        expect(signature).toBeInstanceOf(Uint8Array);
        expect(signature).toHaveLength(64);
    });

    it("ReadonlyDescriptorIdentity alias still works", () => {
        expect(ReadonlyDescriptorIdentity).toBe(ReadonlySeedIdentity);
    });

    it("ReadonlyDescriptorIdentity alias is available from identity module", async () => {
        const { ReadonlyDescriptorIdentity, ReadonlySeedIdentity } =
            await import("../src/identity");
        expect(ReadonlyDescriptorIdentity).toBe(ReadonlySeedIdentity);
    });
});
