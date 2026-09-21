/**
 * Read the JSON `arkadec` writes into the SDK's {@link Program}: spend groups
 * keyed by name instead of listed in an array, `$param` instead of `<param>`,
 * @scure's opcode names instead of the `OP_`-prefixed ones, and each tapleaf
 * described structurally instead of as assembly, so the SDK's tapscript
 * encoders can rebuild it.
 *
 * @module arkade/artifact
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

/** One declared parameter or covenant input. */
export interface ArtifactParameter {
    name: string;
    type: string;
}

/** A user struct layout, so composite parameters can be flattened. */
export interface ArtifactStruct {
    name: string;
    fields: ArtifactParameter[];
}

/** One spend-time witness item of a tapleaf. */
export interface ArtifactWitnessElement {
    name: string;
    type: string;
    /** True when Arkade infrastructure supplies it (server/emulator signatures). */
    injected?: boolean;
}

/** An L1 tapleaf: its witness layout and assembly. */
export interface ArtifactLeaf {
    name: string;
    witness?: ArtifactWitnessElement[];
    asm: string[];
}

/** The emulator-run covenant of a spend group. */
export interface ArtifactCovenant {
    inputs: ArtifactParameter[];
    asm: string[];
}

/** A spend group: an optional covenant plus its tapleaves. */
export interface ArtifactGroup {
    name: string;
    arkade?: ArtifactCovenant;
    leaves: ArtifactLeaf[];
}

/** The JSON `arkadec` writes. Fields the SDK does not read are omitted. */
export interface ContractArtifact {
    contractName: string;
    constructorInputs: ArtifactParameter[];
    structs?: ArtifactStruct[];
    functions: ArtifactGroup[];
}

/** The SDK binds a parameter with this name to the Arkade Service key. */
const SERVER_PARAM = "server";

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
        ["x", "bytes32"],
        ["y", "bytes32"],
    ],
};

/** `true` when the value looks like the compiler's artifact rather than a Program. */
export function isContractArtifact(value: unknown): value is ContractArtifact {
    return (
        typeof value === "object" &&
        value !== null &&
        Array.isArray((value as ContractArtifact).functions)
    );
}

/** `pubkey` and `sig` are length-checked; other byte types stay opaque. */
function argType(arkType: string): ArkadeArgType {
    switch (arkType) {
        case "pubkey":
            return "pubkey";
        case "signature":
            return "sig";
        case "bytes20":
        case "bytes32":
        case "asset":
            return "hash";
        case "int":
        case "bool":
            return "int";
        default:
            return "bytes";
    }
}

/** Split `int[5]` into its element type and length; length 0 means not an array. */
function arrayParts(type: string): [string, number] {
    const open = type.indexOf("[");
    if (open < 0 || !type.endsWith("]")) return [type, 0];
    const length = Number(type.slice(open + 1, -1));
    return Number.isInteger(length) && length > 0 ? [type.slice(0, open), length] : [type, 0];
}

/**
 * Expand one declared entry into the scalar leaves the assembly and witness
 * stack carry, using the dotted paths the artifact's placeholders use.
 */
function flatten(param: ArtifactParameter, structs: ArtifactStruct[]): InputDef[] {
    const native = NATIVE_STRUCTS[param.type];
    if (native) {
        return native.map(([field, type]) => ({
            name: `${param.name}.${field}`,
            type: argType(type),
        }));
    }

    const declared = structs.find((s) => s.name === param.type);
    if (declared) {
        return declared.fields.flatMap((field) =>
            flatten({ name: `${param.name}.${field.name}`, type: field.type }, structs),
        );
    }

    const [element, length] = arrayParts(param.type);
    if (length === 0) return [{ name: param.name, type: argType(param.type) }];
    return Array.from({ length }, (_, index) => ({
        name: `${param.name}.${index}`,
        type: argType(element),
    }));
}

/** Artifact opcodes are `OP_`-prefixed; @scure keeps that prefix only on OP_0..OP_16. */
function opcodeToken(token: string): AsmToken {
    const base = token.slice(3);
    const name = base === "0" || /^([1-9]|1[0-6])$/.test(base) ? token : base;
    if (!(name in ARKADE_OPS)) {
        throw new Error(
            `programFromArtifact: opcode '${token}' is not in this SDK's table — the artifact was built by a newer compiler`,
        );
    }
    return name as AsmToken;
}

/** `<VTXO:SingleSig(<sellerPk>,<exit>)>` → `vtxo_SingleSig_sellerPk_exit`. The caller binds that param to the child witness program. */
function instantiationParam(token: string): string {
    const body = token.replace(/^<VTXO:/, "").replace(/>$/, "");
    return `vtxo_${body.replace(/[^A-Za-z0-9]+/g, "_")}`.replace(/_+$/, "");
}

/** Translate a covenant assembly token, recording any instantiation it names. */
function asmToken(token: string, instantiations: Map<string, string>): AsmToken {
    if (token.startsWith("OP_")) return opcodeToken(token);

    if (token.startsWith("<") && token.endsWith(">")) {
        const inner = token.slice(1, -1);
        if (inner.startsWith("VTXO:")) {
            const name = instantiationParam(token);
            const seen = instantiations.get(name);
            if (seen !== undefined && seen !== token) {
                throw new Error(
                    `programFromArtifact: instantiations '${seen}' and '${token}' both map to parameter '${name}'`,
                );
            }
            instantiations.set(name, token);
            return `$${name}`;
        }
        if (inner === "SERVER_KEY" || inner.startsWith("EMULATOR_KEY:")) {
            throw new Error(
                `programFromArtifact: ${token} is a signer role and cannot appear in a covenant`,
            );
        }
        return `$${inner}`;
    }

    if (token.startsWith("0x")) return hex.decode(token.slice(2));

    try {
        return BigInt(token);
    } catch {
        throw new Error(`programFromArtifact: unrecognized assembly token '${token}'`);
    }
}

