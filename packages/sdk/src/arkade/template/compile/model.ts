import { concatBytes } from "@scure/btc-signer/utils.js";

import type { ArtifactFunction, Definition, Leaf } from "../abi";
import { isContextFree } from "../asm";

export type Piece =
    | { hex: Uint8Array }
    | { name: string }
    | { expr: string[] }
    | { program: string };
/** Pieces concatenated once their names and expressions resolve. */
export type ByteTemplate = Piece[];

export type TemplateType = "proof" | "virtual" | "onchain";

// Indexes into inputs, outputs and issues use -1 for "none", as the Go model does.
export interface Template {
    id: string;
    spendId: string;
    type: TemplateType;
    requiredKeys: { server: boolean; emulator: boolean; cosigner: boolean };
    variables: Map<string, string>;
    sealed: Set<string>;
    /** In transaction order. */
    inputs: Input[];
    outputs: Output[];
    issues: Issue[];
    burns: AssetRoute[];
    /** Filled by an instance's expansion: the coin slots of each input. */
    groups: number[][];
    fee?: Fee;
    locktime?: LockSpec;
    packets?: PacketSpec;
    /** Sorted by input. */
    triggers: Trigger[];
    artifacts: string[];
}

export interface Construction {
    def: Definition;
    /** By flattened constructor field. */
    args: Map<string, ByteTemplate>;
    /** The bytes variable holding a given tree. */
    taptree?: string;
}

export interface Schedule {
    beforeExpirySeconds: number;
    minConfirmations: number;
}

export interface LockSpec {
    n: number;
    variable?: string;
}

export interface Input {
    name: string;
    onchain: boolean;
    schedule: Schedule;
    /** The int variable holding before_expiry_seconds. */
    leadVariable?: string;
    contract: Construction;
    function: string;
    leaf: string;
    selected: ArtifactFunction;
    selectedLeaf: Leaf;
    /** Flattened covenant inputs. */
    arguments: ByteTemplate[];
    /** Non-signature witness items. */
    witness: Map<string, ByteTemplate>;
    sequence?: LockSpec;
}

export interface Locking {
    from: number;
    script?: ByteTemplate;
    contract?: Construction;
}

export interface Draw {
    from: number;
    /** Undefined for the remainder. */
    amount?: ByteTemplate;
}

export interface Output {
    name: string;
    index: number;
    onchain: boolean;
    /** The input of the first draw: the context of the output's expressions. */
    from: number;
    draws: Draw[];
    locking: Locking;
    assets: AssetRoute[];
    each: number;
    /** In an instance, the coin of a copy of an each output. */
    coin: number;
}

export interface AssetRoute {
    from: number;
    issue: number;
    /** The asset as written; undefined, with `asset`, for the catch-all. */
    spec?: string;
    asset?: ByteTemplate;
    /** Undefined for the remainder. */
    amount?: ByteTemplate;
}

export interface Issue {
    name: string;
    /** Undefined for a new asset. */
    asset?: ByteTemplate;
    control?: { asset?: ByteTemplate; issue: number };
    metadata: { key: string; value: ByteTemplate }[];
}

export interface Fee {
    from: number;
    max: number;
    maxVariable?: string;
}

export interface Rule {
    type: number;
    action: "copy" | "drop" | "emit";
    from: number;
    data?: ByteTemplate;
}

export interface Advert {
    self: boolean;
    target: Uint8Array;
    /** Into `outputs`, in the target's slot order. */
    outputs: number[];
}

export interface PacketSpec {
    /** -1 places the extension when built. */
    index: number;
    drop: boolean;
    rules: Rule[];
    adverts: Advert[];
}

export interface Trigger {
    input: number;
    packet: number;
    raw: boolean;
    records: boolean;
    minValue: number;
    /** Sorted by source. */
    require: Requirement[];
    /** Sorted by variable. */
    captures: CaptureRule[];
    group?: string;
    all: boolean;
    ttlSeconds: number;
}

/** Exactly one of key, lit, variable and expr is set. */
export interface Requirement {
    source: string;
    key?: string;
    lit?: Uint8Array;
    variable?: string;
    expr?: string[];
}

export interface CaptureRule {
    variable: string;
    type: string;
    source?: string;
    expr?: string[];
}

/** ctx is the slot whose context the expressions see. */
export interface Sink {
    name: string;
    copy: boolean;
    ctx: number;
    routes: AssetRoute[];
}

export const tokenName = (tok: string) => tok.slice(1, -1).replace(/^!/, "");

export function names(b: ByteTemplate): string[] {
    const out: string[] = [];
    const add = (n: string) => {
        if (!out.includes(n)) out.push(n);
    };
    for (const p of b) {
        if ("name" in p) add(p.name);
        if ("expr" in p) for (const tok of p.expr) if (tok.startsWith("<")) add(tokenName(tok));
    }
    return out;
}

export function literal(b: ByteTemplate): Uint8Array | undefined {
    const parts: Uint8Array[] = [];
    for (const p of b) {
        if (!("hex" in p)) return undefined;
        parts.push(p.hex);
    }
    return concatBytes(...parts);
}

export const hasProgram = (b: ByteTemplate) => b.some((p) => "program" in p);

export const outputIndex = (t: Template, name: string) =>
    t.outputs.findIndex((o) => o.name === name);

export const isTaptree = (t: Template, name: string) =>
    t.inputs.some((i) => i.contract.taptree === name);

export const allOutputs = (t: Template, slot: number) =>
    t.triggers.some((tr) => tr.input === slot && tr.all);

export const arkade = (t: Template) => t.inputs.some((i) => i.selected.arkade !== undefined);

export function contextFree(t: Template): boolean {
    const free = (args: Map<string, ByteTemplate>): boolean =>
        [...args.values()].every((b) =>
            b.every((p) => {
                if ("expr" in p) return isContextFree(p.expr);
                if (!("program" in p)) return true;
                return free(
                    (t.outputs[outputIndex(t, p.program)].locking.contract as Construction).args,
                );
            }),
        );
    return t.inputs.every((i) => free(i.contract.args));
}

export function sinks(t: Template): Sink[] {
    return [
        ...t.outputs.map((o) => ({
            name: `output ${JSON.stringify(o.name)}`,
            copy: o.coin >= 0,
            ctx: o.from,
            routes: o.assets,
        })),
        ...t.burns.map((b) => ({ name: "a burn", copy: false, ctx: b.from, routes: [b] })),
    ];
}
