import { hex } from "@scure/base";
import { ScriptNum } from "@scure/btc-signer";
import { concatBytes } from "@scure/btc-signer/utils.js";
import { getOpcodeValue } from "../arkade/opcodes";
import { ArkadeScript } from "../arkade/script";
import { computeArkadeScriptPublicKey } from "../arkade/tweak";
import type { DelegateeContractKeys } from "../providers/delegatee";
import { VtxoScript } from "./base";
import defaultDocuments from "./delegateeDefaults.json";

/** The parameters of a delegation under the default templates. */
export interface DelegationParams {
    /** BIP 68 sequence of the owner's exit from a delegated VTXO, at least the Ark server's. */
    exitDelay: number;
    /** Seconds before expiry the service renews a VTXO. */
    renewalWindow: number;
    /** Satoshis a renewal may cost. */
    maxFee: number;
    /** BIP 68 sequence of the owner's exit from a boarding deposit, at least the Ark server's. */
    boardingExitDelay?: number;
}

/** A default template: renewal holds delegated VTXOs, boarding holds on-chain deposits. */
export type DelegateeDefault = "renewal" | "boarding";

/** The default templates and the artifact they lock to, as the service's templates/ ships them. */
const DELEGATEE_DEFAULTS = defaultDocuments as Record<
    `${DelegateeDefault}.json` | "delegated_vtxo.json",
    object
>;

/** The ids the service computes for the bundled documents; they change with the bundle. */
export const DEFAULT_TEMPLATE_IDS: Readonly<Record<DelegateeDefault, string>> = {
    renewal: "d901cb8554a77524fb55ebfcde8e1c468871de45163abf34e988c47f1fa36896",
    boarding: "02b4e8bdfb52d7450ab75510cfaff36da5b88323291325e38358df10684a8344",
};

type Field = { name: string; type: string };
type Definition = {
    constructorInputs: Field[];
    functions: { name: string; arkade?: { asm: string[] }; leaves: { asm: string[] }[] }[];
};
type Construction = {
    definition: Definition | { artifact: string };
    arguments: Record<string, string | { program: string }>;
};
type Template = {
    inputs: { type?: string; contract: Construction }[];
    outputs: { name: string; locking: { contract?: Construction } }[];
};
type Value = number | Uint8Array;

/** The variables of a default template for owner. */
function variablesOf(
    kind: DelegateeDefault,
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
    kind: DelegateeDefault,
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
 * function order: forfeit (owner + server), exit (owner after CSV), then the covenant leaf.
 */
export function defaultContract(
    kind: DelegateeDefault,
    keys: DelegateeContractKeys,
    owner: Uint8Array,
    params: DelegationParams,
): VtxoScript {
    const doc = DELEGATEE_DEFAULTS[`${kind}.json`] as Template;
    return instantiate(doc, doc.inputs[0].contract, variablesOf(kind, owner, params), keys);
}

/**
 * Build a bundled contract: arguments bind `<variable>`s or `{"program": output}`, the witness
 * program of an output locked to another contract. Leaves take keys x-only; covenants take the
 * owner compressed and the delegate key as the hex the intent message spells it in.
 */
function instantiate(
    doc: Template,
    construction: Construction,
    variables: Record<string, Value>,
    keys: DelegateeContractKeys,
): VtxoScript {
    const def = (
        "artifact" in construction.definition
            ? DELEGATEE_DEFAULTS["delegated_vtxo.json"]
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
        return value;
    };
    const delegate = hex.decode(keys.delegatePubkey);

    const covenants = new Map<string, Uint8Array>();
    for (const fn of def.functions) {
        if (!fn.arkade) continue;
        const script = assemble(fn.arkade.asm, (name) =>
            name === "DELEGATE_KEY"
                ? // copied: under jsdom, TextEncoder returns another realm's Uint8Array
                  new Uint8Array(new TextEncoder().encode(keys.delegatePubkey.toLowerCase()))
                : arg(name),
        );
        covenants.set(fn.name, script);
    }
    const server = hex.decode(keys.serverPubkey);
    const emulator = hex.decode(keys.emulatorPubkey);
    const leafValue = (name: string): Value => {
        if (name === "SERVER_KEY") return server.subarray(1);
        if (name === "DELEGATE_KEY") return delegate.subarray(1);
        if (name.startsWith("EMULATOR_KEY:")) {
            const covenant = covenants.get(name.slice("EMULATOR_KEY:".length));
            if (!covenant) throw new Error(`${name} names no covenant`);
            return computeArkadeScriptPublicKey(emulator, covenant);
        }
        const value = arg(name);
        return pubkeys.has(name) ? (value as Uint8Array).subarray(1) : value;
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
