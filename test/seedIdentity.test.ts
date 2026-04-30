import { describe, it, expect } from "vitest";
import {
    SeedIdentity,
    MnemonicIdentity,
    ReadonlyDescriptorIdentity,
} from "../src/identity/seedIdentity";
import { mnemonicToSeedSync } from "@scure/bip39";
import { schnorr, verifyAsync } from "@noble/secp256k1";
import { pubSchnorr } from "@scure/btc-signer/utils.js";
import { hex } from "@scure/base";
import { HDKey, expand, networks } from "@bitcoinerlab/descriptors-scure";
import { Transaction } from "../src/utils/transaction";

const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

/**
 * Substitute the wildcard in a SeedIdentity's account-descriptor template
 * with a concrete index. Used by tests as a stand-in for what
 * `HDDescriptorProvider` does in production: SeedIdentity itself no
 * longer exposes an index-aware helper because the template is the
 * canonical thing it provides.
 */
function descriptorAtIndex(identity: SeedIdentity, index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
        throw new Error("Derivation index must be an integer in [0, 2^31)");
    }
    return identity.descriptor.replace("/*)", `/${index})`);
}

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

        it("should expose the wildcard template as descriptor", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

            expect(identity.descriptor).toMatch(
                /^tr\(\[[\da-f]{8}\/86'\/0'\/0'\]xpub.+\/0\/\*\)$/
            );
        });

        it("should accept a caller-supplied template in options", async () => {
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

        it("should use the supplied template instead of default BIP86", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const mainnet = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const testnet = SeedIdentity.fromSeed(seed, {
                isMainnet: false,
            });

            // Pass the mainnet template explicitly — should match mainnet, not testnet
            const identity = SeedIdentity.fromSeed(seed, {
                descriptor: mainnet.descriptor,
            });

            const mainnetPubKey = await mainnet.xOnlyPublicKey();
            const testnetPubKey = await testnet.xOnlyPublicKey();
            const pubKey = await identity.xOnlyPublicKey();
            expect(Array.from(pubKey)).toEqual(Array.from(mainnetPubKey));
            expect(Array.from(pubKey)).not.toEqual(Array.from(testnetPubKey));
        });

        it("should reject non-template descriptors at construction", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const reference = SeedIdentity.fromSeed(seed, { isMainnet: true });
            // Materialize the template at index 5 to get a concrete
            // descriptor — must be rejected.
            const concrete = reference.descriptor.replace("/*)", "/5)");
            expect(() =>
                SeedIdentity.fromSeed(seed, { descriptor: concrete })
            ).toThrow(/wildcard descriptor template/);
        });
    });

    describe("constructor", () => {
        it("should create identity from seed and explicit template", async () => {
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
            // Use mainnet template with a different seed
            const otherSeed = mnemonicToSeedSync(TEST_MNEMONIC, "different");

            expect(
                () => new SeedIdentity(otherSeed, identity.descriptor)
            ).toThrow("xpub mismatch");
        });

        it("should throw if descriptor is not a wildcard template", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            // Materialize at index 0 to get a concrete descriptor.
            const concrete = identity.descriptor.replace("/*)", "/0)");
            expect(() => new SeedIdentity(seed, concrete)).toThrow(
                /wildcard descriptor template/
            );
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

        it("should accept a caller-supplied template in options", async () => {
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
        it("should create readonly identity from template", async () => {
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

        it("should reject non-template descriptors", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const concrete = identity.descriptor.replace("/*)", "/0)");
            expect(() =>
                ReadonlyDescriptorIdentity.fromDescriptor(concrete)
            ).toThrow(/wildcard descriptor template/);
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

    describe("HD template support", () => {
        it("exposes the template via getAccountDescriptor and the index-0 form via descriptor", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const template = identity.descriptor;

            const readonly =
                ReadonlyDescriptorIdentity.fromDescriptor(template);
            expect(readonly.descriptor).toBe(template);
            expect(readonly.descriptor).toBe(identity.descriptor);
        });

        it("template input cached pubkey matches the index-0 substitution", async () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const signing = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const readonly = ReadonlyDescriptorIdentity.fromDescriptor(
                signing.descriptor
            );
            const signingPubKey = await signing.xOnlyPublicKey();
            const readonlyPubKey = await readonly.xOnlyPublicKey();
            expect(Array.from(readonlyPubKey)).toEqual(
                Array.from(signingPubKey)
            );
        });

        it("isOurs accepts descriptors from the same xpub at any index", () => {
            const seed = mnemonicToSeedSync(TEST_MNEMONIC);
            const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
            const template = identity.descriptor;
            const readonly =
                ReadonlyDescriptorIdentity.fromDescriptor(template);

            for (const index of [0, 1, 7, 1024]) {
                const concrete = template.replace("/*)", `/${index})`);
                expect(readonly.isOurs(concrete)).toBe(true);
            }
            // The template itself round-trips
            expect(readonly.isOurs(template)).toBe(true);
        });

        it("isOurs rejects descriptors derived from a different seed", () => {
            const ourSeed = mnemonicToSeedSync(TEST_MNEMONIC);
            const ourReadonly = ReadonlyDescriptorIdentity.fromDescriptor(
                SeedIdentity.fromSeed(ourSeed, {
                    isMainnet: true,
                }).descriptor
            );

            const otherSeed = mnemonicToSeedSync(
                "legal winner thank year wave sausage worth useful legal winner thank yellow"
            );
            const otherDescriptor = SeedIdentity.fromSeed(otherSeed, {
                isMainnet: true,
            }).descriptor;
            expect(ourReadonly.isOurs(otherDescriptor)).toBe(false);
        });
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

describe("MnemonicIdentity", () => {
    it("should produce same key as SeedIdentity.fromSeed", async () => {
        const fromMnemonic = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
        });
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const fromSeed = SeedIdentity.fromSeed(seed, { isMainnet: true });

        const pubKey1 = await fromMnemonic.xOnlyPublicKey();
        const pubKey2 = await fromSeed.xOnlyPublicKey();
        expect(Array.from(pubKey1)).toEqual(Array.from(pubKey2));
    });
});

describe("backwards compatibility", () => {
    it("existing signMessage() API still works", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const message = new Uint8Array(32).fill(99);

        const signature = await identity.signMessage(message);
        expect(signature).toBeInstanceOf(Uint8Array);
        expect(signature).toHaveLength(64);
    });
});

// ============================================================
// HD descriptor methods (DescriptorProvider)
// ============================================================

const OTHER_MNEMONIC =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";

/** Derive the x-only pubkey expected at a concrete BIP86 index. */
function expectedXOnlyAtIndex(
    isMainnet: boolean,
    index: number,
    mnemonic: string = TEST_MNEMONIC
): Uint8Array {
    const network = isMainnet ? networks.bitcoin : networks.testnet;
    const seed = mnemonicToSeedSync(mnemonic);
    const master = HDKey.fromMasterSeed(seed, network.bip32);
    const basePath = isMainnet ? "m/86'/0'/0'" : "m/86'/1'/0'";
    const derived = master.derive(basePath).deriveChild(0).deriveChild(index);
    return pubSchnorr(derived.privateKey!);
}

describe("SeedIdentity.descriptor", () => {
    it("is a wildcard template ending in /*)", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

        expect(identity.descriptor).toMatch(
            /^tr\(\[[\da-f]{8}\/86'\/0'\/0'\]xpub.+\/0\/\*\)$/
        );
    });

    it("uses the testnet originPath when identity is testnet", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: false });
        expect(identity.descriptor).toMatch(
            /^tr\(\[[\da-f]{8}\/86'\/1'\/0'\]tpub.+\/0\/\*\)$/
        );
    });
});

describe("Index substitution against the account descriptor template", () => {
    // SeedIdentity is fixed at index 0; concrete-at-index materialization
    // is the consumer's responsibility (HDDescriptorProvider in production,
    // descriptorAtIndex helper in tests). These tests verify the round-trip
    // property holds: a descriptor materialized from the template parses to
    // the expected key when fed back through the descriptors library.
    it("produces a descriptor whose parsed pubkey matches the BIP86 derivation at that index", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

        const derivedDesc = descriptorAtIndex(identity, 7);
        // Sanity: the materialized descriptor parses back to the
        // BIP86-expected pubkey at index 7. We check by re-expanding
        // through the library rather than constructing a new identity
        // (SeedIdentity is index-0-only by design).
        const expansion = expand({
            descriptor: derivedDesc,
            network: networks.bitcoin,
        });
        const actual = expansion.expansionMap?.["@0"]?.pubkey;
        const expected = expectedXOnlyAtIndex(true, 7);
        expect(actual).toBeDefined();
        expect(hex.encode(actual!)).toBe(hex.encode(expected));
    });

    it("round-trips: the template's index-0 form matches the BIP86 derivation at index 0", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const derived = descriptorAtIndex(identity, 0);
        const expected = expectedXOnlyAtIndex(true, 0);
        const actual = expand({
            descriptor: derived,
            network: networks.bitcoin,
        }).expansionMap?.["@0"]?.pubkey;
        expect(actual).toBeDefined();
        expect(hex.encode(actual!)).toBe(hex.encode(expected));
    });
});

describe("SeedIdentity.isOurs", () => {
    it("returns true for the identity's own descriptor", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        expect(identity.isOurs(identity.descriptor)).toBe(true);
    });

    it("returns true for any derived-index descriptor of the same seed", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

        for (const i of [0, 1, 42, 100, 0x7fffffff]) {
            expect(identity.isOurs(descriptorAtIndex(identity, i))).toBe(true);
        }
    });

    it("returns true for the wildcard template", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        expect(identity.isOurs(identity.descriptor)).toBe(true);
    });

    it("returns false for a different seed's descriptor", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

        const otherSeed = mnemonicToSeedSync(OTHER_MNEMONIC);
        const otherIdentity = SeedIdentity.fromSeed(otherSeed, {
            isMainnet: true,
        });
        expect(identity.isOurs(otherIdentity.descriptor)).toBe(false);
    });

    it("returns false for non-descriptor strings", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        expect(identity.isOurs("")).toBe(false);
        expect(identity.isOurs("not-a-descriptor")).toBe(false);
        expect(identity.isOurs("tr()")).toBe(false);
    });

    it("returns false for simple tr(otherPubkey) descriptors", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const foreignPubkey = hex.encode(
            expectedXOnlyAtIndex(true, 0, OTHER_MNEMONIC)
        );
        expect(identity.isOurs(`tr(${foreignPubkey})`)).toBe(false);
    });

    it("treats mainnet and testnet descriptors from the same mnemonic as different", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const mainnet = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const testnet = SeedIdentity.fromSeed(seed, { isMainnet: false });
        // Different coin-type paths produce different account xpubs.
        expect(mainnet.isOurs(testnet.descriptor)).toBe(false);
        expect(testnet.isOurs(mainnet.descriptor)).toBe(false);
    });
});

