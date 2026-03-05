import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import {
    IntrospectorPacket,
    INTROSPECTOR_PACKET_TYPE,
} from "../src/extension/introspector";
import { Extension, UnknownPacket } from "../src/extension";

describe("IntrospectorPacket", () => {
    it("should have correct packet type", () => {
        expect(INTROSPECTOR_PACKET_TYPE).toBe(0x01);
    });

    describe("serialize / fromBytes round-trip", () => {
        it("should round-trip a single entry with empty witness", () => {
            const script = new Uint8Array([0xc4, 0xd7, 0xe4]); // some arkade opcodes
            const packet = IntrospectorPacket.create([
                { vin: 0, script, witness: new Uint8Array(0) },
            ]);

            expect(packet.type()).toBe(0x01);

            const serialized = packet.serialize();
            const deserialized = IntrospectorPacket.fromBytes(serialized);

            expect(deserialized.entries.length).toBe(1);
            expect(deserialized.entries[0].vin).toBe(0);
            expect(hex.encode(deserialized.entries[0].script)).toBe(
                hex.encode(script)
            );
            expect(deserialized.entries[0].witness.length).toBe(0);
        });

        it("should round-trip multiple entries", () => {
            const script1 = new Uint8Array([0x01, 0x02, 0x03]);
            const script2 = new Uint8Array([0xaa, 0xbb]);
            const witness2 = new Uint8Array([0xcc, 0xdd, 0xee, 0xff]);

            const packet = IntrospectorPacket.create([
                { vin: 0, script: script1, witness: new Uint8Array(0) },
                { vin: 3, script: script2, witness: witness2 },
            ]);

            const serialized = packet.serialize();
            const deserialized = IntrospectorPacket.fromBytes(serialized);

            expect(deserialized.entries.length).toBe(2);
            expect(deserialized.entries[0].vin).toBe(0);
            expect(hex.encode(deserialized.entries[0].script)).toBe("010203");
            expect(deserialized.entries[1].vin).toBe(3);
            expect(hex.encode(deserialized.entries[1].script)).toBe("aabb");
            expect(hex.encode(deserialized.entries[1].witness)).toBe(
                "ccddeeff"
            );
        });

        it("should handle large vin values (u16 LE)", () => {
            const script = new Uint8Array([0x51]); // OP_1
            const packet = IntrospectorPacket.create([
                { vin: 0x1234, script, witness: new Uint8Array(0) },
            ]);

            const serialized = packet.serialize();
            const deserialized = IntrospectorPacket.fromBytes(serialized);

            expect(deserialized.entries[0].vin).toBe(0x1234);
        });
    });

    describe("validation", () => {
        it("should reject duplicate vins", () => {
            const script = new Uint8Array([0x51]);
            expect(() =>
                IntrospectorPacket.create([
                    { vin: 0, script, witness: new Uint8Array(0) },
                    { vin: 0, script, witness: new Uint8Array(0) },
                ])
            ).toThrow("duplicate vin 0");
        });
    });

    describe("binary format compatibility with Go", () => {
        it("should produce correct binary for single entry", () => {
            // Entry: vin=0, script=0x51 (OP_1), empty witness
            // Expected binary:
            //   01           - entry count (CompactSize: 1)
            //   00 00        - vin 0 (u16 LE)
            //   01           - script length (CompactSize: 1)
            //   51           - script data
            //   00           - witness length (CompactSize: 0)
            const packet = IntrospectorPacket.create([
                {
                    vin: 0,
                    script: new Uint8Array([0x51]),
                    witness: new Uint8Array(0),
                },
            ]);

            const serialized = packet.serialize();
            expect(hex.encode(serialized)).toBe("01000001510" + "0");
            // More readable: 01 0000 01 51 00
        });

        it("should produce correct binary for vin=1 with witness", () => {
            // Entry: vin=1, script=0xaabb, witness=0xcc
            // Expected binary:
            //   01           - entry count (CompactSize: 1)
            //   01 00        - vin 1 (u16 LE)
            //   02           - script length (CompactSize: 2)
            //   aa bb        - script data
            //   01           - witness length (CompactSize: 1)
            //   cc           - witness data
            const packet = IntrospectorPacket.create([
                {
                    vin: 1,
                    script: new Uint8Array([0xaa, 0xbb]),
                    witness: new Uint8Array([0xcc]),
                },
            ]);

            const serialized = packet.serialize();
            expect(hex.encode(serialized)).toBe("010100" + "02aabb" + "01cc");
        });
    });

    describe("Extension integration", () => {
        it("should serialize and deserialize as Extension TLV record", () => {
            const script = new Uint8Array([0xc4, 0xd7]); // SHA256INITIALIZE, ADD64
            const packet = IntrospectorPacket.create([
                { vin: 0, script, witness: new Uint8Array(0) },
            ]);

            // Create Extension and serialize to OP_RETURN script
            const ext = Extension.create([packet]);
            const opReturnScript = ext.serialize();

            // Parse it back
            const parsed = Extension.fromBytes(opReturnScript);
            const parsedPacket = parsed.getIntrospectorPacket();

            expect(parsedPacket).not.toBeNull();
            expect(parsedPacket!.entries.length).toBe(1);
            expect(parsedPacket!.entries[0].vin).toBe(0);
            expect(hex.encode(parsedPacket!.entries[0].script)).toBe("c4d7");
        });

        it("should coexist with other packets in Extension", () => {
            const script = new Uint8Array([0x51]);
            const introspectorPacket = IntrospectorPacket.create([
                { vin: 2, script, witness: new Uint8Array(0) },
            ]);

            // Use UnknownPacket with a custom type to test multi-packet Extension
            const fakePacket = new UnknownPacket(
                0x42,
                new Uint8Array([0xde, 0xad])
            );

            const ext = Extension.create([fakePacket, introspectorPacket]);
            const opReturnScript = ext.serialize();

            const parsed = Extension.fromBytes(opReturnScript);
            const parsedIntrospector = parsed.getIntrospectorPacket();
            expect(parsedIntrospector).not.toBeNull();
            expect(parsedIntrospector!.entries[0].vin).toBe(2);
        });
    });
});
