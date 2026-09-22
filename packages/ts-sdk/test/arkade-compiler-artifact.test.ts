import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";

import { programFromArtifact, type ContractArtifact } from "../src/arkade/artifact";
import { ArkadeProgramScript, parseArtifact, type ArkadeParamValue } from "../src/arkade/program";
import { ArkadeScript } from "../src/arkade/script";
import { computeArkadeScriptPublicKey } from "../src/arkade/tweak";
import { MultisigTapscript } from "../src/script/tapscript";
import { networks } from "../src/networks";

const artifact: ContractArtifact = JSON.parse(
    readFileSync(new URL("./fixtures/arkadec/escrow.artifact.json", import.meta.url), "utf8"),
);

const key = (byte: number) => new Uint8Array(32).fill(byte);
const SERVER_KEY = key(0x01);
const EMULATOR_KEY = hex.decode(`02${"02".repeat(32)}`);
const ARGS: Record<string, ArkadeParamValue> = {
    partyAPk: key(0x04),
    partyBPk: key(0x05),
    oraclePk: key(0x06),
    oracleMessageHash: key(0x7a),
    partyAScript: key(0xa1),
    partyBScript: key(0xb2),
    settlementAmount: 500_000n,
    timeoutHeight: 900_000n,
    exit: 1_008n,
    server: SERVER_KEY,
};

const collab = (name: string, prefix: string[] = []) => ({
    name,
    asm: [
        ...prefix,
        "<SERVER_KEY>",
        "OP_CHECKSIGVERIFY",
        `<EMULATOR_KEY:${name.split("/")[0]}>`,
        "OP_CHECKSIG",
    ],
});

function assemble(tokens: string[], extra: Record<string, Uint8Array> = {}): Uint8Array {
    return ArkadeScript.encode(
        tokens.map((token) => {
            if (token.startsWith("OP_")) {
                const base = token.slice(3);
                return base === "0" || /^([1-9]|1[0-6])$/.test(base) ? token : base;
            }
            if (token.startsWith("<") && token.endsWith(">")) {
                const value = extra[token.slice(1, -1)] ?? ARGS[token.slice(1, -1)];
                if (value === undefined) throw new Error(`unbound ${token}`);
                return value instanceof Uint8Array ? value : BigInt(value);
            }
            return token.startsWith("0x") ? hex.decode(token.slice(2)) : BigInt(token);
        }) as never,
    );
}

const demo = (extra: Record<string, unknown> = {}): ContractArtifact =>
    ({
        contractName: "T",
        constructorInputs: [],
        functions: [
            { name: "spend", leaves: [{ name: "spend", asm: ["<SERVER_KEY>", "OP_CHECKSIG"] }] },
        ],
        ...extra,
    }) as ContractArtifact;

