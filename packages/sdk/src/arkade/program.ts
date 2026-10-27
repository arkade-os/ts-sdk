/**
 * Arkade Program model & compiler.
 *
 * A {@link Program} is the normalized SDK model: named functions, each
 * split into a `tapscript` segment enforced
 * on-chain and an optional `arkadeScript` segment emulated by the co-signing
 * service. This module owns everything that is *pure data → script*:
 *
 * - the Program/segment/token types,
 * - `$param` resolution ({@link resolveAsm}), witness and timelock resolution,
 * - program validation ({@link validateProgram}) — every referenced constructor
 *   parameter must be declared and bound,
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
import { equalBytes } from "@scure/btc-signer/utils.js";

import {
    MultisigTapscript,
    CSVMultisigTapscript,
    CLTVMultisigTapscript,
    ConditionMultisigTapscript,
    ConditionCSVMultisigTapscript,
    type ArkTapscript,
    type RelativeTimelock,
    type TapscriptType,
} from "../script/tapscript";
import { VtxoScript, type TapLeafScript } from "../script/base";
import { sequenceToCanonicalTimelock } from "../utils/timelock";
import { ArkadeScript } from "./script";
import { ARKADE_OP } from "./opcodes";
import { computeArkadeScriptPublicKey } from "./tweak";

const MinimalScriptNum = ScriptNum(undefined, true);

// --- Normalized Program model ---------------------------------------------

/** A token in an `asm` array: an opcode name, a number/bigint push, raw bytes, or a `$param` placeholder. */
export type AsmToken = string | number | bigint | Uint8Array;

/** A constructor argument or resolved value. */
export type ArkadeParamValue = Uint8Array | bigint | number;

/** A function call argument (function input). */
export type ArkadeArgValue = Uint8Array | bigint | number;

/** Native scalar types and their compiler witness encodings. */
export const ARKADE_TYPE_ENCODINGS = {
    pubkey: "raw",
    signature: "schnorr-64",
    bytes: "raw",
    bytes20: "raw-20",
    bytes32: "raw-32",
    asset: "raw-32",
    int: "scriptnum",
    bool: "scriptnum",
    AssetGroup: "scriptnum",
} as const;

/** A native Arkade scalar type for a constructor parameter or call input. */
export type ArkadeArgType = keyof typeof ARKADE_TYPE_ENCODINGS;

/**
 * Maps an {@link ArkadeArgType} to its TypeScript argument type.
 * @internal
 */
export interface ArkadeValueType {
    bytes: Uint8Array;
    pubkey: Uint8Array;
    signature: Uint8Array;
    bytes20: Uint8Array;
    bytes32: Uint8Array;
    asset: Uint8Array;
    int: bigint | number;
    bool: bigint | number;
    AssetGroup: bigint | number;
}

/** A typed function input or constructor param: a name plus its {@link ArkadeArgType}. */
export interface InputDef {
    name: string;
    type: ArkadeArgType;
}

/** A typed function input or constructor parameter. */
export type InputRef = InputDef;

/** Constructor pubkey `$param` tweaked by `fn`'s covenant. */
export interface TweakedSigner {
    tweak: string;
    fn: string;
}

/** A `"$param"` reference, literal x-only bytes, or a {@link TweakedSigner}. */
export type SignerRef = string | Uint8Array | TweakedSigner;

/** A witness-stack item: a function-input name, a `"$param"`, a literal number/bigint (minimal script-num), or raw bytes. */
export type WitnessRef = string | number | bigint | Uint8Array;

