import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { base64, hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import {
    type ComputeLimits,
    type OutPoint,
    parseTx,
    serializeTx,
    serializeTxStripped,
    txid,
    type VmTx,
} from "../src/arkade/vm";
import { decodeClosure } from "../src/arkade/vm/closures";
import {
    emulateBatchRegistration,
    emulateOffchainTx,
    emulateOnchainTx,
    type SignRequest,
} from "../src/arkade/vm/emulate";
import { type DraftSource, draftFetcher } from "../src/arkade/vm/fetchers-ark";
import { vmExtensionCodec as codec } from "../src/extension/vmCodec";

// Every expectation is Go's: emulator v0.2.0 (30a59c7) run by test/arkade-vm-oracle on the exact
// bytes each case builds, which `digest` pins.
type ServiceWant = {
    digest: string;
    error?: string;
    code?: string;
    parseError?: string;
    requests?: { txid: string; inputIndex: number; scriptHash: string; closurePubKeys: string[] }[];
};
const oracle: {
    closures: { script: string; valid: boolean; keys?: string[]; error?: string }[];
    service: ({ name: string } & ServiceWant)[];
    draft: {
        name: string;
        prevTx: string;
        queries: {
            outpoint: string;
            value: number | null;
            script: string;
            arkTx: string;
            vtxoScript: string;
        }[];
    }[];
} = JSON.parse(readFileSync(new URL("./fixtures/arkade-vm/emulate.json", import.meta.url), "utf8"));
const CLOSURES = oracle.closures;
const SERVICE: Record<string, ServiceWant> = Object.fromEntries(
    oracle.service.map(({ name, ...want }) => [name, want]),
);
const DRAFT = oracle.draft;

type Pair = [Uint8Array, Uint8Array];
interface RawPsbt {
    global: Pair[];
    inputs: Pair[][];
    outputs: Pair[][];
}

function decodeRaw(b: Uint8Array): RawPsbt {
    let o = 5;
    const varInt = () => (b[o] < 0xfd ? b[o++] : ((o += 3), b[o - 2] | (b[o - 1] << 8)));
    const bytes = () => {
        const n = varInt();
        o += n;
        return b.slice(o - n, o);
    };
    const map = () => {
        const m: Pair[] = [];
        for (let k = bytes(); k.length > 0; k = bytes()) m.push([k, bytes()]);
        return m;
    };
    const global = map();
    const tx = parseTx(global[0][1]);
    return { global, inputs: tx.inputs.map(() => map()), outputs: tx.outputs.map(() => map()) };
}

function encodeRaw(p: RawPsbt): Uint8Array {
    const parts: Uint8Array[] = [Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff)];
    const push = (b: Uint8Array) => {
        const n = b.length;
        const le = (w: number) => Array.from({ length: w }, (_, i) => (n >>> (8 * i)) & 0xff);
        parts.push(
            Uint8Array.from(n < 0xfd ? [n] : n <= 0xffff ? [0xfd, ...le(2)] : [0xfe, ...le(4)]),
            b,
        );
    };
    for (const m of [p.global, ...p.inputs, ...p.outputs]) {
        for (const [k, v] of m) {
            push(k);
            push(v);
        }
        parts.push(Uint8Array.of(0));
    }
    return concatBytes(...parts);
}

const txOf = (p: RawPsbt): VmTx => parseTx(p.global[0][1]);
const setTx = (p: RawPsbt, tx: VmTx) => {
    p.global[0][1] = serializeTxStripped(tx);
};
const same = (a: Uint8Array, b: Uint8Array) => hex.encode(a) === hex.encode(b);
const get = (m: Pair[], k: Uint8Array): Uint8Array =>
    (m.find(([key]) => same(key, k)) as Pair)[1].slice();
/** Go's set: replaces the first pair keyed `k`, deletes it for null, or appends. */
function set(m: Pair[], k: Uint8Array, v: Uint8Array | null): Pair[] {
    const i = m.findIndex(([key]) => same(key, k));
    if (i < 0) return v ? [...m, [k, v]] : m;
    return v ? m.map((kv, j) => (j === i ? [k, v] : kv)) : m.filter((_, j) => j !== i);
}
const withInput0 = (tx: VmTx, edit: object): VmTx => ({
    ...tx,
    inputs: tx.inputs.map((input, i) => (i === 0 ? { ...input, ...edit } : input)),
});

