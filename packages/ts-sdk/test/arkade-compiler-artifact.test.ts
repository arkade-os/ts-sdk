import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hex } from "@scure/base";

import {
    isContractArtifact,
    programFromArtifact,
    type ArtifactGroup,
    type ArtifactLeaf,
    type ContractArtifact,
} from "../src/arkade/artifact";
import {
    ArkadeProgramScript,
    parseArtifact,
    validateProgram,
    type ArkadeParamValue,
} from "../src/arkade/program";
import { ArkadeScript } from "../src/arkade/script";
import { computeArkadeScriptPublicKey } from "../src/arkade/tweak";
import { networks } from "../src/networks";

// escrow.ark without source, updatedAt, witness, and compiler metadata.
const artifact: ContractArtifact = JSON.parse(
    readFileSync(new URL("./fixtures/arkadec/escrow.artifact.json", import.meta.url), "utf8"),
);

const group = (name: string): ArtifactGroup => {
    const found = artifact.functions.find((g) => g.name === name);
    if (!found) throw new Error(`no group ${name}`);
    return found;
};

// Deterministic keys — the values only have to be well-formed and stable.
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

const escrowScript = () =>
    new ArkadeProgramScript(programFromArtifact(artifact), ARGS, {
        serverKey: SERVER_KEY,
        emulatorKey: EMULATOR_KEY,
    });

const collaborativeLeaf = (
    name: string,
    groupName = name,
    prefix: string[] = [],
): ArtifactLeaf => ({
    name,
    witness: [
        { name: "serverSig", type: "signature", injected: true },
        { name: "emulatorSig", type: "signature", injected: true },
    ],
    asm: [
        ...prefix,
        "<SERVER_KEY>",
        "OP_CHECKSIGVERIFY",
        `<EMULATOR_KEY:${groupName}>`,
        "OP_CHECKSIG",
    ],
});

/** Assemble the artifact's own tokens, independent of the reader. */
function assembleArtifactAsm(tokens: string[], extra: Record<string, Uint8Array> = {}): Uint8Array {
    const ops = tokens.map((token) => {
        if (token.startsWith("OP_")) {
            const base = token.slice(3);
            // @scure keeps only the small-integer pushes prefixed.
            return base === "0" || /^([1-9]|1[0-6])$/.test(base) ? token : base;
        }
        if (token.startsWith("<") && token.endsWith(">")) {
            const name = token.slice(1, -1);
            const value = extra[name] ?? ARGS[name];
            if (value === undefined) throw new Error(`unbound placeholder ${token}`);
            return value instanceof Uint8Array ? value : BigInt(value);
        }
        if (token.startsWith("0x")) return hex.decode(token.slice(2));
        return BigInt(token);
    });
    return ArkadeScript.encode(ops as never);
}

