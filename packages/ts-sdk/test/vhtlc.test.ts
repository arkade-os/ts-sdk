import { describe, it, expect } from "vitest";
import { RelativeTimelock, VHTLC } from "../src";
import vhtlcFixtures from "./fixtures/vhtlc.json";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";

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
                type: f.unilateralRefundWithoutReceiverDelay.type as "blocks" | "seconds",
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

                const vhtlcAddress = vhtlcScript.address("tark", hex.decode(serverXOnly)).encode();

                expect(vhtlcAddress).toBe(f.expected);

                // Assert the enriched fixture fields stay in sync with the
                // SDK. These are also test vectors for other VHTLC
                // implementations; if they drift from what
                // `VHTLC.Script` produces, this test breaks loudly
                // instead of silently shipping stale documentation.
                if (f.scripts) {
                    expect(vhtlcScript.claimScript).toBe(f.scripts.claimScript);
                    expect(vhtlcScript.refundScript).toBe(f.scripts.refundScript);
                    expect(vhtlcScript.refundWithoutReceiverScript).toBe(
                        f.scripts.refundWithoutReceiverScript,
                    );
                    expect(vhtlcScript.unilateralClaimScript).toBe(f.scripts.unilateralClaimScript);
                    expect(vhtlcScript.unilateralRefundScript).toBe(
                        f.scripts.unilateralRefundScript,
                    );
                    expect(vhtlcScript.unilateralRefundWithoutReceiverScript).toBe(
                        f.scripts.unilateralRefundWithoutReceiverScript,
                    );
                }
                if (f.taproot) {
                    expect(hex.encode(vhtlcScript.tweakedPublicKey)).toBe(
                        f.taproot.tweakedPublicKey,
                    );
                    expect(hex.encode(vhtlcScript.encode())).toBe(f.taproot.tapTree);
                }
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
                        options.refundLocktime = BigInt(f.refundLocktime as number);
                    }
                    if (f.unilateralClaimDelay) {
                        options.unilateralClaimDelay = {
                            type: f.unilateralClaimDelay.type as "blocks" | "seconds",
                            value: BigInt(f.unilateralClaimDelay.value),
                        };
                    }
                    if (f.unilateralRefundDelay) {
                        options.unilateralRefundDelay = {
                            type: f.unilateralRefundDelay.type as "blocks" | "seconds",
                            value: BigInt(f.unilateralRefundDelay.value),
                        };
                    }
                    if (f.unilateralRefundWithoutReceiverDelay) {
                        options.unilateralRefundWithoutReceiverDelay = {
                            type: f.unilateralRefundWithoutReceiverDelay.type as
                                | "blocks"
                                | "seconds",
                            value: BigInt(f.unilateralRefundWithoutReceiverDelay.value),
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

    describe("non-interactive leaves", () => {
        const key = (fill: number): Uint8Array =>
            schnorr.getPublicKey(new Uint8Array(32).fill(fill));
        const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

        const baseOptions = () => ({
            preimageHash: new Uint8Array(20).fill(9),
            sender: key(1),
            receiver: key(2),
            server: key(3),
            refundLocktime: 1_800_000_000n,
            unilateralClaimDelay: { type: "seconds" as const, value: 512n },
            unilateralRefundDelay: { type: "seconds" as const, value: 1024n },
            unilateralRefundWithoutReceiverDelay: { type: "seconds" as const, value: 1536n },
        });

        it("omits both non-interactive leaves, and their addresses, when neither option is passed", () => {
            const script = new VHTLC.Script(baseOptions());
            expect(script.nonInteractiveClaimScript).toBeUndefined();
            expect(script.nonInteractiveRefundScript).toBeUndefined();
            expect(() => script.nonInteractiveClaim()).toThrow(/no non-interactive claim leaf/);
            expect(() => script.nonInteractiveRefund()).toThrow(/no non-interactive refund leaf/);
        });

        it("builds nonInteractiveClaim as preimage + server + covenant-tweaked emulator key, pinned to receiverPkScript", () => {
            const receiverPkScript = p2tr(key(4));
            const script = new VHTLC.Script({
                ...baseOptions(),
                nonInteractiveClaim: { receiverPkScript, emulatorPubkey: key(5) },
            });
            expect(script.nonInteractiveClaimScript).toBeDefined();
            // preimage condition + VERIFY, then <server> CHECKSIGVERIFY <tweaked> CHECKSIG
            expect(
                script.nonInteractiveClaimScript!.startsWith(
                    "a9140909090909090909090909090909090909090909876920",
                ),
            ).toBe(true);
            // the receiver's OWN identity key never appears — only the covenant-tweaked key does
            expect(script.nonInteractiveClaimScript!.includes(hex.encode(key(2)))).toBe(false);

            const [leaf] = script.nonInteractiveClaim();
            expect(leaf).toBeDefined();
        });

        it("builds nonInteractiveRefund as CLTV(refundLocktime) + server + covenant-tweaked emulator key, pinned to senderPkScript", () => {
            const senderPkScript = p2tr(key(6));
            const script = new VHTLC.Script({
                ...baseOptions(),
                nonInteractiveRefund: { senderPkScript, emulatorPubkey: key(5) },
            });
            expect(script.nonInteractiveRefundScript).toBeDefined();
            // <locktime> CLTV DROP <server> CHECKSIGVERIFY <tweaked> CHECKSIG — same
            // CLTV+DROP shape refundWithoutReceiver already uses (b175), no preimage
            // condition (a refund leaf, not a claim leaf).
            expect(script.nonInteractiveRefundScript!.includes("b175")).toBe(true);
            expect(script.nonInteractiveRefundScript!.startsWith("a9")).toBe(false);
            // the sender's OWN identity key never appears — only the covenant-tweaked key does
            expect(script.nonInteractiveRefundScript!.includes(hex.encode(key(1)))).toBe(false);

            const [leaf] = script.nonInteractiveRefund();
            expect(leaf).toBeDefined();
        });

        it("produces a different address when the two non-interactive leaves are added, but leaves the base six byte-identical", () => {
            const base = new VHTLC.Script(baseOptions());
            const extended = new VHTLC.Script({
                ...baseOptions(),
                nonInteractiveClaim: { receiverPkScript: p2tr(key(4)), emulatorPubkey: key(5) },
                nonInteractiveRefund: { senderPkScript: p2tr(key(6)), emulatorPubkey: key(5) },
            });
            expect(hex.encode(extended.pkScript)).not.toBe(hex.encode(base.pkScript));
            expect(extended.claimScript).toBe(base.claimScript);
            expect(extended.refundScript).toBe(base.refundScript);
            expect(extended.refundWithoutReceiverScript).toBe(base.refundWithoutReceiverScript);
            expect(extended.unilateralClaimScript).toBe(base.unilateralClaimScript);
            expect(extended.unilateralRefundScript).toBe(base.unilateralRefundScript);
            expect(extended.unilateralRefundWithoutReceiverScript).toBe(
                base.unilateralRefundWithoutReceiverScript,
            );
        });

        it("rejects a non-P2TR receiverPkScript or senderPkScript", () => {
            expect(
                () =>
                    new VHTLC.Script({
                        ...baseOptions(),
                        nonInteractiveClaim: { receiverPkScript: key(4), emulatorPubkey: key(5) },
                    }),
            ).toThrow(/P2TR/);
            expect(
                () =>
                    new VHTLC.Script({
                        ...baseOptions(),
                        nonInteractiveRefund: { senderPkScript: key(6), emulatorPubkey: key(5) },
                    }),
            ).toThrow(/P2TR/);
        });
    });
});
