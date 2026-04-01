import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { CovVHTLC } from "../src/script/cov-vhtlc";
import { VHTLC } from "../src/script/vhtlc";
import { ArkadeScript } from "../src/arkade/script";
import { computeArkadeScriptPublicKey } from "../src/arkade/tweak";
import { scriptFromTapLeafScript } from "../src/script/base";

// Derive valid x-only pubkeys from known private keys
const senderPriv = hex.decode(
    "0101010101010101010101010101010101010101010101010101010101010101"
);
const receiverPriv = hex.decode(
    "0202020202020202020202020202020202020202020202020202020202020202"
);
const serverPriv = hex.decode(
    "0303030303030303030303030303030303030303030303030303030303030303"
);
const introspectorPriv = hex.decode(
    "0404040404040404040404040404040404040404040404040404040404040404"
);

const sender = schnorr.getPublicKey(senderPriv);
const receiver = schnorr.getPublicKey(receiverPriv);
const server = schnorr.getPublicKey(serverPriv);
const introspectorPubkey = schnorr.getPublicKey(introspectorPriv);

const preimageHash = hex.decode("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

// p2tr witness program — use a valid x-only pubkey
const claimProgram = schnorr.getPublicKey(
    hex.decode(
        "0505050505050505050505050505050505050505050505050505050505050505"
    )
);

function makeOptions(overrides?: Partial<CovVHTLC.Options>): CovVHTLC.Options {
    return {
        sender,
        receiver,
        server,
        preimageHash,
        refundLocktime: 800100n,
        unilateralClaimDelay: { type: "blocks", value: 100n },
        unilateralRefundDelay: { type: "blocks", value: 102n },
        unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 103n },
        claimAddress: { version: 1, program: claimProgram },
        expectedAmount: 10000n,
        ...overrides,
    };
}

