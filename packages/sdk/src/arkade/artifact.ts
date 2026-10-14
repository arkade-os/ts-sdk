/**
 * Read the JSON `arkadec` writes into a {@link Program}: `$param` placeholders,
 * @scure opcode names, and one structured tapleaf per compiler leaf.
 */

import { hex } from "@scure/base";

import { sequenceToCanonicalTimelock } from "../utils/timelock";
import { ARKADE_OPS } from "./script";
import {
    SUPPORTED_PROGRAM_VERSION,
    type ArkadeArgType,
    type ArkadeFunction,
    type AsmToken,
    type InputDef,
    type Program,
    type SignerRef,
    type TapscriptSegment,
    type WitnessRef,
} from "./program";

export interface ArtifactParameter {
    name: string;
    type: string;
}

export interface ArtifactStruct {
    name: string;
    fields: ArtifactParameter[];
}

export interface ArtifactWitnessElement {
    name: string;
    type: string;
    encoding?: string;
    injected?: boolean;
}

export interface ArtifactLeaf {
    name: string;
    witness?: ArtifactWitnessElement[];
    asm: string[];
}

export interface ArtifactCovenant {
    inputs: ArtifactParameter[];
    asm: string[];
}

export interface ArtifactGroup {
    name: string;
    arkade?: ArtifactCovenant;
    leaves: ArtifactLeaf[];
}

export interface ContractArtifact {
    formatVersion?: number;
    contractName: string;
    constructorInputs: ArtifactParameter[];
    structs?: ArtifactStruct[];
    functions: ArtifactGroup[];
}

/** Native result structs, in the field order the compiler flattens them. */
const NATIVE_STRUCTS: Record<string, [string, string][]> = {
    AssetId: [
        ["txid", "bytes32"],
        ["gidx", "int"],
    ],
    Outpoint: [
        ["txid", "bytes32"],
        ["vout", "int"],
    ],
    ECPoint: [
        ["x", "int"],
        ["y", "int"],
    ],
    ScriptPubKey: [
        ["program", "bytes"],
        ["version", "int"],
    ],
    AssetEntry: [
        ["assetId", "AssetId"],
        ["amount", "int"],
    ],
    AssetLookup: [
        ["amount", "int"],
        ["found", "bool"],
    ],
    G2Point: [
        ["xC1", "int"],
        ["xC0", "int"],
        ["yC1", "int"],
        ["yC0", "int"],
    ],
};

