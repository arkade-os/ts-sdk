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
 * `escrow.artifact.json` is what `arkadec` writes for
 * `examples/escrow/escrow.ark` in arkade-os/compiler, minus the `source`
 * bundle (a verbatim copy of the .ark text) and `updatedAt` (changes every
 * compile). Nothing else is generated: the SDK reads this shape directly, so
 * there is no second artifact to keep in sync.
 *
 * The load-bearing tests rebuild every script twice by independent routes and
 * compare bytes — once through `programFromArtifact` and the SDK's tapscript
 * encoders, once by assembling the artifact's own raw assembly.
 */
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

/**
 * The parameter each `new Contract(...)` payout is expected to become.
 * Spelled out rather than derived, so a change to the naming shows up here
 * instead of as an unbound argument in a caller.
 */
const VTXO_PARAMS: Record<string, string> = {
    "VTXO:SingleSig(<sellerPk>,<exit>)": "vtxo_SingleSig_sellerPk_exit",
    "VTXO:SingleSig(<buyerPk>,<exit>)": "vtxo_SingleSig_buyerPk_exit",
    "VTXO:SingleSig(<mediatorPk>,<exit>)": "vtxo_SingleSig_mediatorPk_exit",
};

const ARGS: Record<string, ArkadeParamValue> = {
    buyerPk: key(0x04),
    sellerPk: key(0x05),
    oraclePk: key(0x06),
    mediatorPk: key(0x07),
    dealId: key(0x7a),
    mediationFee: 10_000n,
    refundLocktime: 800_000n,
    exit: 144n,
    server: SERVER_KEY,
    vtxo_SingleSig_sellerPk_exit: key(0x11),
    vtxo_SingleSig_buyerPk_exit: key(0x12),
    vtxo_SingleSig_mediatorPk_exit: key(0x13),
};

const escrowScript = () =>
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
            const value = extra[name] ?? ARGS[VTXO_PARAMS[name] ?? name];
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
        expect(program.name).toBe("Escrow");
        expect(Object.keys(program.functions)).toEqual(artifact.functions.map((g) => g.name));
        expect(() => validateProgram(program, ARGS)).not.toThrow();
    });

    it("declares server and one parameter per contract instantiation", () => {
        const declared = (programFromArtifact(artifact).params ?? []).map((p) =>
            typeof p === "string" ? p : p.name,
        );
        expect(declared).toContain("server");
        for (const name of Object.values(VTXO_PARAMS)) {
            expect(declared).toContain(name);
        }
        // validateProgram enforces this, but name the failure mode: an
        // unbound `$param` is what a caller would hit.
        for (const name of declared) {
            expect(ARGS[name], `arg ${name}`).toBeDefined();
        }
    });

    it("compiles each leaf to the same bytes as the artifact's own assembly", () => {
        const script = escrowScript();
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
        for (const compiled of escrowScript().compiled) {
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
        const address = escrowScript().address(networks.bitcoin.hrp, SERVER_KEY).encode();
        // Pinned so a change to the reader, the opcode table, or the tapscript
        // encoders shows up here rather than in a deployment.
        expect(address).toMatchInlineSnapshot(
            `"ark1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsrazh2d034redkdjk4rtkac72gw4h6u2au76s48q5g4valx0nx8l3m0f5fk"`,
        );
    });

    it("keeps the spend paths callable with their declared inputs", () => {
        const program = programFromArtifact(artifact);
        const named = (fn: string) =>
            (program.functions[fn].inputs ?? []).map((i) => (typeof i === "string" ? i : i.name));

        // The escrow upgrade, seen from the SDK: release takes only the
        // buyer's signature, refund takes nothing, resolve takes the verdict.
        expect(named("release")).toEqual(["buyerSig"]);
        expect(named("refund")).toEqual([]);
        expect(named("resolve")).toEqual(["sellerShareBps", "attestedAt", "oracleSig"]);

        // Covenant inputs reach the stack in reverse declaration order.
        expect(program.functions.resolve.arkadeScript?.witness).toEqual([
            "oracleSig",
            "attestedAt",
            "sellerShareBps",
        ]);
    });

    it("reads the emulator-down exit as a 2-of-3 across three leaves", () => {
        const program = programFromArtifact(artifact);
        const pairs: Record<string, string[]> = {
            exitBuyerSeller: ["$buyerPk", "$sellerPk"],
            exitBuyerMediator: ["$buyerPk", "$mediatorPk"],
            exitSellerMediator: ["$sellerPk", "$mediatorPk"],
        };
        for (const [name, signers] of Object.entries(pairs)) {
            const tapscript = program.functions[name].tapscript;
            expect(tapscript.signers, name).toEqual(signers);
            expect(tapscript.csv, name).toEqual({ type: "blocks", value: "$exit" });
            // A standalone leaf has no covenant, so no co-signer is appended.
            expect(program.functions[name].arkadeScript, name).toBeUndefined();
        }
    });

    it("refuses an opcode this SDK's table does not carry", () => {
        const unknown: ContractArtifact = {
            ...artifact,
            functions: [
                {
                    name: "release",
                    arkade: { inputs: [], asm: ["OP_NOTAREALOPCODE"] },
                    leaves: [group("release").leaves[0]],
                },
            ],
        };
        expect(() => programFromArtifact(unknown)).toThrow(/not in this SDK's table/);
    });
});
