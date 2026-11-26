import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
    type AssetGroupLike,
    type AssetIdLike,
    ErrUnsupportedByPort,
    executeCovenant,
    MapArkPrevOutFetcher,
    newEngine,
    parseTx,
    serializeWitness,
    txid,
    type VmTx,
} from "../src/arkade/vm";
import { Extension, UnknownPacket } from "../src/extension";
import { BufferWriter } from "../src/extension/utils";
import { vmExtensionCodec as codec } from "../src/extension/vmCodec";

// Expectations come from test/arkade-vm-oracle (emulator pkg/arkade v0.2.0, ark-lib 97386cb3d95c,
// go1.27.3), which also checked every mask against CalcArkadeScriptSignatureHash.
type World = {
    txid: string;
    outputs?: [value: string, script: string][];
    recipe?: string;
    ark_tx?: string;
    orphan?: true;
};
type Expect = string[] | string;
type Row = [
    name: string,
    mode: "ex" | "cov",
    world: string,
    packets: string,
    input: number,
    script: string,
    expect: Expect,
    message?: string,
    goAnswer?: Expect,
];
type CodecRow = [world: string, ext: unknown, emu: unknown, mask: unknown];

type GoAnswer = { stack?: string[]; code?: string; kind?: string; ok?: boolean };
const oracle: {
    base_tx: string;
    ark_tx: string;
    worlds: ({ name: string } & World & { outputs: World["outputs"] })[];
    codec: { world: string; ext: unknown; emu: unknown; mask: unknown }[];
    cases: {
        name: string;
        mode: string;
        world: string;
        packets?: string;
        input: number;
        script: string;
        message?: string;
        message_nesting?: number;
        go: GoAnswer;
        unsupported?: boolean;
    }[];
} = JSON.parse(
    readFileSync(new URL("./fixtures/arkade-vm/ops-assets.json", import.meta.url), "utf8"),
);

const expectOf = (g: GoAnswer): Expect => {
    if (g.stack) return g.stack;
    if (g.code) return g.code;
    if (g.kind) return `kind:${g.kind}`;
    if (g.ok) return "ok";
    throw new Error(`unclassified Go answer ${JSON.stringify(g)}`);
};

const BASE_TX = oracle.base_tx;
const ARK_TX = oracle.ark_tx;
const LEAF = hex.decode("2079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac");
const DOC = oracle.cases.find((c) => c.name === "intent/doc/n1")?.message ?? "";

const WORLDS: Record<string, World> = Object.fromEntries(
    oracle.worlds.map((w) => {
        const spec: World = { txid: w.txid };
        if (w.recipe) spec.recipe = w.recipe;
        else if (w.outputs?.length) spec.outputs = w.outputs;
        if (w.ark_tx) spec.ark_tx = w.ark_tx;
        if (w.orphan) spec.orphan = true;
        return [w.name, spec];
    }),
);

type Packet = { type: number; data: string };
type Entry = { vin: number; script: string; witness: string };
const CODEC: CodecRow[] = oracle.codec.map((c) => {
    const ext = c.ext as { packets: Packet[]; assets: unknown } | string | null;
    const mask = c.mask as { index: number; value: string; script: string } | null;
    return [
        c.world,
        ext && typeof ext === "object"
            ? { packets: ext.packets.map((p) => [p.type, p.data]), assets: ext.assets }
            : ext,
        Array.isArray(c.emu) ? (c.emu as Entry[]).map((e) => [e.vin, e.script, e.witness]) : c.emu,
        mask && [mask.index, mask.value, mask.script],
    ];
});

const CASES: Row[] = oracle.cases.map((c) => {
    const message =
        c.message_nesting !== undefined
            ? `nest:${c.message_nesting}`
            : c.message === DOC
              ? "doc"
              : c.message;
    const row: Row = [
        c.name,
        c.mode === "covenant" ? "cov" : "ex",
        c.world,
        c.packets ?? "",
        c.input,
        c.script,
        c.unsupported ? "unsupported" : expectOf(c.go),
    ];
    if (message !== undefined || c.unsupported) row.push(message);
    if (c.unsupported) row.push(expectOf(c.go));
    return row;
});

const p2trish = (b: number) => Uint8Array.from([0x51, 0x20, ...new Array(32).fill(b)]);
const fill = (n: number, b: number) => new Uint8Array(n).fill(b);
const le16 = (v: number) => [v & 0xff, v >> 8];
const bytes = (...parts: (number[] | Uint8Array)[]) =>
    concatBytes(...parts.map((p) => Uint8Array.from(p)));
