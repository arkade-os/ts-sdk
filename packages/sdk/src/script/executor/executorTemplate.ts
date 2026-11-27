import { hex } from "@scure/base";
import { ScriptNum } from "@scure/btc-signer";
import { type ContractArtifact, programFromArtifact } from "../../arkade/artifact";
import { ArkadeProgramScript } from "../../arkade/program";
import { VtxoScript } from "../base";
import boardDocument from "./board.json";
import delegatedBoarding from "./delegated_boarding.json";
import delegatedVtxo from "./delegated_vtxo.json";
import renewDocument from "./renew.json";

/** The executor's keys a delegated contract derives from, compressed hex. */
export interface ExecutorContractKeys {
    batchCosignerPubkey: string;
    operatorPubkey: string;
    emulatorPubkey: string;
}

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

/** A delegation as restore scans for it: the executor's keys and the params, owner aside. */
export interface ExecutorWatchTemplate {
    keys: ExecutorContractKeys;
    params: DelegationParams;
}

/** A default template: renewal holds delegated VTXOs, boarding holds on-chain deposits. */
export type ExecutorDefault = "renewal" | "boarding";

/** The default templates, as the service's templates/ ships them: renew.json and board.json. */
const EXECUTOR_TEMPLATES: Record<ExecutorDefault, object> = {
    renewal: renewDocument,
    boarding: boardDocument,
};

/** The artifacts the default templates reference, by the id the service computes for them. */
const EXECUTOR_ARTIFACTS: Record<string, ContractArtifact> = {
    faa3249b8a28e999963994e4020e832285351eb7ce3b4821bcb3b4498f5b8ef3: delegatedVtxo,
    e3c0fa053fbb529a252a1025e3453a41f01949f4e49d50de7dfe5d3510470ed3: delegatedBoarding,
};

/** The ids the service computes for the bundled documents; they change with the bundle. */
export const DEFAULT_TEMPLATE_IDS: Readonly<Record<ExecutorDefault, string>> = {
    renewal: "d78996bc48dca7d9cc6da69bf2ee8d8feaa521c4aa5998c410e3e9ba2dc69297",
    boarding: "2f8b8761c3d98230cbb170814643f591c29f737c0cf68f600f81920024dccbf8",
};

export type Construction = {
    definition: ContractArtifact | { artifact: string };
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
    keys: ExecutorContractKeys,
    owner: Uint8Array,
    params: DelegationParams,
): VtxoScript {
    const doc = EXECUTOR_TEMPLATES[kind] as Template;
    return instantiate(doc, doc.inputs[0].contract, variablesOf(kind, owner, params), keys);
}

/**
 * Build a bundled contract: arguments bind `<variable>`s or `{"program": output}`, the witness
 * program of an output locked to another contract. Pubkey bindings are converted to x-only
 * before the shared Arkade compiler derives the scripts.
 */
export function instantiate(
    doc: Template,
    construction: Construction,
    variables: Record<string, Value>,
    keys: ExecutorContractKeys,
): VtxoScript {
    const def =
        "artifact" in construction.definition
            ? EXECUTOR_ARTIFACTS[construction.definition.artifact]
            : construction.definition;
    if (!def)
        throw new Error(
            `unknown artifact ${(construction.definition as { artifact: string }).artifact}`,
        );
    const operatorKey = hex.decode(keys.operatorPubkey).subarray(1);
    const args: Record<string, Value> = { server: operatorKey };
    for (const [field, binding] of Object.entries(construction.arguments)) {
        if (typeof binding === "string") {
            const value = variables[binding.slice(1, -1)];
            if (value === undefined) throw new Error(`missing constructor value ${field}`);
            args[field] = value;
        } else {
            const output = doc.outputs.find((o) => o.name === binding.program)?.locking.contract;
            if (!output) throw new Error(`program ${binding.program} names no contract output`);
            args[field] = instantiate(doc, output, variables, keys).pkScript.subarray(2);
        }
    }
    for (const field of def.constructorInputs) {
        const value = args[field.name];
        if (value === undefined) throw new Error(`missing constructor value ${field.name}`);
        if (field.type === "pubkey") args[field.name] = (value as Uint8Array).subarray(1);
    }
    return new ArkadeProgramScript(programFromArtifact(def), args, {
        serverKey: operatorKey,
        emulatorKey: hex.decode(keys.emulatorPubkey),
    });
}
