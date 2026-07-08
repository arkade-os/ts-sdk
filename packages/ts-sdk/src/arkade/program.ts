/**
 * Arkade Program model & compiler.
 *
 * A {@link Program} is the artifact shape shared with the ArkadeScript
 * compiler: named functions, each split into a `tapscript` segment enforced
 * on-chain and an optional `arkadeScript` segment emulated by the co-signing
 * service. This module owns everything that is *pure data → script*:
 *
 * - the Program/segment/token types,
 * - `$param` resolution ({@link resolveAsm}) and witness resolution,
 * - {@link ArkadeProgramScript} — a {@link VtxoScript} compiled from a
 *   program, its constructor args and the signer keys,
 * - artifact JSON (de)serialization ({@link parseArtifact} /
 *   {@link stringifyArtifact}) and the string-keyed contract params used to
 *   persist a program contract through the `src/contracts` pipeline.
 *
 * Keeping this free of provider/transaction imports lets the generic
 * `arkade` contract handler (src/contracts/handlers/arkade.ts) and the
 * high-level `ArkadeContract` client share one compilation path.
 *
 * @module arkade/program
 */

import { hex } from "@scure/base";
import { ScriptNum } from "@scure/btc-signer";

import {
    MultisigTapscript,
    CSVMultisigTapscript,
    CLTVMultisigTapscript,
    ConditionMultisigTapscript,
    type ArkTapscript,
    type TapscriptType,
} from "../script/tapscript";
import { VtxoScript, type TapLeafScript } from "../script/base";
import { ArkadeScript } from "./script";
import { ARKADE_OP } from "./opcodes";
import { computeArkadeScriptPublicKey } from "./tweak";

const MinimalScriptNum = ScriptNum(undefined, true);

// --- Program model (mirrors the compiler artifact) -------------------------

/** A token in an `asm` array: an opcode name, a number/bigint push, raw bytes, or a `$param` placeholder. */
export type AsmToken = string | number | bigint | Uint8Array;

/** A constructor argument or resolved value. */
export type ArkadeParamValue = Uint8Array | bigint | number;

/** A function call argument (function input). */
export type ArkadeArgValue = Uint8Array | bigint | number;

/**
 * The declared type of a function input, used to derive the static TS type of
 * the corresponding `functions.<name>(...)` argument. Byte-like types map to
 * `Uint8Array`; `int` maps to `bigint | number`.
 */
export type ArkadeArgType = "bytes" | "pubkey" | "sig" | "hash" | "int";

/**
 * Maps an {@link ArkadeArgType} to its TypeScript argument type.
 * @internal
 */
export interface ArkadeValueType {
    bytes: Uint8Array;
    pubkey: Uint8Array;
    sig: Uint8Array;
    hash: Uint8Array;
    int: bigint | number;
}

/** A typed function input: a name plus its {@link ArkadeArgType}. */
export interface InputDef {
    name: string;
    type: ArkadeArgType;
}

/**
 * A function input declaration: either a typed descriptor `{ name, type }` (the
 * argument is statically typed) or a bare name string (the argument falls back
 * to the loose {@link ArkadeArgValue}).
 */
export type InputRef = string | InputDef;

/** Reference to a signer key: a `"$param"` reference or literal x-only bytes. */
export type SignerRef = string | Uint8Array;

/** A witness-stack item: a function-input name, a `"$param"`, a literal number/bigint (minimal script-num), or raw bytes. */
export type WitnessRef = string | number | bigint | Uint8Array;

/** Bitcoin Script segment of a spending path — enforced on-chain. */
export interface TapscriptSegment {
    /** Required signers. The tweaked co-signer is appended automatically when the path has an `arkadeScript`. */
    signers: SignerRef[];
    /** Optional standard-opcode condition (e.g. a hashlock), encoded into a ConditionMultisig leaf. */
    asm?: AsmToken[];
    /**
     * Relative timelock (CSV). The value is a literal or a `"$param"` reference
     * resolved against the constructor args (same convention as {@link SignerRef}).
     * Mutually exclusive with `cltv`/`asm`.
     */
    csv?: { type: "blocks" | "seconds"; value: bigint | string };
    /**
     * Absolute timelock (CLTV): a literal or a `"$param"` reference.
     * Mutually exclusive with `csv`/`asm`.
     */
    cltv?: bigint | string;
    /** Items satisfying the condition (e.g. an HTLC preimage); set via the ConditionWitness PSBT field. */
    witness?: WitnessRef[];
}