const extension = (type: number, data: Uint8Array) =>
    Extension.create([new UnknownPacket(type, data)]).serialize();

function emuEntry(vin: number, script: number[] | Uint8Array, witness: Uint8Array): Uint8Array {
    const w = new BufferWriter();
    w.writeUint16LE(vin);
    w.writeCompactSlice(Uint8Array.from(script));
    w.writeCompactSlice(witness);
    return w.toBytes();
}

const seq1001 = Array.from({ length: 1001 }, (_, i) => [1, ...le16(i), 1]).flat();
const maxEntry = () =>
    emuEntry(
        0,
        fill(10_000, 0x61),
        serializeWitness([...Array.from({ length: 99 }, () => fill(10_000, 7)), fill(9699, 7)]),
    );

// Too big to pin as hex: rebuilt here, and each world's pinned txid proves the bytes match.
const RECIPES: Record<string, () => Uint8Array> = {
    "groups-1001": () =>
        extension(0, bytes([0xe9, 0x07], new Array(1001).fill([0, 0, 1, 1, 0, 0, 1]).flat())),
    "groups-1000": () =>
        extension(0, bytes([0xe8, 0x07], new Array(1000).fill([0, 0, 1, 1, 0, 0, 1]).flat())),
    "inputs-1001": () =>
        extension(0, bytes([1, 1], fill(32, 0x11), [0, 0, 0xe9, 0x07], seq1001, [0])),
    "outputs-1001": () => extension(0, bytes([1, 0, 0, 0xe9, 0x07], seq1001)),
    "emu-witness-item-10001": () =>
        extension(1, bytes([1], emuEntry(0, [0x51], serializeWitness([fill(10_001, 7)])))),
    "emu-budget-max": () => extension(1, bytes([1], maxEntry())),
    "emu-budget-over": () =>
        extension(1, bytes([2], maxEntry(), emuEntry(1, [0x51], new Uint8Array(0)))),
};

const base = parseTx(hex.decode(BASE_TX));
const built = new Map<string, { tx: VmTx; fetcher: MapArkPrevOutFetcher }>();

function world(name: string): { tx: VmTx; fetcher: MapArkPrevOutFetcher } {
    const cached = built.get(name);
    if (cached) return cached;
    const spec = WORLDS[name];
    const extra = spec.recipe
        ? [{ value: 0n, script: RECIPES[spec.recipe]() }]
        : (spec.outputs ?? []).map(([v, s]) => ({ value: BigInt(v), script: hex.decode(s) }));
    const [in0, in1] = base.inputs;
    const fetcher = new MapArkPrevOutFetcher()
        .setPrevOut(in0, { value: 5000n, script: p2trish(9) })
        .setVtxoPkScript(in0, p2trish(1))
        .setArkTx(in0, parseTx(hex.decode(spec.ark_tx ?? ARK_TX)));
    if (!spec.orphan) fetcher.setPrevOut(in1, { value: 3000n, script: p2trish(2) });
    const w = { tx: { ...base, outputs: [...base.outputs, ...extra] }, fetcher };
    built.set(name, w);
    return w;
}

const big = (b: Uint8Array) => (b.length > 64 ? `sha256:${hex.encode(sha256(b))}` : hex.encode(b));
const idJSON = (id: AssetIdLike) => ({ txid: hex.encode(id.txid), index: id.index });
const groupJSON = (g: AssetGroupLike) => ({
    id: g.assetId && idJSON(g.assetId),
    ctrl: g.controlAsset && {
        type: g.controlAsset.type,
        id: idJSON(g.controlAsset.assetId),
        group: g.controlAsset.groupIndex,
    },
    inputs: g.inputs.map((i) => ({
        type: i.type,
        vin: i.vin,
        txid: hex.encode(i.txid),
        amount: String(i.amount),
    })),
    outputs: g.outputs.map((o) => ({ type: o.type, vout: o.vout, amount: String(o.amount) })),
    metadata: g.metadata.map((m) => hex.encode(m.serialize())),
});

function attempt<T>(f: () => T): { value?: T; err?: unknown } {
    try {
        return { value: f() };
    } catch (err) {
        return { err };
    }
}

const orError = <T>(f: () => T): T | "error" => {
    const r = attempt(f);
    return r.err === undefined ? (r.value as T) : "error";
};

function summary(tx: VmTx): unknown[] {
    const ext = orError(() => {
        const e = codec.readExtension(tx);
        if (!e) return null;
        const groups = e.assetPacket;
        return {
            packets: e.packets.map((p) => [p.type, big(p.serialize())]),
            assets:
                groups && (groups.length > 8 ? { groups: groups.length } : groups.map(groupJSON)),
        };
    });
    const emu = orError(
        () =>
            codec
                .findEmulatorPacket(tx)
                ?.map((e) => [e.vin, big(e.script), big(serializeWitness(e.witness))]) ?? null,
    );
    const m = codec.maskExtensionOutput(tx);
    return [ext, emu, m && [m.index, String(m.output.value), big(m.output.script)]];
}

