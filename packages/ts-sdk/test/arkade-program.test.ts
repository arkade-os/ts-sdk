import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { ScriptNum } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    arkade,
    CSVMultisigTapscript,
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
} from "../src";

const MinimalScriptNum = ScriptNum(undefined, true);

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

describe("Typed program params — authoritative when present", () => {
    function typedProgram(): arkade.Program {
        return {
            version: 0,
            params: [
                { name: "user", type: "pubkey" },
                { name: "exit", type: "int" },
            ],
            functions: {
                exit: {
                    tapscript: { signers: ["$user"], csv: { type: "blocks", value: "$exit" } },
                },
            },
        };
    }

    it("compiles when every declared param is bound with the right type", () => {
        const script = new arkade.ArkadeProgramScript(typedProgram(), { user, exit: 144n }, keys);
        const expected = CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 144n },
            pubkeys: [user],
        });
        expect(hex.encode(script.compiled[0].leafScript)).toBe(hex.encode(expected.script));
    });

    it('rejects an undeclared "$param" reference', () => {
        const program = typedProgram();
        program.functions.exit.tapscript.witness = ["$secret"];
        expect(
            () => new arkade.ArkadeProgramScript(program, { user, exit: 144n, secret: user }, keys),
        ).toThrow(/'\$secret' is referenced but not declared/);
    });

    it("rejects a declared param missing from args", () => {
        expect(() => new arkade.ArkadeProgramScript(typedProgram(), { user }, keys)).toThrow(
            /parameter 'exit' is declared but not bound/,
        );
    });

    it("rejects a typed pubkey param bound to a 33-byte array", () => {
        expect(
            () =>
                new arkade.ArkadeProgramScript(
                    typedProgram(),
                    { user: new Uint8Array(33), exit: 144n },
                    keys,
                ),
        ).toThrow(/parameter 'user' expects a 32-byte pubkey, got 33 bytes/);
    });

    it("rejects a typed int param bound to bytes", () => {
        expect(
            () =>
                new arkade.ArkadeProgramScript(
                    typedProgram(),
                    { user, exit: new Uint8Array(4) },
                    keys,
                ),
        ).toThrow(/parameter 'exit' expects an int/);
    });

    it("keeps bare-string params advisory (undeclared references still compile)", () => {
        // Legacy hand-written form: `$h` is referenced but not declared — no
        // authority checks apply because no entry is typed.
        const program: arkade.Program = {
            version: 0,
            params: ["user"],
            functions: {
                lock: {
                    tapscript: {
                        signers: ["$user"],
                        asm: ["HASH160", "$h", "EQUALVERIFY"],
                        witness: ["preimage"],
                    },
                },
            },
        };
        const script = new arkade.ArkadeProgramScript(
            program,
            { user, h: new Uint8Array(20) },
            keys,
        );
        expect(script.compiled).toHaveLength(1);
    });
});

describe("Type-directed persistence", () => {
    const baseProgram = (params: arkade.Program["params"]): arkade.Program => ({
        version: 0,
        params,
        functions: {
            exit: { tapscript: { signers: ["$user"], csv: { type: "blocks", value: "$exit" } } },
        },
    });

    it("deserializes a typed int param from a decimal string to bigint", () => {
        const program = baseProgram([
            { name: "user", type: "pubkey" },
            { name: "exit", type: "int" },
        ]);
        const stored = arkade.serializeArkadeContractParams({
            program,
            args: { user, exit: 144n },
            serverKey: server,
        });
        expect(JSON.parse(stored.args).exit).toBe("144"); // persisted as decimal string
        const typed = arkade.deserializeArkadeContractParams(stored);
        expect(typed.args.exit).toBe(144n);
        expect(typed.args.user).toEqual(user);
    });

    it('throws for a typed bytes param persisted without a "0x" prefix', () => {
        // Regression this feature prevents: under the untyped 0x/BigInt
        // heuristic a bytes value like "1234" silently deserialized to the
        // bigint 1234n instead of erroring.
        const program = baseProgram([
            { name: "user", type: "pubkey" },
            { name: "exit", type: "int" },
            { name: "payload", type: "bytes" },
        ]);
        const stored = {
            program: arkade.stringifyArtifact(program),
            args: JSON.stringify({ user: "0x" + hex.encode(user), exit: "144", payload: "1234" }),
            serverKey: hex.encode(server),
        };
        expect(() => arkade.deserializeArkadeContractParams(stored)).toThrow(
            /'payload' expects bytes as 0x-prefixed hex/,
        );
    });

    it("keeps the 0x/BigInt heuristic for untyped params", () => {
        const program = baseProgram(["user", "exit"]);
        const stored = arkade.serializeArkadeContractParams({
            program,
            args: { user, exit: 144n },
            serverKey: server,
        });
        const typed = arkade.deserializeArkadeContractParams(stored);
        expect(typed.args.exit).toBe(144n);
        expect(typed.args.user).toEqual(user);
    });
});