/** Arkade Script segment of a spending path — emulated, bound via the key tweak. */
export interface ArkadeSegment {
    /** Raw Arkade opcodes with `$param` placeholders. */
    asm: AsmToken[];
    /** The arkade-script witness stack (e.g. an output index). */
    witness?: WitnessRef[];
}

/** One named spending path. */
export interface ArkadeFunction {
    /**
     * The function ABI: an ordered list of call arguments. Each entry is a typed
     * descriptor `{ name, type }` (which gives the matching `functions.<name>`
     * argument a precise static type) or a bare name string (loose
     * {@link ArkadeArgValue}). Absent for nullary paths (e.g. exit/cancel).
     */
    inputs?: readonly InputRef[];
    tapscript: TapscriptSegment;
    /** Present for covenant paths; absent for pure-tapscript paths (cancel/exit). */
    arkadeScript?: ArkadeSegment;
}

export const SUPPORTED_PROGRAM_VERSION = 0;

/** An Arkade contract program (hand-written or compiler-emitted). */
export interface Program {
    version: number;
    /** Ordered constructor parameter names (documentation/validation only). */
    params?: string[];
    functions: Record<string, ArkadeFunction>;
}

// --- helpers ---------------------------------------------------------------

/** The declared name of a function input, whether typed descriptor or bare string. */
export function inputName(ref: InputRef): string {
    return typeof ref === "string" ? ref : ref.name;
}

/** Look up a `$param` / function-input value in a bind map; throws when unbound. */
export function bindValue(bind: Record<string, ArkadeParamValue>, name: string): ArkadeParamValue {
    const v = bind[name];
    if (v === undefined) throw new Error(`unbound parameter '${name}'`);
    return v;
}

/**
 * Resolve a timelock value to a bigint: bigints pass through; a `"$param"`
 * string resolves against the program's constructor args and must be bound to
 * a bigint/number. Any other string is an error.
 */
export function resolveTimelockValue(
    value: bigint | string,
    args: Record<string, ArkadeParamValue>,
): bigint {
    if (typeof value === "bigint") return value;
    if (value.startsWith("$")) {
        const v = bindValue(args, value.slice(1));
        if (typeof v === "bigint" || typeof v === "number") return BigInt(v);
        throw new Error(`timelock value '${value}' must resolve to a number`);
    }
    throw new Error(
        `invalid timelock value '${value}' — expected a bigint or a '$param' reference`,
    );
}

/**
 * Resolve an `asm` array to bytes: substitute `$param` placeholders from `bind`,
 * pass everything else (opcode names, numbers, raw byte pushes) through to the
 * Arkade script encoder. The SDK does not interpret opcodes — this is pure
 * substitution + encoding. To embed a signer key (server, user, or any
 * other), pass it as a `$param` in the constructor args; there is no
 * `<SERVER_KEY>`/`<COSIGNER_KEY>` token.
 */
export function resolveAsm(asm: AsmToken[], bind: Record<string, ArkadeParamValue>): Uint8Array {
    const tokens = asm.map((t) => {
        if (typeof t === "string" && t.startsWith("$")) {
            return bindValue(bind, t.slice(1));
        }
        if (t === "<SELF>") {
            // Continuation covenants don't hard-code their own address (that would
            // be a non-converging fixpoint); express them with input introspection
            // (PUSHCURRENTINPUTINDEX + INSPECTINPUTSCRIPTPUBKEY) instead.
            throw new Error(
                "<SELF> is not a placeholder; use INSPECTINPUTSCRIPTPUBKEY for continuation covenants",
            );
        }
        return t;
    });
    return ArkadeScript.encode(tokens as never);
}

/**
 * Resolve one witness-stack item to bytes.
 *
 * - raw bytes pass through;
 * - numbers/bigints encode as minimal script-nums;
 * - `"$param"` strings resolve against the program's constructor args;
 * - any other string is a function-input name and resolves against `callArgs`
 *   (throws when the input is unbound — e.g. outside a function call).
 */
export function witnessRefToBytes(
    ref: WitnessRef,
    callArgs: Record<string, ArkadeArgValue>,
    programArgs: Record<string, ArkadeParamValue>,
): Uint8Array {
    if (ref instanceof Uint8Array) return ref;
    if (typeof ref === "number" || typeof ref === "bigint") {
        return MinimalScriptNum.encode(BigInt(ref));
    }
    const v = ref.startsWith("$") ? bindValue(programArgs, ref.slice(1)) : bindValue(callArgs, ref);
    if (v instanceof Uint8Array) return v;
    return MinimalScriptNum.encode(BigInt(v));
}