describe("reading an arkadec artifact", () => {
    it("parseArtifact points at the reader instead of mangling the artifact", () => {
        // The array shape used to parse into functions named "0", "1", "2".
        expect(() => parseArtifact(artifact as never)).toThrow(/programFromArtifact/);
    });

    it("rejects incomplete and malformed artifact shapes", () => {
        for (const malformed of [
            { functions: [] },
            { contractName: "Broken", constructorInputs: [], functions: [] },
            {
                contractName: "Broken",
                constructorInputs: [],
                functions: [{ name: "spend", leaves: [{ name: "spend", asm: [7] }] }],
            },
        ]) {
            expect(isContractArtifact(malformed), JSON.stringify(malformed)).toBe(false);
            expect(() => programFromArtifact(malformed as never)).toThrow(
                /complete arkadec artifact/,
            );
        }
    });

    it("reads the escrow artifact into the same program and the same bytes", () => {
        const program = programFromArtifact(artifact);
        expect(program.name).toBe("Escrow");
        expect(Object.keys(program.functions)).toEqual(["complete", "cancel", "unilateral"]);
        expect(() => validateProgram(program, ARGS)).not.toThrow();

        const declared = (program.params ?? []).map((p) => (typeof p === "string" ? p : p.name));
        expect(declared).toContain("server");
        for (const name of declared) expect(ARGS[name], name).toBeDefined();

        const named = (fn: string) =>
            (program.functions[fn].inputs ?? []).map((i) => (typeof i === "string" ? i : i.name));
        expect(named("complete")).toEqual(["oracleMsg", "oracleSig"]);
        expect(named("cancel")).toEqual([]);

        const exit = program.functions.unilateral.tapscript;
        expect(exit.signers).toEqual(["$partyAPk", "$partyBPk"]);
        expect(exit.csv).toEqual({ type: "blocks", value: "$exit" });
        expect(program.functions.unilateral.arkadeScript).toBeUndefined();

        const script = escrowScript();
        expect(script.compiled).toHaveLength(artifact.functions.length);
        for (const compiled of script.compiled) {
            const found = group(compiled.name);
            const extra: Record<string, Uint8Array> = { SERVER_KEY };
            if (compiled.arkadeScript) {
                extra[`EMULATOR_KEY:${compiled.name}`] = computeArkadeScriptPublicKey(
                    EMULATOR_KEY,
                    compiled.arkadeScript,
                );
                expect(hex.encode(compiled.arkadeScript), `${compiled.name} covenant`).toBe(
                    hex.encode(assembleArtifactAsm(found.arkade!.asm)),
                );
            } else {
                expect(found.arkade, compiled.name).toBeUndefined();
            }
            expect(hex.encode(compiled.leafScript), `${compiled.name} leaf`).toBe(
                hex.encode(assembleArtifactAsm(found.leaves[0].asm, extra)),
            );
        }
        expect(script.address(networks.bitcoin.hrp, SERVER_KEY).encode()).toBe(
            "ark1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqykuzqulnz07mglnukt7crj22pg7t8vey9lyqdxq2dr5w5y003ew4flny",
        );
    });

    it("keeps every leaf in a multi-leaf covenant group", () => {
        const multiLeaf: ContractArtifact = {
            contractName: "MultiLeaf",
            constructorInputs: [],
            functions: [
                {
                    name: "spend",
                    arkade: { inputs: [], asm: ["OP_1"] },
                    leaves: [
                        collaborativeLeaf("spend"),
                        collaborativeLeaf("fallback", "spend", [
                            "10",
                            "OP_CHECKSEQUENCEVERIFY",
                            "OP_DROP",
                        ]),
                    ],
                },
            ],
        };

        const program = programFromArtifact(multiLeaf);
        expect(Object.keys(program.functions)).toEqual(["spend", "spend/1:fallback"]);

        const script = new ArkadeProgramScript(
            program,
            { server: SERVER_KEY },
            { serverKey: SERVER_KEY, emulatorKey: EMULATOR_KEY },
        );
        expect(script.compiled).toHaveLength(2);
        expect(script.compiled[0].arkadeScript).toEqual(script.compiled[1].arkadeScript);
        expect(program.functions["spend/1:fallback"].tapscript.csv).toEqual({
            type: "blocks",
            value: 10n,
        });
    });

    it("reads hash conditions and their witness", () => {
        const hashlock: ContractArtifact = {
            contractName: "Hashlock",
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
        };

        const claim = programFromArtifact(hashlock).functions.claim;
        expect(claim.inputs).toEqual([{ name: "preimage", type: "bytes" }]);
        expect(claim.tapscript.asm).toEqual(["SHA256", "$hash", "EQUAL"]);
        expect(claim.tapscript.witness).toEqual(["preimage"]);
    });

    it("flattens structs, native values, arrays, and VTXO parameters", () => {
        const composite: ContractArtifact = {
            contractName: "Composite",
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
                    leaves: [collaborativeLeaf("spend")],
                },
            ],
        };

        const program = programFromArtifact(composite);
        expect(program.params).toEqual([
            { name: "policy.owner", type: "pubkey" },
            { name: "policy.threshold", type: "int" },
            { name: "point.x", type: "int" },
            { name: "point.y", type: "int" },
            { name: "votes.0", type: "int" },
            { name: "votes.1", type: "int" },
            { name: "exit", type: "int" },
            { name: "server", type: "pubkey" },
            { name: "vtxo_SingleSig_policy_owner_exit", type: "hash" },
        ]);
        expect(program.functions.spend.inputs).toEqual([
            { name: "request.owner", type: "pubkey" },
            { name: "request.threshold", type: "int" },
        ]);
        expect(program.functions.spend.arkadeScript?.witness).toEqual([
            "request.threshold",
            "request.owner",
        ]);
    });

    it("rejects parameter and spend-group collisions", () => {
        expect(() =>
            programFromArtifact({
                ...artifact,
                constructorInputs: [
                    ...artifact.constructorInputs,
                    { name: "server", type: "pubkey" },
                ],
            }),
        ).toThrow(/duplicate program parameter 'server'/);

        expect(() =>
            programFromArtifact({
                ...artifact,
                functions: [group("complete"), group("complete")],
            }),
        ).toThrow(/duplicate spend group 'complete'/);
    });

    it("rejects a struct named after a built-in scalar type", () => {
        expect(() =>
            programFromArtifact({
                contractName: "Shadow",
                constructorInputs: [],
                structs: [{ name: "pubkey", fields: [{ name: "x", type: "int" }] }],
                functions: [
                    {
                        name: "spend",
                        leaves: [{ name: "spend", asm: ["<SERVER_KEY>", "OP_CHECKSIG"] }],
                    },
                ],
            }),
        ).toThrow(/struct name 'pubkey' shadows a built-in type/);
    });

    it("leaves a second-emulator tweak as an undeclared parameter", () => {
        const program = programFromArtifact({
            contractName: "Tweaked",
            constructorInputs: [],
            functions: [
                {
                    name: "spend",
                    leaves: [{ name: "spend", asm: ["<TWEAK:agentPk:spend>", "OP_CHECKSIG"] }],
                },
            ],
        });
        expect(() => validateProgram(program, { server: SERVER_KEY })).toThrow(
            /'\$TWEAK:agentPk:spend' is referenced but not declared in program params/,
        );
    });

    it("refuses an opcode this SDK's table does not carry", () => {
        const unknown: ContractArtifact = {
            ...artifact,
            functions: [
                {
                    name: "complete",
                    arkade: { inputs: [], asm: ["OP_NOTAREALOPCODE"] },
                    leaves: [group("complete").leaves[0]],
                },
            ],
        };
        expect(() => programFromArtifact(unknown)).toThrow(/not in this SDK's table/);
    });
});
