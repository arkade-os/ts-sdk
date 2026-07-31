import { describe, it, expect } from "vitest";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey, networks } from "@bitcoinerlab/descriptors-scure";
import { hex } from "@scure/base";
import { schnorr } from "@noble/secp256k1";
import { MnemonicIdentity } from "../src/identity/seedIdentity";
import {
    DescriptorIdentity,
    isHDDeterministicSignCapable,
} from "../src/identity/descriptorIdentity";
import { deriveDescriptorLeafCompressedPubKey } from "../src/identity/descriptor";
import { isBatchSignable } from "../src/identity";
import { isHDCapableIdentity } from "../src/identity/hdCapableIdentity";

const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const identity = MnemonicIdentity.fromMnemonic(TEST_MNEMONIC, { isMainnet: false });
const descriptorAt = (index: number) => identity.descriptor.replace("/*)", `/${index})`);

/** The key the descriptor's index resolves to, straight from the seed. */
function seedKeyAt(index: number): { privateKey: Uint8Array; publicKey: Uint8Array } {
    const master = HDKey.fromMasterSeed(mnemonicToSeedSync(TEST_MNEMONIC), networks.testnet.bip32);
    const node = master.derive(`m/86'/1'/0'/0/${index}`);
    return { privateKey: node.privateKey!, publicKey: node.publicKey! };
}

describe("deriveDescriptorLeafCompressedPubKey", () => {
    it("matches the seed-derived compressed key at a rotated index", () => {
        expect(hex.encode(deriveDescriptorLeafCompressedPubKey(descriptorAt(7)))).toBe(
            hex.encode(seedKeyAt(7).publicKey),
        );
    });

    it("rejects a bare tr(xonly) descriptor rather than guessing parity", () => {
        const xonly = hex.encode(seedKeyAt(0).publicKey.subarray(1));
        expect(() => deriveDescriptorLeafCompressedPubKey(`tr(${xonly})`)).toThrow(
            /parity is unrecoverable/,
        );
    });
});

describe("DescriptorIdentity", () => {
    const at = (index: number) =>
        new DescriptorIdentity({
            descriptor: descriptorAt(index),
            signer: identity,
            base: identity,
        });

    it("exposes the descriptor's keys, not the baseline identity's", async () => {
        const adapter = at(3);
        expect(hex.encode(await adapter.compressedPublicKey())).toBe(
            hex.encode(seedKeyAt(3).publicKey),
        );
        expect(hex.encode(await adapter.xOnlyPublicKey())).toBe(
            hex.encode(seedKeyAt(3).publicKey.subarray(1)),
        );
        expect(hex.encode(await adapter.compressedPublicKey())).not.toBe(
            hex.encode(await identity.compressedPublicKey()),
        );
    });

    it("index 0 is the baseline identity key", async () => {
        expect(hex.encode(await at(0).compressedPublicKey())).toBe(
            hex.encode(await identity.compressedPublicKey()),
        );
    });

    it("signs messages with the descriptor key", async () => {
        const adapter = at(5);
        const message = new Uint8Array(32).fill(9);
        const signature = await adapter.signMessage(message, "schnorr");
        expect(await schnorr.verifyAsync(signature, message, await adapter.xOnlyPublicKey())).toBe(
            true,
        );
    });

    it("signs deterministically with the descriptor key", async () => {
        const adapter = at(5);
        const hash = new Uint8Array(32).fill(4);
        const first = await adapter.signSchnorrDeterministic(hash);
        const second = await adapter.signSchnorrDeterministic(hash);
        expect(hex.encode(first)).toBe(hex.encode(second));
        expect(await schnorr.verifyAsync(first, hash, await adapter.xOnlyPublicKey())).toBe(true);
        expect(hex.encode(first)).not.toBe(hex.encode(await at(0).signSchnorrDeterministic(hash)));
    });

    it("matches a raw BIP-340 signature with aux_rand = 0", async () => {
        const hash = new Uint8Array(32).fill(1);
        const expected = await schnorr.signAsync(hash, seedKeyAt(2).privateKey, new Uint8Array(32));
        expect(hex.encode(await at(2).signSchnorrDeterministic(hash))).toBe(hex.encode(expected));
    });

    it("passes the deterministic-signing probe, fails the HD-root probes", () => {
        const adapter = at(1);
        expect(isHDDeterministicSignCapable(adapter)).toBe(false);
        expect(typeof adapter.signSchnorrDeterministic).toBe("function");
        expect(isBatchSignable(adapter)).toBe(false);
        expect(isHDCapableIdentity(adapter)).toBe(false);
        expect("toReadonly" in adapter).toBe(false);
    });

    it("throws when the base identity cannot sign deterministically", async () => {
        const adapter = new DescriptorIdentity({
            descriptor: descriptorAt(1),
            signer: identity,
            base: { ...identity, signSchnorrDeterministicWithDescriptor: undefined } as any,
        });
        await expect(adapter.signSchnorrDeterministic(new Uint8Array(32))).rejects.toThrow(
            /cannot sign deterministically/,
        );
    });

    it("refuses a descriptor from another seed", async () => {
        const foreign = MnemonicIdentity.fromMnemonic(
            "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
            { isMainnet: false },
        );
        const adapter = new DescriptorIdentity({
            descriptor: foreign.descriptor.replace("/*)", "/0)"),
            signer: identity,
            base: identity,
        });
        await expect(adapter.signMessage(new Uint8Array(32))).rejects.toThrow(
            /does not belong to this identity/,
        );
    });
});
