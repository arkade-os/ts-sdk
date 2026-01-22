import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import {
    DefaultContractHandler,
    timelockToSequence,
} from "../../src/contracts/handlers/default";
import { VHTLCContractHandler } from "../../src/contracts/handlers/vhtlc";

describe("DefaultContractHandler", () => {
    it("creates a script matching the expected pkScript", () => {
        const params = {
            type: "default",
            params: {
                pubKey: "304f9960ebb31cd5f49bd18673042be1ae286019225e08e861233e06ea95fffe",
                serverPubKey:
                    "56f810de93e500e745b7dabfcb2b798b216a70a99de7edee79bf1791379bf62d",
                csvTimelock: timelockToSequence({
                    type: "seconds",
                    value: 86016n,
                }).toString(),
            },
            script: "5120985a208e36f3263160cf47605dfd9c10e358b08dd4a7b75b1eb37725f64797d9",
            address:
                "tark1qpt0syx7j0jspe69kldtljet0x9jz6ns4xw70m0w0xl30yfhn0mzmxz6yz8rduexx9sv73mqth7ecy8rtzcgm498kad3avmhyhmy097ew6h83g",
            state: "active",
        };

        const script = DefaultContractHandler.createScript(params.params);

        expect(hex.encode(script.pkScript)).toEqual(params.script);
    });
});

describe("VHTLCContractHandler", () => {
    it("creates the correct script and handles de/serialization", () => {
        const receiverXOnly =
            "1e1bb85455fe3f5aed60d101aa4dbdb9e7714f6226769a97a17a5331dadcd53b";
        const senderXOnly =
            "0192e796452d6df9697c280542e1560557bcf79a347d925895043136225c7cb4";
        const serverXOnly =
            "aad52d58162e9eefeafc7ad8a1cdca8060b5f01df1e7583362d052e266208f88";

        const params = {
            type: "vhtlc",
            params: {
                sender: senderXOnly,
                receiver: receiverXOnly,
                server: serverXOnly,
                hash: "4d487dd3753a89bc9fe98401d1196523058251fc",
                refundLocktime: "265",
                claimDelay: timelockToSequence({
                    type: "blocks",
                    value: 17n,
                }).toString(),
                refundDelay: timelockToSequence({
                    type: "blocks",
                    value: 144n,
                }).toString(),
                refundNoReceiverDelay: timelockToSequence({
                    type: "blocks",
                    value: 144n,
                }).toString(),
            },
        };

        const script = VHTLCContractHandler.createScript(params.params);

        // Verify the script is created and has expected structure
        expect(script.pkScript).toBeDefined();
        expect(script.pkScript.length).toBeGreaterThan(0);

        // Verify the script can produce all expected leaf scripts
        expect(script.claim()).toBeDefined();
        expect(script.refund()).toBeDefined();
        expect(script.refundWithoutReceiver()).toBeDefined();
        expect(script.unilateralClaim()).toBeDefined();
        expect(script.unilateralRefund()).toBeDefined();
        expect(script.unilateralRefundWithoutReceiver()).toBeDefined();

        // Verify serialization roundtrip works
        const deserialized = VHTLCContractHandler.deserializeParams(
            params.params
        );
        const reserialized = VHTLCContractHandler.serializeParams(deserialized);
        const script2 = VHTLCContractHandler.createScript(reserialized);

        expect(hex.encode(script2.pkScript)).toEqual(
            hex.encode(script.pkScript)
        );
    });
});