describe("reading an arkadec artifact", () => {
    it("parseArtifact points at the reader for the array shape", () => {
        expect(() => parseArtifact(artifact as never)).toThrow(/programFromArtifact/);
    });

    it("reads the escrow artifact into the same program and the same bytes", () => {
        const program = programFromArtifact(artifact);
        expect(Object.keys(program.functions)).toEqual(["complete", "cancel", "unilateral"]);
        expect(program.functions.unilateral.tapscript).toMatchObject({
            signers: ["$partyAPk", "$partyBPk"],
            csv: { type: "blocks", value: "$exit" },
        });
        const script = new ArkadeProgramScript(program, ARGS, {
            serverKey: SERVER_KEY,
            emulatorKey: EMULATOR_KEY,
        });
        for (const compiled of script.compiled) {
            const found = artifact.functions.find((g) => g.name === compiled.name)!;
            const extra: Record<string, Uint8Array> = { SERVER_KEY };
            if (compiled.arkadeScript) {
                extra[`EMULATOR_KEY:${compiled.name}`] = computeArkadeScriptPublicKey(
                    EMULATOR_KEY,
                    compiled.arkadeScript,
                );
                expect(hex.encode(compiled.arkadeScript)).toBe(
                    hex.encode(assemble(found.arkade!.asm)),
                );
            }
            expect(hex.encode(compiled.leafScript)).toBe(
                hex.encode(assemble(found.leaves[0].asm, extra)),
            );
        }
        expect(script.address(networks.bitcoin.hrp, SERVER_KEY).encode()).toBe(
            "ark1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqykuzqulnz07mglnukt7crj22pg7t8vey9lyqdxq2dr5w5y003ew4flny",
        );
    });

    it("keeps every leaf in a multi-leaf covenant group", () => {
        const program = programFromArtifact(
            demo({
                functions: [
                    {
                        name: "spend",
                        arkade: { inputs: [], asm: ["OP_1"] },
                        leaves: [
                            collab("spend"),
                            collab("spend", ["10", "OP_CHECKSEQUENCEVERIFY", "OP_DROP"]),
                        ],
                    },
                ],
            }),
        );
        expect(Object.keys(program.functions)).toEqual(["spend", "spend/1:spend"]);
        expect(program.functions["spend/1:spend"].tapscript.csv).toEqual({
            type: "blocks",
            value: 10n,
        });
    });

    it("reads hash conditions and flattens structs, natives, arrays, and VTXO params", () => {
        const hash = programFromArtifact(
            demo({
                constructorInputs: [
                    { name: "owner", type: "pubkey" },
                    { name: "hash", type: "bytes32" },
                ],
                functions: [
                    {
                        name: "claim",
                        leaves: [
                            {
                                name: "claim",
                                witness: [
                                    { name: "preimage", type: "bytes" },
                                    { name: "ownerSig", type: "signature" },
                                ],
                                asm: [
                                    "OP_SHA256",
                                    "<hash>",
                                    "OP_EQUAL",
                                    "OP_VERIFY",
                                    "<owner>",
                                    "OP_CHECKSIG",
                                ],
                            },
                        ],
                    },
                ],
            }),
        ).functions.claim;
        expect(hash.inputs).toEqual([{ name: "preimage", type: "bytes" }]);
        expect(hash.tapscript).toMatchObject({
            asm: ["SHA256", "$hash", "EQUAL"],
            witness: ["preimage"],
        });

        const program = programFromArtifact(
            demo({
                constructorInputs: [
                    { name: "policy", type: "Policy" },
                    { name: "point", type: "ECPoint" },
                    { name: "votes", type: "bool[2]" },
                    { name: "exit", type: "int" },
                ],
                structs: [
                    {
                        name: "Policy",
                        fields: [
                            { name: "owner", type: "pubkey" },
                            { name: "threshold", type: "int" },
                        ],
                    },
                ],
                functions: [
                    {
                        name: "spend",
                        arkade: {
                            inputs: [{ name: "request", type: "Policy" }],
                            asm: ["<VTXO:SingleSig(<policy.owner>,<exit>)>", "OP_DROP"],
                        },
                        leaves: [collab("spend")],
                    },
                ],
            }),
        );
        expect(program.params?.map((p) => (typeof p === "string" ? p : p.name))).toEqual([
            "policy.owner",
            "policy.threshold",
            "point.x",
            "point.y",
            "votes.0",
            "votes.1",
            "exit",
            "server",
            "vtxo_SingleSig_policy_owner_exit",
        ]);
        expect(program.functions.spend.arkadeScript?.witness).toEqual([
            "request.threshold",
            "request.owner",
        ]);
    });

    it("tweaks a constructor pubkey by the named covenant", () => {
        const insurer = schnorr.getPublicKey(new Uint8Array(32).fill(0x09));
        const program = programFromArtifact(
            demo({
                constructorInputs: [{ name: "insurer", type: "pubkey" }],
                functions: [
                    {
                        name: "claim",
                        arkade: { inputs: [], asm: ["OP_1"] },
                        leaves: [collab("claim")],
                    },
                    {
                        name: "race",
                        leaves: [
                            {
                                name: "race",
                                asm: [
                                    "<SERVER_KEY>",
                                    "OP_CHECKSIGVERIFY",
                                    "<TWEAK:insurer:claim>",
                                    "OP_CHECKSIG",
                                ],
                            },
                        ],
                    },
                ],
            }),
        );
        expect(program.functions.race.tapscript.signers).toEqual([
            "$server",
            { tweak: "$insurer", fn: "claim" },
        ]);
        const script = new ArkadeProgramScript(
            program,
            { insurer, server: SERVER_KEY },
            { serverKey: SERVER_KEY, emulatorKey: EMULATOR_KEY },
        );
        const tweaked = computeArkadeScriptPublicKey(
            insurer,
            script.functionByName("claim")!.arkadeScript!,
        );
        expect(hex.encode(script.functionByName("race")!.leafScript)).toBe(
            hex.encode(MultisigTapscript.encode({ pubkeys: [SERVER_KEY, tweaked] }).script),
        );
    });

    it.each([
        ["an incomplete artifact", { functions: [] }, /complete arkadec artifact/],
        [
            "a constructor input without a type",
            demo({ constructorInputs: [{ name: "amount" }] }),
            /complete arkadec artifact/,
        ],
        [
            "a null struct entry",
            demo({ structs: [null] }),
            /complete arkadec artifact/,
        ],
        [
            "a constructor `server`",
            {
                ...artifact,
                constructorInputs: [
                    ...artifact.constructorInputs,
                    { name: "server", type: "pubkey" },
                ],
            },
            /duplicate program parameter 'server'/,
        ],
        ...(["pubkey", "ECPoint"] as const).map(
            (name) =>
                [
                    `a struct named ${name}`,
                    demo({ structs: [{ name, fields: [{ name: "x", type: "int" }] }] }),
                    /shadows a built-in type/,
                ] as const,
        ),
        [
            "a tweak with no function",
            demo({
                constructorInputs: [{ name: "insurer", type: "pubkey" }],
                functions: [
                    {
                        name: "race",
                        leaves: [{ name: "race", asm: ["<TWEAK:insurer>", "OP_CHECKSIG"] }],
                    },
                ],
            }),
            /malformed tweak/,
        ],
        ...(["OP_NOTAREALOPCODE", "OP_constructor"] as const).map(
            (op) =>
                [
                    op,
                    {
                        ...artifact,
                        functions: [
                            { ...artifact.functions[0], arkade: { inputs: [], asm: [op] } },
                        ],
                    },
                    /not in this SDK's table/,
                ] as const,
        ),
    ] as [string, unknown, RegExp][])("refuses %s", (_label, art, pattern) => {
        expect(() => programFromArtifact(art as never)).toThrow(pattern);
    });
});
