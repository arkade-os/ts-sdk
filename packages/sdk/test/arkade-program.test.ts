import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { ScriptNum } from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    arkade,
    MultisigTapscript,
    CSVMultisigTapscript,
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
} from "../src";
import { validateParamValue, validateTapscript } from "../src/arkade/program";

const MinimalScriptNum = ScriptNum(undefined, true);

function xOnly(): Uint8Array {
    return schnorr.getPublicKey(schnorr.utils.randomSecretKey());
}

const server = xOnly();
const user = xOnly();
const keys = { serverKey: server };

describe("Native scalar validation", () => {
    it.each([
        ["pubkey", 32],
        ["signature", 64],
        ["bytes20", 20],
        ["bytes32", 32],
        ["asset", 32],
    ] as const)("enforces the native %s width without extra metadata", (type, length) => {
        const def = { name: "value", type };
        expect(() => validateParamValue(def, new Uint8Array(length))).not.toThrow();
        for (const size of [length - 1, length + 1]) {
            expect(() => validateParamValue(def, new Uint8Array(size))).toThrow(/byte/);
        }
        expect(() => validateParamValue(def, 1n)).toThrow(/bytes/);
    });

    it.each(["int", "bool", "AssetGroup"] as const)("validates numeric %s values", (type) => {
        const def = { name: "value", type };
        for (const value of [0, 1, 0n, 1n]) {
            expect(() => validateParamValue(def, value)).not.toThrow();
        }
        for (const value of [0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, new Uint8Array()]) {
            expect(() => validateParamValue(def, value)).toThrow();
        }
        if (type === "bool") {
            for (const value of [-1, 2, -1n, 2n]) {
                expect(() => validateParamValue(def, value)).toThrow(/0 or 1/);
            }
        }
    });

    it("allows arbitrary byte lengths for bytes", () => {
        for (const length of [0, 20, 32, 64, 65]) {
            expect(() =>
                validateParamValue({ name: "value", type: "bytes" }, new Uint8Array(length)),
            ).not.toThrow();
        }
    });

    it.each([["hash"], ["sig"], ["toString"], [["bytes"]], [{}], [null]])(
        "rejects non-native type %j",
        (type) => {
            const def = { name: "value", type };
            expect(() => validateParamValue(def as never, user)).toThrow(/unknown type/);
            expect(() => arkade.parseArtifact({ params: [def] as never, functions: {} })).toThrow(
                /typed.*declarations/,
            );
        },
    );
});