describe("CovVHTLC", () => {
    describe("construction", () => {
        it("creates a script with 7 leaves", () => {
            const script = new CovVHTLC.Script(makeOptions(), {
                introspectorPubkey,
            });

            expect(script.leaves).toHaveLength(7);
        });

        it("produces a valid tweaked public key", () => {
            const script = new CovVHTLC.Script(makeOptions(), {
                introspectorPubkey,
            });

            expect(script.tweakedPublicKey).toBeInstanceOf(Uint8Array);
            expect(script.tweakedPublicKey).toHaveLength(32);
        });

        it("first 6 leaves match VHTLC.Script", () => {
            const opts = makeOptions();
            const covScript = new CovVHTLC.Script(opts, {
                introspectorPubkey,
            });
            const vhtlcScript = new VHTLC.Script(opts);

            // The 6 standard scripts should produce the same hex
            expect(covScript.claimScript).toBe(
                hex.encode(scriptFromTapLeafScript(vhtlcScript.claim()))
            );
            expect(covScript.refundScript).toBe(
                hex.encode(scriptFromTapLeafScript(vhtlcScript.refund()))
            );
            expect(covScript.refundWithoutReceiverScript).toBe(
                hex.encode(
                    scriptFromTapLeafScript(vhtlcScript.refundWithoutReceiver())
                )
            );
            expect(covScript.unilateralClaimScript).toBe(
                hex.encode(
                    scriptFromTapLeafScript(vhtlcScript.unilateralClaim())
                )
            );
            expect(covScript.unilateralRefundScript).toBe(
                hex.encode(
                    scriptFromTapLeafScript(vhtlcScript.unilateralRefund())
                )
            );
            expect(covScript.unilateralRefundWithoutReceiverScript).toBe(
                hex.encode(
                    scriptFromTapLeafScript(
                        vhtlcScript.unilateralRefundWithoutReceiver()
                    )
                )
            );
        });
    });

    describe("leaf accessors", () => {
        it("claim() returns a valid TapLeafScript", () => {
            const script = new CovVHTLC.Script(makeOptions(), {
                introspectorPubkey,
            });
            const leaf = script.claim();

            expect(leaf).toBeDefined();
            expect(leaf[0].internalKey).toBeInstanceOf(Uint8Array);
            expect(leaf[1]).toBeInstanceOf(Uint8Array);
        });

        it("covenantClaim() returns a valid TapLeafScript", () => {
            const script = new CovVHTLC.Script(makeOptions(), {
                introspectorPubkey,
            });
            const leaf = script.covenantClaim();

            expect(leaf).toBeDefined();
            expect(leaf[0].internalKey).toBeInstanceOf(Uint8Array);
            expect(leaf[1]).toBeInstanceOf(Uint8Array);
        });

        it("all 7 leaf accessors return distinct leaves", () => {
            const script = new CovVHTLC.Script(makeOptions(), {
                introspectorPubkey,
            });

            const leaves = [
                script.claim(),
                script.refund(),
                script.refundWithoutReceiver(),
                script.unilateralClaim(),
                script.unilateralRefund(),
                script.unilateralRefundWithoutReceiver(),
                script.covenantClaim(),
            ];

            const scriptHexes = leaves.map((l) =>
                hex.encode(scriptFromTapLeafScript(l))
            );
            const unique = new Set(scriptHexes);
            expect(unique.size).toBe(7);
        });
    });

    describe("covenant claim script structure", () => {
        it("covenant leaf contains the tweaked introspector key", () => {
            const opts = makeOptions();
            const script = new CovVHTLC.Script(opts, {
                introspectorPubkey,
            });

            const arkadeScriptBytes = buildTestArkadeScript(
                opts.claimAddress,
                opts.expectedAmount
            );
            const tweakedKey = computeArkadeScriptPublicKey(
                introspectorPubkey,
                arkadeScriptBytes
            );

            const leafScript = scriptFromTapLeafScript(script.covenantClaim());
            const leafHex = hex.encode(leafScript);

            // The tweaked key should appear in the leaf script
            expect(leafHex).toContain(hex.encode(tweakedKey));
        });

        it("covenant leaf contains HASH160 preimage check", () => {
            const script = new CovVHTLC.Script(makeOptions(), {
                introspectorPubkey,
            });

            const leafScript = scriptFromTapLeafScript(script.covenantClaim());
            const leafHex = hex.encode(leafScript);

            // Should contain the preimage hash
            expect(leafHex).toContain(hex.encode(preimageHash));
            // Should contain SIZE opcode (0x82) and HASH160 opcode (0xa9)
            expect(leafHex).toContain("82");
            expect(leafHex).toContain("a9");
        });

        it("covenant leaf is tracked in arkadeScripts map", () => {
            const script = new CovVHTLC.Script(makeOptions(), {
                introspectorPubkey,
            });

            // The 7th leaf (index 6) should be in the arkade scripts map
            expect(script.arkadeScripts.has(6)).toBe(true);
            // Other leaves should not be arkade leaves
            for (let i = 0; i < 6; i++) {
                expect(script.arkadeScripts.has(i)).toBe(false);
            }
        });

        it("arkade script contains introspection opcodes", () => {
            const script = new CovVHTLC.Script(makeOptions(), {
                introspectorPubkey,
            });

            const arkadeScriptBytes = script.arkadeScripts.get(6)!;
            const decoded = ArkadeScript.decode(arkadeScriptBytes);

            // Should contain INSPECTOUTPUTSCRIPTPUBKEY and INSPECTOUTPUTVALUE
            expect(decoded).toContain("INSPECTOUTPUTSCRIPTPUBKEY");
            expect(decoded).toContain("INSPECTOUTPUTVALUE");
        });
    });

    describe("address generation", () => {
        it("produces a different address than VHTLC", () => {
            const opts = makeOptions();
            const covScript = new CovVHTLC.Script(opts, {
                introspectorPubkey,
            });
            const vhtlcScript = new VHTLC.Script(opts);

            const covAddr = covScript.address("tark", server).encode();
            const vhtlcAddr = vhtlcScript.address("tark", server).encode();

            expect(covAddr).not.toBe(vhtlcAddr);
        });

        it("deterministically produces the same address", () => {
            const opts = makeOptions();
            const a = new CovVHTLC.Script(opts, { introspectorPubkey });
            const b = new CovVHTLC.Script(opts, { introspectorPubkey });

            expect(a.address("tark", server).encode()).toBe(
                b.address("tark", server).encode()
            );
        });
    });

    describe("validation", () => {
        it("rejects missing claim address", () => {
            expect(
                () =>
                    new CovVHTLC.Script(
                        makeOptions({
                            claimAddress: undefined as any,
                        }),
                        { introspectorPubkey }
                    )
            ).toThrow("claim address is required");
        });

        it("rejects invalid witness version", () => {
            expect(
                () =>
                    new CovVHTLC.Script(
                        makeOptions({
                            claimAddress: { version: 2, program: claimProgram },
                        }),
                        { introspectorPubkey }
                    )
            ).toThrow("claim address version must be 0 or 1");
        });

        it("rejects wrong program length for v1", () => {
            expect(
                () =>
                    new CovVHTLC.Script(
                        makeOptions({
                            claimAddress: {
                                version: 1,
                                program: new Uint8Array(20),
                            },
                        }),
                        { introspectorPubkey }
                    )
            ).toThrow("witness v1 program must be 32 bytes");
        });

        it("rejects wrong program length for v0", () => {
            expect(
                () =>
                    new CovVHTLC.Script(
                        makeOptions({
                            claimAddress: {
                                version: 0,
                                program: new Uint8Array(16),
                            },
                        }),
                        { introspectorPubkey }
                    )
            ).toThrow("witness v0 program must be 20 or 32 bytes");
        });

        it("accepts v0 with 20-byte program (p2wpkh)", () => {
            expect(
                () =>
                    new CovVHTLC.Script(
                        makeOptions({
                            claimAddress: {
                                version: 0,
                                program: new Uint8Array(20),
                            },
                        }),
                        { introspectorPubkey }
                    )
            ).not.toThrow();
        });

        it("accepts v0 with 32-byte program (p2wsh)", () => {
            expect(
                () =>
                    new CovVHTLC.Script(
                        makeOptions({
                            claimAddress: {
                                version: 0,
                                program: new Uint8Array(32),
                            },
                        }),
                        { introspectorPubkey }
                    )
            ).not.toThrow();
        });

        it("rejects zero expected amount", () => {
            expect(
                () =>
                    new CovVHTLC.Script(makeOptions({ expectedAmount: 0n }), {
                        introspectorPubkey,
                    })
            ).toThrow("expected amount must be greater than 0");
        });

        it("rejects negative expected amount", () => {
            expect(
                () =>
                    new CovVHTLC.Script(makeOptions({ expectedAmount: -1n }), {
                        introspectorPubkey,
                    })
            ).toThrow("expected amount must be greater than 0");
        });

        it("rejects invalid preimage hash length", () => {
            expect(
                () =>
                    new CovVHTLC.Script(
                        makeOptions({
                            preimageHash: new Uint8Array(16),
                        }),
                        { introspectorPubkey }
                    )
            ).toThrow("preimage hash must be 20 bytes");
        });

        it("rejects invalid pubkey length", () => {
            expect(
                () =>
                    new CovVHTLC.Script(
                        makeOptions({
                            sender: new Uint8Array(33),
                        }),
                        { introspectorPubkey }
                    )
            ).toThrow("Invalid public key length (sender)");
        });
    });

    describe("different claim addresses", () => {
        it("produces different scripts for different claim addresses", () => {
            const a = new CovVHTLC.Script(
                makeOptions({
                    claimAddress: { version: 1, program: claimProgram },
                }),
                { introspectorPubkey }
            );
            const otherProgram = hex.decode(
                "0606060606060606060606060606060606060606060606060606060606060606"
            );
            const b = new CovVHTLC.Script(
                makeOptions({
                    claimAddress: { version: 1, program: otherProgram },
                }),
                { introspectorPubkey }
            );

            expect(a.covenantClaimScript).not.toBe(b.covenantClaimScript);
        });

        it("produces different scripts for different amounts", () => {
            const a = new CovVHTLC.Script(
                makeOptions({ expectedAmount: 10000n }),
                { introspectorPubkey }
            );
            const b = new CovVHTLC.Script(
                makeOptions({ expectedAmount: 20000n }),
                { introspectorPubkey }
            );

            expect(a.covenantClaimScript).not.toBe(b.covenantClaimScript);
        });
    });
});

/**
 * Helper to build the arkade script for test verification.
 * Mirrors buildCovenantArkadeScript from cov-vhtlc.ts.
 */
function buildTestArkadeScript(
    claimAddress: CovVHTLC.ClaimAddress,
    expectedAmount: bigint
): Uint8Array {
    const buf = new Uint8Array(8);
    let v = expectedAmount;
    for (let i = 0; i < 8; i++) {
        buf[i] = Number(v & 0xffn);
        v >>= 8n;
    }

    return ArkadeScript.encode([
        0,
        "INSPECTOUTPUTSCRIPTPUBKEY",
        claimAddress.version,
        "EQUALVERIFY",
        claimAddress.program,
        "EQUALVERIFY",
        0,
        "INSPECTOUTPUTVALUE",
        "DROP",
        buf,
        "EQUAL",
    ]);
}
