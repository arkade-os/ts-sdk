import { TaprootControlBlock } from "@scure/btc-signer";
import { concatBytes } from "@scure/btc-signer/utils.js";

import type { IntentFeeConfig } from "../../../arkfee";
import { Extension } from "../../../extension";
import { BufferWriter } from "../../../extension/utils";
import { ArkPsbtFieldKey, ArkPsbtFieldKeyType } from "../../../utils/unknownFields";
import {
    serializeTx,
    serializeTxOut,
    serializeTxStripped,
    serializeWitness,
    type VmTx,
    type VmTxOut,
} from "../../vm";
import type { Leaf } from "../abi";
import { type ByteTemplate, type Template, within } from "../compile";
import { fail } from "../errors";
import {
    checkSources,
    checkSourceScript,
    messageOf,
    newDraft,
    pkScriptOf,
    type Src,
} from "./draft";
import { type Entry, extension } from "./extension";
import { type Instance, leafOf } from "./instance";
import { allocate, intentFee, outputScripts } from "./output";

export interface Fee {
    /** The Ark server's fee programs, for a proof. */
    intent?: IntentFeeConfig;
    /** The fee of an onchain transaction of vsize virtual bytes. */
    onchain?: (vsize: number) => bigint;
    /** The least amount of an output. */
    dust: bigint;
}

export interface Action {
    /** The unsigned PSBT, BIP 174 serialized. A proof's has no message input. */
    psbt: Uint8Array;
    /** Its unsigned transaction. */
    tx: Uint8Array;
    fee: bigint;
    /** Output index of the extension, -1 without one. */
    extension: number;
    /** Output indexes of a proof's onchain outputs. */
    onchain: number[];
}

interface Spending {
    leaf: Leaf;
    proof: { script: Uint8Array; controlBlock: Uint8Array; leafVersion: number };
    /** The non-signature witness items, bottom of the stack first. */
    witness: Uint8Array[];
    entry?: Entry;
}

const q = JSON.stringify;
const EMPTY = new Uint8Array();
const MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff);
const utf8 = new TextEncoder();
const arkKey = (name: string) => concatBytes(Uint8Array.of(ArkPsbtFieldKeyType), utf8.encode(name));

/** Builds over coins[k] sources per input k, in slot order; undefined keeps the layout. */
export function buildCoins(
    base: Instance,
    given: readonly (Src | undefined)[],
    coins: readonly number[] | undefined,
    fee: Fee,
): Action {
    const i = coins ? base.relayout(coins) : base;
    const t = i.tmpl;
    checkSources(given, t.inputs.length);
    const sources = given as readonly Src[];
    t.inputs.forEach((input, slot) => checkSourceScript(input, sources[slot], i.contracts[slot]));
    const d = newDraft(t.type, sources, { locktime: i.locktime, sequences: i.sequences });
    const spends = spendsOf(i, d);
    const scripts = outputScripts(i, d, sources);
    const charged = t.type === "proof" ? intentFee(i, d, sources, scripts, fee) : 0n;
    let a = allocate(i, d, sources, charged, fee.dust);

    const ext = extension(
        i,
        d,
        sources,
        a,
        spends.flatMap((s) => (s.entry ? [s.entry] : [])),
    );
    let index = -1;
    const outs: VmTxOut[] = t.outputs.map((_, k) => ({
        value: BigInt.asIntN(64, a.sats[k]),
        script: scripts[k],
    }));
    if (ext.length > 0) {
        try {
            outs.push({ value: 0n, script: Extension.create(ext).serialize() });
        } catch (e) {
            throw fail("ineligible", `extension: ${messageOf(e)}`);
        }
        index = extensionIndex(t);
    } else if (t.packets && t.packets.index >= 0) {
        throw fail("ineligible", "nothing to write in the extension");
    }
    const pos = positions(t, index);
    const placed: VmTxOut[] = [];
    pos.forEach((p, k) => (placed[p] = outs[k]));
    if (index >= 0) placed[index] = outs[pos.length];
    const tx: VmTx = {
        version: d.tx.version,
        locktime: i.locktime,
        inputs: sources.map((s, slot) => ({
            ...s.outpoint,
            scriptSig: EMPTY,
            sequence: i.sequences[slot],
        })),
        outputs: placed,
    };

    let paid = charged;
    if (t.type === "onchain") {
        if (!fee.onchain) throw fail("ineligible", "no on-chain fee estimate");
        const estimate: unknown = fee.onchain(vsize(tx, spends));
        if (typeof estimate !== "bigint" || estimate < 0n) {
            throw fail("ineligible", `on-chain fee ${String(estimate)} out of range`);
        }
        paid = estimate;
        a = allocate(i, d, sources, paid, fee.dust);
        pos.forEach((p, k) => (placed[p] = { ...placed[p], value: BigInt.asIntN(64, a.sats[k]) }));
    }
    return {
        psbt: psbt(tx, sources, i, spends),
        tx: serializeTx(tx),
        fee: paid,
        extension: index,
        onchain:
            t.type === "proof"
                ? pos.filter((_, k) => t.outputs[k].onchain).sort((x, y) => x - y)
                : [],
    };
}

