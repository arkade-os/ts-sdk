import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { decodeCbor, encodeCbor } from "../../src/enclave/cbor";

const decodeHex = (s: string) => decodeCbor(hex.decode(s));

describe("decodeCbor", () => {
    it("decodes integers, strings, simple values and containers", () => {
        expect(decodeHex("17")).toBe(23);
        expect(decodeHex("1903e8")).toBe(1000);
        expect(decodeHex("3822")).toBe(-35);
        expect(decodeHex("1b0020000000000000")).toBe(2n ** 53n);
        expect(decodeHex("6449455446")).toBe("IETF");
        expect(decodeHex("4401020304")).toEqual(Uint8Array.of(1, 2, 3, 4));
        expect(decodeHex("f4")).toBe(false);
        expect(decodeHex("f5")).toBe(true);
        expect(decodeHex("f6")).toBeNull();
        expect(decodeHex("83010203")).toEqual([1, 2, 3]);
        expect(decodeHex("a201020304")).toEqual(
            new Map([
                [1, 2],
                [3, 4],
            ]),
        );
    });

    // The NSM writes its attestation payload as an indefinite-length map.
    it("decodes indefinite-length maps and arrays", () => {
        expect(decodeHex("bf61610161629f0203ffff")).toEqual(
            new Map<string, unknown>([
                ["a", 1],
                ["b", [2, 3]],
            ]),
        );
    });

    it("tolerates the COSE_Sign1 tag around the whole document only", () => {
        expect(decodeHex("d28101")).toEqual([1]);
        expect(() => decodeHex("81d201")).toThrow(/tag/);
        expect(() => decodeHex("c101")).toThrow(/tag/);
    });

    it.each([
        ["trailing bytes", "0101"],
        ["truncated byte string", "4401"],
        ["truncated header", "19"],
        ["duplicate map key", "a201020103"],
        ["a float", "f93c00"],
        ["an indefinite byte string", "5f4101ff"],
        ["a stray break", "ff"],
        ["a break inside a definite array", "82ff01"],
        ["a byte-string map key", "a1410101"],
        ["nesting past the depth limit", "81".repeat(20) + "01"],
    ])("rejects %s", (_name, input) => {
        expect(() => decodeHex(input)).toThrow();
    });
});

describe("encodeCbor", () => {
    // Sig_structure for COSE_Sign1: ["Signature1", protected, h'', payload].
    it("encodes the COSE Sig_structure with definite lengths", () => {
        const protectedHeader = hex.decode("a1013822");
        const payload = Uint8Array.of(0xde, 0xad);
        expect(
            hex.encode(encodeCbor(["Signature1", protectedHeader, new Uint8Array(0), payload])),
        ).toBe("846a5369676e61747572653144a101382240" + "42dead");
    });

    it("round-trips what it encodes", () => {
        const value = new Map<string | number, any>([
            ["n", 1000],
            ["neg", -35],
            ["big", 2n ** 64n - 1n],
            ["s", "héllo"],
            ["b", new Uint8Array(300).fill(9)],
            [1, [true, false, null]],
        ]);
        expect(decodeCbor(encodeCbor(value))).toEqual(value);
    });
});