describe("SeedIdentity.signMessageWithDescriptor", () => {
    it("signs with the key derived from the given descriptor", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const message = new Uint8Array(32).fill(7);

        const descriptor = descriptorAtIndex(identity, 12);
        const signature = await identity.signMessageWithDescriptor(
            descriptor,
            message
        );

        const expectedPub = expectedXOnlyAtIndex(true, 12);
        const ok = await schnorr.verifyAsync(signature, message, expectedPub);
        expect(ok).toBe(true);
    });

    it("supports ECDSA signatures", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const message = new Uint8Array(32).fill(9);

        const descriptor = descriptorAtIndex(identity, 3);
        const signature = await identity.signMessageWithDescriptor(
            descriptor,
            message,
            "ecdsa"
        );
        expect(signature).toBeInstanceOf(Uint8Array);

        // ECDSA verification needs the compressed (33-byte) pubkey
        const network = networks.bitcoin;
        const master = HDKey.fromMasterSeed(seed, network.bip32);
        const node = master.derive("m/86'/0'/0'/0/3");
        const ok = await verifyAsync(signature, message, node.publicKey!, {
            prehash: false,
        });
        expect(ok).toBe(true);
    });

    it("rejects a descriptor that does not belong to this identity", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const other = SeedIdentity.fromSeed(
            mnemonicToSeedSync(OTHER_MNEMONIC),
            {
                isMainnet: true,
            }
        );

        await expect(
            identity.signMessageWithDescriptor(
                other.descriptor,
                new Uint8Array(32)
            )
        ).rejects.toThrow("does not belong to this identity");
    });

    it("rejects wildcard descriptors (must derive a concrete index first)", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

        await expect(
            identity.signMessageWithDescriptor(
                identity.descriptor,
                new Uint8Array(32)
            )
        ).rejects.toThrow("wildcard descriptor");
    });
});

