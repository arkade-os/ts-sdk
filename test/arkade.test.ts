/**
 * Comprehensive Tests for Arkade Script Support
 *
 * This test suite combines the best tests from multiple independent implementations
 * to ensure thorough coverage of opcodes, script encoding/decoding, ASM conversion,
 * and PSBT field handling.
 */

import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import {
    OPCODE_NAMES,
    OPCODE_VALUES,
    ARKADE_OPCODES,
    toASM,
    fromASM,
    ArkadeScript,
    type ArkadeScriptType,
    ARKADE_OPS,
    ArkadeVtxoScript,
    computeArkadeScriptPublicKey,
} from "../src/arkade";
import { MultisigTapscript, CSVMultisigTapscript, VtxoScript } from "../src";

describe("Arkade Opcodes", () => {
    it("should have bidirectional opcode mappings", () => {
        for (const [value, name] of Object.entries(OPCODE_NAMES)) {
            expect(OPCODE_VALUES[name]).toBe(Number(value));
        }
    });
});

describe("Script Encoding/Decoding", () => {
    describe("ArkadeScript.encode and ArkadeScript.decode", () => {
        it("should encode and decode empty script", () => {
            const encoded = ArkadeScript.encode([]);
            expect(encoded.length).toBe(0);

            const decoded = ArkadeScript.decode(encoded);
            expect(decoded).toEqual([]);
        });

        it("should encode and decode single opcode", () => {
            const encoded = ArkadeScript.encode(["DUP"]);
            expect(encoded).toEqual(new Uint8Array([0x76]));

            const decoded = ArkadeScript.decode(encoded);
            expect(decoded).toEqual(["DUP"]);
        });

        it("should encode and decode multiple opcodes", () => {
            const encoded = ArkadeScript.encode([
                "DUP",
                "HASH160",
                "EQUALVERIFY",
            ]);
            expect(encoded).toEqual(new Uint8Array([0x76, 0xa9, 0x88]));

            const decoded = ArkadeScript.decode(encoded);
            expect(decoded).toEqual(["DUP", "HASH160", "EQUALVERIFY"]);
        });

        it("should encode and decode OP_0 (number 0)", () => {
            const encoded = ArkadeScript.encode([0]);
            expect(encoded).toEqual(new Uint8Array([0x00]));

            const decoded = ArkadeScript.decode(encoded);
            expect(decoded).toEqual([0]);
        });

        it("should encode and decode small data push (<= 75 bytes)", () => {
            const data = new Uint8Array(20).fill(0xab);
            const encoded = ArkadeScript.encode([data]);

            // Should be: <length> <data>
            expect(encoded[0]).toBe(20);
            expect(encoded.slice(1)).toEqual(data);

            const decoded = ArkadeScript.decode(encoded);
            expect(decoded.length).toBe(1);
            expect(decoded[0]).toEqual(data);
        });

        it("should encode and decode PUSHDATA1 (76-255 bytes)", () => {
            const data = new Uint8Array(100).fill(0xcd);
            const encoded = ArkadeScript.encode([data]);

            // Should be: OP_PUSHDATA1 <length:1> <data>
            expect(encoded[0]).toBe(0x4c);
            expect(encoded[1]).toBe(100);
            expect(encoded.slice(2)).toEqual(data);

            const decoded = ArkadeScript.decode(encoded);
            expect(decoded.length).toBe(1);
            expect(decoded[0]).toEqual(data);
        });

        it("should encode and decode PUSHDATA2 (256-65535 bytes)", () => {
            const data = new Uint8Array(300).fill(0xef);
            const encoded = ArkadeScript.encode([data]);

            // Should be: OP_PUSHDATA2 <length:2 LE> <data>
            expect(encoded[0]).toBe(0x4d);
            expect(encoded[1]).toBe(300 & 0xff);
            expect(encoded[2]).toBe((300 >> 8) & 0xff);
            expect(encoded.slice(3)).toEqual(data);

            const decoded = ArkadeScript.decode(encoded);
            expect(decoded.length).toBe(1);
            expect(decoded[0]).toEqual(data);
        });

        it("should encode and decode Arkade opcodes", () => {
            const script: ArkadeScriptType = [
                "SHA256INITIALIZE",
                "SHA256UPDATE",
                "SHA256FINALIZE",
                "INSPECTINPUTVALUE",
                "ADD64",
            ];

            const decoded = ArkadeScript.decode(ArkadeScript.encode(script));
            expect(decoded).toEqual(script);
        });

        it("should encode and decode mixed script", () => {
            const data1 = hex.decode("deadbeef");
            const data2 = new Uint8Array(32).fill(0x11);
            const script: ArkadeScriptType = [
                data1,
                "DUP",
                "INSPECTNUMASSETGROUPS",
                data2,
                "EQUALVERIFY",
            ];

            const decoded = ArkadeScript.decode(ArkadeScript.encode(script));
            expect(decoded[0]).toEqual(data1);
            expect(decoded[1]).toBe("DUP");
            expect(decoded[2]).toBe("INSPECTNUMASSETGROUPS");
            expect(decoded[3]).toEqual(data2);
            expect(decoded[4]).toBe("EQUALVERIFY");
        });

        it("should throw on truncated script (not enough data for push)", () => {
            const script = new Uint8Array([0x20]); // Says 32 bytes follow, but none do
            expect(() => ArkadeScript.decode(script)).toThrow();
        });

        it("should throw on truncated PUSHDATA1", () => {
            const script = new Uint8Array([0x4c]); // PUSHDATA1 without length
            expect(() => ArkadeScript.decode(script)).toThrow();
        });

        it("should throw on truncated PUSHDATA2", () => {
            const script = new Uint8Array([0x4d, 0x00]); // PUSHDATA2 with only 1 length byte
            expect(() => ArkadeScript.decode(script)).toThrow();
        });
    });
});