const WITNESS_UTXO = Uint8Array.of(0x01);
const PREV_ARK_TX = Uint8Array.of(0xde, ...new TextEncoder().encode("prevarktx"));
const PREVOUT_TX = Uint8Array.of(0xde, ...new TextEncoder().encode("prevouttx"));

/** OP_RETURN <"ARK" 0x01 len packet>. */
function extensionWith(packet: number[]): Uint8Array {
    const data = [0x41, 0x52, 0x4b, 0x01, packet.length, ...packet];
    return Uint8Array.from([0x6a, data.length, ...data]);
}
/** One emulator entry for vin 0, with no witness. */
const extensionScript = (entryScript: number[], trailing: number[] = []): Uint8Array =>
    extensionWith([0x01, 0x00, 0x00, entryScript.length, ...entryScript, 0x00, ...trailing]);
const withLeafKey = (p: RawPsbt, edit: (cb0: number) => number) => {
    p.inputs[0] = p.inputs[0].map(([k, v]) =>
        k[0] === 0x15 ? [Uint8Array.of(0x15, edit(k[1]), ...k.subarray(2)), v] : [k, v],
    );
};
function replaceExtension(p: RawPsbt, script: Uint8Array) {
    const tx = txOf(p);
    setTx(p, {
        ...tx,
        outputs: tx.outputs.map((o) => (o.script[0] === 0x6a ? { ...o, script } : o)),
    });
}

type VmCase = {
    name: string;
    psbt_b64: string;
    checkpoints_b64?: string[];
    message?: string;
};
const fixtures = JSON.parse(
    readFileSync(new URL("./fixtures/arkade-vm/service.json", import.meta.url), "utf8"),
) as { cases: VmCase[] };
const fixture = (name: string) => fixtures.cases.find((c) => c.name === name) as VmCase;

type Built = {
    variant: "offchain" | "proof" | "onchain";
    psbt: Uint8Array;
    checkpoints?: Uint8Array[];
    message?: string;
    limits?: ComputeLimits;
};

const singleVtxo = fixture("service/offchain/valid/single-vtxo");
const arkBytes = base64.decode(singleVtxo.psbt_b64);
const cpBytes = base64.decode((singleVtxo.checkpoints_b64 as string[])[0]);
const offchain = (p: RawPsbt, checkpoints = [cpBytes]): Built => ({
    variant: "offchain",
    psbt: encodeRaw(p),
    checkpoints,
});
const ark = () => decodeRaw(arkBytes);
const onchainBytes = base64.decode(fixture("service/onchain/valid/single-input").psbt_b64);
const packet = (bytes: number[]): Built => {
    const p = ark();
    replaceExtension(p, extensionWith(bytes));
    return offchain(p);
};

