import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hex } from "@scure/base";

import {
    ArkadeProgramScript,
    parseArtifact,
    validateProgram,
    type ArkadeParamValue,
    type Program,
} from "../src/arkade/program";
import { ArkadeScript } from "../src/arkade/script";
import { computeArkadeScriptPublicKey } from "../src/arkade/tweak";
import { networks } from "../src/networks";

/**
 * The compiler-to-SDK bridge, from the SDK's side.
 *
 * Both fixtures come from `examples/escrow/escrow.ark` in arkade-os/compiler
 * and are generated, not hand-maintained:
 *
 * - `escrow.artifact.json` is what `arkadec` writes, minus the `source` bundle
 *   (a verbatim copy of the .ark text) and `updatedAt` (changes every compile).
 * - `escrow.program.json` is `arkade-bindgen --lang sdk-program` applied to it,
 *   byte-identical to the golden that repository holds.
 *
 * Having both lets these tests rebuild every script from the compiler's own
 * assembly and compare it against what the SDK builds from the program's
 * structured description — two independent routes to the same bytes.
 */
const fixture = (name: string) =>
    JSON.parse(readFileSync(new URL(`./fixtures/arkadec/${name}`, import.meta.url), "utf8"));

interface CompilerGroup {
    name: string;
    arkade?: { asm: string[] };
    leaves: { name: string; asm: string[] }[];
}

const compilerGroups: CompilerGroup[] = fixture("escrow.artifact.json").functions;

const compilerGroup = (name: string): CompilerGroup => {
    const group = compilerGroups.find((g) => g.name === name);
    if (!group) throw new Error(`no compiler group ${name}`);
    return group;
};

// Deterministic keys — the values only have to be well-formed and stable.
const key = (byte: number) => new Uint8Array(32).fill(byte);
const SERVER_KEY = key(0x01);
const EMULATOR_KEY = hex.decode(`02${"02".repeat(32)}`);

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
    // Each `new SingleSig(pk, exit)` payout resolves to the child's 32-byte
    // taproot witness program, which the caller computes and binds.
    vtxo_SingleSig_sellerPk_exit: key(0x11),
    vtxo_SingleSig_buyerPk_exit: key(0x12),
    vtxo_SingleSig_mediatorPk_exit: key(0x13),
};

function escrowProgram(): Program {
    return parseArtifact(fixture("escrow.program.json"));
}

function escrowScript(): ArkadeProgramScript {
    return new ArkadeProgramScript(escrowProgram(), ARGS, {
        serverKey: SERVER_KEY,
        emulatorKey: EMULATOR_KEY,
    });
}

/**
 * The parameter each `new Contract(...)` instantiation is expected to become.
 * Spelled out rather than derived, so a change to the generator's naming shows
 * up here as a failure rather than as an unbound argument in a caller.
 */
const VTXO_PARAMS: Record<string, string> = {
    "VTXO:SingleSig(<sellerPk>,<exit>)": "vtxo_SingleSig_sellerPk_exit",
    "VTXO:SingleSig(<buyerPk>,<exit>)": "vtxo_SingleSig_buyerPk_exit",
    "VTXO:SingleSig(<mediatorPk>,<exit>)": "vtxo_SingleSig_mediatorPk_exit",
};

/**
 * Assemble the compiler's own assembly tokens, resolving placeholders the way
 * the runtime would. Independent of how the Program JSON describes the same
 * script, so agreement between the two is meaningful.
 */
function assembleCompilerAsm(tokens: string[], extra: Record<string, Uint8Array> = {}): Uint8Array {
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

describe("arkadec artifacts and the SDK program model", () => {
    it("refuses a raw compiler artifact instead of silently mangling it", () => {
        // The compiler lists spend groups in an array; parsing that as a
        // program used to yield functions named "0", "1", "2" — and
        // validateProgram accepted the result.
        expect(() => parseArtifact(fixture("escrow.artifact.json"))).toThrow(
            /arkadec artifact shape/,
        );
    });

    it("accepts the generated escrow program", () => {
        const program = escrowProgram();
        expect(program.name).toBe("Escrow");
        expect(Object.keys(program.functions)).toEqual([
            "release",
            "refund",
            "resolve",
            "unilateral",
        ]);
        expect(() => validateProgram(program, ARGS)).not.toThrow();
    });

    it("declares every parameter the program references", () => {
        const program = escrowProgram();
        const declared = (program.params ?? []).map((p) => (typeof p === "string" ? p : p.name));
        // validateProgram enforces this, but name the gap explicitly: an
        // unbound `$param` is the failure mode a generated program would hit.
        for (const name of declared) {
            expect(ARGS[name], `arg ${name}`).toBeDefined();
        }
        expect(declared).toContain("server");
        expect(declared).toContain("vtxo_SingleSig_sellerPk_exit");
    });

    it("compiles each leaf to the same bytes as the compiler's own assembly", () => {
        const script = escrowScript();
        expect(script.compiled).toHaveLength(compilerGroups.length);
        for (const compiled of script.compiled) {
            const group = compilerGroup(compiled.name);

            // A covenant leaf commits to the co-signer key tweaked by that
            // covenant; the SDK appends it, the compiler names it.
            const extra: Record<string, Uint8Array> = { SERVER_KEY };
            if (compiled.arkadeScript) {
                extra[`EMULATOR_KEY:${compiled.name}`] = computeArkadeScriptPublicKey(
                    EMULATOR_KEY,
                    compiled.arkadeScript,
                );
            }

            expect(hex.encode(compiled.leafScript), `${compiled.name} leaf`).toBe(
                hex.encode(assembleCompilerAsm(group.leaves[0].asm, extra)),
            );
        }
    });

    it("compiles each covenant to the same bytes as the compiler's own assembly", () => {
        const script = escrowScript();
        for (const compiled of script.compiled) {
            const group = compilerGroup(compiled.name);
            if (!group.arkade) {
                expect(compiled.arkadeScript, `${compiled.name} has no covenant`).toBeUndefined();
                continue;
            }
            expect(hex.encode(compiled.arkadeScript!), `${compiled.name} covenant`).toBe(
                hex.encode(assembleCompilerAsm(group.arkade.asm)),
            );
        }
    });

    it("derives a stable address", () => {
        const address = escrowScript().address(networks.bitcoin.hrp, SERVER_KEY).encode();
        // Pinned so a change to the bridge, the opcode table, or the tapscript
        // encoders shows up here rather than in a deployment.
        expect(address).toMatchInlineSnapshot(
            `"ark1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszhr2r8g2exc93eqhccphlyu8x76yua2gxmfwculfz2urrrcywxza7aaedq"`,
        );
    });

    it("keeps the spend paths callable with their declared inputs", () => {
        const program = escrowProgram();
        const named = (fn: keyof typeof program.functions) =>
            (program.functions[fn].inputs ?? []).map((i) => (typeof i === "string" ? i : i.name));

        // The upgrade, seen from the SDK: release takes only the buyer's
        // signature, refund takes nothing at all, resolve takes the verdict.
        expect(named("release")).toEqual(["buyerSig"]);
        expect(named("refund")).toEqual([]);
        expect(named("resolve")).toEqual(["sellerShareBps", "attestedAt", "oracleSig"]);
        expect(program.functions.resolve.arkadeScript?.witness).toEqual([
            "oracleSig",
            "attestedAt",
            "sellerShareBps",
        ]);
    });
});