describe("ASM Conversion", () => {
    describe("toASM", () => {
        it("should convert opcodes to ASM", () => {
            expect(toASM(["DUP", "HASH160"])).toBe("OP_DUP OP_HASH160");
        });

        it("should convert data to hex in ASM", () => {
            expect(toASM([hex.decode("aabbccdd")])).toBe("aabbccdd");
        });

        it("should convert number 0 to OP_0", () => {
            expect(toASM([0])).toBe("OP_0");
        });

        it("should convert Arkade opcodes to ASM", () => {
            expect(toASM(["SHA256INITIALIZE", "ADD64", "TWEAKVERIFY"])).toBe(
                "OP_SHA256INITIALIZE OP_ADD64 OP_TWEAKVERIFY"
            );
        });

        it("should convert mixed script to ASM", () => {
            const pubKeyHash = hex.decode(
                "1234567890abcdef1234567890abcdef12345678"
            );
            expect(
                toASM(["DUP", "HASH160", pubKeyHash, "EQUALVERIFY", "CHECKSIG"])
            ).toBe(
                "OP_DUP OP_HASH160 1234567890abcdef1234567890abcdef12345678 OP_EQUALVERIFY OP_CHECKSIG"
            );
        });
    });

    describe("fromASM", () => {
        it("should parse ASM with OP_ prefix", () => {
            expect(fromASM("OP_DUP OP_HASH160")).toEqual(["DUP", "HASH160"]);
        });

        it("should parse ASM without OP_ prefix", () => {
            expect(fromASM("DUP HASH160")).toEqual(["DUP", "HASH160"]);
        });

        it("should parse ASM with hex data", () => {
            const result = fromASM("OP_DUP aabbccdd OP_EQUALVERIFY");
            expect(result[0]).toBe("DUP");
            expect(result[1]).toEqual(hex.decode("aabbccdd"));
            expect(result[2]).toBe("EQUALVERIFY");
        });

        it("should parse Arkade opcodes from ASM", () => {
            expect(
                fromASM("OP_SHA256INITIALIZE OP_ADD64 OP_TWEAKVERIFY")
            ).toEqual(["SHA256INITIALIZE", "ADD64", "TWEAKVERIFY"]);
        });

        it("should parse OP_0 as number 0", () => {
            expect(fromASM("OP_0")).toEqual([0]);
        });

        it("should parse OP_1 through OP_16 as numbers", () => {
            expect(fromASM("OP_1 OP_2 OP_16")).toEqual([1, 2, 16]);
        });

        it("should throw on invalid ASM token", () => {
            expect(() => fromASM("INVALID_OPCODE")).toThrow();
        });
    });

    describe("Round-trip ASM conversion", () => {
        it("should round-trip ASM conversion", () => {
            const original =
                "OP_DUP OP_HASH160 1234567890abcdef1234567890abcdef12345678 OP_EQUALVERIFY OP_CHECKSIG";
            expect(toASM(fromASM(original))).toBe(original);
        });

        it("should round-trip Arkade opcodes", () => {
            const original =
                "OP_INSPECTNUMASSETGROUPS OP_ADD64 deadbeef OP_EQUAL";
            expect(toASM(fromASM(original))).toBe(original);
        });
    });
});