describe("Program name & full-feature artifact round-trip", () => {
    it("name is metadata only — it never changes the compiled tree", () => {
        const base: arkade.Program = {
            version: 0,
            functions: {
                exit: { tapscript: { signers: ["$user"], csv: { type: "blocks", value: 144n } } },
            },
        };
        const named: arkade.Program = { ...base, name: "wallet" };
        const a = new arkade.ArkadeProgramScript(base, { user }, keys);
        const b = new arkade.ArkadeProgramScript(named, { user }, keys);
        expect(hex.encode(b.pkScript)).toBe(hex.encode(a.pkScript));
    });

    it("a program exercising every feature survives the artifact round-trip", () => {
        const hash = new Uint8Array(20).fill(7);
        const HUGE = 2n ** 60n; // above Number.MAX_SAFE_INTEGER
        const program: arkade.Program = {
            version: 0,
            name: "vault",
            params: [
                { name: "user", type: "pubkey" },
                { name: "server", type: "pubkey" },
                { name: "hash", type: "hash" },
                { name: "amount", type: "int" },
                { name: "exit", type: "int" },
            ],
            functions: {
                claim: {
                    inputs: [{ name: "preimage", type: "bytes" }],
                    tapscript: {
                        signers: ["$server"],
                        asm: ["HASH160", "$hash", "EQUALVERIFY"],
                        witness: ["preimage"],
                    },
                    arkadeScript: {
                        asm: ["INSPECTOUTPUTVALUE", "$amount", HUGE, "EQUAL"],
                        witness: [0, "$hash"],
                    },
                },
                reclaim: {
                    // condition + csv, with a "$param" csv value
                    tapscript: {
                        signers: ["$user"],
                        asm: ["HASH160", "$hash", "EQUAL"],
                        csv: { type: "blocks", value: "$exit" },
                    },
                },
                refund: {
                    tapscript: { signers: ["$user", "$server"], cltv: 900_000n },
                },
            },
        };

        const rt = arkade.parseArtifact(JSON.parse(arkade.stringifyArtifact(program)));

        // Bigint tokens above Number.MAX_SAFE_INTEGER canonicalize to their
        // minimal script-num byte push (the script encoder pushes both forms
        // identically); everything else survives structurally unchanged.
        const expected: arkade.Program = {
            ...program,
            functions: {
                ...program.functions,
                claim: {
                    ...program.functions.claim,
                    arkadeScript: {
                        ...program.functions.claim.arkadeScript!,
                        asm: [
                            "INSPECTOUTPUTVALUE",
                            "$amount",
                            MinimalScriptNum.encode(HUGE),
                            "EQUAL",
                        ],
                    },
                },
            },
        };
        expect(rt).toEqual(expected);
        // ...and the parsed form is a fixpoint of the round trip.
        expect(arkade.parseArtifact(JSON.parse(arkade.stringifyArtifact(rt)))).toEqual(rt);

        // The canonicalization is semantics-preserving: both forms compile to
        // the same taproot tree.
        const args = { user, server, hash, amount: 10_000n, exit: 144n };
        const fullKeys = { serverKey: server, userKey: user, emulatorKey: xOnly() };
        const a = new arkade.ArkadeProgramScript(program, args, fullKeys);
        const b = new arkade.ArkadeProgramScript(rt, args, fullKeys);
        expect(hex.encode(b.pkScript)).toBe(hex.encode(a.pkScript));
    });
});
