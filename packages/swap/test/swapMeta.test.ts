import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { decodeSwapMeta, encodeSwapMeta, SwapMeta } from "../src/swapMeta";

const pkScript = hex.decode("5120" + "ab".repeat(32));
const paymentHash = hex.decode("cd".repeat(32));
const solverPubkey = hex.decode("ef".repeat(32));

// hand-built TLV records: encodeSwapMeta rejects malformed input, so the
// decode-side coverage assembles its foreign payloads from raw records
const rec = (tag: number, value: Uint8Array): Uint8Array =>
    Uint8Array.from([tag, (value.length >> 8) & 0xff, value.length & 0xff, ...value]);
const cat = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
};

describe("swap metadata packet", () => {
    it("round-trips a lightning send's covenant and terms", () => {
        const meta: SwapMeta = {
            feeBps: 25,
            swapPkScript: pkScript,
            paymentHash,
            solverPubkey,
            refundLocktime: 900_000,
        };
        expect(decodeSwapMeta(encodeSwapMeta(meta))).toEqual(meta);
    });

    it("round-trips a fee on its own, which is all an offer swap needs", () => {
        expect(decodeSwapMeta(encodeSwapMeta({ feeBps: 30 }))).toEqual({ feeBps: 30 });
    });

    it("carries a zero fee as a fact, not as an absence", () => {
        // "the solver charged nothing" and "we do not know the fee" render as
        // different receipts, so a zero must survive the round trip
        expect(decodeSwapMeta(encodeSwapMeta({ feeBps: 0 }))).toEqual({ feeBps: 0 });
    });

    it("encodes an empty payload when there is nothing to say", () => {
        expect(encodeSwapMeta({})).toEqual(new Uint8Array(0));
        expect(decodeSwapMeta(new Uint8Array(0))).toEqual({});
    });

    describe("unknown records", () => {
        it("ignores a field from a newer writer and keeps the rest", () => {
            // The whole point of the packet being descriptive: adding a field
            // later must not blind every older reader to the fields it does
            // know. This is the opposite of decodeOffer, which binds a covenant
            // and so must refuse anything it cannot read.
            const payload = cat(
                rec(0x01, Uint8Array.of(0x00, 0x19)), // feeBps = 25
                rec(0x7f, hex.decode("deadbeef")), // not yet assigned
                rec(0x03, paymentHash),
            );
            expect(decodeSwapMeta(payload)).toEqual({ feeBps: 25, paymentHash });
        });

        it("still rejects corruption, which is not a field from the future", () => {
            // a truncated value is unusable rather than unrecognised; reading a
            // short feeBps as a plausible small number would misprice a receipt
            expect(() => decodeSwapMeta(cat(rec(0x01, Uint8Array.of(0x19))))).toThrow(/feeBps/);
            expect(() => decodeSwapMeta(Uint8Array.of(0x01, 0x00))).toThrow(/truncated TLV header/);
            expect(() => decodeSwapMeta(Uint8Array.of(0x01, 0x00, 0x08, 0x00))).toThrow(
                /truncated TLV value/,
            );
        });

        it("rejects a duplicate record rather than picking a winner", () => {
            // last-wins here and first-wins elsewhere would let identical bytes
            // describe two different swaps
            const payload = cat(
                rec(0x01, Uint8Array.of(0x00, 0x19)),
                rec(0x01, Uint8Array.of(0x00, 0x1e)),
            );
            expect(() => decodeSwapMeta(payload)).toThrow(/duplicate TLV record/);
        });
    });

    describe("out-of-range values", () => {
        it("refuses a fee at or past the denominator on the way out and back in", () => {
            // 10000 bps is the entire swap; past it the arithmetic inverts
            expect(() => encodeSwapMeta({ feeBps: 10_000 })).toThrow(/feeBps/);
            expect(() => decodeSwapMeta(cat(rec(0x01, Uint8Array.of(0x27, 0x10))))).toThrow(
                /invalid feeBps/,
            );
        });

        it("refuses a fee that is not a whole basis point", () => {
            expect(() => encodeSwapMeta({ feeBps: -1 })).toThrow(/feeBps/);
            expect(() => encodeSwapMeta({ feeBps: 12.5 })).toThrow(/feeBps/);
        });

        it("refuses a fee that would wrap the u16 into a bargain", () => {
            // 65536 + 25 would silently encode as 25 and read as a 0.25% fee
            expect(() => encodeSwapMeta({ feeBps: 65_561 })).toThrow(/feeBps/);
        });

        it("refuses a wrong-width script or key", () => {
            expect(() => encodeSwapMeta({ swapPkScript: pkScript.slice(0, 33) })).toThrow(
                /swapPkScript/,
            );
            expect(() => encodeSwapMeta({ paymentHash: new Uint8Array(31) })).toThrow(
                /paymentHash/,
            );
            expect(() => encodeSwapMeta({ solverPubkey: new Uint8Array(33) })).toThrow(
                /solverPubkey/,
            );
        });

        it("refuses a locktime outside the u32", () => {
            expect(() => encodeSwapMeta({ refundLocktime: -1 })).toThrow(/refundLocktime/);
            expect(() => encodeSwapMeta({ refundLocktime: 0x1_0000_0000 })).toThrow(
                /refundLocktime/,
            );
        });

        it("accepts the boundary values either side rejects", () => {
            expect(decodeSwapMeta(encodeSwapMeta({ feeBps: 9_999 }))).toEqual({ feeBps: 9_999 });
            expect(decodeSwapMeta(encodeSwapMeta({ refundLocktime: 0xffffffff }))).toEqual({
                refundLocktime: 0xffffffff,
            });
        });
    });
});
