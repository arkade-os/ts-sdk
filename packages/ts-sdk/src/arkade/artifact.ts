/**
 * Arkade contract artifacts — reading what `arkadec` writes.
 *
 * The compiler's artifact and the SDK's {@link Program} describe the same
 * contract differently. The artifact lists spend groups in an array, writes
 * `<param>` placeholders, names opcodes with the `OP_` prefix, and gives each
 * tapleaf as assembly. A {@link Program} keys functions by name, uses `$param`,
 * follows @scure's opcode naming, and describes a leaf structurally so the
 * SDK's tapscript encoders can build it.
 *
 * {@link programFromArtifact} is that translation, done here rather than in a
 * build step so there is one artifact format to version and no generated JSON
 * to keep in sync. A client loads the compiler's output and spends:
 *
 * ```typescript
 * const artifact = JSON.parse(await readFile("settlement.json", "utf8"));
 * const settlement = arkade.contract(programFromArtifact(artifact), {
 *     partyAPk, partyBPk, agentPk, oraclePk, oracleMessageHash,
 *     partyAScript, partyBScript, settlementAmount, timeoutHeight,
 *     agentExit: 144n, exit: 1_008n,
 * });
 * ```
 *
 * Three conventions the artifact documents but does not encode are resolved
 * here, so callers do not have to know them: covenant inputs are pushed in
 * reverse declaration order, the function-tweaked co-signer is appended by the
 * SDK rather than listed as a signer, and composite parameters flatten to
 * their scalar leaves.
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

// --- Artifact shape --------------------------------------------------------

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

// --- Types and flattening --------------------------------------------------

/**
 * Map an Arkade type onto the SDK's narrower argument types. The SDK
 * length-checks `pubkey` (32) and `sig` (64); every other byte-like type is
 * opaque bytes.
 */
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

// --- Assembly --------------------------------------------------------------

/**
 * Translate one opcode token. The artifact prefixes every opcode with `OP_`;
 * @scure keeps that prefix only on the small-integer pushes.
 */
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

/**
 * `<VTXO:SingleSig(<sellerPk>,<exit>)>` → `vtxo_SingleSig_sellerPk_exit`.
 *
 * The compiler leaves child instantiations opaque for the runtime to resolve
 * into the child's 32-byte witness program. The SDK cannot compute that — it
 * has no child artifact — so each distinct instantiation becomes a parameter
 * the caller binds.
 */
function instantiationParam(token: string): string {
    const body = token.replace(/^<VTXO:/, "").replace(/>$/, "");
    return `vtxo_${body.replace(/[^A-Za-z0-9]+/g, "_")}`.replace(/_+$/, "");
}

/** Placeholders that name a signer role rather than a value. */
function isSignerRole(inner: string): boolean {
    return inner === "SERVER_KEY" || inner.startsWith("EMULATOR_KEY:");
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
        if (isSignerRole(inner)) {
            throw new Error(
                `programFromArtifact: ${token} is a signer role and cannot appear in a covenant`,
            );
        }
        return `$${inner}`;
    }

    if (token.startsWith("0x")) return hex.decode(token.slice(2));

    // Everything else is a decimal literal the VM pushes as data.
    try {
        return BigInt(token);
    } catch {
        throw new Error(`programFromArtifact: unrecognized assembly token '${token}'`);
    }
}

// --- Tapleaves -------------------------------------------------------------

const HASH_OPCODES = new Set(["OP_SHA256", "OP_HASH160", "OP_HASH256", "OP_RIPEMD160"]);

/** A timelock operand is a literal or a `<param>` reference. */
function timelockOperand(token: string): bigint | string {
    if (token.startsWith("<") && token.endsWith(">")) return `$${token.slice(1, -1)}`;
    return BigInt(token);
}

/**
 * Parse a leaf back into the closure the compiler emitted it from:
 * `condition? · timelock? · N-of-N multisig`. Anything else is refused rather
 * than guessed at.
 */
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
        const operand = timelockOperand(asm[index]);
        if (asm[index + 1] === "OP_CHECKSEQUENCEVERIFY") {
            // The compiler emits block-denominated CSV only, and BIP68 encodes
            // a block count as itself, so the scripts agree.
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
        } else if (inner.startsWith("TWEAK:")) {
            // `<TWEAK:agentPk:complete>`: a second enclave key, tweaked by that
            // function's covenant. The SDK resolves it at compile time.
            const spec = inner.slice("TWEAK:".length);
            const split = spec.indexOf(":");
            if (split <= 0 || split === spec.length - 1) {
                throw new Error(`leaf '${leaf.name}': malformed tweak operand '${key}'`);
            }
            signers.push(`$tweak:${spec.slice(0, split)}:${spec.slice(split + 1)}`);
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

// --- Entry point -----------------------------------------------------------

/**
 * Build a {@link Program} from an `arkadec` contract artifact.
 *
 * The returned program declares two kinds of parameter the artifact does not:
 * `server`, which the client binds automatically to the Arkade Service key,
 * and one per `new Contract(...)` payout, which the caller binds to the
 * child's 32-byte Taproot witness program.
 *
 * @throws when the artifact uses a shape the SDK cannot express — a spend
 * group with several tapleaves, a standalone leaf bound to another function's
 * covenant, or an opcode this SDK's table does not carry.
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

        // Call arguments: the covenant's flattened inputs, then anything the
        // leaf condition needs. Composites arrive expanded, so an `int[3]`
        // parameter becomes three arguments.
        const inputs: InputDef[] = [
            ...(group.arkade?.inputs ?? []).flatMap((input) => flatten(input, structs)),
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
                          // The artifact documents that clients push covenant
                          // inputs in reverse declaration order, composites
                          // deepest first. Reversing the flattened list is
                          // that stack.
                          witness: group.arkade.inputs
                              .flatMap((input) => flatten(input, structs))
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