describe("ArkadeScript CoderType", () => {
    describe("ARKADE_OPS", () => {
        it("should include standard Bitcoin opcodes", () => {
            expect(ARKADE_OPS.OP_0).toBe(0x00);
            expect(ARKADE_OPS.OP_1).toBe(0x51);
            expect(ARKADE_OPS.DUP).toBe(0x76);
            expect(ARKADE_OPS.CHECKSIG).toBe(0xac);
        });

        it("should include Arkade extension opcodes", () => {
            expect(ARKADE_OPS.SHA256INITIALIZE).toBe(0xc4);
            expect(ARKADE_OPS.ADD64).toBe(0xd7);
            expect(ARKADE_OPS.TWEAKVERIFY).toBe(0xe4);
            expect(ARKADE_OPS.INSPECTINASSETLOOKUP).toBe(0xf2);
        });
    });

    describe("encode", () => {
        it("should encode standard opcodes by string", () => {
            const bytes = ArkadeScript.encode(["DUP", "HASH160"]);
            expect(hex.encode(bytes)).toBe("76a9");
        });

        it("should encode Arkade opcodes by string", () => {
            const bytes = ArkadeScript.encode([
                "ADD64",
                "SUB64",
                "SHA256INITIALIZE",
            ]);
            expect(hex.encode(bytes)).toBe("d7d8c4");
        });

        it("should encode mixed Bitcoin + Arkade opcodes", () => {
            const script: ArkadeScriptType = [
                "DUP",
                "INSPECTOUTPUTVALUE",
                "ADD64",
                "EQUALVERIFY",
            ];
            const bytes = ArkadeScript.encode(script);
            expect(hex.encode(bytes)).toBe("76cfd788");
        });

        it("should encode raw bytes (data push)", () => {
            const pubkeyHash = hex.decode(
                "0102030405060708091011121314151617181920"
            );
            const bytes = ArkadeScript.encode([pubkeyHash]);
            // 20-byte push: length prefix (0x14) + data
            expect(bytes[0]).toBe(0x14);
            expect(hex.encode(bytes.slice(1))).toBe(
                "0102030405060708091011121314151617181920"
            );
        });

        it("should encode number 0 as OP_0", () => {
            const bytes = ArkadeScript.encode([0]);
            expect(bytes[0]).toBe(0x00);
            expect(bytes.length).toBe(1);
        });

        it("should encode numbers 1-16 as OP_1 through OP_16", () => {
            for (let i = 1; i <= 16; i++) {
                const bytes = ArkadeScript.encode([i]);
                expect(bytes[0]).toBe(0x50 + i); // OP_1=0x51, OP_2=0x52, ...
                expect(bytes.length).toBe(1);
            }
        });

        it("should throw for unknown opcode string", () => {
            expect(() =>
                ArkadeScript.encode(["NOTAREALOPCODE" as any])
            ).toThrow("Unknown opcode");
        });
    });

    describe("decode", () => {
        it("should decode standard opcodes to string names", () => {
            const decoded = ArkadeScript.decode(hex.decode("76a9"));
            expect(decoded).toEqual(["DUP", "HASH160"]);
        });

        it("should decode Arkade opcodes to string names", () => {
            const decoded = ArkadeScript.decode(hex.decode("d7d8c4"));
            expect(decoded).toEqual(["ADD64", "SUB64", "SHA256INITIALIZE"]);
        });

        it("should decode OP_0 as number 0", () => {
            const decoded = ArkadeScript.decode(hex.decode("00"));
            expect(decoded).toEqual([0]);
        });

        it("should decode OP_1 through OP_16 as numbers", () => {
            for (let i = 1; i <= 16; i++) {
                const opByte = (0x50 + i).toString(16);
                const decoded = ArkadeScript.decode(hex.decode(opByte));
                expect(decoded).toEqual([i]);
            }
        });

        it("should decode data pushes to Uint8Array", () => {
            // 4 bytes of data: 04 deadbeef
            const decoded = ArkadeScript.decode(hex.decode("04deadbeef"));
            expect(decoded.length).toBe(1);
            expect(decoded[0]).toBeInstanceOf(Uint8Array);
            expect(hex.encode(decoded[0] as Uint8Array)).toBe("deadbeef");
        });

        it("should throw for truly unknown opcodes", () => {
            // 0xc8 is in the Arkade range but not assigned
            expect(() => ArkadeScript.decode(new Uint8Array([0xc8]))).toThrow(
                "Unknown opcode"
            );
        });
    });

    describe("round-trip encode/decode", () => {
        it("should round-trip standard opcodes", () => {
            const script: ArkadeScriptType = [
                "IF",
                "DUP",
                "HASH160",
                "EQUALVERIFY",
                "CHECKSIG",
                "ENDIF",
            ];
            const decoded = ArkadeScript.decode(ArkadeScript.encode(script));
            expect(decoded).toEqual(script);
        });

        it("should round-trip Arkade opcodes", () => {
            const script: ArkadeScriptType = [
                "SHA256INITIALIZE",
                "SHA256UPDATE",
                "SHA256FINALIZE",
                "ADD64",
                "INSPECTOUTPUTVALUE",
                "TWEAKVERIFY",
            ];
            const decoded = ArkadeScript.decode(ArkadeScript.encode(script));
            expect(decoded).toEqual(script);
        });

        it("should round-trip mixed script with data", () => {
            const pubkey = hex.decode(
                "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
            );
            const script: ArkadeScriptType = [
                "DUP",
                "HASH160",
                pubkey,
                "EQUALVERIFY",
                "CHECKSIG",
                "INSPECTOUTPUTVALUE",
                "ADD64",
            ];
            const decoded = ArkadeScript.decode(ArkadeScript.encode(script));
            expect(decoded.length).toBe(script.length);
            expect(decoded[0]).toBe("DUP");
            expect(decoded[1]).toBe("HASH160");
            expect(hex.encode(decoded[2] as Uint8Array)).toBe(
                hex.encode(pubkey)
            );
            expect(decoded[3]).toBe("EQUALVERIFY");
            expect(decoded[4]).toBe("CHECKSIG");
            expect(decoded[5]).toBe("INSPECTOUTPUTVALUE");
            expect(decoded[6]).toBe("ADD64");
        });

        it("should round-trip numbers 0-16", () => {
            const script: ArkadeScriptType = [0, 1, 2, 15, 16];
            const decoded = ArkadeScript.decode(ArkadeScript.encode(script));
            expect(decoded).toEqual(script);
        });

        it("should round-trip all Arkade opcodes", () => {
            const allArkadeOps: ArkadeScriptType = Object.keys(
                ARKADE_OPS
            ).filter((k) => {
                const v = ARKADE_OPS[k as keyof typeof ARKADE_OPS];
                // Only include Arkade-range opcodes (0xc4+)
                return v >= 0xc4;
            }) as ArkadeScriptType;
            const decoded = ArkadeScript.decode(
                ArkadeScript.encode(allArkadeOps)
            );
            expect(decoded).toEqual(allArkadeOps);
        });
    });

    describe("compatibility with @scure/btc-signer Script", () => {
        it("should produce identical bytes for standard Bitcoin scripts", () => {
            const { Script } = require("@scure/btc-signer");
            const script: ArkadeScriptType = [
                "DUP",
                "HASH160",
                hex.decode("aabbccdd"),
                "EQUALVERIFY",
                "CHECKSIG",
            ];
            const arkadeBytes = ArkadeScript.encode(script);
            const scureBytes = Script.encode(script);
            expect(hex.encode(arkadeBytes)).toBe(hex.encode(scureBytes));
        });

        it("should decode standard scripts identically to @scure", () => {
            const { Script } = require("@scure/btc-signer");
            // P2PKH script: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
            const scriptHex =
                "76a914aabbccddaabbccddaabbccddaabbccddaabbccdd88ac";
            const arkadeDecoded = ArkadeScript.decode(hex.decode(scriptHex));
            const scureDecoded = Script.decode(hex.decode(scriptHex));
            expect(arkadeDecoded).toEqual(scureDecoded);
        });
    });
});