describe("SeedIdentity.signWithDescriptor", () => {
    it("returns a Transaction per request when no inputs need signing", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });

        const tx = new Transaction();
        const result = await identity.signWithDescriptor([
            { tx, descriptor: descriptorAtIndex(identity, 0) },
            { tx, descriptor: descriptorAtIndex(identity, 2) },
        ]);
        expect(result).toHaveLength(2);
        // tx.clone() from @scure/btc-signer returns a BtcSignerTransaction, not
        // our Transaction wrapper — so just check the sign/PSBT API is present.
        expect(typeof result[0].toPSBT).toBe("function");
        // Should be a clone (not the same instance)
        expect(result[0]).not.toBe(tx);
    });

    it("rejects a request whose descriptor is not ours", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const other = SeedIdentity.fromSeed(
            mnemonicToSeedSync(OTHER_MNEMONIC),
            {
                isMainnet: true,
            }
        );

        const tx = new Transaction();
        await expect(
            identity.signWithDescriptor([
                { tx, descriptor: descriptorAtIndex(other, 0) },
            ])
        ).rejects.toThrow("does not belong to this identity");
    });
});

describe("MnemonicIdentity DescriptorProvider", () => {
    it("inherits HD methods and produces matching keys vs SeedIdentity", async () => {
        const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
        });
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const seedIdentity = SeedIdentity.fromSeed(seed, { isMainnet: true });

        expect(identity.descriptor).toBe(seedIdentity.descriptor);
        expect(descriptorAtIndex(identity, 42)).toBe(
            descriptorAtIndex(seedIdentity, 42)
        );
        expect(identity.isOurs(descriptorAtIndex(identity, 99))).toBe(true);
    });
});