/** Bitcoin Script segment of a spending path — enforced on-chain. */
export interface TapscriptSegment {
    /**
     * Required signers. A path with `arkadeScript` also inserts the emulator
     * co-signer at `emulatorIndex` (last by default), unless `emulator` is `null`.
     */
    signers: SignerRef[];
    /** Caller signature ABI; satisfied through PSBT signing, never ConditionWitness. */
    signatures?: InputDef[];
    /**
     * Covenant named by `<EMULATOR_KEY:fn>`. `null` when this leaf belongs to a
     * covenant but signs with a constructor-key tweak instead. Omitted on
     * hand-written programs, which still append the co-signer.
     */
    emulator?: string | null;
    /** Emulator's position in the full signer list; omitted to append it. */
    emulatorIndex?: number;
    /**
     * Optional standard-opcode condition (e.g. a hashlock), encoded into a
     * ConditionMultisig leaf — or ConditionCSVMultisig when combined with `csv`.
     */
    asm?: AsmToken[];
    /**
     * Relative timelock (CSV). The value is a literal or a `"$param"` reference
     * resolved against the constructor args (same convention as {@link SignerRef}).
     * `"blocks"` and `"seconds"` are counts; `"sequence"` is a raw BIP68
     * sequence, which is what an `arkadec` CSV operand holds.
     * Combinable with `asm` (condition + CSV); mutually exclusive with `cltv`.
     */
    csv?: { type: "blocks" | "seconds" | "sequence"; value: bigint | string };
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
    /** Compiler spend group, used to resolve named covenant commitments. */
    group?: string;
    /** Ordered typed call arguments; absent for nullary paths. */
    inputs?: readonly InputDef[];
    tapscript: TapscriptSegment;
    /** Present for covenant paths; absent for pure-tapscript paths (cancel/exit). */
    arkadeScript?: ArkadeSegment;
}

/** Supported normalized Program version. */
export const SUPPORTED_PROGRAM_VERSION = 1;

/**
 * A Program written for a version this SDK cannot read. Typed so a stored row in that format is
 * reported as unsupported rather than broken: its script stays unknown until it is recovered with
 * an SDK that reads that version, or re-created from fresh params.
 */
export class UnsupportedProgramVersionError extends Error {
    readonly name = "UnsupportedProgramVersionError";
    constructor(
        readonly version: unknown,
        context: string,
    ) {
        super(
            `${context}: unsupported program version ${String(version)}; this SDK supports version ${SUPPORTED_PROGRAM_VERSION}. ` +
                `Recover it with an SDK that reads version ${String(version)}, re-create it with current params, or delete it.`,
        );
    }
}

/** An Arkade contract program (hand-written or compiler-emitted). */
export interface Program {
    version: number;
    /**
     * Optional program name — metadata only: round-tripped through the
     * artifact JSON, never used in compilation or the taproot tree.
     */
    name?: string;
    /** Ordered typed constructor parameters. */
    params?: readonly InputDef[];
    functions: Record<string, ArkadeFunction>;
}

// --- helpers ---------------------------------------------------------------