describe("ArkadeVtxoScript", () => {
    // Deterministic test keys (32-byte x-only pubkeys)
    const userPubkey = new Uint8Array(32).fill(0x01);
    const serverPubkey = new Uint8Array(32).fill(0x02);
    // Valid compressed introspector pubkey (secp256k1 generator point G)
    const introspectorPubkey = hex.decode(
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    );

    const arkadeScriptBytes = ArkadeScript.encode([
        0,
        "INSPECTOUTPUTSCRIPTPUBKEY",
        1,
        "EQUALVERIFY",
        new Uint8Array(32).fill(0xaa),
        "EQUAL",
    ]);

    it("should extend VtxoScript", () => {
        const multisig = MultisigTapscript.encode({
            pubkeys: [userPubkey, serverPubkey],
        });
        const vtxo = new ArkadeVtxoScript(
            [{ arkadeScript: arkadeScriptBytes, tapscript: multisig }],
            { introspectorPubkey }
        );
        expect(vtxo).toBeInstanceOf(VtxoScript);
    });

    it("should produce correct tweaked pubkey in multisig leaf", () => {
        const multisig = MultisigTapscript.encode({
            pubkeys: [userPubkey, serverPubkey],
        });
        const vtxo = new ArkadeVtxoScript(
            [{ arkadeScript: arkadeScriptBytes, tapscript: multisig }],
            { introspectorPubkey }
        );
        const expectedTweaked = computeArkadeScriptPublicKey(
            introspectorPubkey,
            arkadeScriptBytes
        );
        const expectedMultisig = MultisigTapscript.encode({
            pubkeys: [userPubkey, serverPubkey, expectedTweaked],
        });
        const manualVtxo = new VtxoScript([expectedMultisig.script]);
        expect(hex.encode(vtxo.tweakedPublicKey)).toBe(
            hex.encode(manualVtxo.tweakedPublicKey)
        );
    });

    it("should store arkade script bytes in arkadeScripts map", () => {
        const multisig = MultisigTapscript.encode({
            pubkeys: [userPubkey, serverPubkey],
        });
        const vtxo = new ArkadeVtxoScript(
            [{ arkadeScript: arkadeScriptBytes, tapscript: multisig }],
            { introspectorPubkey }
        );
        expect(vtxo.arkadeScripts.size).toBe(1);
        expect(hex.encode(vtxo.arkadeScripts.get(0)!)).toBe(
            hex.encode(arkadeScriptBytes)
        );
    });

    it("should pass through plain Uint8Array scripts unchanged", () => {
        const csvExit = CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 5120n },
            pubkeys: [userPubkey, serverPubkey],
        });
        const multisig = MultisigTapscript.encode({
            pubkeys: [userPubkey, serverPubkey],
        });
        const vtxo = new ArkadeVtxoScript(
            [
                { arkadeScript: arkadeScriptBytes, tapscript: multisig },
                csvExit.script,
            ],
            { introspectorPubkey }
        );
        expect(vtxo.leaves).toHaveLength(2);
        expect(vtxo.arkadeScripts.has(0)).toBe(true);
        expect(vtxo.arkadeScripts.has(1)).toBe(false);
    });

    it("should match manual VtxoScript with arkade multisig + CSV exit", () => {
        const expectedTweaked = computeArkadeScriptPublicKey(
            introspectorPubkey,
            arkadeScriptBytes
        );
        const multisig = MultisigTapscript.encode({
            pubkeys: [userPubkey, serverPubkey],
        });
        const csvExit = CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 5120n },
            pubkeys: [userPubkey, serverPubkey],
        });
        const vtxo = new ArkadeVtxoScript(
            [
                { arkadeScript: arkadeScriptBytes, tapscript: multisig },
                csvExit.script,
            ],
            { introspectorPubkey }
        );
        const manualMultisig = MultisigTapscript.encode({
            pubkeys: [userPubkey, serverPubkey, expectedTweaked],
        });
        const manualVtxo = new VtxoScript([
            manualMultisig.script,
            csvExit.script,
        ]);
        expect(hex.encode(vtxo.tweakedPublicKey)).toBe(
            hex.encode(manualVtxo.tweakedPublicKey)
        );
        expect(hex.encode(vtxo.pkScript)).toBe(hex.encode(manualVtxo.pkScript));
    });

    it("should work with CSVMultisigTapscript as arkade closure", () => {
        const csv = CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 100n },
            pubkeys: [userPubkey],
        });
        const vtxo = new ArkadeVtxoScript(
            [{ arkadeScript: arkadeScriptBytes, tapscript: csv }],
            { introspectorPubkey }
        );
        const expectedTweaked = computeArkadeScriptPublicKey(
            introspectorPubkey,
            arkadeScriptBytes
        );
        const manualCsv = CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 100n },
            pubkeys: [userPubkey, expectedTweaked],
        });
        const manualVtxo = new VtxoScript([manualCsv.script]);
        expect(hex.encode(vtxo.tweakedPublicKey)).toBe(
            hex.encode(manualVtxo.tweakedPublicKey)
        );
    });

    it("should support multiple arkade leaves", () => {
        const arkadeScript2 = ArkadeScript.encode([
            "INSPECTNUMASSETGROUPS",
            1,
            "EQUAL",
        ]);
        const multisig1 = MultisigTapscript.encode({
            pubkeys: [userPubkey, serverPubkey],
        });
        const multisig2 = MultisigTapscript.encode({
            pubkeys: [userPubkey],
        });
        const vtxo = new ArkadeVtxoScript(
            [
                { arkadeScript: arkadeScriptBytes, tapscript: multisig1 },
                { arkadeScript: arkadeScript2, tapscript: multisig2 },
            ],
            { introspectorPubkey }
        );
        expect(vtxo.leaves).toHaveLength(2);
        expect(vtxo.arkadeScripts.size).toBe(2);
        expect(hex.encode(vtxo.arkadeScripts.get(0)!)).toBe(
            hex.encode(arkadeScriptBytes)
        );
        expect(hex.encode(vtxo.arkadeScripts.get(1)!)).toBe(
            hex.encode(arkadeScript2)
        );
    });

    it("should work with no arkade leaves (all plain scripts)", () => {
        const csvExit = CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 5120n },
            pubkeys: [userPubkey, serverPubkey],
        });
        const multisig = MultisigTapscript.encode({
            pubkeys: [userPubkey, serverPubkey],
        });
        const vtxo = new ArkadeVtxoScript([multisig.script, csvExit.script], {
            introspectorPubkey,
        });
        const manualVtxo = new VtxoScript([multisig.script, csvExit.script]);
        expect(hex.encode(vtxo.tweakedPublicKey)).toBe(
            hex.encode(manualVtxo.tweakedPublicKey)
        );
        expect(vtxo.arkadeScripts.size).toBe(0);
    });
});
