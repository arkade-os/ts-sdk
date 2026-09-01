import { describe, it, expect } from "vitest";
import { RelativeTimelock, VHTLC, arkade } from "../src";
import vhtlcFixtures from "./fixtures/vhtlc.json";
import { hex } from "@scure/base";
import { CLTVMultisigTapscript } from "../src/script/tapscript";
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

        // Independent of vhtlc.ts's own (private) enforcePayTo — mirrors it by
        // hand so the tweak assertions below don't just re-run the code under
        // test against itself.
        const enforcePayTo = (dest: Uint8Array): Uint8Array =>
            arkade.ArkadeScript.encode([
                "PUSHCURRENTINPUTINDEX",
                "DUP",
                "INSPECTOUTPUTSCRIPTPUBKEY",
                1,
                "EQUALVERIFY",
                dest.subarray(2),
                "EQUALVERIFY",
                "INSPECTOUTPUTVALUE",
                "PUSHCURRENTINPUTINDEX",
                "INSPECTINPUTVALUE",
                "GREATERTHANOREQUAL",
            ]);

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

        it("omits all three covenant leaves when emulatorCovenants is not passed", () => {
            const script = new VHTLC.Script(baseOptions());
            expect(script.nonInteractiveClaimScript).toBeUndefined();
            expect(script.nonInteractiveRefundScript).toBeUndefined();
            expect(script.nonInteractiveRefundWithoutReceiverScript).toBeUndefined();
            expect(() => script.nonInteractiveClaim()).toThrow(/no non-interactive claim leaf/);
            expect(() => script.nonInteractiveRefund()).toThrow(/no non-interactive refund leaf/);
        });

        it("builds nonInteractiveClaim as preimage + server + covenant-tweaked emulator key, pinned to receiverPkScript", () => {
            const receiverPkScript = p2tr(key(4));
            const senderPkScript = p2tr(key(6));
            const emulatorPubkey = key(5);
            // The suite is all-or-nothing, so the claim leaf cannot be built
            // alone — the assertions below are on that leaf within the full
            // suite, whose refund leaves cannot alter its bytes (see the
            // tweak assertion: the claim tweak is a function of
            // receiverPkScript + emulatorPubkey only).
            const script = new VHTLC.Script({
                ...baseOptions(),
                emulatorCovenants: { receiverPkScript, senderPkScript, emulatorPubkey },
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

            // The tweak is a function of WHICH destination it was computed
            // against — computed independently here (not by calling back into
            // the code under test) and asserted to be the one actually
            // embedded. Without this, a leaf tweaked against the WRONG
            // destination still "looks" like a normal, well-formed leaf: same
            // opcode shape, same length, some 32-byte tail that isn't the raw
            // identity key either way.
            const expectedTweak = hex.encode(
                arkade.computeArkadeScriptPublicKey(emulatorPubkey, enforcePayTo(receiverPkScript)),
            );
            expect(script.nonInteractiveClaimScript).toBe(
                `a9140909090909090909090909090909090909090909876920${hex.encode(baseOptions().server)}ad20${expectedTweak}ac`,
            );

            const [leaf, arkadeScript] = script.nonInteractiveClaim();
            expect(leaf).toBeDefined();
            expect(hex.encode(arkadeScript)).toBe(hex.encode(enforcePayTo(receiverPkScript)));
        });

        it("builds nonInteractiveRefund as server + receiver + covenant-tweaked emulator key, no timelock, pinned to senderPkScript", () => {
            const receiverPkScript = p2tr(key(4));
            const senderPkScript = p2tr(key(6));
            const emulatorPubkey = key(5);
            const script = new VHTLC.Script({
                ...baseOptions(),
                emulatorCovenants: { receiverPkScript, senderPkScript, emulatorPubkey },
            });
            expect(script.nonInteractiveRefundScript).toBeDefined();
            // <server> CHECKSIGVERIFY <receiver> CHECKSIGVERIFY <tweaked> CHECKSIG —
            // no CLTV/CSV opcode, no preimage condition (a refund leaf, not a claim
            // leaf): nothing precedes the signer chain and nothing follows it.
            expect(script.nonInteractiveRefundScript!.includes("b175")).toBe(false);
            expect(script.nonInteractiveRefundScript!.startsWith("a9")).toBe(false);
            expect(
                script.nonInteractiveRefundScript!.startsWith(
                    `20${hex.encode(baseOptions().server)}ad20${hex.encode(baseOptions().receiver)}ad`,
                ),
            ).toBe(true);
            // the sender's OWN identity key never appears — only the covenant-tweaked key does
            expect(script.nonInteractiveRefundScript!.includes(hex.encode(key(1)))).toBe(false);

            // Same independent-computation check as nonInteractiveClaim above,
            // against senderPkScript instead — and cross-checked to make sure
            // the two leaves' tweaks are not interchangeable.
            const expectedRefundTweak = hex.encode(
                arkade.computeArkadeScriptPublicKey(emulatorPubkey, enforcePayTo(senderPkScript)),
            );
            expect(script.nonInteractiveRefundScript).toBe(
                `20${hex.encode(baseOptions().server)}ad20${hex.encode(baseOptions().receiver)}ad20${expectedRefundTweak}ac`,
            );
            const expectedClaimTweak = hex.encode(
                arkade.computeArkadeScriptPublicKey(emulatorPubkey, enforcePayTo(p2tr(key(4)))),
            );
            expect(script.nonInteractiveRefundScript!.includes(expectedClaimTweak)).toBe(false);

            const [leaf, arkadeScript] = script.nonInteractiveRefund();
            expect(leaf).toBeDefined();
            expect(hex.encode(arkadeScript)).toBe(hex.encode(enforcePayTo(senderPkScript)));
        });

        it("produces a different address when the covenant suite is added, but leaves the base six byte-identical", () => {
            const base = new VHTLC.Script(baseOptions());
            const extended = new VHTLC.Script({
                ...baseOptions(),
                emulatorCovenants: {
                    receiverPkScript: p2tr(key(4)),
                    senderPkScript: p2tr(key(6)),
                    emulatorPubkey: key(5),
                },
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

        it("rejects a non-P2TR receiverPkScript or senderPkScript — wrong length", () => {
            // One bad field at a time, the other destination kept valid: the
            // suite is all-or-nothing, so every rejection goes through the
            // single `emulatorCovenants` group validation.
            expect(
                () =>
                    new VHTLC.Script({
                        ...baseOptions(),
                        emulatorCovenants: {
                            receiverPkScript: key(4),
                            senderPkScript: p2tr(key(6)),
                            emulatorPubkey: key(5),
                        },
                    }),
            ).toThrow(/P2TR/);
            expect(
                () =>
                    new VHTLC.Script({
                        ...baseOptions(),
                        emulatorCovenants: {
                            receiverPkScript: p2tr(key(4)),
                            senderPkScript: key(6),
                            emulatorPubkey: key(5),
                        },
                    }),
            ).toThrow(/P2TR/);
        });

        it("rejects a malformed emulatorPubkey", () => {
            for (const emulatorPubkey of [new Uint8Array(31), new Uint8Array(34)]) {
                expect(
                    () =>
                        new VHTLC.Script({
                            ...baseOptions(),
                            emulatorCovenants: {
                                receiverPkScript: p2tr(key(4)),
                                senderPkScript: p2tr(key(6)),
                                emulatorPubkey,
                            },
                        }),
                ).toThrow(/Invalid public key length \(emulator\)/);
            }
        });

        it("rejects a non-P2TR receiverPkScript or senderPkScript — right length, wrong witness version", () => {
            // Same length as a real P2TR script (34 bytes) but a different
            // witness-version prefix — e.g. OP_RETURN <32 bytes>, exactly what
            // ArkAddress.subdustPkScript produces. Length alone can't catch
            // this; enforcePayTo blindly trusts bytes[2:34] as the taproot
            // program regardless of what the prefix actually says.
            const opReturnShaped = Uint8Array.from([0x6a, 0x20, ...key(4)]);
            expect(
                () =>
                    new VHTLC.Script({
                        ...baseOptions(),
                        emulatorCovenants: {
                            receiverPkScript: opReturnShaped,
                            senderPkScript: p2tr(key(6)),
                            emulatorPubkey: key(5),
                        },
                    }),
            ).toThrow(/P2TR/);
            expect(
                () =>
                    new VHTLC.Script({
                        ...baseOptions(),
                        emulatorCovenants: {
                            receiverPkScript: p2tr(key(4)),
                            senderPkScript: opReturnShaped,
                            emulatorPubkey: key(5),
                        },
                    }),
            ).toThrow(/P2TR/);
        });

        it("rejects an emulatorCovenants group missing a destination script with the same clean error as a wrong-length one — not a raw TypeError", () => {
            // The emulatorPubkey check just above already guards with `!x ||`;
            // the destination check originally didn't, so an object present
            // but missing this one field crashed on `undefined.length` instead
            // of throwing validateOptions' own intended message.
            expect(
                () =>
                    new VHTLC.Script({
                        ...baseOptions(),
                        emulatorCovenants: {
                            senderPkScript: p2tr(key(6)),
                            emulatorPubkey: key(5),
                        } as never,
                    }),
            ).toThrow(/P2TR/);
            expect(
                () =>
                    new VHTLC.Script({
                        ...baseOptions(),
                        emulatorCovenants: {
                            receiverPkScript: p2tr(key(4)),
                            emulatorPubkey: key(5),
                        } as never,
                    }),
            ).toThrow(/P2TR/);
        });
    });

    describe("ScriptV2", () => {
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

        // `OP_SIZE 32 OP_EQUALVERIFY` ahead of `OP_HASH160 <hash20> OP_EQUAL` —
        // `82` `0120` `88` `a914`, then the hash. The exact prefix every leaf
        // gated on the preimage must carry in V2 and must NOT carry in V1.
        const SIZE_CHECK_PREFIX = "82012088a914";

        it("carries the SIZE-32 preimage-length check on claim and unilateralClaim, which V1 does not", () => {
            const v1 = new VHTLC.Script(baseOptions());
            const v2 = new VHTLC.ScriptV2(baseOptions());

            expect(v2.claimScript.startsWith(SIZE_CHECK_PREFIX)).toBe(true);
            expect(v2.unilateralClaimScript.includes(SIZE_CHECK_PREFIX)).toBe(true);

            expect(v1.claimScript.startsWith(SIZE_CHECK_PREFIX)).toBe(false);
            expect(v1.unilateralClaimScript.includes(SIZE_CHECK_PREFIX)).toBe(false);

            // Confirms the two scripts actually differ (not a no-op change) and
            // that the derived address differs as a result.
            expect(v2.claimScript).not.toBe(v1.claimScript);
            expect(v2.unilateralClaimScript).not.toBe(v1.unilateralClaimScript);
            expect(hex.encode(v2.pkScript)).not.toBe(hex.encode(v1.pkScript));
        });

        it("carries the SIZE-32 check on nonInteractiveClaim too — it shares the same preimage condition as claim/unilateralClaim", () => {
            const receiverPkScript = p2tr(key(4));
            const senderPkScript = p2tr(key(6));
            const emulatorPubkey = key(5);
            const emulatorCovenants = { receiverPkScript, senderPkScript, emulatorPubkey };
            const v1 = new VHTLC.Script({
                ...baseOptions(),
                emulatorCovenants,
            });
            const v2 = new VHTLC.ScriptV2({
                ...baseOptions(),
                emulatorCovenants,
            });

            expect(v2.nonInteractiveClaimScript).toBeDefined();
            expect(v2.nonInteractiveClaimScript!.startsWith(SIZE_CHECK_PREFIX)).toBe(true);
            expect(v1.nonInteractiveClaimScript!.startsWith(SIZE_CHECK_PREFIX)).toBe(false);
            expect(v2.nonInteractiveClaimScript).not.toBe(v1.nonInteractiveClaimScript);

            // The covenant tweak itself (the part after the preimage condition
            // and the server key) is untouched by the version change — only the
            // preimage condition differs.
            const v1Tail = v1.nonInteractiveClaimScript!.slice(
                v1.nonInteractiveClaimScript!.indexOf("6920"),
            );
            const v2Tail = v2.nonInteractiveClaimScript!.slice(
                v2.nonInteractiveClaimScript!.indexOf("6920"),
            );
            expect(v2Tail).toBe(v1Tail);
        });

        it("leaves refund-side leaves — refund, refundWithoutReceiver, unilateralRefund*, nonInteractiveRefund* — byte-identical to V1", () => {
            // None of these gate on the preimage at all, so the version split
            // must not touch them.
            const senderPkScript = p2tr(key(6));
            const opts = {
                ...baseOptions(),
                emulatorCovenants: {
                    receiverPkScript: p2tr(key(4)),
                    senderPkScript,
                    emulatorPubkey: key(5),
                },
            };
            const v1 = new VHTLC.Script(opts);
            const v2 = new VHTLC.ScriptV2(opts);

            expect(v2.refundScript).toBe(v1.refundScript);
            expect(v2.refundWithoutReceiverScript).toBe(v1.refundWithoutReceiverScript);
            expect(v2.unilateralRefundScript).toBe(v1.unilateralRefundScript);
            expect(v2.unilateralRefundWithoutReceiverScript).toBe(
                v1.unilateralRefundWithoutReceiverScript,
            );
            expect(v2.nonInteractiveRefundScript).toBe(v1.nonInteractiveRefundScript);
            expect(v2.nonInteractiveRefundWithoutReceiverScript).toBe(
                v1.nonInteractiveRefundWithoutReceiverScript,
            );
        });

        it("still rejects a non-P2TR covenant destination, same as V1", () => {
            expect(
                () =>
                    new VHTLC.ScriptV2({
                        ...baseOptions(),
                        emulatorCovenants: {
                            receiverPkScript: key(4),
                            senderPkScript: p2tr(key(6)),
                            emulatorPubkey: key(5),
                        },
                    }),
            ).toThrow(/P2TR/);
        });
    });
});

describe("VHTLC.ScriptV2 — asset denomination", () => {
    const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
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

    const receiverPkScript = p2tr(key(4));
    const emulatorPubkey = key(5);
    const asset = { txid: new Uint8Array(32).fill(0xab), groupIndex: 2 };
    /** The covenant suite these tests build on — all-or-nothing since the per-leaf options were merged. */
    const suite = { receiverPkScript, senderPkScript: p2tr(key(6)), emulatorPubkey };

    const withAsset = (extra: object = {}) =>
        new VHTLC.ScriptV2({
            ...baseOptions(),
            emulatorCovenants: suite,
            ...extra,
        });

    it("leaves every script byte-identical when no asset is given", () => {
        // The compatibility property. Every contract already funded derives
        // from the sat covenant; a change of one byte makes those underivable
        // and therefore unspendable.
        const sats = withAsset();
        const explicitlyNone = withAsset({ asset: undefined });
        expect(hex.encode(explicitlyNone.pkScript)).toBe(hex.encode(sats.pkScript));
        expect(explicitlyNone.nonInteractiveClaimScript).toBe(sats.nonInteractiveClaimScript);
        expect(explicitlyNone.nonInteractiveRefundScript).toBe(sats.nonInteractiveRefundScript);
    });

    it("changes ONLY the covenant leaves", () => {
        // Every other leaf is a signature path asserting nothing about value,
        // so an asset must make no difference to them. This is what "mostly
        // just the non-interactive paths" means, checked rather than asserted.
        const sats = withAsset();
        const assets = withAsset({ asset });

        expect(assets.claimScript).toBe(sats.claimScript);
        expect(assets.refundScript).toBe(sats.refundScript);
        expect(assets.unilateralClaimScript).toBe(sats.unilateralClaimScript);
        expect(assets.unilateralRefundScript).toBe(sats.unilateralRefundScript);
        expect(assets.unilateralRefundWithoutReceiverScript).toBe(
            sats.unilateralRefundWithoutReceiverScript,
        );

        // ...and the three that DO change, change — the timelocked refund
        // leaf shares nonInteractiveRefund's covenant and cosigner, so the
        // asset reaches it through the same tweak.
        expect(assets.nonInteractiveClaimScript).not.toBe(sats.nonInteractiveClaimScript);
        expect(assets.nonInteractiveRefundScript).not.toBe(sats.nonInteractiveRefundScript);
        expect(assets.nonInteractiveRefundWithoutReceiverScript).not.toBe(
            sats.nonInteractiveRefundWithoutReceiverScript,
        );
        // which necessarily moves the address
        expect(hex.encode(assets.pkScript)).not.toBe(hex.encode(sats.pkScript));
    });

    it("keeps the sat covenant as the tail, so an asset contract never enforces less", () => {
        const sats = withAsset();
        const assets = withAsset({ asset });
        const satCovenant = hex.encode(sats.nonInteractiveClaimArkadeScript!);
        const assetCovenant = hex.encode(assets.nonInteractiveClaimArkadeScript!);
        expect(assetCovenant.endsWith(satCovenant)).toBe(true);
        expect(assetCovenant.length).toBeGreaterThan(satCovenant.length);
    });

    it("binds the asset id, so a different asset is a different contract", () => {
        const a = withAsset({ asset });
        const otherTxid = withAsset({ asset: { ...asset, txid: new Uint8Array(32).fill(0xcd) } });
        const otherGroup = withAsset({ asset: { ...asset, groupIndex: 3 } });
        expect(hex.encode(otherTxid.pkScript)).not.toBe(hex.encode(a.pkScript));
        expect(hex.encode(otherGroup.pkScript)).not.toBe(hex.encode(a.pkScript));
    });

    it("pushes the txid REVERSED, because that is what the opcode matches", () => {
        // `asset.txid` is CANONICAL order -- the leading 32 bytes of the serialized
        // Asset ID -- but the introspection opcodes match those bytes reversed.
        // Push the canonical bytes unflipped and the lookup reports the asset
        // ABSENT (`0 0`), so
        // the covenant fails and the contract it guards is unspendable, with
        // nothing in the error naming the cause. Established on regtest against
        // a real minted asset (see test/e2e/asset-covenant.test.ts).
        const distinct = { txid: new Uint8Array(32).map((_, i) => i + 1), groupIndex: 1 };
        const covenant = hex.encode(
            withAsset({ asset: distinct }).nonInteractiveClaimArkadeScript!,
        );
        expect(covenant).toContain(hex.encode(Uint8Array.from(distinct.txid).reverse()));
        expect(covenant).not.toContain(hex.encode(distinct.txid));
    });

    it("does not mutate the caller's asset id", () => {
        const mine = { txid: new Uint8Array(32).map((_, i) => i + 1), groupIndex: 1 };
        const before = hex.encode(mine.txid);
        withAsset({ asset: mine });
        expect(hex.encode(mine.txid)).toBe(before);
    });

    it("derives the same pkScript bytes it always has, for every shape", () => {
        // GOLDEN VECTORS. Captured from b43534b and pinned ever since, through
        // two changes that each had to leave the default path's BYTES alone —
        // and did: the `strict` claim bound came and went without moving them
        // (opt-in, default off, and now removed unused), and the per-leaf
        // covenant options merged into the all-or-nothing `emulatorCovenants`
        // group. A claim-only or refund-only tree is no longer expressible, so
        // those four vectors are dropped — the API they pinned is gone. The
        // eight-leaf "suite" shape is what `legacy: "preTimelockedRefund"`
        // builds: the same eight leaves, byte for byte, while the group's
        // default gained the timelocked refund leaf. The nine-leaf vectors were
        // captured at that refactor and pin the new default going forward.
        //
        // Those bytes ARE the address of every contract already funded: a
        // change that moves the default path fails here instead of making
        // funded contracts underivable.
        const legacySuite = { ...suite, legacy: "preTimelockedRefund" as const };
        const shapes: [string, object, string, string][] = [
            [
                "bare",
                {},
                "512069be6bafd0f15802284199463ddc3fa995fd6a5ba470d9ce02a565f286492fc8",
                "5120f2612eed370d3603672b7e256635fdb1e8fdf2636853175cc0dbec585d50679e",
            ],
            [
                "suite, legacy eight-leaf",
                { emulatorCovenants: legacySuite },
                "5120d155531ea89a92eac969c5e5205607b9debba9a4e66453c9410e9b6ca38e4eda",
                "5120d8880eda3ad3281604f27e5b5dcd851631acb974f9d8aecf18a9e13e3a439f5b",
            ],
            [
                "suite, nine leaves (the default)",
                { emulatorCovenants: suite },
                "5120b279a2f2ec1683c7118d78fa4a971ffb9a830adfb6c3665daa54239e5b6e9e31",
                "512058ef69965bc6378ee1feb3f5ad2e577e884eded58bcf3c77ddf6ad37f403f64b",
            ],
            [
                "asset + suite, legacy eight-leaf",
                { emulatorCovenants: legacySuite, asset },
                "5120dd8f3358c9d8300d57772c6450f1d310086d45e5903aa1808637d8dd3e5ffea0",
                "5120869d1ad5a5bced06a50c883c718c8e25f531168a8f536469ca58e28360a87a8e",
            ],
            [
                "asset + suite, nine leaves (the default)",
                { emulatorCovenants: suite, asset },
                "512055c316b67e22dd00f6d97c61d22f962bacb7da2d33c2ec3b23021f73f3dad65a",
                "51207106ec590b0082ca87b86e7d3ce29bb584d3d255ad799b4973378a9849455a3c",
            ],
        ];
        for (const [name, extra, v2, v1] of shapes) {
            const options = { ...baseOptions(), ...extra };
            expect(hex.encode(new VHTLC.ScriptV2(options).pkScript), `${name} (v2)`).toBe(v2);
            expect(hex.encode(new VHTLC.Script(options).pkScript), `${name} (v1)`).toBe(v1);
        }
    });

    it("refuses an asset that no leaf would bind, instead of silently dropping it", () => {
        // THE SILENT CASE. The covenant suite is opt-in, and its leaves are the
        // only ones carrying the covenant — the signature leaves assert nothing
        // about value. So `asset` without the suite used to build a sat-only
        // contract and say nothing: the caller funds it believing the asset is
        // bound, and ANY spend satisfying the sat covenant walks off with the
        // asset. The only outward difference is a pkScript that happens to
        // match a non-asset address, which is not something a caller checks.
        expect(
            () =>
                new VHTLC.ScriptV2({
                    ...baseOptions(),
                    asset,
                }),
        ).toThrow(/no effect without emulatorCovenants/);
        // The suite present, the asset binds: no per-leaf subset to require.
        expect(() => withAsset({ asset })).not.toThrow();
    });

    it("binds the asset on VHTLC.Script (v1) too, which inherits the same base", () => {
        // The option lands on `BaseScript`, so v1 gets it. That is deliberate —
        // the asset covenant is orthogonal to the preimage-condition fragment
        // that is the ONLY difference between versions — but it has to be
        // asserted, or v1 is carrying an untested money path.
        const v1 = new VHTLC.Script({
            ...baseOptions(),
            emulatorCovenants: suite,
            asset,
        });
        const v1NoAsset = new VHTLC.Script({
            ...baseOptions(),
            emulatorCovenants: suite,
        });
        expect(hex.encode(v1.pkScript)).not.toBe(hex.encode(v1NoAsset.pkScript));
        expect(() => new VHTLC.Script({ ...baseOptions(), asset })).toThrow(/no effect without/);
    });

    it("refuses a malformed asset id rather than encoding one", () => {
        expect(() => withAsset({ asset: { txid: new Uint8Array(31), groupIndex: 0 } })).toThrow(
            /32 bytes/,
        );
        expect(() => withAsset({ asset: { ...asset, groupIndex: -1 } })).toThrow(/\[0, 65535\]/);
        expect(() => withAsset({ asset: { ...asset, groupIndex: 0x10000 } })).toThrow(
            /\[0, 65535\]/,
        );
    });
});

describe("nonInteractiveRefundWithoutReceiver", () => {
    const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
    const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program]);

    const senderPk = key(1);
    const receiverPk = key(2);
    const serverPk = key(3);
    const preimageHash = new Uint8Array(20).fill(9);
    const emulatorPubkey = key(5);
    const receiverPkScript = p2tr(key(4));
    const senderPkScript = p2tr(key(6));

    const base = {
        sender: senderPk,
        receiver: receiverPk,
        server: serverPk,
        preimageHash,
        refundLocktime: 1000n,
        unilateralClaimDelay: { type: "blocks", value: 100n } as const,
        unilateralRefundDelay: { type: "blocks", value: 102n } as const,
        unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 103n } as const,
    };

    /** The covenant suite, as the group takes it — the leaf this describe pins is part of it by DEFAULT. */
    const suite = { receiverPkScript, senderPkScript, emulatorPubkey };

    it('is built with the suite by default, and withheld only by legacy: "preTimelockedRefund"', () => {
        const full = new VHTLC.ScriptV2({ ...base, emulatorCovenants: suite });
        expect(full.nonInteractiveRefundWithoutReceiverScript).toBeDefined();

        const legacy = new VHTLC.ScriptV2({
            ...base,
            emulatorCovenants: { ...suite, legacy: "preTimelockedRefund" },
        });
        expect(legacy.nonInteractiveRefundWithoutReceiverScript).toBeUndefined();
        expect(() => legacy.nonInteractiveRefundWithoutReceiver()).toThrow(
            "VHTLC has no non-interactive refund-without-receiver leaf",
        );
        // Withholding the leaf moves the address — a legacy lockup and a
        // full-suite one never collide, which is what makes "which shape did
        // this quote opt into" answerable by an address comparison.
        expect(hex.encode(legacy.pkScript)).not.toBe(hex.encode(full.pkScript));
    });

    it("legacy withholds exactly one leaf — the other eight stay byte-identical and in position", () => {
        const full = new VHTLC.ScriptV2({ ...base, emulatorCovenants: suite });
        const legacy = new VHTLC.ScriptV2({
            ...base,
            emulatorCovenants: { ...suite, legacy: "preTimelockedRefund" },
        });

        expect(full.scripts.length).toBe(9);
        expect(legacy.scripts.length).toBe(8);
        expect(full.scripts.length).toBe(legacy.scripts.length + 1);

        // The eight leaves the legacy shape keeps are byte-identical AND in
        // the same position — the ninth is appended, never interleaved, since
        // leaf order decides the taproot merkle root. (`toContain` on
        // `.encode()`'s raw tap-tree bytes would only check for byte-VALUE
        // membership, which almost any buffer satisfies trivially; this
        // checks the actual per-leaf script list instead.) It is also what
        // "byte-identical to the pre-suite eight-leaf shape" means: that
        // shape was these same eight leaves in this same order.
        expect(full.scripts.slice(0, legacy.scripts.length).map(hex.encode)).toEqual(
            legacy.scripts.map(hex.encode),
        );
    });

    it("is absent with the whole suite when emulatorCovenants is not passed — six leaves", () => {
        const bare = new VHTLC.ScriptV2(base);
        expect(bare.scripts.length).toBe(6);
        expect(bare.nonInteractiveClaimScript).toBeUndefined();
        expect(bare.nonInteractiveRefundScript).toBeUndefined();
        expect(bare.nonInteractiveRefundWithoutReceiverScript).toBeUndefined();
        expect(() => bare.nonInteractiveRefundWithoutReceiver()).toThrow(
            "VHTLC has no non-interactive refund-without-receiver leaf",
        );
    });

    it("is CLTVMultisig{refundLocktime, [server, nonInteractiveRefund's own cosigner]}", () => {
        const script = new VHTLC.ScriptV2({
            ...base,
            emulatorCovenants: suite,
        });

        const cosigner = arkade.computeArkadeScriptPublicKey(
            emulatorPubkey,
            script.nonInteractiveRefundArkadeScript!,
        );
        const expected = CLTVMultisigTapscript.encode({
            absoluteTimelock: base.refundLocktime,
            pubkeys: [serverPk, cosigner],
        }).script;

        expect(script.nonInteractiveRefundWithoutReceiverScript).toBe(hex.encode(expected));
        // Same covenant bytes as the immediate leaf — one destination, one covenant.
        expect(hex.encode(script.nonInteractiveRefundWithoutReceiverArkadeScript!)).toBe(
            hex.encode(script.nonInteractiveRefundArkadeScript!),
        );
    });
});
