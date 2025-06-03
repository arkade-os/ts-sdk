import { describe, it, expect } from "vitest";
import { ArkAddress, ArkNote } from "../src";
import fixtures from "./fixtures/encoding.json";
import { hex } from "@scure/base";

describe("ArkNote", () => {
    describe("valid notes", () => {
        fixtures.note.valid.forEach((fixture) => {
            it(`should correctly decode and encode note ${fixture.str}`, () => {
                // Check HRP is valid
                expect(fixture.str.slice(0, ArkNote.HRP.length)).toEqual(
                    ArkNote.HRP
                );

                // Test decoding
                const note = ArkNote.fromString(fixture.str);
                const preimage = hex.encode(note.preimage);
                expect(preimage).toBe(fixture.expectedPreimage);
                expect(note.value).toBe(fixture.expectedValue);

                // Test encoding
                const newNote = new ArkNote(note.preimage, note.value);
                expect(newNote.toString()).toBe(fixture.str);
            });
        });
    });

    describe("invalid addresses", () => {
        fixtures.note.invalid.forEach((fixture) => {
            it(`should fail to decode invalid note ${fixture.str}`, () => {
                expect(() => ArkNote.fromString(fixture.str)).toThrow();
            });
        });
    });
});
