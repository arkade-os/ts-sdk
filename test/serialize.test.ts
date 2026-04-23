import { describe, it, expect, vi, afterEach } from "vitest";
import { hex } from "@scure/base";
import { mnemonicToSeedSync } from "@scure/bip39";
import { SingleKey, ReadonlySingleKey } from "../src/identity/singleKey";
import {
    SeedIdentity,
    MnemonicIdentity,
    ReadonlyDescriptorIdentity,
} from "../src/identity/seedIdentity";
import {
    serializeSigningIdentity,
    serializeReadonlyIdentity,
    hydrateIdentity,
    normalizeSerializedIdentity,
    toWireSerializedIdentity,
    isSigningSerialized,
    type SerializedSigningIdentity,
    type SerializedReadonlyIdentity,
} from "../src/identity/serialize";

const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_PRIVATE_KEY_HEX =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

afterEach(() => {
    vi.restoreAllMocks();
});

describe("serializeSigningIdentity", () => {
    it("produces a single-key envelope for SingleKey", () => {
        const identity = SingleKey.fromHex(TEST_PRIVATE_KEY_HEX);
        const envelope = serializeSigningIdentity(identity);
        expect(envelope).toEqual({
            type: "single-key",
            privateKey: TEST_PRIVATE_KEY_HEX,
        });
        expect(isSigningSerialized(envelope)).toBe(true);
    });

    it("produces a seed envelope for SeedIdentity", () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const envelope = serializeSigningIdentity(identity);
        expect(envelope.type).toBe("seed");
        if (envelope.type !== "seed") throw new Error("unreachable");
        expect(envelope.seed).toBe(hex.encode(seed));
        expect(envelope.descriptor).toBe(identity.descriptor);
    });

    it("produces a mnemonic envelope for MnemonicIdentity", () => {
        const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
        });
        const envelope = serializeSigningIdentity(identity);
        expect(envelope.type).toBe("mnemonic");
        if (envelope.type !== "mnemonic") throw new Error("unreachable");
        expect(envelope.mnemonic).toBe(TEST_MNEMONIC);
        expect(envelope.descriptor).toBe(identity.descriptor);
        expect(envelope.passphrase).toBeUndefined();
    });

    it("includes passphrase in the mnemonic envelope when set", () => {
        const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
            passphrase: "correct horse battery staple",
        });
        const envelope = serializeSigningIdentity(identity);
        if (envelope.type !== "mnemonic") throw new Error("unreachable");
        expect(envelope.passphrase).toBe("correct horse battery staple");
    });

    it("falls back to toHex() for custom SingleKey-like identities", () => {
        const custom = {
            toHex: () => TEST_PRIVATE_KEY_HEX,
            // stub the rest of Identity — unused by serializeSigningIdentity
            xOnlyPublicKey: async () => new Uint8Array(32),
            compressedPublicKey: async () => new Uint8Array(33),
            sign: async () => {
                throw new Error("unused");
            },
            signMessage: async () => new Uint8Array(64),
            signerSession: () => {
                throw new Error("unused");
            },
        } as unknown as Parameters<typeof serializeSigningIdentity>[0];
        expect(serializeSigningIdentity(custom)).toEqual({
            type: "single-key",
            privateKey: TEST_PRIVATE_KEY_HEX,
        });
    });

    it("throws for a signing identity with neither instanceof nor toHex", () => {
        const opaque = {
            xOnlyPublicKey: async () => new Uint8Array(32),
            compressedPublicKey: async () => new Uint8Array(33),
            sign: async () => {
                throw new Error("unused");
            },
            signMessage: async () => new Uint8Array(64),
            signerSession: () => {
                throw new Error("unused");
            },
        } as unknown as Parameters<typeof serializeSigningIdentity>[0];
        expect(() => serializeSigningIdentity(opaque)).toThrow(
            /Unsupported signing identity/
        );
    });
});

