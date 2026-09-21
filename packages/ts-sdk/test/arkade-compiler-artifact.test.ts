import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hex } from "@scure/base";

import {
    programFromArtifact,
    type ArtifactGroup,
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

/**
 * Reading a compiler artifact, from the SDK's side.
 *
 * `settlement.artifact.json` is what `arkadec` writes for
 * `examples/settlement/settlement.ark` in arkade-os/compiler, minus the `source`
 * bundle (a verbatim copy of the .ark text) and `updatedAt` (changes every
 * compile). Nothing else is generated: the SDK reads this shape directly, so
 * there is no second artifact to keep in sync.
 *
 * The load-bearing tests rebuild every script twice by independent routes and
 * compare bytes — once through `programFromArtifact` and the SDK's tapscript
 * encoders, once by assembling the artifact's own raw assembly.
 */
const artifact: ContractArtifact = JSON.parse(
    readFileSync(new URL("./fixtures/arkadec/settlement.artifact.json", import.meta.url), "utf8"),
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
    agentPk: key(0x07),
    oracleMessageHash: key(0x7a),
    partyAScript: key(0xa1),
    partyBScript: key(0xb2),
    settlementAmount: 500_000n,
    timeoutHeight: 900_000n,
    agentExit: 144n,
    exit: 1_008n,
    server: SERVER_KEY,
};

const settlementScript = () =>
    new ArkadeProgramScript(programFromArtifact(artifact), ARGS, {
        serverKey: SERVER_KEY,
        emulatorKey: EMULATOR_KEY,
    });

/**
 * Assemble the artifact's own assembly tokens, resolving placeholders the way
 * the runtime would. Independent of how `programFromArtifact` describes the
 * same script, so agreement between the two is meaningful.
 */
function assembleArtifactAsm(tokens: string[], extra: Record<string, Uint8Array> = {}): Uint8Array {
    const ops = tokens.map((token) => {
        if (token.startsWith("OP_")) {
            const base = token.slice(3);
            // @scure keeps only the small-integer pushes prefixed.
            return base === "0" || /^([1-9]|1[0-6])$/.test(base) ? token : base;
        }
        if (token.startsWith("<") && token.endsWith(">")) {
            const name = token.slice(1, -1);
            if (name.startsWith("TWEAK:")) {
                const [, key, func] = name.split(":");
                const covenant = group(func).arkade;
                if (!covenant) throw new Error(`tweak target ${func} has no covenant`);
                const base = ARGS[key];
                if (!(base instanceof Uint8Array)) throw new Error(`tweak base ${key}`);
                return computeArkadeScriptPublicKey(base, assembleArtifactAsm(covenant.asm, extra));
            }
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
        // Parsing the array shape used to yield functions named "0", "1", "2",
        // which validateProgram then accepted.
        expect(() => parseArtifact(artifact as never)).toThrow(/programFromArtifact/);
    });

    it("produces a valid program with the artifact's spend groups", () => {
        const program = programFromArtifact(artifact);
        expect(program.name).toBe("Settlement");
        expect(Object.keys(program.functions)).toEqual(artifact.functions.map((g) => g.name));
        expect(() => validateProgram(program, ARGS)).not.toThrow();
    });

    it("declares server and every constructor parameter", () => {
        const declared = (programFromArtifact(artifact).params ?? []).map((p) =>
            typeof p === "string" ? p : p.name,
        );
        expect(declared).toContain("server");
        for (const name of declared) {
            expect(ARGS[name], `arg ${name}`).toBeDefined();
        }
    });

    it("compiles each leaf to the same bytes as the artifact's own assembly", () => {
        const script = settlementScript();
        expect(script.compiled).toHaveLength(artifact.functions.length);
        for (const compiled of script.compiled) {
            const leaf = group(compiled.name).leaves[0];

            // A covenant leaf commits to the co-signer key tweaked by that
            // covenant; the SDK appends it, the artifact names it.
            const extra: Record<string, Uint8Array> = { SERVER_KEY };
            if (compiled.arkadeScript) {
                extra[`EMULATOR_KEY:${compiled.name}`] = computeArkadeScriptPublicKey(
                    EMULATOR_KEY,
                    compiled.arkadeScript,
                );
            }

            expect(hex.encode(compiled.leafScript), `${compiled.name} leaf`).toBe(
                hex.encode(assembleArtifactAsm(leaf.asm, extra)),
            );
        }
    });

    it("compiles each covenant to the same bytes as the artifact's own assembly", () => {
        for (const compiled of settlementScript().compiled) {
            const covenant = group(compiled.name).arkade;
            if (!covenant) {
                expect(compiled.arkadeScript, `${compiled.name} has no covenant`).toBeUndefined();
                continue;
            }
            expect(hex.encode(compiled.arkadeScript!), `${compiled.name} covenant`).toBe(
                hex.encode(assembleArtifactAsm(covenant.asm)),
            );
        }
    });

    it("derives a stable address", () => {
        const address = settlementScript().address(networks.bitcoin.hrp, SERVER_KEY).encode();
        // Pinned so a change to the reader, the opcode table, or the tapscript
        // encoders shows up here rather than in a deployment.
        expect(address).toMatchInlineSnapshot(
            `"ark1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsrze5ykn7pag4e0xgpn6ufe9h3u6ruutxzha4x3awusg5qenqmk7ll06vug"`,
        );
    });

    it("keeps the spend paths callable with their declared inputs", () => {
        const program = programFromArtifact(artifact);
        const named = (fn: string) =>
            (program.functions[fn].inputs ?? []).map((i) => (typeof i === "string" ? i : i.name));

        expect(named("complete")).toEqual(["oracleMsg", "oracleSig"]);
        expect(named("cancel")).toEqual([]);
    });

    it("reads the insurer exit as a covenant tweak, then the parties", () => {
        const program = programFromArtifact(artifact);

        const complete = program.functions.fallbackComplete.tapscript;
        expect(complete.signers).toEqual(["$tweak:agentPk:complete"]);
        expect(complete.csv).toEqual({ type: "blocks", value: "$agentExit" });
        expect(program.functions.fallbackComplete.arkadeScript).toBeUndefined();

        const cancel = program.functions.fallbackCancel.tapscript;
        expect(cancel.signers).toEqual(["$tweak:agentPk:cancel"]);
        expect(cancel.csv).toEqual({ type: "blocks", value: "$agentExit" });

        const unilateral = program.functions.unilateral.tapscript;
        expect(unilateral.signers).toEqual(["$partyAPk", "$partyBPk"]);
        expect(unilateral.csv).toEqual({ type: "blocks", value: "$exit" });
        expect(program.functions.unilateral.arkadeScript).toBeUndefined();
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