function messageOf(key: string): string {
    if (key.startsWith("nest:")) {
        const n = Number(key.slice(5));
        return "[".repeat(n) + "]".repeat(n);
    }
    return (key === "doc" ? DOC : key).replaceAll("%u", "\\" + "u");
}

function run([, mode, worldName, packets, input, script, , message]: Row): Expect {
    const { tx, fetcher } = world(worldName);
    if (mode === "cov") {
        executeCovenant({
            script: hex.decode(script),
            tapLeaf: { script: LEAF, leafVersion: 0xc0 },
            witness: [],
            tx,
            inputIndex: 0,
            fetcher,
            codec,
        });
        return "ok";
    }
    const from = packets ? world(packets).tx : undefined;
    const engine = newEngine({
        script: hex.decode(script),
        tx,
        inputIndex: input,
        inputAmount: fetcher.fetchPrevOutput(tx.inputs[input])?.value ?? 0n,
        fetcher,
        codec,
        intentMessage: message === undefined ? undefined : messageOf(message),
        assetPacket: (from && codec.readExtension(from)?.assetPacket) ?? undefined,
        emulatorPacket: (from && codec.findEmulatorPacket(from)) ?? undefined,
    });
    while (!engine.step()) {}
    return engine.getStack().map(big);
}

describe("vmExtensionCodec", () => {
    it("rebuilds every Go world byte for byte", () => {
        for (const [name, spec] of Object.entries(WORLDS)) {
            expect(hex.encode(txid(world(name).tx)), name).toBe(spec.txid);
        }
    });
    for (const [name, ...want] of CODEC) {
        it(`reads ${name} as Go does`, () => expect(summary(world(name).tx)).toEqual(want));
    }
});

describe("asset, packet, tunnel and intent ops", () => {
    for (const row of CASES) {
        it(row[0], () => {
            const got = attempt(() => run(row));
            const want = row[6];
            if (want === "unsupported") {
                expect(got.err).toBeInstanceOf(ErrUnsupportedByPort);
            } else if (Array.isArray(want) || want === "ok") {
                expect(got.err).toBeUndefined();
                expect(got.value).toEqual(want);
            } else {
                const err = got.err as { code?: string; kind?: string } | undefined;
                const kind = want.startsWith("kind:");
                expect(kind ? err?.kind : err?.code, String(got.err)).toBe(
                    want.replace("kind:", ""),
                );
            }
        });
    }
});

// Where the SDK's own codecs and Go disagree, which is why vmCodec re-applies Go's rules.
describe("the SDK codecs differ from Go", () => {
    const script = (name: string) => world(name).tx.outputs[3].script;
    const sdkAccepts = (f: () => unknown) => attempt(f).err === undefined;
    const goAccepts = (name: string, field: 1 | 2) =>
        CODEC.find(([w]) => w === name)?.[field] !== "error";
    const extension = (s: Uint8Array) => Extension.fromBytes(s);
    const emulator = (s: Uint8Array) => Extension.fromBytes(s).getEmulatorPacket();
    const probes: [string, (s: Uint8Array) => unknown, 1 | 2][] = [
        ["assets", extension, 1],
        ["dup-intent-vin", extension, 1],
        ["groups-1001", extension, 1],
        ["inputs-1001", extension, 1],
        ["outputs-1001", extension, 1],
        ["trail-empty", extension, 1],
        ["packets", extension, 1],
        ["emu-noncanonical", emulator, 2],
        ["emu-witness-noncanonical", emulator, 2],
        ["emu-witness-item-10001", emulator, 2],
        ["emu-budget-over", emulator, 2],
    ];
    for (const [name, probe, field] of probes) {
        it(name, () => expect(sdkAccepts(() => probe(script(name)))).toBe(!goAccepts(name, field)));
    }
    it("junk after the push", () => {
        expect(Extension.isExtension(script("junk-after-push"))).toBe(false);
        expect(codec.readExtension(world("junk-after-push").tx)).not.toBeNull();
    });
    it("a second push", () => {
        expect(Extension.fromBytes(script("two-pushes")).getPacketByType(8)).not.toBeNull();
        expect(codec.readExtension(world("two-pushes").tx)?.packets.map((p) => p.type)).toEqual([
            7,
        ]);
    });
});