describe("serializeReadonlyIdentity", () => {
    it("produces a readonly-single-key envelope for ReadonlySingleKey", async () => {
        const signing = SingleKey.fromHex(TEST_PRIVATE_KEY_HEX);
        const readonly = await signing.toReadonly();
        const envelope = await serializeReadonlyIdentity(readonly);
        expect(envelope.type).toBe("readonly-single-key");
        if (envelope.type !== "readonly-single-key")
            throw new Error("unreachable");
        expect(envelope.publicKey).toBe(
            hex.encode(await readonly.compressedPublicKey())
        );
        expect(isSigningSerialized(envelope)).toBe(false);
    });

    it("downgrades a signing SingleKey to a readonly-single-key envelope", async () => {
        const signing = SingleKey.fromHex(TEST_PRIVATE_KEY_HEX);
        const envelope = await serializeReadonlyIdentity(signing);
        expect(envelope.type).toBe("readonly-single-key");
        if (envelope.type !== "readonly-single-key")
            throw new Error("unreachable");
        expect(envelope.publicKey).toBe(
            hex.encode(await signing.compressedPublicKey())
        );
        expect(JSON.stringify(envelope)).not.toContain(TEST_PRIVATE_KEY_HEX);
    });

    it("produces a readonly-descriptor envelope for SeedIdentity", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const identity = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const envelope = await serializeReadonlyIdentity(identity);
        expect(envelope).toEqual({
            type: "readonly-descriptor",
            descriptor: identity.descriptor,
        });
        expect(JSON.stringify(envelope)).not.toContain(hex.encode(seed));
    });

    it("produces a readonly-descriptor envelope for MnemonicIdentity without phrase", async () => {
        const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
            passphrase: "extra secret",
        });
        const envelope = await serializeReadonlyIdentity(identity);
        expect(envelope).toEqual({
            type: "readonly-descriptor",
            descriptor: identity.descriptor,
        });
        const serialized = JSON.stringify(envelope);
        expect(serialized).not.toContain("abandon");
        expect(serialized).not.toContain("extra secret");
    });

    it("produces a readonly-descriptor envelope for ReadonlyDescriptorIdentity", async () => {
        const mnemonic = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
        });
        const readonly = ReadonlyDescriptorIdentity.fromDescriptor(
            mnemonic.descriptor
        );
        const envelope = await serializeReadonlyIdentity(readonly);
        expect(envelope).toEqual({
            type: "readonly-descriptor",
            descriptor: mnemonic.descriptor,
        });
    });
});

