import { describe, it, expect } from "vitest";
import { ArkAddress, RelativeTimelock, VHTLC } from "../src";
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

    describe("VHTLC Address", () => {
        const preimageHash = "4d487dd3753a89bc9fe98401d1196523058251fc";
        const receiver =
            "021e1bb85455fe3f5aed60d101aa4dbdb9e7714f6226769a97a17a5331dadcd53b";
        const receiverXOnly = receiver.slice(2);
        const sender =
            "030192e796452d6df9697c280542e1560557bcf79a347d925895043136225c7cb4";
        const senderXOnly = sender.slice(2);
        const server =
            "03aad52d58162e9eefeafc7ad8a1cdca8060b5f01df1e7583362d052e266208f88";
        const serverXOnly = server.slice(2);
        const refundLocktime = 265n;
        const unilateralRefundDelay: RelativeTimelock = {
            type: "blocks",
            value: 144n,
        };
        const unilateralRefundWithoutReceiverDelay: RelativeTimelock = {
            type: "blocks",
            value: 144n,
        };
        it("valid address with no values < 17", () => {
            const unilateralClaimDelay: RelativeTimelock = {
                type: "blocks",
                value: 17n,
            };
            const vhtlcScript = new VHTLC.Script({
                preimageHash: hex.decode(preimageHash),
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

            expect(vhtlcAddress).toBe(
                "tark1qz4d2t2czchfaml2l3ad3gwde2qxpd0srhc7wkpnvtg99cnxyz8c3pnvvhnhumhwhqthmlxmdryakwx99s6508y8dunj9sty2p5mr7unh5re63"
            );
        });

        it("valid address with some values < 17", () => {
            const unilateralClaimDelay: RelativeTimelock = {
                type: "blocks",
                value: 16n,
            };
            const vhtlcScript = new VHTLC.Script({
                preimageHash: hex.decode(preimageHash),
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

            expect(vhtlcAddress).toBe(
                "tark1qz4d2t2czchfaml2l3ad3gwde2qxpd0srhc7wkpnvtg99cnxyz8c3vyn9exe9gjwcjp5ez0wfhhawvvg0xfenzztjmgp3ddrvkwhw04eztqjn6"
            );
        });
    });
});
