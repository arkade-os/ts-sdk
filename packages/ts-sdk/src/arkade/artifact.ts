/**
 * Read the JSON `arkadec` writes into a {@link Program}: `$param` placeholders,
 * @scure opcode names, and one structured tapleaf per compiler leaf.
 */

import { hex } from "@scure/base";

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
};

const HASH_OPCODES = new Set(["OP_SHA256", "OP_HASH160", "OP_HASH256", "OP_RIPEMD160"]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNamed(value: unknown): value is ArtifactParameter {
    return (
        isRecord(value) &&
        typeof value.name === "string" &&
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

/** `pubkey` and `sig` are length-checked. `bytes20`, `bytes32`, and `asset` stay opaque hashes. */
const SCALAR_TYPES: Record<string, ArkadeArgType> = {
    pubkey: "pubkey",
    signature: "sig",
    bytes: "bytes",
    bytes20: "hash",
    bytes32: "hash",
    asset: "hash",
    int: "int",
    bool: "int",
};

function argType(arkType: string): ArkadeArgType {
    if (!Object.hasOwn(SCALAR_TYPES, arkType)) fail(`unknown type '${arkType}'`);
    return SCALAR_TYPES[arkType];
}

function arrayParts(type: string): [string, number] {
    const open = type.indexOf("[");
    if (open < 0 || !type.endsWith("]")) return [type, 0];
    const length = Number(type.slice(open + 1, -1));
    return Number.isInteger(length) && length > 0 ? [type.slice(0, open), length] : [type, 0];
}

function flatten(
    param: ArtifactParameter,
    structs: ArtifactStruct[],
    stack: string[] = [],
): InputDef[] {
    if (!isNamed(param)) fail("parameter needs a name and a type");

    if (Object.hasOwn(NATIVE_STRUCTS, param.type)) {
        return NATIVE_STRUCTS[param.type].map(([field, type]) => ({
            name: `${param.name}.${field}`,
            type: argType(type),
        }));
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

    const [element, length] = arrayParts(param.type);
    if (length === 0) {
        if (param.type.includes("[") || param.type.includes("]")) {
            fail(`invalid array type '${param.type}'`);
        }
        return [{ name: param.name, type: argType(param.type) }];
    }
    if (
        Object.hasOwn(NATIVE_STRUCTS, element) ||
        structs.some((struct) => struct.name === element)
    ) {
        fail(`arrays of structs are not supported: '${param.type}'`);
    }
    return Array.from({ length }, (_, index) => ({
        name: `${param.name}.${index}`,
        type: argType(element),
    }));
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

/**
 * `<VTXO:…>` and `<CONTRACT:…>` are the same child-output placeholder.
 * The parameter keeps the `vtxo_` prefix so either spelling binds the same argument.
 */
function instantiationBody(token: string): string | undefined {
    const inner = token.slice(1, -1);
    if (inner.startsWith("VTXO:")) return inner.slice("VTXO:".length);
    if (inner.startsWith("CONTRACT:")) return inner.slice("CONTRACT:".length);
    return undefined;
}

function instantiationParam(body: string): string {
    return `vtxo_${body.replace(/[^A-Za-z0-9]+/g, "_")}`.replace(/_+$/, "");
}

function asmToken(token: string, instantiations: Map<string, string>): AsmToken {
    if (token.startsWith("OP_")) return opcodeToken(token);

    if (token.startsWith("<") && token.endsWith(">")) {
        const body = instantiationBody(token);
        if (body !== undefined) {
            const name = instantiationParam(body);
            const seen = instantiations.get(name);
            if (seen !== undefined && seen !== body) {
                fail(`instantiations '${seen}' and '${body}' both map to parameter '${name}'`);
            }
            instantiations.set(name, body);
            return `$${name}`;
        }
        const inner = token.slice(1, -1);
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
        return !item.injected && item.type !== "signature";
    }) as ArtifactWitnessElement[];
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
    if (asm.length >= 4 && HASH_OPCODES.has(asm[0]) && asm[2] === "OP_EQUAL") {
        if (asm[3] !== "OP_VERIFY")
            fail(`leaf '${leaf.name}': hash condition must end in OP_VERIFY`);
        // The SDK appends VERIFY when it builds the closure.
        condition = asm.slice(0, 3).map((token) => asmToken(token, instantiations));
        index = 4;
    }

    let csv: TapscriptSegment["csv"];
    let cltv: TapscriptSegment["cltv"];
    if (asm.length >= index + 3 && asm[index + 2] === "OP_DROP") {
        const operand =
            asm[index].startsWith("<") && asm[index].endsWith(">")
                ? `$${asm[index].slice(1, -1)}`
                : BigInt(asm[index]);
        if (asm[index + 1] === "OP_CHECKSEQUENCEVERIFY") csv = { type: "blocks", value: operand };
        else if (asm[index + 1] === "OP_CHECKLOCKTIMEVERIFY") cltv = operand;
        else fail(`leaf '${leaf.name}': unexpected timelock opcode ${asm[index + 1]}`);
        index += 3;
    }

    const signers: SignerRef[] = [];
    let emulator: string | undefined;
    while (index < asm.length) {
        const key = asm[index];
        const terminator = asm[index + 1];
        const last = terminator === "OP_CHECKSIG";
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
            if (!last) fail(`leaf '${leaf.name}': ${key} must be the last signer`);
            emulator = inner.slice("EMULATOR_KEY:".length);
        } else signers.push(`$${inner}`);
        index += 2;
    }

    const constructorTweak = signers.some((signer) => typeof signer !== "string");
    if (hasCovenant && emulator === undefined && !constructorTweak) {
        fail(
            `leaf '${leaf.name}': covenant leaf must sign with the emulator or a tweaked constructor key`,
        );
    }
    if (signers.length === 0) fail(`leaf '${leaf.name}': at least one named signer is required`);

    return {
        signers,
        ...(emulator !== undefined ? { emulator } : hasCovenant ? { emulator: null } : {}),
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

    const structs = artifact.structs ?? [];
    const structNames = new Set<string>();
    for (const struct of structs) {
        // Nameless entries are skipped. A parameter that needed that struct fails as an unknown type.
        if (!isRecord(struct) || typeof struct.name !== "string") continue;
        if (
            Object.hasOwn(SCALAR_TYPES, struct.name) ||
            Object.hasOwn(NATIVE_STRUCTS, struct.name)
        ) {
            fail(`struct name '${struct.name}' shadows a built-in type`);
        }
        claim(structNames, struct.name, "struct");
    }

    const instantiations = new Map<string, string>();
    const functions: Record<string, ArkadeFunction> = {};
    const groups = new Set<string>();
    const leafNames = new Set<string>();

    for (const group of artifact.functions) {
        claim(groups, group.name, "spend group");
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

        for (const [index, leaf] of group.leaves.entries()) {
            const name = index === 0 ? group.name : `${group.name}/${index}:${leaf.name}`;
            claim(leafNames, name, "function name");
            const extras = providedWitness(leaf.witness);
            const tapscript = parseLeaf(leaf, group.arkade !== undefined, instantiations, extras);
            const inputs: InputDef[] = [
                ...covenantInputs,
                ...extras.map((item) => ({ name: item.name, type: argType(item.type) })),
            ];
            functions[name] = {
                ...(inputs.length > 0 ? { inputs } : {}),
                tapscript,
                ...(arkadeScript ? { arkadeScript } : {}),
            };
        }
    }

    const params: InputDef[] = [
        ...artifact.constructorInputs.flatMap((input) => flatten(input, structs)),
        { name: "server", type: "pubkey" },
        ...[...instantiations.keys()].map((name) => ({ name, type: "hash" as const })),
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
