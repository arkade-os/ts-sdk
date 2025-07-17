import { describe, it, expect } from "vitest";
import { ArkAddress, RelativeTimelock, VHTLC } from "../src";
import fixtures from "./fixtures/encoding.json";
import vhtlcFixtures from "./fixtures/vhtlc.json";
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

    describe("VHTLC Address", () => {
        vhtlcFixtures.valid.forEach((f) => {
            const receiverXOnly = f.receiver.slice(2);
            const senderXOnly = f.sender.slice(2);
            const serverXOnly = f.server.slice(2);
            const refundLocktime = BigInt(f.refundLocktime);
            const unilateralClaimDelay: RelativeTimelock = {
                type: f.unilateralRefundWithoutReceiverDelay.type as
                    | "blocks"
                    | "seconds",
                value: BigInt(f.unilateralClaimDelay.value),
            };
            const unilateralRefundDelay: RelativeTimelock = {
                type: f.unilateralRefundWithoutReceiverDelay.type as
                    | "blocks"
                    | "seconds",
                value: BigInt(f.unilateralRefundDelay.value),
            };
            const unilateralRefundWithoutReceiverDelay: RelativeTimelock = {
                type: f.unilateralRefundWithoutReceiverDelay.type as
                    | "blocks"
                    | "seconds",
                value: BigInt(f.unilateralRefundWithoutReceiverDelay.value),
            };

            it(f.description, () => {
                const vhtlcScript = new VHTLC.Script({
                    preimageHash: hex.decode(f.preimageHash),
                    sender: hex.decode(senderXOnly),
                    receiver: hex.decode(receiverXOnly),
                    server: hex.decode(serverXOnly),
                    refundLocktime,
                    unilateralClaimDelay,
                    unilateralRefundDelay,
                    unilateralRefundWithoutReceiverDelay,
                });

                const vhtlcAddress = vhtlcScript
                    .address("tark", hex.decode(serverXOnly))
                    .encode();

                expect(vhtlcAddress).toBe(f.expected);
            });
        });
    });
});