const HASH_OPCODES = new Set(["OP_SHA256", "OP_HASH160", "OP_HASH256", "OP_RIPEMD160"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNamed(value: unknown): value is ArtifactParameter {
    return (
        isRecord(value) &&
        typeof value.name === "string" &&
        value.name.length > 0 &&
        typeof value.type === "string" &&
        value.type.length > 0
    );
}

/** `true` when `value` is an arkadec artifact rather than a Program. */
export function isContractArtifact(value: unknown): value is ContractArtifact {
    if (!isRecord(value) || typeof value.contractName !== "string") return false;
    if (!Array.isArray(value.constructorInputs)) return false;
    if (value.structs !== undefined && !Array.isArray(value.structs)) return false;
    if (!Array.isArray(value.functions) || value.functions.length === 0) return false;
    return value.functions.every(
        (group) =>
            isRecord(group) &&
            typeof group.name === "string" &&
            group.name.length > 0 &&
            Array.isArray(group.leaves) &&
            group.leaves.length > 0,
    );
}

function fail(detail: string): never {
    throw new Error(`programFromArtifact: ${detail}`);
}

function claim(seen: Set<string>, name: string, kind: string): void {
    if (seen.has(name)) fail(`duplicate ${kind} '${name}'`);
    seen.add(name);
}

/** Source scalars share SDK types; fixed widths and bool constraints live on InputDef. */
const SCALAR_TYPES: Record<string, ArkadeArgType> = {
    pubkey: "pubkey",
    signature: "sig",
    bytes: "bytes",
    bytes20: "hash",
    bytes32: "hash",
    asset: "hash",
    int: "int",
    AssetGroup: "int",
    bool: "int",
};

const ENCODINGS: Record<string, InputDef["encoding"]> = {
    pubkey: "raw",
    signature: "schnorr-64",
    bytes: "raw",
    bytes20: "raw-20",
    bytes32: "raw-32",
    asset: "raw-32",
    int: "scriptnum",
    bool: "scriptnum",
    AssetGroup: "scriptnum",
};

function inputDef(name: string, type: string): InputDef {
    return {
        name,
        type: argType(type),
        ...(type === "bytes20" || type === "bytes32" || type === "asset"
            ? { encoding: ENCODINGS[type] }
            : {}),
        ...(type === "bool" ? { boolean: true } : {}),
    };
}

function argType(arkType: string): ArkadeArgType {
    if (!Object.hasOwn(SCALAR_TYPES, arkType)) fail(`unknown type '${arkType}'`);
    return SCALAR_TYPES[arkType];
}

function arrayParts(type: string): [string, number] {
    const open = type.indexOf("[");
    if (open < 0 || !type.endsWith("]")) return [type, 0];
    const length = Number(type.slice(open + 1, -1));
    return Number.isSafeInteger(length) && length > 0 && /^\d+$/.test(type.slice(open + 1, -1))
        ? [type.slice(0, open), length]
        : [type, 0];
}

function flatten(
    param: ArtifactParameter,
    structs: ArtifactStruct[],
    stack: string[] = [],
): InputDef[] {
    if (!isNamed(param)) fail("parameter needs a name and a type");

    const [element, length] = arrayParts(param.type);
    if (length > 0) {
        return Array.from({ length }, (_, index) =>
            flatten({ name: `${param.name}.${index}`, type: element }, structs, stack),
        ).flat();
    }
    if (param.type.includes("[") || param.type.includes("]")) {
        fail(`invalid array type '${param.type}'`);
    }

    if (Object.hasOwn(NATIVE_STRUCTS, param.type)) {
        return NATIVE_STRUCTS[param.type].flatMap(([field, type]) =>
            flatten({ name: `${param.name}.${field}`, type }, structs, stack),
        );
    }

    const declared = structs.find((struct) => struct?.name === param.type);
    if (declared) {
        if (stack.includes(param.type)) fail(`recursive struct layout '${param.type}'`);
        return declared.fields.flatMap((field) =>
            flatten({ name: `${param.name}.${field.name}`, type: field.type }, structs, [
                ...stack,
                param.type,
            ]),
        );
    }

    return [inputDef(param.name, param.type)];
}

/** Artifact opcodes are `OP_`-prefixed; @scure keeps that prefix only on OP_0..OP_16. */
function opcodeToken(token: string): AsmToken {
    const base = token.slice(3);
    const name = base === "0" || /^([1-9]|1[0-6])$/.test(base) ? token : base;
    if (!Object.hasOwn(ARKADE_OPS, name)) {
        fail(`opcode '${token}' is not in this SDK's table`);
    }
    return name as AsmToken;
}

/** `SingleSig(<sellerPk>,<exit>)` → `contract_SingleSig_sellerPk_exit`. */
function instantiationParam(body: string): string {
    return `contract_${body.replace(/[^A-Za-z0-9]+/g, "_")}`.replace(/_+$/, "");
}

function asmToken(token: string, instantiations: Map<string, string>): AsmToken {
    if (token.startsWith("OP_")) return opcodeToken(token);

    if (token.startsWith("<") && token.endsWith(">")) {
        const inner = token.slice(1, -1);
        if (inner.startsWith("CONTRACT:")) {
            const body = inner.slice("CONTRACT:".length);
            const name = instantiationParam(body);
            const seen = instantiations.get(name);
            if (seen !== undefined && seen !== body) {
                fail(`instantiations '${seen}' and '${body}' both map to parameter '${name}'`);
            }
            instantiations.set(name, body);
            return `$${name}`;
        }
        if (inner.startsWith("VTXO:")) {
            fail(`'${token}' is not a placeholder; the compiler emits <CONTRACT:…>`);
        }
        if (inner === "SERVER_KEY" || inner.startsWith("EMULATOR_KEY:")) {
            fail(`${token} is a signer role and cannot appear in a covenant`);
        }
        return `$${inner}`;
    }

    if (token.startsWith("0x")) return hex.decode(token.slice(2));
    try {
        return BigInt(token);
    } catch {
        fail(`unrecognized assembly token '${token}'`);
    }
}

function providedWitness(witness: ArtifactWitnessElement[] | undefined): ArtifactWitnessElement[] {
    if (witness === undefined) return [];
    if (!Array.isArray(witness)) fail("leaf witness must be an array");
    return witness.filter((item) => {
        if (!isNamed(item)) fail("witness item needs a name and a type");
        argType(item.type);
        if (item.injected !== undefined && typeof item.injected !== "boolean")
            fail(`witness '${item.name}': injected must be boolean`);
        if (item.injected && item.type !== "signature")
            fail(`witness '${item.name}': only infrastructure signatures can be injected`);
        if (item.encoding !== undefined && item.encoding !== ENCODINGS[item.type])
            fail(
                `witness '${item.name}': encoding '${item.encoding}' does not match type '${item.type}'`,
            );
        return !item.injected && item.type !== "signature";
    }) as ArtifactWitnessElement[];
}

/** Every CSV operand is an encoded BIP68 sequence — a literal here, a `$param` when it is bound. */
function csvTimelock(leafName: string, operand: bigint | string): TapscriptSegment["csv"] {
    if (typeof operand === "string") return { type: "sequence", value: operand };
    const timelock = sequenceToCanonicalTimelock(operand);
    if (!timelock) {
        fail(`leaf '${leafName}': CSV literal ${operand} is not a canonical BIP68 sequence`);
    }
    return timelock;
}

/** `condition? · timelock? · N-of-N`. Anything else is refused. */
function parseLeaf(
    leaf: ArtifactLeaf,
    hasCovenant: boolean,
    instantiations: Map<string, string>,
    extras: ArtifactWitnessElement[],
): TapscriptSegment {
    const asm = leaf.asm;
    let index = 0;

    let condition: AsmToken[] | undefined;
    const hashIndex =
        asm[0] === "OP_SIZE" && (asm[1] === "20" || asm[1] === "32") && asm[2] === "OP_EQUALVERIFY"
            ? 3
            : 0;
    if (HASH_OPCODES.has(asm[hashIndex]) && asm[hashIndex + 2] === "OP_EQUAL") {
        if (asm[hashIndex + 3] !== "OP_VERIFY")
            fail(`leaf '${leaf.name}': hash condition must end in OP_VERIFY`);
        // The SDK appends VERIFY when it builds the closure.
        condition = asm.slice(0, hashIndex + 3).map((token) => asmToken(token, instantiations));
        index = hashIndex + 4;
    }

    let csv: TapscriptSegment["csv"];
    let cltv: TapscriptSegment["cltv"];
    if (asm.length >= index + 3 && asm[index + 2] === "OP_DROP") {
        const operand =
            asm[index].startsWith("<") && asm[index].endsWith(">")
                ? `$${asm[index].slice(1, -1)}`
                : BigInt(asm[index]);
        if (asm[index + 1] === "OP_CHECKSEQUENCEVERIFY") csv = csvTimelock(leaf.name, operand);
        else if (asm[index + 1] === "OP_CHECKLOCKTIMEVERIFY") cltv = operand;
        else fail(`leaf '${leaf.name}': unexpected timelock opcode ${asm[index + 1]}`);
        index += 3;
    }

    const signers: SignerRef[] = [];
    let emulator: string | undefined;
    let emulatorIndex: number | undefined;
    while (index < asm.length) {
        const key = asm[index];
        const terminator = asm[index + 1];
        const last = terminator === "OP_CHECKSIG";
        if (last !== (index + 2 === asm.length)) {
            fail(`leaf '${leaf.name}': only the final signer must end in OP_CHECKSIG`);
        }
        if (!last && terminator !== "OP_CHECKSIGVERIFY") {
            fail(`leaf '${leaf.name}': expected CHECKSIG after '${key}', found '${terminator}'`);
        }
        if (!key.startsWith("<") || !key.endsWith(">")) {
            fail(`leaf '${leaf.name}': unsupported key operand '${key}'`);
        }
        const inner = key.slice(1, -1);
        if (inner === "SERVER_KEY") signers.push("$server");
        else if (inner.startsWith("TWEAK:")) {
            const [, base, fn] = inner.match(/^TWEAK:([^:]+):([^:]+)$/) ?? [];
            if (!base || !fn) fail(`leaf '${leaf.name}': malformed tweak '${key}'`);
            signers.push({ tweak: `$${base}`, fn });
        } else if (inner.startsWith("EMULATOR_KEY:")) {
            if (!hasCovenant) fail(`leaf '${leaf.name}': ${key} needs a covenant`);
            if (emulator !== undefined) fail(`leaf '${leaf.name}': duplicate emulator signer`);
            emulator = inner.slice("EMULATOR_KEY:".length);
            emulatorIndex = signers.length;
        } else signers.push(`$${inner}`);
        index += 2;
    }

    const constructorTweak = signers.some((signer) => typeof signer !== "string");
    if (hasCovenant && emulator === undefined && !constructorTweak) {
        fail(
            `leaf '${leaf.name}': covenant leaf must sign with the emulator or a tweaked constructor key`,
        );
    }
    if (signers.length === 0 && emulator === undefined)
        fail(`leaf '${leaf.name}': at least one named signer is required`);

    return {
        signers,
        ...(emulator !== undefined ? { emulator } : hasCovenant ? { emulator: null } : {}),
        ...(emulatorIndex !== undefined ? { emulatorIndex } : {}),
        ...(condition ? { asm: condition } : {}),
        ...(csv ? { csv } : {}),
        ...(cltv !== undefined ? { cltv } : {}),
        ...(extras.length > 0 ? { witness: extras.map((item) => item.name as WitnessRef) } : {}),
    };
}

/** Adds `server`, and one param per child-output placeholder for the caller to bind to that output key. */
export function programFromArtifact(artifact: ContractArtifact): Program {
    if (!isContractArtifact(artifact)) {
        fail(
            "expected a complete arkadec artifact with contractName, constructorInputs, and non-empty functions",
        );
    }
    if (artifact.formatVersion !== undefined && artifact.formatVersion !== 1) {
        fail(`unsupported artifact format version ${artifact.formatVersion}; expected 1`);
    }

    const structs = artifact.structs ?? [];
    const structNames = new Set<string>();
    for (const struct of structs) {
        if (!isRecord(struct) || typeof struct.name !== "string" || !Array.isArray(struct.fields)) {
            fail("struct needs a name and fields array");
        }
        const fields = new Set<string>();
        for (const field of struct.fields) {
            if (!isNamed(field)) fail(`struct '${struct.name}': field needs a name and type`);
            claim(fields, field.name, "struct field");
        }
        if (
            Object.hasOwn(SCALAR_TYPES, struct.name) ||
            Object.hasOwn(NATIVE_STRUCTS, struct.name)
        ) {
            fail(`struct name '${struct.name}' shadows a built-in type`);
        }
        claim(structNames, struct.name, "struct");
    }

    const instantiations = new Map<string, string>();
    const functions: Record<string, ArkadeFunction> = Object.create(null);
    const groups = new Set<string>();
    const leafNames = new Set<string>();

    for (const group of artifact.functions) {
        claim(groups, group.name, "spend group");
        if (
            group.arkade !== undefined &&
            (!isRecord(group.arkade) ||
                !Array.isArray(group.arkade.inputs) ||
                !Array.isArray(group.arkade.asm) ||
                !group.arkade.asm.every((t) => typeof t === "string"))
        ) {
            fail(`group '${group.name}': covenant needs inputs and string assembly arrays`);
        }
        const covenantInputs = (group.arkade?.inputs ?? []).flatMap((input) =>
            flatten(input, structs),
        );
        const arkadeScript = group.arkade
            ? {
                  asm: group.arkade.asm.map((token) => asmToken(token, instantiations)),
                  // Covenant witness is reverse declaration order.
                  witness: covenantInputs.map((field) => field.name as WitnessRef).reverse(),
              }
            : undefined;

        const covenantNames = new Set<string>();
        for (const input of covenantInputs) claim(covenantNames, input.name, "covenant input");
        for (const leaf of group.leaves) {
            if (
                !isRecord(leaf) ||
                typeof leaf.name !== "string" ||
                leaf.name.length === 0 ||
                !Array.isArray(leaf.asm) ||
                leaf.asm.length === 0 ||
                !leaf.asm.every((t) => typeof t === "string")
            ) {
                fail(`group '${group.name}': leaf needs a name and non-empty string assembly`);
            }
            const name = leaf.name;
            claim(leafNames, name, "function name");
            const extras = providedWitness(leaf.witness);
            for (const input of extras) {
                if (leaf.asm.includes(`<${input.name}>`)) {
                    fail(
                        `leaf '${leaf.name}': call input '${input.name}' is a script operand; it must be a constructor binding to derive a fixed Taproot tree`,
                    );
                }
            }
            const witnessNames = new Set<string>();
            for (const item of leaf.witness ?? []) claim(witnessNames, item.name, "leaf witness");
            const scopedExtras = extras.map((item) => ({
                ...item,
                name: covenantNames.has(item.name) ? `tapscript:${item.name}` : item.name,
            }));
            const tapscript = parseLeaf(
                leaf,
                group.arkade !== undefined,
                instantiations,
                scopedExtras,
            );
            if (
                tapscript.emulator !== undefined &&
                tapscript.emulator !== null &&
                tapscript.emulator !== group.name
            ) {
                fail(
                    `leaf '${leaf.name}': emulator covenant '${tapscript.emulator}' must match group '${group.name}'`,
                );
            }
            const signatures = (leaf.witness ?? [])
                .filter((item) => item.type === "signature" && !item.injected)
                .map((item) => inputDef(item.name, item.type));
            if (signatures.length > 0) tapscript.signatures = signatures;
            const inputs: InputDef[] = [
                ...covenantInputs,
                ...scopedExtras.map((item) => inputDef(item.name, item.type)),
            ];
            const inputNames = new Set<string>();
            for (const input of inputs) claim(inputNames, input.name, "function input");
            functions[name] = {
                group: group.name,
                ...(inputs.length > 0 ? { inputs } : {}),
                tapscript,
                ...(arkadeScript ? { arkadeScript } : {}),
            };
        }
    }

    const params: InputDef[] = [
        ...artifact.constructorInputs.flatMap((input) => flatten(input, structs)),
        { name: "server", type: "pubkey" },
        ...(Object.values(functions).some((fn) => fn.tapscript.csv?.value === "$SERVER_EXIT_DELAY")
            ? [{ name: "SERVER_EXIT_DELAY", type: "int" as const }]
            : []),
        ...[...instantiations.keys()].map((name) => ({
            name,
            type: "hash" as const,
            encoding: "raw-32" as const,
        })),
    ];
    const paramNames = new Set<string>();
    for (const param of params) claim(paramNames, param.name, "program parameter");

    return {
        version: SUPPORTED_PROGRAM_VERSION,
        name: artifact.contractName,
        params,
        functions,
    };
}
