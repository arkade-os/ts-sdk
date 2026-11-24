import { describe, expect, it } from "vitest";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";

import { toXOnly } from "../src/utils/keys";

describe("toXOnly", () => {
    const priv = new Uint8Array(32).fill(9);
    const compressed = secp256k1.getPublicKey(priv, true);
    const xonly = schnorr.getPublicKey(priv);

    it("strips the parity prefix of a compressed key and passes an x-only key through", () => {
        expect(toXOnly(compressed)).toEqual(xonly);
        expect(toXOnly(xonly)).toBe(xonly);
    });

    it("refuses anything else, naming the caller's label", () => {
        // An uncompressed key is the case worth refusing: dropping one byte
        // yields a well-formed 32-byte value that is not the key.
        const uncompressed = secp256k1.getPublicKey(priv, false);
        expect(() => toXOnly(uncompressed, "solver key")).toThrow(
            /solver key is not a compressed or x-only public key/,
        );
        expect(() => toXOnly(new Uint8Array(33), "solver key")).toThrow(/solver key/);
        expect(() => toXOnly(new Uint8Array(0))).toThrow(/public key/);
    });
});
