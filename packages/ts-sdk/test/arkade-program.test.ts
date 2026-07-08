import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    arkade,
    CSVMultisigTapscript,
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
} from "../src";

function xOnly(): Uint8Array {
    return schnorr.getPublicKey(schnorr.utils.randomSecretKey());
}

const server = xOnly();
const user = xOnly();
const keys = { serverKey: server };

describe("Program timelocks — literal and $param values", () => {
    it('resolves a "$param" csv value to a leaf byte-identical to the literal', () => {
        const program: arkade.Program = {
            version: 0,
            functions: {
                exit: {
                    tapscript: { signers: ["$user"], csv: { type: "blocks", value: "$exit" } },
                },
            },
        };
        const script = new arkade.ArkadeProgramScript(program, { user, exit: 144n }, keys);
        const expected = CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 144n },
            pubkeys: [user],
        });
        expect(hex.encode(script.compiled[0].leafScript)).toBe(hex.encode(expected.script));
    });

    it('resolves a "$param" cltv value to a leaf byte-identical to the literal', () => {
        const program: arkade.Program = {
            version: 0,
            functions: {
                refund: {
                    tapscript: { signers: ["$user", "$server"], cltv: "$expiry" },
                },
            },
        };
        const script = new arkade.ArkadeProgramScript(
            program,
            { user, server, expiry: 900_000n },
            keys,
        );
        const expected = CLTVMultisigTapscript.encode({
            absoluteTimelock: 900_000n,
            pubkeys: [user, server],
        });
        expect(hex.encode(script.compiled[0].leafScript)).toBe(hex.encode(expected.script));
    });

    it("rejects a non-$param string timelock value", () => {
        const program: arkade.Program = {
            version: 0,
            functions: {
                exit: {
                    tapscript: { signers: ["$user"], csv: { type: "blocks", value: "144" } },
                },
            },
        };
        expect(() => new arkade.ArkadeProgramScript(program, { user }, keys)).toThrow(
            /invalid timelock value/i,
        );
    });

    it('rejects a "$param" timelock bound to bytes', () => {
        const program: arkade.Program = {
            version: 0,
            functions: {
                exit: {
                    tapscript: { signers: ["$user"], csv: { type: "blocks", value: "$exit" } },
                },
            },
        };
        expect(
            () => new arkade.ArkadeProgramScript(program, { user, exit: new Uint8Array(4) }, keys),
        ).toThrow(/timelock value '\$exit' must resolve to a number/i);
    });

    it("encodes asm + csv as a ConditionCSVMultisig leaf (byte-identical)", () => {
        const hash = new Uint8Array(20).fill(7);
        const condition: arkade.AsmToken[] = ["HASH160", hash, "EQUAL"];
        const program: arkade.Program = {
            version: 0,
            functions: {
                reclaim: {
                    tapscript: {
                        signers: ["$user"],
                        asm: condition,
                        csv: { type: "blocks", value: "$exit" },
                    },
                },
            },
        };
        const script = new arkade.ArkadeProgramScript(program, { user, exit: 144n }, keys);
        const expected = ConditionCSVMultisigTapscript.encode({
            conditionScript: arkade.resolveAsm(condition, {}),
            timelock: { type: "blocks", value: 144n },
            pubkeys: [user],
        });
        expect(hex.encode(script.compiled[0].leafScript)).toBe(hex.encode(expected.script));
    });

    it("rejects asm + cltv (arkd has no condition+CLTV closure)", () => {
        const program: arkade.Program = {
            version: 0,
            functions: {
                bad: {
                    tapscript: {
                        signers: ["$user"],
                        asm: ["HASH160", new Uint8Array(20), "EQUAL"],
                        cltv: 900_000n,
                    },
                },
            },
        };
        expect(() => new arkade.ArkadeProgramScript(program, { user }, keys)).toThrow(
            /`asm` and `cltv` conflict/,
        );
    });

    it("still rejects csv + cltv", () => {
        const program: arkade.Program = {
            version: 0,
            functions: {
                bad: {
                    tapscript: {
                        signers: ["$user"],
                        csv: { type: "blocks", value: 144n },
                        cltv: 900_000n,
                    },
                },
            },
        };
        expect(() => new arkade.ArkadeProgramScript(program, { user }, keys)).toThrow(
            /`csv` and `cltv` conflict/,
        );
    });

    it('round-trips a "$param" csv reference and a literal cltv through the artifact JSON', () => {
        const program: arkade.Program = {
            version: 0,
            functions: {
                exit: {
                    tapscript: { signers: ["$user"], csv: { type: "blocks", value: "$exit" } },
                },
                refund: {
                    tapscript: { signers: ["$user", "$server"], cltv: 900_000n },
                },
            },
        };
        const rt = arkade.parseArtifact(JSON.parse(arkade.stringifyArtifact(program)));
        expect(rt).toEqual(program);
        expect(rt.functions.exit.tapscript.csv?.value).toBe("$exit");
        expect(rt.functions.refund.tapscript.cltv).toBe(900_000n);
    });
});
