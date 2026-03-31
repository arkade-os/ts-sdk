import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { banco, asset, Extension } from "../../../src";
const { Offer } = banco;

describe("Offer TLV encoding", () => {
    // makerPkScript = OP_1 (0x51) + PUSH32 (0x20) + 32 bytes of 0xaa
    const makerPkScript = new Uint8Array(34);
    makerPkScript[0] = 0x51; // OP_1
    makerPkScript[1] = 0x20; // push 32 bytes
    makerPkScript.fill(0xaa, 2);

    const sampleOffer: Offer.Data = {
        swapAddress: "tark1qexampleaddress",
        wantAmount: 10_000n,
        makerPkScript,
        makerPublicKey: new Uint8Array(32).fill(0xcc),
        introspectorPubkey: new Uint8Array(32).fill(0xdd),
    };

    it("round-trips a BTC offer (no optional fields)", () => {
        const encoded = Offer.encode(sampleOffer);
        const decoded = Offer.decode(encoded);

        expect(decoded.swapAddress).toBe(sampleOffer.swapAddress);
        expect(decoded.wantAmount).toBe(sampleOffer.wantAmount);
        expect(decoded.wantAsset).toBeUndefined();
        expect(decoded.cancelDelay).toBeUndefined();
        expect(hex.encode(decoded.makerPkScript)).toBe(
            hex.encode(sampleOffer.makerPkScript)
        );
        expect(hex.encode(decoded.makerPublicKey)).toBe(
            hex.encode(sampleOffer.makerPublicKey)
        );
        expect(hex.encode(decoded.introspectorPubkey)).toBe(
            hex.encode(sampleOffer.introspectorPubkey)
        );
    });

    it("round-trips an asset offer with cancel delay", () => {
        const wantAsset = asset.AssetId.create(
            "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
            0
        );
        const offer: Offer.Data = {
            ...sampleOffer,
            wantAsset,
            cancelDelay: 1_700_000_000n,
        };
        const decoded = Offer.decode(Offer.encode(offer));

        expect(decoded.wantAsset).toBeDefined();
        expect(decoded.wantAsset!.toString()).toBe(wantAsset.toString());
        expect(decoded.cancelDelay).toBe(offer.cancelDelay);
    });

    it("hex round-trip", () => {
        const hexStr = Offer.toHex(sampleOffer);
        expect(typeof hexStr).toBe("string");
        const decoded = Offer.fromHex(hexStr);
        expect(decoded.swapAddress).toBe(sampleOffer.swapAddress);
        expect(decoded.wantAmount).toBe(sampleOffer.wantAmount);
    });

    it("rejects truncated data", () => {
        const encoded = Offer.encode(sampleOffer);
        expect(() => Offer.decode(encoded.subarray(0, 5))).toThrow();
    });

    it("rejects unknown required type", () => {
        const bad = new Uint8Array([0xff, 0x00, 0x01, 0x00]);
        expect(() => Offer.decode(bad)).toThrow();
    });

    it("rejects wrong makerPkScript length", () => {
        const badOffer = { ...sampleOffer, makerPkScript: new Uint8Array(30) };
        const encoded = Offer.encode(badOffer);
        expect(() => Offer.decode(encoded)).toThrow("expected 34 bytes");
    });

    it("round-trips through Extension packet", () => {
        const packet = Offer.toPacket(sampleOffer);
        expect(packet.type()).toBe(0x03);

        const ext = Extension.create([packet]);
        const script = ext.serialize();
        const parsed = Extension.fromBytes(script);
        const recovered = parsed.getBancoOffer();

        expect(recovered).not.toBeNull();
        expect(recovered!.swapAddress).toBe(sampleOffer.swapAddress);
        expect(recovered!.wantAmount).toBe(sampleOffer.wantAmount);
        expect(hex.encode(recovered!.makerPkScript)).toBe(
            hex.encode(sampleOffer.makerPkScript)
        );
    });

    it("round-trips an offer with ratio fields", () => {
        const wantAsset = asset.AssetId.create(
            "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
            0
        );
        const offer: Offer.Data = {
            ...sampleOffer,
            wantAsset,
            ratioNum: 100_000_000n,
            ratioDen: 5n,
        };
        const decoded = Offer.decode(Offer.encode(offer));

        expect(decoded.ratioNum).toBe(100_000_000n);
        expect(decoded.ratioDen).toBe(5n);
        expect(decoded.wantAsset).toBeDefined();
    });
});
