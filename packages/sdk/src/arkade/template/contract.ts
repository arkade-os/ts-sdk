import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";

import { TapTreeCoder, VtxoScript, type TapLeafScript } from "../../script/base";
import { computeArkadeScriptPublicKey } from "../tweak";
import { decodeClosure } from "../vm/closures";
import { type Definition, flatten } from "./abi";
import { assemble, type Lookup, type Value } from "./asm";
import { fail } from "./errors";

/** The service keys a contract is resolved under, each a 33-byte compressed key. */
export interface ContractKeys {
    server?: Uint8Array;
    emulator?: Uint8Array;
    cosigner?: Uint8Array;
}

/** A built taproot output: leaves in the given tree's order if any, else function then leaf order. */
export interface Contract {
    script: VtxoScript;
    /** Function name to its assembled covenant. */
    covenants: Map<string, Uint8Array>;
    /** Function name, then leaf name, to the leaf with its control block. */
    proofs: Map<string, Map<string, TapLeafScript>>;
}

const MAX_TAPTREE_BYTES = 8 << 10;
const MAX_LEAVES = 400;
const utf8 = new TextEncoder();
const bytes32 = (raw: Uint8Array): Value => ({ type: "bytes32", raw });

// contract.go wraps every lookup error with %v, so even a missing cosigner reports a bad leaf.
const badLeaf = (message: string) => fail("invalid_template", `bad leaf: ${message}`);
const badTree = (message: string) => fail("ineligible", `bad taptree: ${message}`);

/**
 * Assembles the covenants and leaves of `def` under `args`, the flattened constructor fields as
 * canonical bytes. With `taptree`, the declared leaves must be in it and the tree's leaves are taken.
 */
export function buildContract(
    def: Definition,
    args: Record<string, Uint8Array>,
    keys: ContractKeys,
    taptree?: Uint8Array,
): Contract {
    const types = new Map(flatten(def, def.constructorInputs).map((f) => [f.name, f.type]));
    const raw = (name: string): Uint8Array => {
        const v = Object.hasOwn(args, name) && types.has(name) ? args[name] : undefined;
        if (v === undefined) throw new Error(`unknown constructor value "${name}"`);
        return v;
    };
    const field = (name: string): Value => {
        const v = raw(name);
        const type = types.get(name) as string;
        return type === "pubkey" ? bytes32(xOnly(v, name)) : { type, raw: v };
    };

    const covenants = new Map<string, Uint8Array>();
    for (const fn of def.functions) {
        if (!fn.arkade) continue;
        const script = assembled(fn.arkade.asm, `function "${fn.name}"`, (name) => {
            if (name !== "COSIGNER_KEY") return field(name);
            xOnly(keys.cosigner, "cosigner key");
            return { type: "bytes", raw: utf8.encode(hex.encode(keys.cosigner as Uint8Array)) };
        });
        covenants.set(fn.name, script);
    }
    const tweak = (key: Uint8Array, fn: string): Uint8Array => {
        const covenant = covenants.get(fn);
        if (!covenant) throw new Error(`function "${fn}" has no covenant`);
        return computeArkadeScriptPublicKey(key, covenant);
    };
    const leafLookup: Lookup = (name) => {
        const parts = name.split(":");
        if (name === "SERVER_KEY") return bytes32(xOnly(keys.server, "server key"));
        if (name === "COSIGNER_KEY") return bytes32(xOnly(keys.cosigner, "cosigner key"));
        if (parts[0] === "EMULATOR_KEY" && parts.length === 2) {
            return bytes32(tweak(xOnly(keys.emulator, "emulator key"), parts[1]));
        }
        if (parts[0] === "TWEAK" && parts.length === 3) {
            return bytes32(tweak(xOnly(raw(parts[1]), parts[1]), parts[2]));
        }
        return field(name);
    };

    const scripts: Uint8Array[] = [];
    const names: [string, string][] = [];
    const seen = new Set<string>();
    for (const fn of def.functions) {
        for (const leaf of fn.leaves) {
            const s = assembled(leaf.asm, `leaf ${fn.name}/${leaf.name}`, leafLookup);
            if (seen.has(hex.encode(s))) throw badLeaf(`duplicate leaf ${fn.name}/${leaf.name}`);
            seen.add(hex.encode(s));
            scripts.push(s);
            names.push([fn.name, leaf.name]);
        }
    }
    if (scripts.length === 0) throw badLeaf("no leaves");

    let tree = scripts;
    if (taptree !== undefined) {
        tree = decodeTaptree(taptree);
        const given = new Set(tree.map((s) => hex.encode(s)));
        names.forEach(([fn, leaf], i) => {
            if (!given.has(hex.encode(scripts[i]))) {
                throw badTree(`leaf ${fn}/${leaf} is not in the taptree`);
            }
        });
    }
    const script = new VtxoScript(tree);
    const proofs = new Map<string, Map<string, TapLeafScript>>();
    names.forEach(([fn, leaf], i) => {
        if (!proofs.has(fn)) proofs.set(fn, new Map());
        proofs.get(fn)?.set(leaf, script.findLeaf(hex.encode(scripts[i])));
    });
    return { script, covenants, proofs };
}

function assembled(tokens: readonly string[], where: string, lookup: Lookup): Uint8Array {
    try {
        return assemble(tokens, lookup);
    } catch (e) {
        throw badLeaf(`${where}: ${(e as Error).message}`);
    }
}

function xOnly(key: Uint8Array | undefined, what: string): Uint8Array {
    if (key === undefined) throw new Error(`no ${what}`);
    if (key.length !== 33) throw new Error(`${what} must be a 33-byte compressed key`);
    secp256k1.Point.fromBytes(key);
    return key.subarray(1);
}

// Leaves of a BIP-371 tree in its own order, depths ignored as arkd's DecodeTapTree does; each must
// be a closure arkd accepts.
function decodeTaptree(raw: Uint8Array): Uint8Array[] {
    if (raw.length > MAX_TAPTREE_BYTES) {
        throw badTree(`taptree of ${raw.length} bytes exceeds ${MAX_TAPTREE_BYTES}`);
    }
    let scripts: Uint8Array[];
    try {
        scripts = TapTreeCoder.decode(raw).map((l) => l.script);
    } catch (e) {
        throw badTree((e as Error).message);
    }
    if (scripts.length === 0) throw badTree("no leaf");
    if (scripts.length > MAX_LEAVES) throw badTree(`more than ${MAX_LEAVES} leaves`);
    for (const s of scripts) {
        try {
            decodeClosure(s);
        } catch (e) {
            throw badTree((e as Error).message);
        }
    }
    const seen = new Set<string>();
    for (const s of scripts) {
        const leaf = hex.encode(s);
        if (seen.has(leaf)) throw badTree(`leaf ${leaf} is repeated`);
        seen.add(leaf);
    }
    return scripts;
}
