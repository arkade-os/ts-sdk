import { describe, it, expect } from "vitest";
import { RelativeTimelock, VHTLC } from "../src";
import vhtlcFixtures from "./fixtures/vhtlc.json";
import { hex } from "@scure/base";

describe("VHTLC address", () => {
    describe("valid", () => {
        vhtlcFixtures.valid.forEach((f) => {
            const receiverXOnly = f.receiver.slice(2);
            const senderXOnly = f.sender.slice(2);
            const serverXOnly = f.server.slice(2);
            const refundLocktime = BigInt(f.refundLocktime);
            const unilateralClaimDelay: RelativeTimelock = {
                type: f.unilateralClaimDelay.type as "blocks" | "seconds",
                value: BigInt(f.unilateralClaimDelay.value),
            };
            const unilateralRefundDelay: RelativeTimelock = {
                type: f.unilateralRefundDelay.type as "blocks" | "seconds",
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

    describe("invalid", () => {
        vhtlcFixtures.invalid.forEach((f) => {
            it(f.description, () => {
                // Helper function to create VHTLC options from fixture
                const createVHTLCOptions = () => {
                    const options: any = {};

                    if (f.preimageHash) {
                        options.preimageHash = hex.decode(f.preimageHash);
                    }
                    if (f.receiver) {
                        options.receiver = hex.decode(f.receiver.slice(2));
                    }
                    if (f.sender) {
                        options.sender = hex.decode(f.sender.slice(2));
                    }
                    if (f.server) {
                        options.server = hex.decode(f.server.slice(2));
                    }
                    if (f.refundLocktime !== undefined) {
                        options.refundLocktime = BigInt(
                            f.refundLocktime as number
                        );
                    }
                    if (f.unilateralClaimDelay) {
                        options.unilateralClaimDelay = {
                            type: f.unilateralClaimDelay.type as
                                | "blocks"
                                | "seconds",
                            value: BigInt(f.unilateralClaimDelay.value),
                        };
                    }
                    if (f.unilateralRefundDelay) {
                        options.unilateralRefundDelay = {
                            type: f.unilateralRefundDelay.type as
                                | "blocks"
                                | "seconds",
                            value: BigInt(f.unilateralRefundDelay.value),
                        };
                    }
                    if (f.unilateralRefundWithoutReceiverDelay) {
                        options.unilateralRefundWithoutReceiverDelay = {
                            type: f.unilateralRefundWithoutReceiverDelay
                                .type as "blocks" | "seconds",
                            value: BigInt(
                                f.unilateralRefundWithoutReceiverDelay.value
                            ),
                        };
                    }

                    return options;
                };

                expect(() => {
                    new VHTLC.Script(createVHTLCOptions());
                }).toThrow();
            });
        });
    });
});