describe("hydrateIdentity round-trip", () => {
    it("SingleKey -> single-key -> SingleKey preserves xOnlyPublicKey", async () => {
        const original = SingleKey.fromHex(TEST_PRIVATE_KEY_HEX);
        const rehydrated = hydrateIdentity(serializeSigningIdentity(original));
        expect(rehydrated).toBeInstanceOf(SingleKey);
        expect(Array.from(await rehydrated.xOnlyPublicKey())).toEqual(
            Array.from(await original.xOnlyPublicKey())
        );
    });

    it("SingleKey produces equal signMessage output after round-trip", async () => {
        const original = SingleKey.fromHex(TEST_PRIVATE_KEY_HEX);
        const rehydrated = hydrateIdentity(
            serializeSigningIdentity(original)
        ) as SingleKey;
        const message = new Uint8Array(32).fill(7);
        const [sigA, sigB] = await Promise.all([
            original.signMessage(message, "ecdsa"),
            rehydrated.signMessage(message, "ecdsa"),
        ]);
        expect(Array.from(sigA)).toEqual(Array.from(sigB));
    });

    it("ReadonlySingleKey -> readonly-single-key -> ReadonlySingleKey preserves pubkey", async () => {
        const signing = SingleKey.fromHex(TEST_PRIVATE_KEY_HEX);
        const original = await signing.toReadonly();
        const rehydrated = hydrateIdentity(
            await serializeReadonlyIdentity(original)
        );
        expect(rehydrated).toBeInstanceOf(ReadonlySingleKey);
        expect(Array.from(await rehydrated.xOnlyPublicKey())).toEqual(
            Array.from(await original.xOnlyPublicKey())
        );
    });

    it("SeedIdentity -> seed -> SeedIdentity preserves keys and descriptor", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const original = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const rehydrated = hydrateIdentity(
            serializeSigningIdentity(original)
        ) as SeedIdentity;
        expect(rehydrated).toBeInstanceOf(SeedIdentity);
        expect(rehydrated.descriptor).toBe(original.descriptor);
        expect(Array.from(await rehydrated.xOnlyPublicKey())).toEqual(
            Array.from(await original.xOnlyPublicKey())
        );
        const message = new Uint8Array(32).fill(11);
        expect(
            Array.from(await rehydrated.signMessage(message, "ecdsa"))
        ).toEqual(Array.from(await original.signMessage(message, "ecdsa")));
    });

    it("MnemonicIdentity -> mnemonic -> MnemonicIdentity preserves class and keys", async () => {
        const original = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
        });
        const rehydrated = hydrateIdentity(
            serializeSigningIdentity(original)
        ) as MnemonicIdentity;
        expect(rehydrated).toBeInstanceOf(MnemonicIdentity);
        expect(rehydrated.mnemonic).toBe(TEST_MNEMONIC);
        expect(rehydrated.passphrase).toBeUndefined();
        expect(rehydrated.descriptor).toBe(original.descriptor);
        expect(Array.from(await rehydrated.xOnlyPublicKey())).toEqual(
            Array.from(await original.xOnlyPublicKey())
        );
    });

    it("MnemonicIdentity with passphrase round-trips correctly", async () => {
        const passphrase = "extra secret";
        const original = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: true,
            passphrase,
        });
        const rehydrated = hydrateIdentity(
            serializeSigningIdentity(original)
        ) as MnemonicIdentity;
        expect(rehydrated.passphrase).toBe(passphrase);
        expect(Array.from(await rehydrated.xOnlyPublicKey())).toEqual(
            Array.from(await original.xOnlyPublicKey())
        );
    });

    it("MnemonicIdentity with custom descriptor preserves the descriptor", async () => {
        const testnetReference = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            isMainnet: false,
        });
        const original = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, {
            descriptor: testnetReference.descriptor,
        });
        const rehydrated = hydrateIdentity(
            serializeSigningIdentity(original)
        ) as MnemonicIdentity;
        expect(rehydrated.descriptor).toBe(testnetReference.descriptor);
        expect(Array.from(await rehydrated.xOnlyPublicKey())).toEqual(
            Array.from(await testnetReference.xOnlyPublicKey())
        );
    });

    it("SeedIdentity through readonly downgrade produces ReadonlyDescriptorIdentity", async () => {
        const seed = mnemonicToSeedSync(TEST_MNEMONIC);
        const signing = SeedIdentity.fromSeed(seed, { isMainnet: true });
        const envelope = await serializeReadonlyIdentity(signing);
        const rehydrated = hydrateIdentity(envelope);
        expect(rehydrated).toBeInstanceOf(ReadonlyDescriptorIdentity);
        expect(Array.from(await rehydrated.xOnlyPublicKey())).toEqual(
            Array.from(await signing.xOnlyPublicKey())
        );
    });
});

describe("normalizeSerializedIdentity", () => {
    it("returns tagged envelopes unchanged", () => {
        const tagged: SerializedSigningIdentity = {
            type: "single-key",
            privateKey: TEST_PRIVATE_KEY_HEX,
        };
        expect(normalizeSerializedIdentity(tagged)).toBe(tagged);
    });

    it("maps legacy { privateKey } to a single-key envelope", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const normalized = normalizeSerializedIdentity({
            privateKey: TEST_PRIVATE_KEY_HEX,
        });
        expect(normalized).toEqual({
            type: "single-key",
            privateKey: TEST_PRIVATE_KEY_HEX,
        });
        expect(warn).toHaveBeenCalled();
    });

    it("maps legacy { publicKey } to a readonly-single-key envelope", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const publicKey = hex.encode(new Uint8Array(33).fill(0x02));
        expect(normalizeSerializedIdentity({ publicKey })).toEqual({
            type: "readonly-single-key",
            publicKey,
        });
    });

    it("maps legacy envelopes to hydrate-compatible output", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const legacyReadonly: SerializedReadonlyIdentity =
            normalizeSerializedIdentity({
                publicKey: hex.encode(
                    await SingleKey.fromHex(
                        TEST_PRIVATE_KEY_HEX
                    ).compressedPublicKey()
                ),
            }) as SerializedReadonlyIdentity;
        const rehydrated = hydrateIdentity(legacyReadonly);
        expect(rehydrated).toBeInstanceOf(ReadonlySingleKey);
    });
});

