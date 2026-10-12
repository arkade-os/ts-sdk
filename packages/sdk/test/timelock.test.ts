import { describe, it, expect } from "vitest";
import * as bip68 from "bip68";
import { timelockToSequence, type RelativeTimelock } from "../src";

describe("timelockToSequence — type and value validation", () => {
    it.each<[RelativeTimelock, number]>([
        [{ type: "blocks", value: 0n }, bip68.encode({ blocks: 0 })],
        [{ type: "blocks", value: 144n }, bip68.encode({ blocks: 144 })],
        [{ type: "blocks", value: 65535n }, bip68.encode({ blocks: 65535 })],
        [{ type: "seconds", value: 512n }, bip68.encode({ seconds: 512 })],
        [{ type: "seconds", value: 86_016n }, bip68.encode({ seconds: 86_016 })],
    ])("encodes %o as before", (timelock, expected) => {
        expect(timelockToSequence(timelock)).toBe(expected);
    });

    it("refuses an unknown type instead of encoding it as seconds", () => {
        // 1024 is a multiple of 512, so the old fall-through built a seconds leaf silently.
        expect(() => timelockToSequence({ type: "block" as any, value: 1024n })).toThrow(
            "Invalid relative timelock type 'block'",
        );
        expect(() => timelockToSequence({ type: "Sequence" as any, value: 144n })).toThrow(
            "Invalid relative timelock type 'Sequence'",
        );
    });

    it("refuses a negative value instead of encoding the unspendable -1", () => {
        expect(() => timelockToSequence({ type: "blocks", value: -1n })).toThrow(
            "Invalid relative timelock value -1",
        );
        expect(() => timelockToSequence({ type: "seconds", value: -512n })).toThrow(
            "Invalid relative timelock value -512",
        );
    });

    it("checks the value before the type", () => {
        expect(() => timelockToSequence({ type: "bogus" as any, value: -1n })).toThrow(
            "Invalid relative timelock value -1",
        );
    });

    it("coerces a safe-integer number to the bigint encoding", () => {
        expect(timelockToSequence({ type: "blocks", value: 144 as any })).toBe(
            timelockToSequence({ type: "blocks", value: 144n }),
        );
        expect(timelockToSequence({ type: "seconds", value: (512 * 200) as any })).toBe(
            timelockToSequence({ type: "seconds", value: 102_400n }),
        );
    });

    it.each([1.5, Number.NaN, -1, "144", undefined])("refuses value %o", (value) => {
        expect(() => timelockToSequence({ type: "blocks", value: value as any })).toThrow(
            "Invalid relative timelock value",
        );
    });
});
