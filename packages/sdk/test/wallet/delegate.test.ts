import { describe, it, expect } from "vitest";
import { defaultDelegateAt, findDestinationOutputIndex } from "../../src/wallet/delegate";

describe("defaultDelegateAt", () => {
    const now = Date.UTC(2026, 0, 1);

    it("uses ten percent of a long remaining lifetime", () => {
        expect(defaultDelegateAt(now + 1_000_000, 30n, now).getTime()).toBe(now + 900_000);
    });

    it("leaves a full server session when it is longer than ten percent", () => {
        expect(defaultDelegateAt(now + 120_000, 30n, now).getTime()).toBe(now + 90_000);
    });

    it("preserves the full server session at the short-lifetime boundary", () => {
        expect(defaultDelegateAt(now + 31_000, 30n, now).getTime()).toBe(now + 1_000);
    });

    it("uses a short scheduling margin when less than one server session remains", () => {
        expect(defaultDelegateAt(now + 20_000, 30n, now).getTime()).toBe(now + 2_000);
    });
});

describe("findDestinationOutputIndex", () => {
    const scriptA = new Uint8Array([0x00, 0x14, 0xaa, 0xbb]);
    const scriptB = new Uint8Array([0x00, 0x14, 0xcc, 0xdd]);
    const scriptC = new Uint8Array([0x00, 0x14, 0xee, 0xff]);

    it("should find the destination output when it is the last output", () => {
        const outputs = [
            { script: scriptA, amount: 1000n },
            { script: scriptB, amount: 5000n },
        ];
        expect(findDestinationOutputIndex(outputs, scriptB)).toBe(1);
    });

    it("should find the destination output when it is the first output", () => {
        const outputs = [
            { script: scriptB, amount: 5000n },
            { script: scriptA, amount: 1000n },
        ];
        expect(findDestinationOutputIndex(outputs, scriptB)).toBe(0);
    });

    it("should find the destination output in the middle", () => {
        const outputs = [
            { script: scriptA, amount: 1000n },
            { script: scriptB, amount: 5000n },
            { script: scriptC, amount: 3000n },
        ];
        expect(findDestinationOutputIndex(outputs, scriptB)).toBe(1);
    });

    it("should return -1 when no output matches", () => {
        const outputs = [
            { script: scriptA, amount: 1000n },
            { script: scriptC, amount: 3000n },
        ];
        expect(findDestinationOutputIndex(outputs, scriptB)).toBe(-1);
    });

    it("should return -1 for empty outputs", () => {
        expect(findDestinationOutputIndex([], scriptA)).toBe(-1);
    });

    it("should skip outputs with undefined script", () => {
        const outputs = [{ amount: 1000n }, { script: scriptA, amount: 5000n }];
        expect(findDestinationOutputIndex(outputs, scriptA)).toBe(1);
    });

    it("should not match outputs with different-length scripts", () => {
        const shortScript = new Uint8Array([0x00, 0x14]);
        const outputs = [{ script: shortScript, amount: 1000n }];
        expect(findDestinationOutputIndex(outputs, scriptA)).toBe(-1);
    });

    it("should return the first match when duplicates exist", () => {
        const outputs = [
            { script: scriptA, amount: 1000n },
            { script: scriptB, amount: 2000n },
            { script: scriptB, amount: 3000n },
        ];
        expect(findDestinationOutputIndex(outputs, scriptB)).toBe(1);
    });
});