describe("Program timelocks — literal and $param values", () => {
    it('resolves a "$param" csv value to a leaf byte-identical to the literal', () => {
        const program: arkade.Program = {
            version: 1,
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
        const script = new arkade.ArkadeProgramScript(program, { user, exit: 144n }, keys);
        const expected = CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 144n },
            pubkeys: [user],
        });
        expect(hex.encode(script.compiled[0].leafScript)).toBe(hex.encode(expected.script));
    });

    it('resolves a "$param" cltv value to a leaf byte-identical to the literal', () => {
        const program: arkade.Program = {
            version: 1,
            params: [
                { name: "user", type: "pubkey" },
                { name: "server", type: "pubkey" },
                { name: "expiry", type: "int" },
            ],
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
            version: 1,
            params: [{ name: "user", type: "pubkey" }],
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
            version: 1,
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
        expect(
            () => new arkade.ArkadeProgramScript(program, { user, exit: new Uint8Array(4) }, keys),
        ).toThrow(/parameter 'exit' expects int/);
    });

    it("encodes asm + csv as a ConditionCSVMultisig leaf (byte-identical)", () => {
        const hash = new Uint8Array(20).fill(7);
        const condition: arkade.AsmToken[] = ["HASH160", hash, "EQUAL"];
        const program: arkade.Program = {
            version: 1,
            params: [
                { name: "user", type: "pubkey" },
                { name: "exit", type: "int" },
            ],
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
            version: 1,
            params: [{ name: "user", type: "pubkey" }],
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
            version: 1,
            params: [{ name: "user", type: "pubkey" }],
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
            version: 1,
            params: [
                { name: "user", type: "pubkey" },
                { name: "exit", type: "int" },
                { name: "server", type: "pubkey" },
            ],
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

    it('round-trips a "sequence" csv and still decodes it to the seconds leaf', () => {
        const program: arkade.Program = {
            version: 1,
            params: [
                { name: "user", type: "pubkey" },
                { name: "exit", type: "int" },
            ],
            functions: {
                exit: {
                    tapscript: { signers: ["$user"], csv: { type: "sequence", value: "$exit" } },
                },
            },
        };
        const rt = arkade.parseArtifact(JSON.parse(arkade.stringifyArtifact(program)));
        expect(rt).toEqual(program);
        const script = new arkade.ArkadeProgramScript(rt, { user, exit: 4_194_472n }, keys);
        const expected = CSVMultisigTapscript.encode({
            timelock: { type: "seconds", value: 86_016n },
            pubkeys: [user],
        });
        expect(hex.encode(script.compiled[0].leafScript)).toBe(hex.encode(expected.script));
    });
});

describe("Typed program params — authoritative when present", () => {
    function typedProgram(): arkade.Program {
        return {
            version: 1,
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

    it("rejects unsafe numeric integers", () => {
        expect(() =>
            arkade.validateProgram(typedProgram(), { user, exit: Number.MAX_SAFE_INTEGER + 1 }),
        ).toThrow(/safe integer/);
    });

    it("defaults omitted JSON versions to v1 and rejects explicit v0", () => {
        const artifact = { functions: { spend: { tapscript: { signers: [user] } } } };
        const program = arkade.parseArtifact(artifact);
        expect(program.version).toBe(1);
        expect(Object.getPrototypeOf(program.functions)).toBe(null);
        expect(JSON.parse(arkade.stringifyArtifact(program)).version).toBe(1);
        expect(() => arkade.parseArtifact({ ...artifact, version: 0 })).toThrow(
            /unsupported program version 0/,
        );
        expect(() => new arkade.ArkadeProgramScript({ ...program, version: 0 }, {}, keys)).toThrow(
            /unsupported program version 0/,
        );
        const stored = arkade.serializeArkadeContractParams({
            program: { ...program, version: 0 },
            args: {},
            serverKey: server,
        });
        expect(() => arkade.deserializeArkadeContractParams(stored)).toThrow(
            /unsupported program version 0/,
        );
    });

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

    it("rejects inherited constructor bindings", () => {
        expect(
            () =>
                new arkade.ArkadeProgramScript(
                    typedProgram(),
                    Object.create({ user, exit: 144n }),
                    keys,
                ),
        ).toThrow(/not bound/);
    });

    it("rejects undeclared arguments before constructing a contract", () => {
        expect(
            () =>
                new arkade.ArkadeProgramScript(
                    typedProgram(),
                    { user, exit: 144n, unknown: 1n },
                    keys,
                ),
        ).toThrow(/undeclared argument 'unknown'/);
    });

    it.each([null, 42, true, { role: "oracle" }])(
        "rejects signer %j where a key belongs",
        (signer) => {
            const program = typedProgram();
            program.functions.exit.tapscript.signers = [signer as never];
            expect(
                () => new arkade.ArkadeProgramScript(program, { user, exit: 144n }, keys),
            ).toThrow(/unknown signer reference/);
        },
    );

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
        ).toThrow(/parameter 'exit' expects int/);
    });

    it("rejects bare parameter and input declarations", () => {
        const functions = { spend: { tapscript: { signers: [user] } } };
        expect(() => arkade.parseArtifact({ params: ["user"] as never, functions })).toThrow(
            /typed.*declarations/,
        );
        expect(() =>
            arkade.parseArtifact({
                functions: { spend: { ...functions.spend, inputs: ["preimage"] } },
            }),
        ).toThrow(/typed.*declarations/);
    });
});

describe("Type-directed persistence", () => {
    const baseProgram = (params: readonly arkade.InputRef[]): arkade.Program => ({
        version: 1,
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

    it("round-trips a constructor parameter named __proto__", () => {
        const program = baseProgram([
            { name: "user", type: "pubkey" },
            { name: "exit", type: "int" },
            { name: "__proto__", type: "bytes" },
        ]);
        program.functions.exit.tapscript.asm = ["$__proto__", "DROP", 1];
        const args = { user, exit: 144n, ["__proto__"]: new Uint8Array([1, 2, 3]) };
        const stored = arkade.serializeArkadeContractParams({ program, args, serverKey: server });
        const recovered = arkade.deserializeArkadeContractParams(stored);
        expect(Object.hasOwn(JSON.parse(stored.args), "__proto__")).toBe(true);
        expect(Object.hasOwn(recovered.args, "__proto__")).toBe(true);
        expect(recovered.args.__proto__).toEqual(args.__proto__);
        expect(
            new arkade.ArkadeProgramScript(recovered.program, recovered.args, keys).pkScript,
        ).toEqual(new arkade.ArkadeProgramScript(program, args, keys).pkScript);
    });

    it("rejects undeclared persisted arguments", () => {
        const stored = arkade.serializeArkadeContractParams({
            program: baseProgram([
                { name: "user", type: "pubkey" },
                { name: "exit", type: "int" },
            ]),
            args: { user, exit: 144n, unknown: 1n },
            serverKey: server,
        });
        expect(() => arkade.deserializeArkadeContractParams(stored)).toThrow(
            /undeclared argument 'unknown'/,
        );
    });
});

describe("parseArtifact — structural validation", () => {
    it.each([[null], [42], [true], ["spend"], [[]]])("rejects function entry %j", (fn) => {
        expect(() => arkade.parseArtifact({ functions: { spend: fn } })).toThrow(
            /parseArtifact: function 'spend' must be an object/,
        );
    });

    it.each([[null], [42], [true], ["spend"], [[]]])("rejects tapscript %j", (tapscript) => {
        expect(() => arkade.parseArtifact({ functions: { spend: { tapscript } } })).toThrow(
            /parseArtifact: function 'spend' tapscript must be an object/,
        );
    });

    it.each(["params", "inputs", "signatures"] as const)(
        "validates %s as an array of typed declarations",
        (field) => {
            for (const value of [null, "input", { name: "input", type: "bytes" }, ["input"]]) {
                const artifact = {
                    ...(field === "params" ? { params: value } : {}),
                    functions: {
                        spend: {
                            ...(field === "inputs" ? { inputs: value } : {}),
                            tapscript: {
                                signers: [user],
                                ...(field === "signatures" ? { signatures: value } : {}),
                            },
                        },
                    },
                };
                expect(() => arkade.parseArtifact(artifact as never)).toThrow(
                    /parseArtifact: .*typed.*declarations/,
                );
            }
        },
    );

    it.each([-1, 0.5, NaN, Infinity, "0", null])(
        "rejects emulator position %s at import and restore",
        (emulatorIndex) => {
            const artifact = {
                version: 1,
                functions: { spend: { tapscript: { signers: [user], emulatorIndex } } },
            };
            expect(() => arkade.parseArtifact(artifact)).toThrow(
                /parseArtifact: function 'spend' has an invalid emulator position/,
            );
            expect(() =>
                arkade.deserializeArkadeContractParams({
                    program: JSON.stringify(artifact),
                    args: "{}",
                    serverKey: hex.encode(server),
                }),
            ).toThrow(/parseArtifact: function 'spend' has an invalid emulator position/);
        },
    );

    it.each([null, 42, true, { role: "oracle" }])(
        "rejects signer %j before compilation",
        (signer) => {
            expect(() =>
                arkade.parseArtifact({
                    version: 1,
                    functions: { exit: { tapscript: { signers: [signer] } } },
                }),
            ).toThrow(/tweaked signer needs string `tweak` and `fn`/);
        },
    );

    it("round-trips a valid TweakedSigner", () => {
        const tweaked = { tweak: "$insurer", fn: "claim" };
        const program = arkade.parseArtifact({
            version: 1,
            functions: { exit: { tapscript: { signers: [tweaked] } } },
        });
        expect(program.functions.exit.tapscript.signers[0]).toEqual(tweaked);
        expect(
            arkade.parseArtifact(JSON.parse(arkade.stringifyArtifact(program))).functions.exit
                .tapscript.signers[0],
        ).toEqual(tweaked);
    });
});

describe("Tapscript signer validation", () => {
    it("rejects an empty signer list even with emulator metadata", () => {
        expect(() => validateTapscript({ signers: [], emulatorIndex: 0 })).toThrow(
            /at least one signer/,
        );
        expect(
            () =>
                new arkade.ArkadeProgramScript(
                    {
                        version: 1,
                        functions: { spend: { tapscript: { signers: [], emulatorIndex: 0 } } },
                    },
                    {},
                    keys,
                ),
        ).toThrow(/without an emulator/);
    });

    it("validates the resolved emulator signer when its position is omitted", () => {
        const program: arkade.Program = {
            version: 1,
            functions: {
                spend: { tapscript: { signers: [] }, arkadeScript: { asm: [1] } },
            },
        };
        const script = new arkade.ArkadeProgramScript(program, {}, { ...keys, emulatorKey: user });
        expect(script.compiled[0].leafScript).toEqual(
            MultisigTapscript.encode({
                pubkeys: [
                    arkade.computeArkadeScriptPublicKey(user, script.compiled[0].arkadeScript!),
                ],
            }).script,
        );
    });
});

describe("Program name & full-feature artifact round-trip", () => {
    it("name is metadata only — it never changes the compiled tree", () => {
        const base: arkade.Program = {
            version: 1,
            params: [{ name: "user", type: "pubkey" }],
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
            version: 1,
            name: "vault",
            params: [
                { name: "user", type: "pubkey" },
                { name: "server", type: "pubkey" },
                { name: "hash", type: "bytes20" },
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