/**
 * Validate a tapscript segment: it must have signers, may use at most one of
 * `asm`/`csv`/`cltv`, and may not contain Arkade opcodes (those are `OP_SUCCESS`
 * on-chain and belong in the `arkadeScript` segment).
 */
export function validateTapscript(seg: TapscriptSegment): void {
    if (!seg.signers || seg.signers.length === 0) {
        throw new Error("tapscript: at least one signer is required");
    }
    const forms = [seg.asm !== undefined, seg.csv !== undefined, seg.cltv !== undefined].filter(
        Boolean,
    ).length;
    if (forms > 1) {
        throw new Error("tapscript: `asm`, `csv` and `cltv` conflict — use at most one");
    }
    for (const t of seg.asm ?? []) {
        if (typeof t === "string" && t in ARKADE_OP) {
            throw new Error(
                `tapscript: arkade opcode '${t}' is not enforceable on-chain — move it to arkadeScript`,
            );
        }
    }
}

// --- Compilation -----------------------------------------------------------

/** The signer keys a program is compiled against. */
export interface ProgramKeys {
    /** The Arkade Service signer key (x-only) — used for address derivation and collaborative-path detection, not for `$param` resolution. */
    serverKey: Uint8Array;
    /** The wallet's x-only key — identifies which inputs the wallet signs. */
    userKey?: Uint8Array;
    /** The co-signer (emulator) key — required only for covenant (`arkadeScript`) functions. */
    emulatorKey?: Uint8Array;
}

/**
 * A single spending path, fully resolved at compilation: its definition, the
 * committed leaf body, the per-path arkade-script bytes (covenant paths only),
 * and the {@link TapLeafScript} (control block) for spending it.
 */
export interface CompiledProgramFunction {
    name: string;
    def: ArkadeFunction;
    /** The committed leaf script (body). */
    leafScript: Uint8Array;
    /** Resolved arkade-script bytes; undefined for pure-tapscript paths. */
    arkadeScript?: Uint8Array;
    /** Resolved signer keys (x-only), in the declared `signers` order. */
    signerKeys: Uint8Array[];
    /** Resolved once — the taproot leaf + control block for this path. */
    tapLeafScript: TapLeafScript;
}

/** Resolve a {@link SignerRef} to x-only key bytes against the program's constructor args. */
function resolveSigner(ref: SignerRef, args: Record<string, ArkadeParamValue>): Uint8Array {
    if (ref instanceof Uint8Array) return ref;
    if (!ref.startsWith("$")) {
        throw new Error(`unknown signer reference '${ref}' — use '$${ref}'`);
    }
    const v = bindValue(args, ref.slice(1));
    if (!(v instanceof Uint8Array)) {
        throw new Error(`signer ${ref} must be a pubkey (bytes)`);
    }
    return v;
}

function encodeTapscriptSegment(
    seg: TapscriptSegment,
    pubkeys: Uint8Array[],
    args: Record<string, ArkadeParamValue>,
): ArkTapscript<TapscriptType, any> {
    if (seg.csv) {
        return CSVMultisigTapscript.encode({
            timelock: { type: seg.csv.type, value: resolveTimelockValue(seg.csv.value, args) },
            pubkeys,
        });
    }
    if (seg.cltv !== undefined) {
        return CLTVMultisigTapscript.encode({
            absoluteTimelock: resolveTimelockValue(seg.cltv, args),
            pubkeys,
        });
    }
    if (seg.asm) {
        return ConditionMultisigTapscript.encode({
            conditionScript: resolveAsm(seg.asm, args),
            pubkeys,
        });
    }
    return MultisigTapscript.encode({ pubkeys });
}

