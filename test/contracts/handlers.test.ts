import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import {
    DefaultContractHandler,
    timelockToSequence,
} from "../../src/contracts/handlers/default";

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
