import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { DescriptorIdentity, MnemonicIdentity, SeedIdentity, SingleKey } from "@arkade-os/sdk";
import { expand, networks } from "@bitcoinerlab/descriptors-scure";
import { buildPreimageMessage, derivePreimage } from "../src/utils/preimage";
import vectors from "./fixtures/preimage_vectors.json";

/**
 * Materialize the account template at `index`, the same way
 * `HDDescriptorProvider` does, and pin an identity to it.
 */
const descriptorIdentityAt = (identity: SeedIdentity, index: number): DescriptorIdentity => {
    const template = identity.descriptor;
    const network = template.includes("tpub") ? networks.testnet : networks.bitcoin;
    const keyExpression = expand({ descriptor: template, network, index }).expansionMap?.["@0"]
        ?.keyExpression;
    return new DescriptorIdentity({
        descriptor: `tr(${keyExpression})`,
        signer: identity,
        base: identity,
    });
};

describe("swap preimage derivation", () => {
    const identity = MnemonicIdentity.fromMnemonic(vectors.seed, { isMainnet: false });

    describe("buildPreimageMessage", () => {
        const xonly = new Uint8Array(32).fill(0xab);

        it("is tag ‖ xonly ‖ u32le(index)", () => {
            const message = buildPreimageMessage(xonly, 1);

            expect(message).toHaveLength(24 + 32 + 4);
            expect(new TextDecoder().decode(message.subarray(0, 24))).toBe(
                "Arkade-Boltz-Preimage-v1",
            );
            expect(message.subarray(24, 56)).toEqual(xonly);
            expect(message.subarray(56)).toEqual(new Uint8Array([1, 0, 0, 0]));
        });

        it("rejects a key that is not 32 bytes", () => {
            expect(() => buildPreimageMessage(new Uint8Array(33), 0)).toThrow(/32-byte/);
        });

        it("rejects an index that does not fit a u32", () => {
            expect(() => buildPreimageMessage(xonly, -1)).toThrow(/u32/);
            expect(() => buildPreimageMessage(xonly, 0x1_0000_0000)).toThrow(/u32/);
            expect(() => buildPreimageMessage(xonly, 1.5)).toThrow(/u32/);
        });
    });

    describe("derivePreimage", () => {
        it("is stable across calls", async () => {
            const descriptorIdentity = descriptorIdentityAt(identity, 0);

            const first = await derivePreimage(descriptorIdentity);
            const second = await derivePreimage(descriptorIdentity);

            expect(first).toHaveLength(32);
            expect(second).toEqual(first);
        });

        it("differs per descriptor index", async () => {
            const at0 = await derivePreimage(descriptorIdentityAt(identity, 0));
            const at1 = await derivePreimage(descriptorIdentityAt(identity, 1));

            expect(at1).not.toEqual(at0);
        });

        it("throws rather than falling back for an identity that cannot sign deterministically", async () => {
            await expect(derivePreimage(SingleKey.fromHex("11".repeat(32)))).rejects.toThrow(
                /deterministic/,
            );
        });
    });

    /**
     * Cross-SDK vectors from NArk (`NArk.Tests/Assets/Fixtures/preimage_vectors.json`).
     * A failure here means the scheme diverged and swaps created by one SDK are no
     * longer recoverable by the other.
     */
    describe("NArk cross-SDK vectors", () => {
        for (const [network, { keyIndexed }] of Object.entries(vectors.vectors)) {
            const seedIdentity = MnemonicIdentity.fromMnemonic(vectors.seed, {
                isMainnet: network === "mainnet",
            });
            for (const [keyIndex, entries] of Object.entries(keyIndexed)) {
                const descriptorIdentity = descriptorIdentityAt(seedIdentity, Number(keyIndex));
                for (const entry of entries) {
                    it(`${network} key ${keyIndex} derivation ${entry.derivationIndex}`, async () => {
                        const message = buildPreimageMessage(
                            await descriptorIdentity.xOnlyPublicKey(),
                            entry.derivationIndex,
                        );
                        const preimage = await derivePreimage(
                            descriptorIdentity,
                            entry.derivationIndex,
                        );

                        expect(hex.encode(message)).toBe(entry.expectedPreimageMessage);
                        expect(hex.encode(preimage)).toBe(entry.expectedPreimage);
                    });
                }
            }
        }
    });
});