const BUILD: Record<string, () => Built> = {
    "ark input without witness utxo": () => {
        const p = ark();
        p.inputs[0] = set(p.inputs[0], WITNESS_UTXO, null);
        return offchain(p);
    },
    "two prevarktx fields": () => {
        const p = ark();
        p.inputs[0] = [
            ...p.inputs[0],
            [PREV_ARK_TX, Uint8Array.of(...get(p.inputs[0], PREV_ARK_TX), 0)],
        ];
        return offchain(p);
    },
    "prevarktx with trailing bytes": () => {
        const p = ark();
        const prev = Uint8Array.of(...get(p.inputs[0], PREV_ARK_TX), 0, 1);
        p.inputs[0] = set(p.inputs[0], PREV_ARK_TX, prev);
        return offchain(p);
    },
    "prevarktx with a superfluous witness record": () => {
        const p = ark();
        const prev = parseTx(get(p.inputs[0], PREV_ARK_TX));
        const raw = serializeTxStripped(prev);
        const flagged = concatBytes(
            raw.subarray(0, 4),
            Uint8Array.of(0x00, 0x01),
            raw.subarray(4, -4),
            new Uint8Array(prev.inputs.length),
            raw.subarray(-4),
        );
        p.inputs[0] = set(p.inputs[0], PREV_ARK_TX, flagged);
        return offchain(p);
    },
    "identical prevarktx twice": () => {
        const p = ark();
        p.inputs[0] = [...p.inputs[0], [PREV_ARK_TX, get(p.inputs[0], PREV_ARK_TX)]];
        return offchain(p);
    },
    "nil checkpoint": () => offchain(ark(), [new Uint8Array(0)]),
    "checkpoint without inputs": () => {
        const cp = decodeRaw(cpBytes);
        const unfunded = { ...txOf(cp), inputs: [] };
        setTx(cp, unfunded);
        cp.inputs = [];
        const p = ark();
        setTx(p, withInput0(txOf(p), { txid: txid(unfunded) }));
        return offchain(p, [encodeRaw(cp)]);
    },
    "ark input vout beyond checkpoint outputs": () => {
        const p = ark();
        setTx(p, withInput0(txOf(p), { index: 5 }));
        return offchain(p);
    },
    "ark input without tapleaf": () => {
        const p = ark();
        p.inputs[0] = p.inputs[0].filter(([k]) => k[0] !== 0x15);
        return offchain(p);
    },
    "tapleaf decodes as no closure": () => {
        const p = ark();
        p.inputs[0] = p.inputs[0].map(([k, v]) =>
            k[0] === 0x15 ? [k, Uint8Array.of(0x51, 0xc0)] : [k, v],
        );
        return offchain(p);
    },
    "witness utxo script length byte is not read": () => {
        const p = ark();
        const utxo = get(p.inputs[0], WITNESS_UTXO);
        utxo[8] = 0;
        p.inputs[0] = set(p.inputs[0], WITNESS_UTXO, utxo);
        return offchain(p);
    },
    "malformed script fails expiry scan": () => {
        const p = ark();
        replaceExtension(p, extensionScript([0x02, 0x01]));
        return offchain(p);
    },
    "emulator packet with trailing byte": () => {
        const p = ark();
        replaceExtension(p, extensionScript([0x51], [0x00]));
        return offchain(p);
    },
    "proof with only its message input": () => {
        const f = fixture("service/proof/invalid/only-message-input-entry");
        const p = decodeRaw(base64.decode(f.psbt_b64));
        const tx = txOf(p);
        setTx(p, { ...tx, inputs: tx.inputs.slice(0, 1) });
        p.inputs = p.inputs.slice(0, 1);
        return { variant: "proof", psbt: encodeRaw(p), message: f.message };
    },
    "onchain input spending a non-taproot prevout": () => {
        const p = decodeRaw(base64.decode(fixture("service/onchain/valid/single-input").psbt_b64));
        const prev = parseTx(get(p.inputs[0], PREVOUT_TX));
        const out = { ...prev.outputs[0], script: Uint8Array.of(0x51) };
        const forged = { ...prev, outputs: [out, ...prev.outputs.slice(1)] };
        p.inputs[0] = set(p.inputs[0], PREVOUT_TX, serializeTx(forged));
        setTx(p, withInput0(txOf(p), { txid: txid(forged) }));
        const utxo = new Uint8Array(10);
        new DataView(utxo.buffer).setBigInt64(0, out.value, true);
        utxo.set([0x01, 0x51], 8);
        p.inputs[0] = set(p.inputs[0], WITNESS_UTXO, utxo);
        return { variant: "onchain", psbt: encodeRaw(p) };
    },
    "malformed script fails engine creation": () => {
        const p = decodeRaw(onchainBytes);
        replaceExtension(p, extensionScript([0x02, 0x01]));
        return { variant: "onchain", psbt: encodeRaw(p) };
    },
    "ark input control block with the wrong parity": () => {
        const p = ark();
        withLeafKey(p, (cb0) => cb0 ^ 1);
        return offchain(p);
    },
    "ark input witness utxo is not taproot": () => {
        const cp = decodeRaw(cpBytes);
        const tx = txOf(cp);
        const bare = {
            ...tx,
            outputs: tx.outputs.map((o, i) => (i ? o : { ...o, script: Uint8Array.of(0x51) })),
        };
        setTx(cp, bare);
        const p = ark();
        setTx(p, withInput0(txOf(p), { txid: txid(bare) }));
        const utxo = get(p.inputs[0], WITNESS_UTXO);
        p.inputs[0] = set(
            p.inputs[0],
            WITNESS_UTXO,
            Uint8Array.of(...utxo.subarray(0, 8), 0x01, 0x51),
        );
        return offchain(p, [encodeRaw(cp)]);
    },
    "prevarktx over the length cap": () => {
        const p = ark();
        p.inputs[0] = set(p.inputs[0], PREV_ARK_TX, new Uint8Array(1_000_001));
        return offchain(p);
    },
    "control block leaf version differs from the leaf's": () => {
        const p = decodeRaw(onchainBytes);
        withLeafKey(p, () => 0xc2);
        return { variant: "onchain", psbt: encodeRaw(p) };
    },
    "exact compute limits replace the defaults": () => ({
        variant: "onchain",
        psbt: onchainBytes,
        limits: new Map([[0x51, 0]]),
    }),
    "emulator packet without entries": () => packet([0x00]),
    "emulator entry with an empty script": () => packet([0x01, 0x00, 0x00, 0x00, 0x00]),
    "emulator entries sharing a vin": () =>
        packet([0x02, 0x00, 0x00, 0x01, 0x51, 0x00, 0x00, 0x00, 0x01, 0x51, 0x00]),
    "emulator packet over the entry cap": () => packet([0xfd, 0xe9, 0x03]),
    "emulator entry vin beyond the inputs": () => packet([0x01, 0x05, 0x00, 0x01, 0x51, 0x00]),
    "extension shorter than its packet length": () => {
        const p = ark();
        replaceExtension(p, Uint8Array.of(0x6a, 0x07, 0x41, 0x52, 0x4b, 0x01, 0x10, 0x00, 0x00));
        return offchain(p);
    },
};

