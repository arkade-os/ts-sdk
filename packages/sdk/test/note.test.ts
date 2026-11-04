import { describe, it, expect } from "vitest";
import { ArkadeNote } from "../src";
import fixtures from "./fixtures/encoding.json";
import { hex } from "@scure/base";

describe("ArkadeNote", () => {
    describe("valid notes", () => {
        fixtures.note.valid.forEach((fixture) => {
            it(`should correctly decode and encode note ${fixture.str}`, () => {
                // Test decoding
                const note = ArkadeNote.fromString(fixture.str, fixture.hrp);
                const preimage = hex.encode(note.preimage);
                expect(preimage).toBe(fixture.expectedPreimage);
                expect(note.value).toBe(fixture.expectedValue);

                // Test encoding
                const newNote = new ArkadeNote(
                    hex.decode(fixture.expectedPreimage),
                    fixture.expectedValue,
                    fixture.hrp,
                );
                expect(newNote.toString()).toBe(fixture.str);

                // Check HRP is valid
                expect(fixture.str.slice(0, note.HRP.length)).toEqual(note.HRP);
            });
        });
    });

    describe("invalid addresses", () => {
        fixtures.note.invalid.forEach((fixture) => {
            it(`should fail to decode invalid note ${fixture.str}`, () => {
                expect(() => ArkadeNote.fromString(fixture.str)).toThrow();
            });
        });
    });
});
