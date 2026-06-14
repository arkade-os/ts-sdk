import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import type { ArkInfo } from "@arkade-os/sdk";
import { candidateServerPubkeys } from "../src/utils/vhtlc";

const ACTIVE = "aa".repeat(32);
const DEPRECATED_A = "bb".repeat(32);
const DEPRECATED_B = "cc".repeat(32);

function makeInfo(
    signerPubkey: string,
    deprecatedSigners: { pubkey: string; cutoffDate?: bigint }[] = [],
): ArkInfo {
    return { signerPubkey, deprecatedSigners } as unknown as ArkInfo;
}

describe("candidateServerPubkeys", () => {
    it("returns the current signer first, then deprecated signers", () => {
        const info = makeInfo(ACTIVE, [{ pubkey: DEPRECATED_A }, { pubkey: DEPRECATED_B }]);
        expect(candidateServerPubkeys(info)).toEqual([ACTIVE, DEPRECATED_A, DEPRECATED_B]);
    });

    it("normalizes compressed (33-byte) keys to x-only", () => {
        const info = makeInfo("02" + ACTIVE, [{ pubkey: "03" + DEPRECATED_A }]);
        expect(candidateServerPubkeys(info)).toEqual([ACTIVE, DEPRECATED_A]);
    });

    it("dedupes a deprecated entry equal to the current signer", () => {
        const info = makeInfo(ACTIVE, [{ pubkey: ACTIVE }, { pubkey: DEPRECATED_A }]);
        expect(candidateServerPubkeys(info)).toEqual([ACTIVE, DEPRECATED_A]);
    });

    it("returns only the current signer when none are deprecated", () => {
        expect(candidateServerPubkeys(makeInfo(ACTIVE))).toEqual([ACTIVE]);
    });

    it("skips deprecated entries with an empty pubkey", () => {
        const info = makeInfo(ACTIVE, [{ pubkey: "" }, { pubkey: DEPRECATED_A }]);
        expect(candidateServerPubkeys(info)).toEqual([ACTIVE, DEPRECATED_A]);
    });

    it("preserves lowercase x-only hex output", () => {
        const info = makeInfo(ACTIVE.toUpperCase(), [{ pubkey: DEPRECATED_A.toUpperCase() }]);
        const result = candidateServerPubkeys(info);
        expect(result).toEqual([ACTIVE, DEPRECATED_A]);
        expect(result.every((k) => k === k.toLowerCase())).toBe(true);
        // sanity: keys round-trip through hex decode
        expect(hex.decode(result[0])).toHaveLength(32);
    });
});