// The codec (src/extension/vmCodec.ts) words these refusals differently from Go; this file pins
// the refusal and the gate's prefix, not the codec's text.
const CODEC_WORDED = new Set([
    "emulator packet without entries",
    "emulator entry with an empty script",
    "emulator entries sharing a vin",
    "emulator packet over the entry cap",
    "emulator entry vin beyond the inputs",
    "extension shorter than its packet length",
]);

const digestOf = (b: Built): string =>
    hex.encode(
        sha256(
            new TextEncoder().encode(
                [b.psbt, ...(b.checkpoints ?? [])].map(base64.encode).join(","),
            ),
        ),
    );

function emulate(b: Built): SignRequest[] {
    const vtxoExpiries = new Map<string, bigint>();
    if (b.variant === "offchain") {
        return emulateOffchainTx({
            arkPsbt: b.psbt,
            checkpoints: b.checkpoints ?? [],
            vtxoExpiries,
            codec,
        });
    }
    if (b.variant === "proof") {
        return emulateBatchRegistration({
            proofPsbt: b.psbt,
            message: b.message ?? "",
            vtxoExpiries,
            codec,
        });
    }
    return emulateOnchainTx({ psbt: b.psbt, codec, limits: b.limits });
}

function codeOf(e: unknown): string | undefined {
    for (let x = e as { code?: string; cause?: unknown } | undefined; x; x = x.cause as typeof x) {
        if (x.code !== undefined) return x.code;
    }
    return undefined;
}

const asJson = (r: SignRequest) => ({
    txid: r.txid,
    inputIndex: r.inputIndex,
    scriptHash: hex.encode(r.scriptHash),
    closurePubKeys: r.closurePubKeys.map((k) => hex.encode(k)),
});