function compileFunctions(
    program: Program,
    args: Record<string, ArkadeParamValue>,
    keys: ProgramKeys,
): Omit<CompiledProgramFunction, "tapLeafScript">[] {
    if (program.version !== SUPPORTED_PROGRAM_VERSION) {
        throw new Error(
            `ArkadeContract: unsupported program version ${program.version} — this SDK supports version ${SUPPORTED_PROGRAM_VERSION}`,
        );
    }
    const functions: Record<string, ArkadeFunction> = program.functions;
    const names = Object.keys(functions);
    if (names.length === 0) {
        throw new Error("ArkadeContract: program has no functions");
    }
    const defs = names.map((n) => functions[n]);

    // Covenant functions need the emulator's co-signer key for the tweak.
    const covenant = names.find((_, i) => defs[i].arkadeScript);
    if (covenant && !keys.emulatorKey) {
        throw new Error(
            `ArkadeContract: function '${covenant}' has an arkadeScript but no emulator is configured — pass an \`emulator\` to Arkade.connect`,
        );
    }

    return defs.map((def, i) => {
        validateTapscript(def.tapscript);
        const pubkeys = def.tapscript.signers.map((s) => resolveSigner(s, args));

        // Covenant leaf: bind the emulator's co-signer key to the arkade
        // script via the tagged-hash tweak, then append it to the leaf's
        // signer set.
        const arkadeScript = def.arkadeScript ? resolveAsm(def.arkadeScript.asm, args) : undefined;
        const leafPubkeys = arkadeScript
            ? [...pubkeys, computeArkadeScriptPublicKey(keys.emulatorKey!, arkadeScript)]
            : pubkeys;
        const leafScript = encodeTapscriptSegment(def.tapscript, leafPubkeys, args).script;
        return { name: names[i], def, leafScript, arkadeScript, signerKeys: pubkeys };
    });
}

/**
 * A {@link VtxoScript} compiled from an Arkade {@link Program}, its
 * constructor args and the signer keys.
 *
 * This is the single compilation path shared by the high-level
 * `ArkadeContract` client and the `"arkade"` contract handler: both produce
 * byte-identical taproot trees for the same (program, args, keys), so a
 * contract registered through the `src/contracts` pipeline re-derives the
 * exact script it was created with.
 */
export class ArkadeProgramScript extends VtxoScript {
    /** Spending paths in declaration order. */
    readonly compiled: CompiledProgramFunction[];

    constructor(
        readonly program: Program,
        readonly args: Record<string, ArkadeParamValue>,
        readonly keys: ProgramKeys,
    ) {
        const partial = compileFunctions(program, args, keys);
        super(partial.map((p) => p.leafScript));
        this.compiled = partial.map((p) => ({
            ...p,
            tapLeafScript: this.findLeaf(hex.encode(p.leafScript)),
        }));
    }

    /** The compiled spending path with the given function name, if any. */
    functionByName(name: string): CompiledProgramFunction | undefined {
        return this.compiled.find((f) => f.name === name);
    }
}

// --- Artifact JSON ----------------------------------------------------------

/**
 * Convert a compiler-style JSON artifact into a {@link Program}. Byte values are
 * encoded as `0x`-prefixed hex strings in `asm`/`witness`/`signers`; opcode names,
 * `$param` placeholders and numbers pass through unchanged.
 */
export function parseArtifact(artifact: {
    version?: number;
    params?: string[];
    functions: Record<string, any>;
}): Program {
    const hexToken = (t: unknown): any =>
        typeof t === "string" && t.startsWith("0x") ? hex.decode(t.slice(2)) : t;
    // A "$param" timelock stays a reference (resolved at compile time); anything
    // else is a literal.
    const timelockValue = (v: unknown): bigint | string =>
        typeof v === "string" && v.startsWith("$") ? v : BigInt(v as string | number);

    const functions: Record<string, ArkadeFunction> = {};
    for (const [name, fn] of Object.entries(artifact.functions)) {
        const tap = fn.tapscript ?? {};
        const tapscript: TapscriptSegment = {
            signers: (tap.signers ?? []).map(hexToken),
            ...(tap.asm ? { asm: tap.asm.map(hexToken) } : {}),
            ...(tap.witness ? { witness: tap.witness.map(hexToken) } : {}),
            ...(tap.csv
                ? { csv: { type: tap.csv.type, value: timelockValue(tap.csv.value) } }
                : {}),
            ...(tap.cltv !== undefined ? { cltv: timelockValue(tap.cltv) } : {}),
        };
        const arkadeScript = fn.arkadeScript
            ? {
                  asm: fn.arkadeScript.asm.map(hexToken),
                  ...(fn.arkadeScript.witness
                      ? { witness: fn.arkadeScript.witness.map(hexToken) }
                      : {}),
              }
            : undefined;
        functions[name] = {
            ...(fn.inputs ? { inputs: fn.inputs } : {}),
            tapscript,
            ...(arkadeScript ? { arkadeScript } : {}),
        };
    }
    return {
        version: artifact.version ?? SUPPORTED_PROGRAM_VERSION,
        ...(artifact.params ? { params: artifact.params } : {}),
        functions,
    };
}

/**
 * Serialize a {@link Program} to compiler-artifact JSON — the inverse of
 * {@link parseArtifact}: bytes become `0x`-hex strings; bigint tokens become
 * plain numbers (or, above `Number.MAX_SAFE_INTEGER`, `0x`-hex of their
 * minimal script-num bytes, which the script encoder pushes identically);
 * literal timelock values serialize as decimal strings while `"$param"`
 * timelock references are emitted as-is.
 */