/** Look up a `$param` / function-input value in a bind map; throws when unbound. */
export function bindValue(bind: Record<string, ArkadeParamValue>, name: string): ArkadeParamValue {
    const v = Object.hasOwn(bind, name) ? bind[name] : undefined;
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
 * Resolve a CSV segment to a {@link RelativeTimelock}. A `"sequence"` kind holds
 * the raw BIP68 sequence that `arkadec` and the delegatee push for a CSV
 * operand, so it is decoded here instead of being read as a count.
 */
export function resolveCsvTimelock(
    csv: NonNullable<TapscriptSegment["csv"]>,
    args: Record<string, ArkadeParamValue>,
): RelativeTimelock {
    const value = resolveTimelockValue(csv.value, args);
    if (csv.type !== "sequence") return { type: csv.type, value };
    const timelock = sequenceToCanonicalTimelock(value);
    if (!timelock) {
        throw new Error(
            `csv '${csv.value}' resolved to ${value}, which is not a canonical BIP68 sequence`,
        );
    }
    return timelock;
}

/**
 * Resolve an `asm` array to bytes: substitute `$param` placeholders from `bind`,
 * pass everything else (opcode names, numbers, raw byte pushes) through to the
 * Arkade script encoder. The SDK does not interpret opcodes — this is pure
 * substitution + encoding. To embed a signer key (server, user, or any
 * other), pass it as a `$param` in the constructor args. Compiler `<...>`
 * placeholders are normalized by {@link programFromArtifact} before this step.
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
 * Validate a tapscript segment with its resolved signers; `asm` may combine with
 * `csv` (the condition + CSV closure) but `cltv` conflicts with both (arkd
 * recognizes no condition+CLTV or dual-timelock closure); the `asm` may not
 * contain Arkade opcodes (those are `OP_SUCCESS` on-chain and belong in the
 * `arkadeScript` segment).
 */
export function validateTapscript(seg: TapscriptSegment): void {
    if (!seg.signers || seg.signers.length === 0) {
        throw new Error("tapscript: at least one signer is required");
    }
    if (seg.asm !== undefined && seg.cltv !== undefined) {
        throw new Error(
            "tapscript: `asm` and `cltv` conflict — arkd has no condition+CLTV closure",
        );
    }
    if (seg.csv !== undefined && seg.cltv !== undefined) {
        throw new Error("tapscript: `csv` and `cltv` conflict — use at most one timelock");
    }
    for (const t of seg.asm ?? []) {
        if (typeof t === "string" && t in ARKADE_OP) {
            throw new Error(
                `tapscript: arkade opcode '${t}' is not enforceable on-chain — move it to arkadeScript`,
            );
        }
    }
}

/** Collect every `"$name"` reference in a program's signers, asm, witness and timelock values. */
function collectParamRefs(program: Program): Set<string> {
    const refs = new Set<string>();
    const collect = (items: readonly (AsmToken | WitnessRef | SignerRef)[] | undefined) => {
        for (const t of items ?? []) {
            if (typeof t === "string" && t.startsWith("$")) refs.add(t.slice(1));
            else if (isTweakedSigner(t) && t.tweak.startsWith("$")) refs.add(t.tweak.slice(1));
        }
    };
    for (const fn of Object.values(program.functions)) {
        const tap = fn.tapscript;
        collect(tap.signers);
        collect(tap.asm);
        collect(tap.witness);
        collect(tap.csv ? [tap.csv.value] : undefined);
        collect(tap.cltv !== undefined ? [tap.cltv] : undefined);
        collect(fn.arkadeScript?.asm);
        collect(fn.arkadeScript?.witness);
    }
    return refs;
}

/** The SDK restricts pubkeys to 32-byte x-only keys, including constructor values. */
const TYPED_BYTE_LENGTHS: Partial<Record<ArkadeArgType, number>> = {
    pubkey: 32,
    signature: 64,
    bytes20: 20,
    bytes32: 32,
    asset: 32,
};

/** Validate a bound value against its typed declaration; errors name the parameter. */
export function validateParamValue(def: InputDef, value: ArkadeParamValue): void {
    if (typeof def.type !== "string" || !Object.hasOwn(ARKADE_TYPE_ENCODINGS, def.type)) {
        throw new Error(`program parameter '${def.name}': unknown type '${def.type}'`);
    }
    if (ARKADE_TYPE_ENCODINGS[def.type] === "scriptnum") {
        if (typeof value !== "bigint" && typeof value !== "number") {
            throw new Error(`program parameter '${def.name}' expects ${def.type}, got bytes`);
        }
        if (typeof value === "number" && !Number.isSafeInteger(value)) {
            throw new Error(
                `program parameter '${def.name}' expects a safe integer; use bigint for larger values`,
            );
        }
        if (def.type === "bool" && value !== 0 && value !== 1 && value !== 0n && value !== 1n) {
            throw new Error(`program parameter '${def.name}' expects a boolean encoded as 0 or 1`);
        }
        return;
    }
    if (!(value instanceof Uint8Array)) {
        throw new Error(
            `program parameter '${def.name}' expects ${def.type} bytes, got ${typeof value}`,
        );
    }
    const length = TYPED_BYTE_LENGTHS[def.type];
    if (length !== undefined && value.length !== length) {
        throw new Error(
            `program parameter '${def.name}' expects a ${length}-byte ${def.type}, got ${value.length} bytes`,
        );
    }
}

/** Validate declared constructor values and reject undeclared references. */
export function validateProgram(program: Program, args: Record<string, ArkadeParamValue>): void {
    const params = program.params ?? [];

    const declared = new Set(params.map((p) => p.name));
    for (const name of declared) {
        if (!Object.hasOwn(args, name) || args[name] === undefined) {
            throw new Error(`program parameter '${name}' is declared but not bound in args`);
        }
    }
    for (const ref of collectParamRefs(program)) {
        if (!declared.has(ref)) {
            throw new Error(`'$${ref}' is referenced but not declared in program params`);
        }
    }
    for (const p of params) {
        validateParamValue(p, args[p.name]);
    }
    for (const name of Object.keys(args)) {
        if (!declared.has(name)) throw new Error(`program: undeclared argument '${name}'`);
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

function isTweakedSigner(ref: unknown): ref is TweakedSigner {
    if (typeof ref !== "object" || ref === null || ref instanceof Uint8Array) return false;
    const { tweak, fn } = ref as TweakedSigner;
    return typeof tweak === "string" && typeof fn === "string";
}

/** Resolve a pubkey signer to x-only key bytes against the program's constructor args. */
function resolveSigner(
    ref: string | Uint8Array,
    args: Record<string, ArkadeParamValue>,
): Uint8Array {
    if (ref instanceof Uint8Array) return ref;
    if (typeof ref !== "string" || !ref.startsWith("$")) {
        throw new Error(`unknown signer reference '${ref}' — use a '$param' or key bytes`);
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
        const timelock = resolveCsvTimelock(seg.csv, args);
        if (seg.asm) {
            // The fifth arkd closure: condition + CSV.
            return ConditionCSVMultisigTapscript.encode({
                conditionScript: resolveAsm(seg.asm, args),
                timelock,
                pubkeys,
            });
        }
        return CSVMultisigTapscript.encode({ timelock, pubkeys });
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
        throw new UnsupportedProgramVersionError(program.version, "ArkadeContract");
    }
    const functions: Record<string, ArkadeFunction> = program.functions;
    const names = Object.keys(functions);
    if (names.length === 0) {
        throw new Error("ArkadeContract: program has no functions");
    }
    validateProgram(program, args);
    if (
        args.server !== undefined &&
        (!(args.server instanceof Uint8Array) || !equalBytes(args.server, keys.serverKey))
    ) {
        throw new Error(
            "ArkadeContract: reserved server parameter must match the contract server key",
        );
    }
    const defs = names.map((n) => functions[n]);

    const covenants = new Map<string, Uint8Array>();
    for (const [name, def] of Object.entries(functions)) {
        if (!def.arkadeScript) continue;
        const script = resolveAsm(def.arkadeScript.asm, args);
        for (const target of [name, ...(def.group ? [def.group] : [])]) {
            const previous = covenants.get(target);
            if (previous && !equalBytes(previous, script)) {
                throw new Error(`ArkadeContract: ambiguous covenant '${target}'`);
            }
            covenants.set(target, script);
        }
    }

    const covenant = names.find(
        (_, i) => defs[i].arkadeScript && defs[i].tapscript.emulator !== null,
    );
    if (covenant && !keys.emulatorKey) {
        throw new Error(
            `ArkadeContract: function '${covenant}' has an arkadeScript but no emulator is configured — pass an \`emulator\` to Arkade.connect`,
        );
    }

    return defs.map((def, i) => {
        const pubkeys = def.tapscript.signers.map((signer) => {
            if (!isTweakedSigner(signer)) return resolveSigner(signer, args);
            const script = covenants.get(signer.fn);
            if (!script) {
                throw new Error(
                    `ArkadeContract: function '${names[i]}' tweaks '${signer.fn}', which has no arkade script`,
                );
            }
            return computeArkadeScriptPublicKey(resolveSigner(signer.tweak, args), script);
        });

        const arkadeScript = def.arkadeScript ? covenants.get(names[i]) : undefined;
        const leafPubkeys = [...pubkeys];
        if (arkadeScript && def.tapscript.emulator !== null) {
            const position = def.tapscript.emulatorIndex ?? pubkeys.length;
            if (!Number.isInteger(position) || position < 0 || position > pubkeys.length) {
                throw new Error(
                    `ArkadeContract: function '${names[i]}' has an invalid emulator position ${position}`,
                );
            }
            const target = def.group
                ? covenants.get(def.tapscript.emulator ?? def.group)
                : arkadeScript;
            if (!target || !equalBytes(target, arkadeScript)) {
                throw new Error(
                    `ArkadeContract: function '${names[i]}' has an invalid emulator covenant '${def.tapscript.emulator}'`,
                );
            }
            leafPubkeys.splice(
                position,
                0,
                computeArkadeScriptPublicKey(keys.emulatorKey!, target),
            );
        } else if (def.tapscript.emulatorIndex !== undefined) {
            throw new Error(
                `ArkadeContract: function '${names[i]}' specifies an emulator position without an emulator`,
            );
        }
        validateTapscript({ ...def.tapscript, signers: leafPubkeys });
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
 * Convert a Program JSON artifact into a {@link Program}. Byte values are
 * encoded as `0x`-prefixed hex strings in `asm`/`witness`/`signers`; opcode names,
 * `$param` placeholders and numbers pass through unchanged.
 *
 * This is *not* the JSON `arkadec` writes. That artifact lists spend groups in
 * an array and uses `<param>` placeholders and raw leaf assembly; pass it to
 * {@link programFromArtifact} instead.
 */
export function parseArtifact(artifact: {
    version?: number;
    name?: string;
    params?: readonly InputDef[];
    functions: unknown;
}): Program {
    // An arkadec ContractJson would otherwise become functions named "0", "1", "2".
    if (Array.isArray(artifact.functions)) {
        throw new Error(
            "parseArtifact: `functions` is an array, which is the arkadec artifact shape, not an SDK program — read it with programFromArtifact instead",
        );
    }
    if (typeof artifact.functions !== "object" || artifact.functions === null) {
        throw new Error("parseArtifact: `functions` must be an object keyed by function name");
    }
    const hexToken = (t: unknown): any =>
        typeof t === "string" && t.startsWith("0x") ? hex.decode(t.slice(2)) : t;
    const signerRef = (s: unknown): SignerRef => {
        if (s instanceof Uint8Array || typeof s === "string") return hexToken(s);
        if (isTweakedSigner(s)) return { tweak: s.tweak, fn: s.fn };
        throw new Error("parseArtifact: a tweaked signer needs string `tweak` and `fn`");
    };
    // A "$param" timelock stays a reference (resolved at compile time); anything
    // else is a literal.
    const timelockValue = (v: unknown): bigint | string =>
        typeof v === "string" && v.startsWith("$") ? v : BigInt(v as string | number);

    if (artifact.version !== undefined && artifact.version !== SUPPORTED_PROGRAM_VERSION) {
        throw new UnsupportedProgramVersionError(artifact.version, "parseArtifact");
    }
    const declarations: unknown[] = [artifact.params];
    for (const [name, fn] of Object.entries(artifact.functions as Record<string, any>)) {
        if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
            throw new Error(`parseArtifact: function '${name}' must be an object`);
        }
        const tap = fn.tapscript;
        if (tap !== undefined && (!tap || typeof tap !== "object" || Array.isArray(tap))) {
            throw new Error(`parseArtifact: function '${name}' tapscript must be an object`);
        }
        declarations.push(fn.inputs, tap?.signatures);
        if (
            tap?.emulatorIndex !== undefined &&
            (!Number.isInteger(tap.emulatorIndex) || tap.emulatorIndex < 0)
        ) {
            throw new Error(`parseArtifact: function '${name}' has an invalid emulator position`);
        }
    }
    for (const defs of declarations) {
        if (defs === undefined) continue;
        if (!Array.isArray(defs)) {
            throw new Error(
                "parseArtifact: parameters, inputs and signatures require arrays of typed declarations",
            );
        }
        for (const def of defs) {
            if (
                !def ||
                typeof def.name !== "string" ||
                def.name.length === 0 ||
                typeof def.type !== "string" ||
                !Object.hasOwn(ARKADE_TYPE_ENCODINGS, def.type)
            ) {
                throw new Error(
                    "parseArtifact: parameters, inputs and signatures require typed { name, type } declarations",
                );
            }
        }
    }
    const functions: Record<string, ArkadeFunction> = Object.create(null);
    for (const [name, fn] of Object.entries(artifact.functions as Record<string, any>)) {
        const tap = fn.tapscript ?? {};
        const tapscript: TapscriptSegment = {
            signers: (tap.signers ?? []).map(signerRef),
            ...(tap.signatures ? { signatures: tap.signatures } : {}),
            ...(tap.asm ? { asm: tap.asm.map(hexToken) } : {}),
            ...(tap.witness ? { witness: tap.witness.map(hexToken) } : {}),
            ...(tap.csv
                ? { csv: { type: tap.csv.type, value: timelockValue(tap.csv.value) } }
                : {}),
            ...(tap.cltv !== undefined ? { cltv: timelockValue(tap.cltv) } : {}),
            ...("emulator" in tap ? { emulator: tap.emulator as string | null } : {}),
            ...(tap.emulatorIndex !== undefined ? { emulatorIndex: tap.emulatorIndex } : {}),
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
            ...(fn.group !== undefined ? { group: fn.group } : {}),
            ...(fn.inputs ? { inputs: fn.inputs } : {}),
            tapscript,
            ...(arkadeScript ? { arkadeScript } : {}),
        };
    }
    return {
        version: artifact.version ?? SUPPORTED_PROGRAM_VERSION,
        ...(artifact.name !== undefined ? { name: artifact.name } : {}),
        ...(artifact.params ? { params: artifact.params } : {}),
        functions,
    };
}

/**
 * Serialize a {@link Program} to normalized Program JSON — the inverse of
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

    const functions: Record<string, unknown> = Object.create(null);
    for (const [name, fn] of Object.entries(program.functions)) {
        const tap = fn.tapscript;
        functions[name] = {
            ...(fn.group !== undefined ? { group: fn.group } : {}),
            ...(fn.inputs ? { inputs: fn.inputs } : {}),
            tapscript: {
                signers: tap.signers.map(token),
                ...(tap.signatures ? { signatures: tap.signatures } : {}),
                ...(tap.asm ? { asm: tap.asm.map(token) } : {}),
                ...(tap.witness ? { witness: tap.witness.map(token) } : {}),
                ...(tap.csv
                    ? { csv: { type: tap.csv.type, value: tap.csv.value.toString() } }
                    : {}),
                ...(tap.cltv !== undefined ? { cltv: tap.cltv.toString() } : {}),
                ...(tap.emulator !== undefined ? { emulator: tap.emulator } : {}),
                ...(tap.emulatorIndex !== undefined ? { emulatorIndex: tap.emulatorIndex } : {}),
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
        ...(program.name !== undefined ? { name: program.name } : {}),
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

/**
 * Decode a persisted arg by its declared type — no `0x`/BigInt guessing. A
 * bytes-like param whose serialized value lacks the `0x` prefix is an error.
 */
function parseTypedArgValue(name: string, type: ArkadeArgType, v: unknown): ArkadeParamValue {
    if (ARKADE_TYPE_ENCODINGS[type] === "scriptnum") {
        if (typeof v === "number") return v;
        if (typeof v === "string") return BigInt(v);
        throw new Error(
            `arkade contract params: '${name}' expects ${type}, got ${JSON.stringify(v)}`,
        );
    }
    if (typeof v === "string" && v.startsWith("0x")) return hex.decode(v.slice(2));
    throw new Error(
        `arkade contract params: '${name}' expects ${type} as 0x-prefixed hex, got ${JSON.stringify(v)}`,
    );
}

/** Serialize {@link ArkadeContractParams} to the string map `Contract.params` requires. */
export function serializeArkadeContractParams(typed: ArkadeContractParams): Record<string, string> {
    const args: Record<string, string | number> = Object.create(null);
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
    const program = parseArtifact(JSON.parse(params.program));
    const paramTypes = new Map((program.params ?? []).map((p) => [p.name, p.type]));
    const args: Record<string, ArkadeParamValue> = Object.create(null);
    if (params.args) {
        for (const [k, v] of Object.entries(JSON.parse(params.args))) {
            const type = paramTypes.get(k);
            if (!type) throw new Error(`arkade contract params: undeclared argument '${k}'`);
            args[k] = parseTypedArgValue(k, type, v);
        }
    }
    return {
        program,
        args,
        serverKey: hex.decode(params.serverKey),
        ...(params.userKey ? { userKey: hex.decode(params.userKey) } : {}),
        ...(params.emulatorKey ? { emulatorKey: hex.decode(params.emulatorKey) } : {}),
    };
}