function spendsOf(i: Instance, d: ReturnType<typeof newDraft>): Spending[] {
    return i.tmpl.inputs.map((input, slot) => {
        const ct = i.contracts[slot];
        const [cb, scriptVersion] = leafOf(ct, input);
        const proof = {
            script: scriptVersion.subarray(0, -1),
            controlBlock: TaprootControlBlock.encode(cb),
            leafVersion: scriptVersion[scriptVersion.length - 1],
        };
        const leaf = input.selectedLeaf;
        const item = (what: string, b: ByteTemplate, type: string) =>
            within(`input ${q(input.name)} ${what}`, () => i.decoded(b, type, d, slot));
        // a leaf's metadata lists stack items top first, a witness bottom first
        const witness = leaf.witness
            .filter((w) => w.type !== "signature")
            .map((w) =>
                item(`witness ${q(w.name)}`, input.witness.get(w.name) as ByteTemplate, w.type),
            )
            .reverse();
        const covenant = ct.covenants.get(input.function);
        if (covenant === undefined) return { leaf, proof, witness };
        // Go pairs the flattened arguments with the declared, unflattened inputs (build.go:202)
        const items = (input.selected.arkade?.inputs ?? [])
            .map((f, k) => item(`argument ${q(f.name)}`, input.arguments[k], f.type))
            .reverse();
        return {
            leaf,
            proof,
            witness,
            entry: { vin: slot, script: covenant.slice(), witness: items },
        };
    });
}

/** The stated output_index, else after the offchain outputs of a proof, else last. */
function extensionIndex(t: Template): number {
    const stated = t.packets?.index ?? -1;
    if (stated >= 0) return stated;
    return t.outputs.filter((o) => t.type !== "proof" || !o.onchain).length;
}

/** Each output's place in the transaction; an automatic extension shifts what follows it. */
function positions(t: Template, ext: number): number[] {
    const auto = t.packets !== undefined && t.packets.index < 0 && ext >= 0;
    return t.outputs.map((o) => (auto && o.index >= ext ? o.index + 1 : o.index));
}

/** Assumes ark-lib finalization: 64-byte signatures, bound items, leaf script, control block. */
function vsize(tx: VmTx, spends: readonly Spending[]): number {
    const signed: VmTx = {
        ...tx,
        inputs: tx.inputs.map((input, slot) => {
            const s = spends[slot];
            const sigs = s.leaf.witness.filter((w) => w.type === "signature");
            return {
                ...input,
                witness: [
                    ...sigs.map(() => new Uint8Array(64)),
                    ...s.witness,
                    s.proof.script,
                    s.proof.controlBlock,
                ],
            };
        }),
    };
    const weight = serializeTxStripped(signed).length * 3 + serializeTx(signed).length;
    return Math.floor((weight + 3) / 4);
}

// psbt.Packet.Serialize for the fields a build sets, in btcd's order
function psbt(tx: VmTx, sources: readonly Src[], i: Instance, spends: readonly Spending[]) {
    const w = new BufferWriter();
    const pair = (key: Uint8Array, value: Uint8Array) => {
        w.writeCompactSlice(key);
        w.writeCompactSlice(value);
    };
    w.write(MAGIC);
    pair(Uint8Array.of(0x00), serializeTxStripped(tx));
    w.writeByte(0);
    sources.forEach((s, slot) => {
        const { proof, witness } = spends[slot];
        const amount = BigInt.asIntN(64, s.amount);
        pair(Uint8Array.of(0x01), serializeTxOut({ value: amount, script: pkScriptOf(s) }));
        pair(
            concatBytes(Uint8Array.of(0x15), proof.controlBlock),
            concatBytes(proof.script, Uint8Array.of(proof.leafVersion)),
        );
        pair(arkKey(ArkPsbtFieldKey.VtxoTaprootTree), tapTree(i.contracts[slot].script.scripts));
        if (witness.length > 0)
            pair(arkKey(ArkPsbtFieldKey.ConditionWitness), serializeWitness(witness));
        w.writeByte(0);
    });
    for (const _ of tx.outputs) w.writeByte(0);
    return w.toBytes();
}

/** txutils.TapTree.Encode: depths of a left caterpillar, leaf i at i+1 and the last two together. */
function tapTree(scripts: readonly Uint8Array[]): Uint8Array {
    const w = new BufferWriter();
    scripts.forEach((s, k) => {
        w.writeByte(Math.min(k + 1, scripts.length - 1) & 0xff);
        w.writeByte(0xc0);
        w.writeCompactSlice(s);
    });
    return w.toBytes();
}