describe("emulate gates and fetchers", () => {
    for (const [name, want] of Object.entries(SERVICE)) {
        it(name, () => {
            const built = BUILD[name]();
            expect(digestOf(built)).toBe(want.digest);
            if (want.parseError) {
                // Go fails psbt.NewFromRawBytes with "Invalid Psbt due to duplicate key"
                expect(() => emulate(built)).toThrow("invalid psbt: duplicate key");
                return;
            }
            if (!want.error) {
                expect(emulate(built).map(asJson)).toEqual(want.requests ?? []);
                return;
            }
            let err: unknown;
            expect(() => {
                try {
                    emulate(built);
                } catch (e) {
                    err = e;
                    throw e;
                }
            }).toThrow();
            const gate = "failed to parse emulator packet: ";
            if (CODEC_WORDED.has(name)) {
                const prefix = want.error.slice(0, want.error.indexOf(gate) + gate.length);
                expect((err as Error).message.startsWith(prefix), (err as Error).message).toBe(
                    true,
                );
            } else {
                expect((err as Error).message).toBe(want.error);
            }
            expect(codeOf(err)).toBe(want.code);
        });
    }

    it("refuses an extension it cannot read rather than skipping it", () => {
        const run = () =>
            emulateOffchainTx({
                arkPsbt: arkBytes,
                checkpoints: [cpBytes],
                vtxoExpiries: new Map(),
            });
        expect(run).toThrow(expect.objectContaining({ kind: "ErrUnsupportedByPort" }));
    });
});

describe("closure decoding", () => {
    CLOSURES.forEach((c, i) => {
        it(`${i} ${c.script.slice(0, 40)}`, () => {
            let got: { keys?: string[]; error?: string };
            try {
                got = { keys: decodeClosure(hex.decode(c.script)).map((k) => hex.encode(k)) };
            } catch (e) {
                got = { error: (e as Error).message };
            }
            expect(got).toEqual(c.valid ? { keys: c.keys ?? [] } : { error: c.error });
        });
    });
});

describe("draft fetcher", () => {
    const prev = parseTx(hex.decode(DRAFT[0].prevTx));
    const prevId = txid(prev);
    const filled = (b: number) => new Uint8Array(32).fill(b);
    const bound: DraftSource = { outpoint: { txid: prevId, index: 0 }, amount: 1000n, tx: prev };
    const wrongAmount: DraftSource = {
        outpoint: { txid: prevId, index: 1 },
        amount: 999n,
        tx: prev,
    };
    const noTx: DraftSource = { outpoint: { txid: filled(7), index: 7 }, amount: 5n };
    const queries: OutPoint[] = [
        { txid: filled(0), index: 0 },
        bound.outpoint,
        wrongAmount.outpoint,
        noTx.outpoint,
        { txid: filled(9), index: 9 },
    ];
    const cases: [boolean, DraftSource[]][] = [
        [true, [bound, wrongAmount, noTx]],
        [true, [wrongAmount, bound]],
        [false, [noTx, bound]],
    ];
    const display = (h: Uint8Array) => hex.encode(h.slice().reverse());
    cases.forEach(([proof, sources], n) => {
        it(DRAFT[n].name, () => {
            const inputs = [...(proof ? [queries[0]] : []), ...sources.map((s) => s.outpoint)];
            const tx: VmTx = {
                version: 3,
                locktime: 0,
                inputs: inputs.map((op) => ({
                    ...op,
                    sequence: 0xffffffff,
                    scriptSig: new Uint8Array(0),
                })),
                outputs: [],
            };
            const f = draftFetcher(tx, [...(proof ? [null] : []), ...sources]);
            const got = queries.map((op) => {
                const out = f.fetchPrevOutput(op);
                const arkTx = f.fetchPrevOutArkTx(op);
                const vtxo = f.fetchVtxoPrevOutPkScript(op);
                return {
                    outpoint: `${display(op.txid)}:${op.index}`,
                    value: out ? Number(out.value) : null,
                    script: out ? hex.encode(out.script) : "nil",
                    arkTx: arkTx ? display(txid(arkTx)) : "nil",
                    vtxoScript: vtxo ? hex.encode(vtxo) : "nil",
                };
            });
            // VmTxOut has no nil script, so Go's nil pkScript compares as empty
            const want = DRAFT[n].queries.map((q) => ({
                ...q,
                script: q.value === null ? "nil" : q.script.replace("nil", ""),
            }));
            expect(got).toEqual(want);
        });
    });
});
