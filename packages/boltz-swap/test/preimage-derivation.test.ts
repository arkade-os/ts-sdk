import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { MnemonicIdentity, SingleKey, isDeterministicSignCapable } from "@arkade-os/sdk";
import { buildPreimageMessage, derivePreimage, PREIMAGE_TAG } from "../src/utils/preimage";
import vectors from "./fixtures/preimage_vectors.json";

const MNEMONIC = vectors.seed;

describe("buildPreimageMessage", () => {
    it("tag encodes to expected utf-8 hex", () => {
        const tagHex = hex.encode(new TextEncoder().encode(PREIMAGE_TAG));
        expect(tagHex).toBe("41726b6164652d426f6c747a2d507265696d6167652d7631");
    });

    it("total length is 60 bytes (tag=24 + xonly=32 + index=4)", () => {
        expect(buildPreimageMessage(new Uint8Array(32), 0).length).toBe(60);
    });

    it("encodes index as u32 little-endian", () => {
        const xonly = new Uint8Array(32);
        expect(hex.encode(buildPreimageMessage(xonly, 0).slice(-4))).toBe("00000000");
        expect(hex.encode(buildPreimageMessage(xonly, 1).slice(-4))).toBe("01000000");
        expect(hex.encode(buildPreimageMessage(xonly, 42).slice(-4))).toBe("2a000000");
        expect(hex.encode(buildPreimageMessage(xonly, 999).slice(-4))).toBe("e7030000");
    });
});

describe("isDeterministicSignCapable", () => {
    it("is true for SingleKey", () => {
        expect(isDeterministicSignCapable(SingleKey.fromRandomBytes())).toBe(true);
    });

    it("is true for MnemonicIdentity", () => {
        expect(isDeterministicSignCapable(MnemonicIdentity.fromMnemonic(MNEMONIC))).toBe(true);
    });

    it("is false for plain object without signSchnorrDeterministic", () => {
        expect(isDeterministicSignCapable({})).toBe(false);
    });
});

describe("derivePreimage determinism", () => {
    it("same identity and index always produce the same preimage", async () => {
        const identity = SingleKey.fromRandomBytes();
        const p1 = await derivePreimage(identity, 0);
        const p2 = await derivePreimage(identity, 0);
        expect(hex.encode(p1)).toBe(hex.encode(p2));
    });

    it("different identities produce different preimages", async () => {
        const a = SingleKey.fromRandomBytes();
        const b = SingleKey.fromRandomBytes();
        expect(hex.encode(await derivePreimage(a, 0))).not.toBe(
            hex.encode(await derivePreimage(b, 0)),
        );
    });

    it("different indices produce different preimages for the same identity", async () => {
        const identity = SingleKey.fromRandomBytes();
        expect(hex.encode(await derivePreimage(identity, 0))).not.toBe(
            hex.encode(await derivePreimage(identity, 1)),
        );
    });
});

// Cross-SDK compatibility: verify output matches NArk's preimage_vectors.json.
// Only keyIndex=0 is tested here because MnemonicIdentity always uses the BIP86
// change=0 path (m/86'/coin'/0'/0/*).
describe("cross-SDK vectors (keyIndex=0 — BIP86 change=0)", () => {
    type Entry = {
        derivationIndex: number;
        expectedPreimageMessage: string;
        expectedPreimage: string;
    };

    const networks: Array<{ name: string; isMainnet: boolean; entries: Entry[] }> = [
        { name: "mainnet", isMainnet: true, entries: vectors.vectors.mainnet.keyIndexed["0"] },
        { name: "regtest", isMainnet: false, entries: vectors.vectors.regtest.keyIndexed["0"] },
    ];

    for (const { name, isMainnet, entries } of networks) {
        for (const v of entries) {
            it(`${name} derivationIndex=${v.derivationIndex}: message and preimage match NArk`, async () => {
                const identity = MnemonicIdentity.fromMnemonic(MNEMONIC, { isMainnet });
                const xonly = await identity.xOnlyPublicKey();

                const msg = buildPreimageMessage(xonly, v.derivationIndex);
                expect(hex.encode(msg)).toBe(v.expectedPreimageMessage);

                const preimage = await derivePreimage(identity, v.derivationIndex);
                expect(hex.encode(preimage)).toBe(v.expectedPreimage);
            });
        }
    }
});