const HASH_OPCODES = new Set(["OP_SHA256", "OP_HASH160", "OP_HASH256", "OP_RIPEMD160"]);

/** `condition? · timelock? · N-of-N`. Anything else is refused. */
function parseLeaf(
    leaf: ArtifactLeaf,
    hasCovenant: boolean,
    instantiations: Map<string, string>,
): TapscriptSegment {
    const asm = leaf.asm;
    let index = 0;

    let condition: AsmToken[] | undefined;
    if (asm.length >= 4 && HASH_OPCODES.has(asm[0]) && asm[2] === "OP_EQUAL") {
        if (asm[3] !== "OP_VERIFY") {
            throw new Error(`leaf '${leaf.name}': hash condition must end in OP_VERIFY`);
        }
        // The SDK appends the VERIFY itself when it builds the closure.
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
        if (asm[index + 1] === "OP_CHECKSEQUENCEVERIFY") {
            csv = { type: "blocks", value: operand };
        } else if (asm[index + 1] === "OP_CHECKLOCKTIMEVERIFY") {
            cltv = operand;
        } else {
            throw new Error(`leaf '${leaf.name}': unexpected timelock opcode ${asm[index + 1]}`);
        }
        index += 3;
    }

    const signers: SignerRef[] = [];
    let sawEmulator = false;
    while (index < asm.length) {
        const key = asm[index];
        const terminator = asm[index + 1];
        const last = terminator === "OP_CHECKSIG";
        if (!last && terminator !== "OP_CHECKSIGVERIFY") {
            throw new Error(
                `leaf '${leaf.name}': expected a signature check after '${key}', found '${terminator}'`,
            );
        }
        if (!key.startsWith("<") || !key.endsWith(">")) {
            throw new Error(`leaf '${leaf.name}': unsupported key operand '${key}'`);
        }
        const inner = key.slice(1, -1);
        if (inner === "SERVER_KEY") {
            signers.push(`$${SERVER_PARAM}`);
        } else if (inner.startsWith("EMULATOR_KEY:")) {
            if (!hasCovenant) {
                throw new Error(
                    `leaf '${leaf.name}': references ${key} but its group has no covenant, so the tweak cannot be derived`,
                );
            }
            if (!last) {
                throw new Error(
                    `leaf '${leaf.name}': the tweaked co-signer is appended last, but ${key} is not the final key`,
                );
            }
            sawEmulator = true;
        } else {
            signers.push(`$${inner}`);
        }
        index += 2;
    }

    if (hasCovenant && !sawEmulator) {
        throw new Error(
            `leaf '${leaf.name}': a covenant group's leaf must commit to the tweaked co-signer key`,
        );
    }
    if (signers.length === 0) {
        throw new Error(`leaf '${leaf.name}': at least one named signer is required`);
    }

    // Witness items that satisfy a hash condition. Signature entries are not
    // listed: they are produced from `signers`, one per key.
    const conditionWitness = (leaf.witness ?? []).filter(
        (item) => !item.injected && item.type !== "signature",
    );

    return {
        signers,
        ...(condition ? { asm: condition } : {}),
        ...(csv ? { csv } : {}),
        ...(cltv !== undefined ? { cltv } : {}),
        ...(conditionWitness.length > 0
            ? { witness: conditionWitness.map((item) => item.name as WitnessRef) }
            : {}),
    };
}

/**
 * Build a {@link Program} from an `arkadec` artifact. Adds `server`, and one
 * param per `<VTXO:...>` placeholder for the caller to bind to the child
 * witness program.
 */
export function programFromArtifact(artifact: ContractArtifact): Program {
    if (!isContractArtifact(artifact)) {
        throw new Error(
            "programFromArtifact: expected an arkadec artifact with a `functions` array",
        );
    }
    const structs = artifact.structs ?? [];
    const instantiations = new Map<string, string>();
    const functions: Record<string, ArkadeFunction> = {};

    for (const group of artifact.functions) {
        if (group.name in functions) {
            throw new Error(`programFromArtifact: duplicate spend group '${group.name}'`);
        }
        if (group.leaves.length !== 1) {
            throw new Error(
                `programFromArtifact: group '${group.name}' has ${group.leaves.length} leaves; one tapscript per function is supported`,
            );
        }
        const leaf = group.leaves[0];
        const tapscript = parseLeaf(leaf, group.arkade !== undefined, instantiations);

        const covenantInputs = (group.arkade?.inputs ?? []).flatMap((input) =>
            flatten(input, structs),
        );
        const inputs: InputDef[] = [
            ...covenantInputs,
            ...(leaf.witness ?? [])
                .filter((item) => !item.injected && item.type !== "signature")
                .map((item) => ({ name: item.name, type: argType(item.type) })),
        ];

        functions[group.name] = {
            ...(inputs.length > 0 ? { inputs } : {}),
            tapscript,
            ...(group.arkade
                ? {
                      arkadeScript: {
                          asm: group.arkade.asm.map((token) => asmToken(token, instantiations)),
                          // Covenant witness is reverse declaration order.
                          witness: covenantInputs
                              .map((field) => field.name as WitnessRef)
                              .reverse(),
                      },
                  }
                : {}),
        };
    }

    const params: InputDef[] = [
        ...artifact.constructorInputs.flatMap((input) => flatten(input, structs)),
        { name: SERVER_PARAM, type: "pubkey" },
        ...[...instantiations.keys()].map((name) => ({ name, type: "hash" as const })),
    ];

    return {
        version: SUPPORTED_PROGRAM_VERSION,
        name: artifact.contractName,
        params,
        functions,
    };
}
