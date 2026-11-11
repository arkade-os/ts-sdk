import { hex } from "@scure/base";
import { ScriptNum } from "@scure/btc-signer";
import { concatBytes } from "@scure/btc-signer/utils.js";
import { getOpcodeValue } from "../../arkade/opcodes";
import { ArkadeScript } from "../../arkade/script";
import { computeArkadeScriptPublicKey } from "../../arkade/tweak";
import type { DelegatedContractKeys } from "../../providers/executor";
import { VtxoScript } from "../base";
import artifactDocument from "./artifact.json";
import boardingDocument from "./boarding.json";
import renewalDocument from "./renewal.json";

/** The parameters of a delegation under the default templates. */
export interface DelegationParams {
    /** BIP 68 sequence of the owner's exit from a delegated virtual output, at least the operator's. */
    exitDelay: number;
    /** Seconds before expiry the executor renews a virtual output. */
    renewalWindow: number;
    /** Satoshis a renewal may cost. */
    maxFee: number;
    /** BIP 68 sequence of the owner's exit from a boarding deposit, at least the operator's. */
    boardingExitDelay?: number;
}

/** A default template: renewal holds delegated virtual outputs, boarding holds onchain deposits. */
export type ExecutorDefault = "renewal" | "boarding";

/** The default templates and the artifact they lock to, as the service's templates/ ships them. */
const EXECUTOR_DEFAULTS = {
    "renewal.json": renewalDocument,
    "boarding.json": boardingDocument,
    "artifact.json": artifactDocument,
} as Record<`${ExecutorDefault}.json` | "artifact.json", object>;

/** The ids the service computes for the bundled documents; they change with the bundle. */
export const DEFAULT_TEMPLATE_IDS: Readonly<Record<ExecutorDefault, string>> = {
    renewal: "b19c1a79f8d27559420e10804ea566d55422277aac0ade21d939a6b9e217f51c",
    boarding: "d9fa62772dc1c349aa1fa526e6ae9ce0f38cd778e8a3d885513435eea6401b34",
};

type Field = { name: string; type: string };
export type Definition = {
    constructorInputs: Field[];
    functions: { name: string; arkade?: { asm: string[] }; leaves: { asm: string[] }[] }[];
};
export type Construction = {
    definition: Definition | { artifact: string };
    arguments: Record<string, string | { program: string }>;
};
export type Template = {
    inputs: { type?: string; contract: Construction }[];
    outputs: { name: string; locking: { contract?: Construction } }[];
};
export type Value = number | Uint8Array;

/** The variables of a default template for owner. */
function variablesOf(
    kind: ExecutorDefault,
    owner: Uint8Array,
    params: DelegationParams,
): Record<string, Value> {
    if (owner.length !== 33) throw new Error("owner must be a compressed public key");
    const variables: Record<string, Value> = {
        owner,
        exit_delay: params.exitDelay,
        renewal_window: params.renewalWindow,
        max_fee: params.maxFee,
    };
    if (kind === "boarding") {
        if (params.boardingExitDelay === undefined) throw new Error("boarding needs an exit delay");
        variables.boarding_exit_delay = params.boardingExitDelay;
    }
    return variables;
}

/** The variables of a default template for owner, in canonical hex. */
export function defaultVariables(
    kind: ExecutorDefault,
    owner: Uint8Array,
    params: DelegationParams,
): Record<string, string> {
    const variables = variablesOf(kind, owner, params);
    return Object.fromEntries(
        Object.entries(variables).map(([name, v]) => [
            name,
            hex.encode(typeof v === "number" ? ScriptNum().encode(BigInt(v)) : v),
        ]),
    );
}

/**
 * The contract of a default template for owner, from the keys and params alone. Leaves are in
 * function order: forfeit (owner + operator), exit (owner after CSV), then the emulator-enforced leaf.
 */
export function defaultContract(
    kind: ExecutorDefault,
    keys: DelegatedContractKeys,
    owner: Uint8Array,
    params: DelegationParams,
): VtxoScript {
    const doc = EXECUTOR_DEFAULTS[`${kind}.json`] as Template;
    return instantiate(doc, doc.inputs[0].contract, variablesOf(kind, owner, params), keys);
}

/**
 * Build a bundled contract: arguments bind `<variable>`s or `{"program": output}`, the witness
 * program of an output locked to another contract. A pubkey is x-only in a leaf and in an Arkade
 * script alike; `COSIGNER_KEY` in an Arkade script is the hex the proof message spells it in.
 */
export function instantiate(
    doc: Template,
    construction: Construction,
    variables: Record<string, Value>,
    keys: DelegatedContractKeys,
): VtxoScript {
    const def = (
        "artifact" in construction.definition
            ? EXECUTOR_DEFAULTS["artifact.json"]
            : construction.definition
    ) as Definition;
    const args = new Map<string, Value>();
    for (const [field, binding] of Object.entries(construction.arguments)) {
        if (typeof binding === "string") {
            args.set(field, variables[binding.slice(1, -1)]);
        } else {
            const output = doc.outputs.find((o) => o.name === binding.program)?.locking.contract;
            if (!output) throw new Error(`program ${binding.program} names no contract output`);
            args.set(field, instantiate(doc, output, variables, keys).pkScript.subarray(2));
        }
    }
    const pubkeys = new Set(
        def.constructorInputs.filter((f) => f.type === "pubkey").map((f) => f.name),
    );
    const arg = (name: string): Value => {
        const value = args.get(name);
        if (value === undefined) throw new Error(`missing constructor value ${name}`);
        return pubkeys.has(name) ? (value as Uint8Array).subarray(1) : value;
    };

    const covenants = new Map<string, Uint8Array>();
    for (const fn of def.functions) {
        if (!fn.arkade) continue;
        const script = assemble(fn.arkade.asm, (name) =>
            name === "COSIGNER_KEY"
                ? // copied: under jsdom, TextEncoder returns another realm's Uint8Array
                  new Uint8Array(new TextEncoder().encode(keys.cosignerPubkey.toLowerCase()))
                : arg(name),
        );
        covenants.set(fn.name, script);
    }
    const operator = hex.decode(keys.serverPubkey);
    const emulator = hex.decode(keys.emulatorPubkey);
    const leafValue = (name: string): Value => {
        if (name === "SERVER_KEY") return operator.subarray(1);
        if (name.startsWith("EMULATOR_KEY:")) {
            const covenant = covenants.get(name.slice("EMULATOR_KEY:".length));
            if (!covenant) throw new Error(`${name} names no covenant`);
            return computeArkadeScriptPublicKey(emulator, covenant);
        }
        return arg(name);
    };

    const tapscripts = def.functions.flatMap((fn) =>
        fn.leaves.map((leaf) => assemble(leaf.asm, leafValue)),
    );
    return new VtxoScript(tapscripts);
}

function assemble(tokens: string[], lookup: (name: string) => Value): Uint8Array {
    const push = (value: Value) =>
        ArkadeScript.encode([typeof value === "number" ? BigInt(value) : value]);
    return concatBytes(
        ...tokens.map((token) => {
            if (token.startsWith("OP_")) {
                const op = getOpcodeValue(token);
                if (op === undefined) throw new Error(`unknown opcode ${token}`);
                return new Uint8Array([op]);
            }
            if (token.startsWith("0x")) return push(hex.decode(token.slice(2)));
            if (token.startsWith("<")) return push(lookup(token.slice(1, -1)));
            return push(Number(token));
        }),
    );
}