export function stringifyArtifact(program: Program): string {
    const token = (t: AsmToken | WitnessRef | SignerRef): unknown => {
        if (t instanceof Uint8Array) return "0x" + hex.encode(t);
        if (typeof t === "bigint") {
            if (t >= BigInt(Number.MIN_SAFE_INTEGER) && t <= BigInt(Number.MAX_SAFE_INTEGER)) {
                return Number(t);
            }
            // Out of JSON-safe integer range: a plain decimal string would be
            // misread as an opcode name, so emit the equivalent byte push.
            return "0x" + hex.encode(MinimalScriptNum.encode(t));
        }
        return t;
    };

    const functions: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(program.functions)) {
        const tap = fn.tapscript;
        functions[name] = {
            ...(fn.inputs ? { inputs: fn.inputs } : {}),
            tapscript: {
                signers: tap.signers.map(token),
                ...(tap.asm ? { asm: tap.asm.map(token) } : {}),
                ...(tap.witness ? { witness: tap.witness.map(token) } : {}),
                ...(tap.csv
                    ? { csv: { type: tap.csv.type, value: tap.csv.value.toString() } }
                    : {}),
                ...(tap.cltv !== undefined ? { cltv: tap.cltv.toString() } : {}),
            },
            ...(fn.arkadeScript
                ? {
                      arkadeScript: {
                          asm: fn.arkadeScript.asm.map(token),
                          ...(fn.arkadeScript.witness
                              ? { witness: fn.arkadeScript.witness.map(token) }
                              : {}),
                      },
                  }
                : {}),
        };
    }

    return JSON.stringify({
        version: program.version,
        ...(program.params ? { params: program.params } : {}),
        functions,
    });
}

// --- Persisted contract params ----------------------------------------------

/**
 * Typed parameters of an `"arkade"` contract as persisted through the
 * `src/contracts` pipeline. The program serializes as artifact JSON, args as
 * a JSON map (`0x`-hex bytes, decimal-string bigints), keys as hex — so a
 * stored contract row re-derives its script fully offline.
 */
export interface ArkadeContractParams {
    program: Program;
    args: Record<string, ArkadeParamValue>;
    serverKey: Uint8Array;
    userKey?: Uint8Array;
    emulatorKey?: Uint8Array;
}

function serializeArgValue(v: ArkadeParamValue): string | number {
    if (v instanceof Uint8Array) return "0x" + hex.encode(v);
    if (typeof v === "bigint") return v.toString();
    return v;
}

function parseArgValue(v: unknown): ArkadeParamValue {
    if (typeof v === "number") return v;
    if (typeof v === "string") {
        if (v.startsWith("0x")) return hex.decode(v.slice(2));
        return BigInt(v);
    }
    throw new Error(`invalid arkade arg value: ${JSON.stringify(v)}`);
}

/** Serialize {@link ArkadeContractParams} to the string map `Contract.params` requires. */
export function serializeArkadeContractParams(typed: ArkadeContractParams): Record<string, string> {
    const args: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(typed.args)) {
        args[k] = serializeArgValue(v);
    }
    return {
        program: stringifyArtifact(typed.program),
        args: JSON.stringify(args),
        serverKey: hex.encode(typed.serverKey),
        ...(typed.userKey ? { userKey: hex.encode(typed.userKey) } : {}),
        ...(typed.emulatorKey ? { emulatorKey: hex.encode(typed.emulatorKey) } : {}),
    };
}

/** Parse the string map persisted in `Contract.params` back into typed params. */
export function deserializeArkadeContractParams(
    params: Record<string, string>,
): ArkadeContractParams {
    if (!params.program) {
        throw new Error("arkade contract params: missing 'program'");
    }
    if (!params.serverKey) {
        throw new Error("arkade contract params: missing 'serverKey'");
    }
    const args: Record<string, ArkadeParamValue> = {};
    if (params.args) {
        for (const [k, v] of Object.entries(JSON.parse(params.args))) {
            args[k] = parseArgValue(v);
        }
    }
    return {
        program: parseArtifact(JSON.parse(params.program)),
        args,
        serverKey: hex.decode(params.serverKey),
        ...(params.userKey ? { userKey: hex.decode(params.userKey) } : {}),
        ...(params.emulatorKey ? { emulatorKey: hex.decode(params.emulatorKey) } : {}),
    };
}
