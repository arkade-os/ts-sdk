import { describe, it, expect } from "vitest";
import { ArkAddress } from "../src";
import fixtures from "./fixtures/encoding.json";
import { hex } from "@scure/base";

describe("ArkAddress", () => {
    describe("valid addresses", () => {
        fixtures.address.valid.forEach((fixture) => {
            it(`should correctly decode and encode address ${fixture.addr}`, () => {
                // Test decoding
                const addr = ArkAddress.decode(fixture.addr);

                // Check server public key matches expected
                expect(hex.encode(addr.serverPubKey)).toBe(
                    fixture.expectedServerKey.slice(2)
                ); // Remove '02' prefix

                // Check VTXO taproot key matches expected
                expect(hex.encode(addr.vtxoTaprootKey)).toBe(
                    fixture.expectedUserKey.slice(2)
                ); // Remove '02' prefix

                // Check version matches expected
                expect(addr.version).toBe(fixture.expectedVersion);

                // Check prefix matches expected
                expect(addr.hrp).toBe(fixture.expectedPrefix);

                // Test encoding
                const encoded = addr.encode();
                expect(encoded).toBe(fixture.addr);
            });
        });
    });

    describe("invalid addresses", () => {
        fixtures.address.invalid.forEach((fixture) => {
            it(`should fail to decode invalid address ${fixture.addr}`, () => {
                expect(() => ArkAddress.decode(fixture.addr)).toThrow();
            });
        });
    });
});
