import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import {
    IntrospectorPacket,
    type IntrospectorEntry,
} from "../src/extension/introspector";
import fixtures from "./fixtures/introspector_packet.json";

interface RawEntry {
    vin: number;
    script: string;
    witness: string;
}

function decodeEntries(raw: RawEntry[]): IntrospectorEntry[] {
    return raw.map((e) => ({
        vin: e.vin,
        script: e.script.length > 0 ? hex.decode(e.script) : new Uint8Array(0),
        witness: e.witness.length > 0 ? hex.decode(e.witness) : undefined,
    }));
}

describe("IntrospectorPacket", () => {
    describe("valid", () => {
        for (const f of fixtures.valid) {
            it(f.name, () => {
                const entries = decodeEntries(f.entries);
                const packet = IntrospectorPacket.create(entries);

                // serialize and compare to expected encoding
                const serialized = packet.serialize();
                expect(hex.encode(serialized)).toBe(f.encoded);

                // deserialize and compare entries field-by-field
                const deserialized = IntrospectorPacket.fromBytes(
                    hex.decode(f.encoded)
                );
                expect(deserialized.entries.length).toBe(entries.length);

                for (let i = 0; i < entries.length; i++) {
                    expect(deserialized.entries[i].vin).toBe(entries[i].vin);
                    expect(hex.encode(deserialized.entries[i].script)).toBe(
                        hex.encode(entries[i].script)
                    );
                    expect(
                        hex.encode(
                            deserialized.entries[i].witness || Buffer.alloc(0)
                        )
                    ).toBe(hex.encode(entries[i].witness || Buffer.alloc(0)));
                }
            });
        }
    });

    describe("invalid", () => {
        for (const f of fixtures.invalid) {
            it(f.name, () => {
                if (f.entries) {
                    const entries = decodeEntries(f.entries);
                    expect(() => IntrospectorPacket.create(entries)).toThrow(
                        f.expectedError
                    );
                }
                if (f.encoded) {
                    const encoded = f.encoded;
                    expect(() =>
                        IntrospectorPacket.fromBytes(hex.decode(encoded))
                    ).toThrow(f.expectedError);
                }
            });
        }
    });
});