describe("toWireSerializedIdentity", () => {
    it("downgrades single-key to legacy { privateKey }", () => {
        const wire = toWireSerializedIdentity({
            type: "single-key",
            privateKey: TEST_PRIVATE_KEY_HEX,
        });
        expect(wire).toEqual({ privateKey: TEST_PRIVATE_KEY_HEX });
        expect(wire).not.toHaveProperty("type");
    });

    it("downgrades readonly-single-key to legacy { publicKey }", () => {
        const publicKey = hex.encode(new Uint8Array(33).fill(0x02));
        const wire = toWireSerializedIdentity({
            type: "readonly-single-key",
            publicKey,
        });
        expect(wire).toEqual({ publicKey });
        expect(wire).not.toHaveProperty("type");
    });

    it("passes seed envelopes through unchanged", () => {
        const envelope: SerializedSigningIdentity = {
            type: "seed",
            seed: hex.encode(mnemonicToSeedSync(TEST_MNEMONIC)),
            descriptor: "tr([00000000/86'/0'/0']xpub.../0/0)",
        };
        expect(toWireSerializedIdentity(envelope)).toBe(envelope);
    });

    it("passes mnemonic envelopes through unchanged", () => {
        const envelope: SerializedSigningIdentity = {
            type: "mnemonic",
            mnemonic: TEST_MNEMONIC,
            descriptor: "tr([00000000/86'/0'/0']xpub.../0/0)",
            passphrase: "secret",
        };
        expect(toWireSerializedIdentity(envelope)).toBe(envelope);
    });

    it("passes readonly-descriptor envelopes through unchanged", () => {
        const envelope: SerializedReadonlyIdentity = {
            type: "readonly-descriptor",
            descriptor: "tr([00000000/86'/0'/0']xpub.../0/0)",
        };
        expect(toWireSerializedIdentity(envelope)).toBe(envelope);
    });

    it("serialize -> toWire -> normalize -> hydrate round-trips a SingleKey", async () => {
        const original = SingleKey.fromHex(TEST_PRIVATE_KEY_HEX);
        const wire = toWireSerializedIdentity(
            serializeSigningIdentity(original)
        );
        const rehydrated = hydrateIdentity(normalizeSerializedIdentity(wire));
        expect(rehydrated).toBeInstanceOf(SingleKey);
        expect(Array.from(await rehydrated.xOnlyPublicKey())).toEqual(
            Array.from(await original.xOnlyPublicKey())
        );
    });

    it("serialize -> toWire -> normalize -> hydrate round-trips a ReadonlySingleKey", async () => {
        const signing = SingleKey.fromHex(TEST_PRIVATE_KEY_HEX);
        const original = await signing.toReadonly();
        const wire = toWireSerializedIdentity(
            await serializeReadonlyIdentity(original)
        );
        const rehydrated = hydrateIdentity(normalizeSerializedIdentity(wire));
        expect(rehydrated).toBeInstanceOf(ReadonlySingleKey);
        expect(Array.from(await rehydrated.xOnlyPublicKey())).toEqual(
            Array.from(await original.xOnlyPublicKey())
        );
    });
});

describe("isSigningSerialized", () => {
    it("true for signing envelopes", () => {
        expect(
            isSigningSerialized({
                type: "single-key",
                privateKey: TEST_PRIVATE_KEY_HEX,
            })
        ).toBe(true);
        expect(
            isSigningSerialized({
                type: "seed",
                seed: hex.encode(mnemonicToSeedSync(TEST_MNEMONIC)),
                descriptor: "irrelevant-for-guard",
            })
        ).toBe(true);
        expect(
            isSigningSerialized({
                type: "mnemonic",
                mnemonic: TEST_MNEMONIC,
                descriptor: "irrelevant-for-guard",
            })
        ).toBe(true);
    });

    it("false for readonly envelopes", () => {
        expect(
            isSigningSerialized({
                type: "readonly-single-key",
                publicKey: hex.encode(new Uint8Array(33)),
            })
        ).toBe(false);
        expect(
            isSigningSerialized({
                type: "readonly-descriptor",
                descriptor: "irrelevant-for-guard",
            })
        ).toBe(false);
    });
});
