import { describe, expect, it } from "vitest";
import { arkade } from "../src";

describe("compiler variable assignment opcode", () => {
    it("round-trips OP_PUT at the emulator's byte", () => {
        expect(arkade.getOpcodeValue("PUT")).toBe(0xbb);
        expect(arkade.getOpcodeValue("OP_PUT")).toBe(0xbb);
        expect(arkade.getOpcodeName(0xbb)).toBe("OP_PUT");

        const bytes = new Uint8Array([0x51, 0x00, 0xbb]);
        expect(arkade.ArkadeScript.encode(arkade.fromASM("OP_1 OP_0 OP_PUT"))).toEqual(bytes);
        expect(arkade.ArkadeScript.decode(bytes)).toEqual([1, 0, "PUT"]);
        expect(arkade.bytesToASM(bytes)).toBe("OP_1 OP_0 OP_PUT");
    });

    it("assembles a compiler artifact containing OP_PUT", () => {
        const program = arkade.programFromArtifact({
            contractName: "Assignment",
            constructorInputs: [],
            functions: [
                {
                    name: "advance",
                    arkade: { inputs: [], asm: ["OP_1", "OP_0", "OP_PUT", "OP_1"] },
                    leaves: [
                        {
                            name: "advance",
                            asm: [
                                "<SERVER_KEY>",
                                "OP_CHECKSIGVERIFY",
                                "<EMULATOR_KEY:advance>",
                                "OP_CHECKSIG",
                            ],
                        },
                    ],
                },
            ],
        });
        const asm = program.functions.advance.arkadeScript!.asm;
        expect(asm).toEqual(["OP_1", "OP_0", "PUT", "OP_1"]);
        expect(arkade.resolveAsm(asm, {})).toEqual(new Uint8Array([0x51, 0x00, 0xbb, 0x51]));
    });
});
