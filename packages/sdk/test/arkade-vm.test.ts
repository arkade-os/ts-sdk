import { readdirSync, readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64, hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { OPCODE_VALUES } from "../src/arkade/opcodes";
import * as vm from "../src/arkade/vm";
import type { ComputeLimits, ExtensionCodec, VmTx } from "../src/arkade/vm";
import {
    AggregateComputeLimits,
    DefaultAggregateComputeLimits,
    MaxStackSize,
    maxCombinedStackByteSize,
    requestInputBudget,
} from "../src/arkade/vm/limits";
import { opcodeArray } from "../src/arkade/vm/opcodes";

// Vectors come from test/arkade-vm-oracle (Go, emulator 30a59c7); regenerate there, never by hand.
const PIN = { emulator: "30a59c7", module: "v0.2.0", go: "go1.27.3" };
const FAMILIES = [
    "core",
    "arith",
    "splice",
    "hash",
    "merkle",
    "introspect",
    "time",
    "sig",
    "ec",
    "asset",
    "packet",
    "tunnel",
    "intent",
    "covenant",
    "service",
] as const;

type SignRequest = {
    txid: string;
    inputIndex: number;
    scriptHash: Uint8Array;
    closurePubKeys: Uint8Array[];
};
type ServiceOpts = {
    vtxoExpiries: Map<string, bigint>;
    limits?: ComputeLimits;
    codec?: ExtensionCodec;
};
interface Emulate {
    emulateOffchainTx(
        o: ServiceOpts & { arkPsbt: Uint8Array; checkpoints: Uint8Array[] },
    ): SignRequest[];
    emulateBatchRegistration(
        o: ServiceOpts & { proofPsbt: Uint8Array; message: string },
    ): SignRequest[];
    emulateOnchainTx(o: Omit<ServiceOpts, "vtxoExpiries"> & { psbt: Uint8Array }): SignRequest[];
}

// vmCodec.ts (T5) and emulate.ts (T6) may not exist yet: loading them by computed path keeps
// their absence a run-time failure of the cases that need them, not a `typecheck` or load error.
async function optional<T>(path: string): Promise<{ mod: Partial<T>; error?: string }> {
    try {
        return { mod: await import(/* @vite-ignore */ new URL(path, import.meta.url).href) };
    } catch (e) {
        return { mod: {}, error: String(e) };
    }
}
const codecModule = await optional<{ vmExtensionCodec: ExtensionCodec }>(
    "../src/extension/vmCodec.ts",
);
const emulateModule = await optional<Emulate>("../src/arkade/vm/emulate.ts");
const codec = codecModule.mod.vmExtensionCodec;

function requireCodec(): ExtensionCodec {
    if (!codec) throw new Error(`no vmExtensionCodec: ${codecModule.error ?? "not exported"}`);
    return codec;
}

function emulate<K extends keyof Emulate>(name: K): Emulate[K] {
    const fn = emulateModule.mod[name];
    if (typeof fn !== "function") {
        throw new Error(`vm/emulate.ts ${name}: ${emulateModule.error ?? "not exported"}`);
    }
    return fn as Emulate[K];
}

type PrevoutJson = {
    outpoint: { txid: string; index: number };
    value?: string;
    script?: string;
    ark_tx_hex?: string;
    vtxo_script?: string;
};
type Expect = {
    ok: boolean;
    stack_hex?: string[];
    requests?: {
        txid: string;
        input_index: number;
        script_hash: string;
        closure_pubkeys: string[];
    }[];
    code?: string | null;
    kind?: string | null;
    stage?: string;
    failed_op?: string;
    position?: number;
    error_contains?: string;
};
type VmCase = {
    name: string;
    mode: "expression" | "covenant" | "service";
    op: string | null;
    hazard?: string;
    world?: string;
    input_index?: number;
    input_amount?: string;
    script_hex?: string;
    seed_hex?: string[];
    witness_hex?: string[];
    tap_leaf_hex?: string;
    leaf_version?: number;
    packets_from_tx?: boolean;
    expiry?: string;
    intent_message?: string;
    intent_message_fill?: { char: string; length: number };
    limits?: Record<string, number>;
    budget?: Record<string, number>;
    port_unsupported?: boolean;
    variant?: "offchain" | "proof" | "onchain";
    psbt_b64?: string;
    checkpoints_b64?: string[];
    message?: string;
    vtxo_expiries?: Record<string, string>;
    expect: Expect;
};
type CaseFile = {
    pin: typeof PIN;
    family: string;
    worlds: Record<string, { tx_hex: string; prevouts: PrevoutJson[] }>;
    cases: VmCase[];
};

const dir = new URL("./fixtures/arkade-vm/", import.meta.url);
const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, dir), "utf8")) as T;
const files = Object.fromEntries(FAMILIES.map((f) => [f, read<CaseFile>(`${f}.json`)]));
const allCases = FAMILIES.flatMap((f) => files[f].cases);

function fetcherFor(prevouts: PrevoutJson[]): vm.MapArkPrevOutFetcher {
    const f = new vm.MapArkPrevOutFetcher();
    for (const p of prevouts) {
        const op = { txid: hex.decode(p.outpoint.txid), index: p.outpoint.index };
        if (p.value !== undefined) {
            f.setPrevOut(op, { value: BigInt(p.value), script: hex.decode(p.script ?? "") });
        }
        if (p.ark_tx_hex) f.setArkTx(op, vm.parseTx(hex.decode(p.ark_tx_hex)));
        if (p.vtxo_script !== undefined) f.setVtxoPkScript(op, hex.decode(p.vtxo_script));
    }
    return f;
}

function chain(e: unknown): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (let x = e as Record<string, unknown> | undefined; x && out.length < 8; ) {
        out.push(x);
        x = x.cause as Record<string, unknown> | undefined;
    }
    return out;
}
const field = (e: unknown, k: string) => chain(e).find((x) => x[k] !== undefined)?.[k];

function expectFailure(err: unknown, c: VmCase) {
    expect(err, "expected a failure").toBeDefined();
    if (c.port_unsupported) {
        expect(field(err, "kind"), String(err)).toBe("ErrUnsupportedByPort");
        return;
    }
    const want = c.expect;
    expect(field(err, "code") ?? null, String(err)).toBe(want.code ?? null);
    if (want.kind) expect(field(err, "kind"), String(err)).toBe(want.kind);
    if (c.mode === "covenant" && want.failed_op !== undefined) {
        expect(field(err, "opcode")).toBe(want.failed_op);
        expect(field(err, "position")).toBe(want.position);
    }
    if (want.error_contains) expect(String(err)).toContain(want.error_contains);
}

function attempt<T>(fn: () => T): { value?: T; err?: unknown } {
    try {
        return { value: fn() };
    } catch (err) {
        return { err: err ?? new Error("thrown undefined") };
    }
}

function base(c: VmCase, file: CaseFile) {
    const w = file.worlds[c.world ?? ""];
    return {
        script: hex.decode(c.script_hex ?? ""),
        tx: vm.parseTx(hex.decode(w.tx_hex)),
        inputIndex: c.input_index ?? 0,
        fetcher: fetcherFor(w.prevouts),
        expiry: c.expiry === undefined ? undefined : BigInt(c.expiry),
        intentMessage:
            c.intent_message ?? c.intent_message_fill?.char.repeat(c.intent_message_fill.length),
        codec,
    };
}

// Expression engines get no packets of their own (Go's NewEngine); these cases model the
// SetAssetPacket/SetEmulatorPacket calls with what Execute would read off the same tx.
function packetsOf(c: VmCase, tx: VmTx) {
    if (!c.packets_from_tx) return {};
    return {
        assetPacket: requireCodec().readExtension(tx)?.assetPacket ?? undefined,
        emulatorPacket: requireCodec().findEmulatorPacket(tx) ?? undefined,
    };
}

const limitsMap = (l?: Record<string, number>): ComputeLimits | undefined =>
    l && new Map(Object.entries(l).map(([op, n]) => [Number(op), n]));

function disasmPC(e: ReturnType<typeof vm.newEngine>): string | undefined {
    const b = e.scripts[e.scriptIdx]?.[e.tokenizer.byteIndex()];
    return b === undefined ? undefined : opcodeArray[b].name;
}

// Go used its wall clock; every CHECKTIME vector agrees at this instant, 2001-is-past at equality
const NOW = 1_000_000_000n;

function runExpression(c: VmCase, file: CaseFile) {
    const opts = { ...base(c, file), inputAmount: BigInt(c.input_amount ?? "0"), now: NOW };
    let pc: string | undefined;
    const got = attempt(() => {
        const engine = vm.newEngine({ ...opts, ...packetsOf(c, opts.tx) });
        if (c.seed_hex?.length) engine.setStack(c.seed_hex.map((s) => hex.decode(s)));
        do {
            pc = disasmPC(engine) ?? pc;
        } while (!engine.step());
        return engine.getStack().map((s) => hex.encode(s));
    });
    if (c.expect.ok && !c.port_unsupported) {
        expect(got.err).toBeUndefined();
        expect(got.value).toEqual(c.expect.stack_hex);
    } else {
        expectFailure(got.err, c);
        if (!c.port_unsupported && c.expect.failed_op !== undefined) {
            expect(pc, "failed opcode").toBe(c.expect.failed_op);
        }
    }
    if (c.packets_from_tx || c.seed_hex || opts.intentMessage !== undefined) return;
    const { intentMessage: _, ...exprOpts } = opts;
    const single = attempt(() => hex.encode(vm.evalExpression(exprOpts)));
    if (c.expect.ok && c.expect.stack_hex?.length === 1) {
        expect(single.err).toBeUndefined();
        expect(single.value).toBe(c.expect.stack_hex[0]);
    } else if (c.expect.ok) {
        expect(field(single.err, "kind")).toBe(vm.KIND.expressionStackDepth);
    } else {
        expectFailure(single.err, c);
    }
}

// The kind alone cannot tell a limit from a truncated read, so pin the codec's reason.
const CODEC_FAILURE: Record<string, string> = {
    "packet/emulator-packet/count-1001": "emulator entry count 1001 exceeded",
    "packet/emulator-packet/script-length-10001": "emulator entry too large",
};

function runCovenant(c: VmCase, file: CaseFile) {
    const got = attempt(() =>
        vm.executeCovenant({
            ...base(c, file),
            tapLeaf: { script: hex.decode(c.tap_leaf_hex ?? ""), leafVersion: c.leaf_version ?? 0 },
            witness: (c.witness_hex ?? []).map((w) => hex.decode(w)),
            limits: limitsMap(c.limits),
            budget: c.budget && new vm.ComputeBudget(limitsMap(c.budget)),
        }),
    );
    if (c.expect.ok) expect(got.err).toBeUndefined();
    else expectFailure(got.err, c);
    const why = CODEC_FAILURE[c.name];
    if (why) expect(String(got.err)).toContain(why);
}

function runService(c: VmCase) {
    const psbt = base64.decode(c.psbt_b64 ?? "");
    const shared = {
        vtxoExpiries: new Map(
            Object.entries(c.vtxo_expiries ?? {}).map(([op, t]) => [op, BigInt(t)]),
        ),
        limits: limitsMap(c.limits),
        codec,
    };
    const got = attempt(() => {
        if (c.variant === "offchain") {
            const checkpoints = (c.checkpoints_b64 ?? []).map((b) => base64.decode(b));
            return emulate("emulateOffchainTx")({ ...shared, arkPsbt: psbt, checkpoints });
        }
        if (c.variant === "proof") {
            const message = c.message ?? "";
            return emulate("emulateBatchRegistration")({ ...shared, proofPsbt: psbt, message });
        }
        return emulate("emulateOnchainTx")({ limits: shared.limits, codec, psbt });
    });
    if (!c.expect.ok) {
        expectFailure(got.err, c);
        return;
    }
    expect(got.err).toBeUndefined();
    expect(
        (got.value ?? []).map((r) => ({
            txid: r.txid,
            input_index: r.inputIndex,
            script_hash: hex.encode(r.scriptHash),
            closure_pubkeys: r.closurePubKeys.map((k) => hex.encode(k)),
        })),
    ).toEqual(c.expect.requests);
}

type Slot = { value: number; name: string; length: number; aliases: string[] };
const opcodes = read<{ opcodes: Slot[] }>("opcodes.json").opcodes;

const entries = (limits: ReadonlyMap<number, number>) =>
    [...limits.entries()].sort((a, b) => a[0] - b[0]);

// §8 T1 coverage rule: the slots that can only fail, or only succeed, when executed.
const ALWAYS_FAIL = new Set([
    "OP_RETURN",
    "OP_CHECKMULTISIG",
    "OP_CHECKMULTISIGVERIFY",
    "OP_NOP1",
    ...[5, 6, 7, 8, 9, 10].map((n) => `OP_NOP${n}`),
    "OP_VERIF",
    "OP_VERNOTIF",
    "OP_RESERVED",
    "OP_VER",
    "OP_RESERVED1",
    "OP_RESERVED2",
    ...[188, 189, 190, 191, 192, 193, 194, 208, 221, 222, 223, 249, 252].map(
        (n) => `OP_UNKNOWN${n}`,
    ),
    "OP_SMALLINTEGER",
    "OP_PUBKEYS",
    "OP_PUBKEYHASH",
    "OP_PUBKEY",
    "OP_INVALIDOPCODE",
]);
const ALWAYS_SUCCEED = new Set(["OP_NOP"]);

describe("tables", () => {
    it("PIN OF EVERY VECTOR FILE", () => {
        const names = readdirSync(dir).filter((f) => f.endsWith(".json"));
        // the families, four tables, and ops-sig / ops-assets / emulate
        expect(names.length).toBe(FAMILIES.length + 7);
        for (const f of names) expect(read<{ pin: unknown }>(f).pin, f).toEqual(PIN);
    });

    it("OPCODE TABLE MATCHES VM/OPCODES.TS", () => {
        expect(opcodeArray.length).toBe(256);
        for (const o of opcodes) {
            const got = opcodeArray[o.value];
            expect({ value: got.value, name: got.name, length: got.length }).toEqual({
                value: o.value,
                name: o.name,
                length: o.length,
            });
            for (const n of [o.name, ...o.aliases]) expect(vm.OpcodeByName.get(n), n).toBe(o.value);
        }
    });

    it("OPCODE TABLE AGREES WITH SRC/ARKADE/OPCODES.TS", () => {
        const known = new Map(
            opcodes.flatMap((o) => [o.name, ...o.aliases].map((n) => [n, o.value])),
        );
        for (const [name, value] of Object.entries(OPCODE_VALUES)) {
            if (known.has(name)) expect(value, name).toBe(known.get(name));
        }
        for (const o of opcodes) {
            const arkade =
                o.value === 0xb3 || o.value === 0xbb || (o.value >= 0xc3 && o.value <= 0xf8);
            if (arkade && !o.name.startsWith("OP_UNKNOWN")) {
                expect(
                    [o.name, ...o.aliases].some((n) => n in OPCODE_VALUES),
                    o.name,
                ).toBe(true);
            }
        }
    });

    it("COMPUTE LIMITS MATCH VM/LIMITS.TS", () => {
        const dump = read<{
            default: { opcode: number; limit: number }[];
            aggregate: { opcode: number; limit: number }[];
            request_input_budget: number;
            engine: Record<string, number>;
        }>("compute_limits.json");
        const pairs = (l: { opcode: number; limit: number }[]) => l.map((e) => [e.opcode, e.limit]);
        const def = vm.DefaultComputeLimits();
        expect(entries(def)).toEqual(pairs(dump.default));
        expect(entries(AggregateComputeLimits(def))).toEqual(pairs(dump.aggregate));
        expect(entries(DefaultAggregateComputeLimits())).toEqual(pairs(dump.aggregate));
        expect([
            requestInputBudget,
            vm.MaxScriptElementSize,
            vm.MaxScriptSize,
            MaxStackSize,
            maxCombinedStackByteSize,
        ]).toEqual([
            dump.request_input_budget,
            dump.engine.max_script_element_size,
            dump.engine.max_script_size,
            dump.engine.max_stack_size,
            dump.engine.max_combined_stack_byte_size,
        ]);
    });

    it("SHA256 FRAMING IS PREFIX PLUS THE STDLIB PAYLOAD", () => {
        const f = read<{
            prefix_hex: string;
            total_len: number;
            payload_len: number;
            matches_emulator_golden: boolean;
            states: { data_hex: string; state_hex: string; digest_hex: string }[];
        }>("sha256_framing.json");
        const prefixLen = f.prefix_hex.length / 2;
        expect(f.matches_emulator_golden).toBe(true);
        expect(prefixLen + f.payload_len).toBe(f.total_len);
        for (const s of f.states) {
            const state = hex.decode(s.state_hex);
            const data = hex.decode(s.data_hex);
            expect(state.length).toBe(f.total_len);
            expect(hex.encode(state.subarray(0, prefixLen))).toBe(f.prefix_hex);
            const payload = state.subarray(prefixLen);
            expect(hex.encode(payload.subarray(0, 4))).toBe("73686103");
            const view = new DataView(payload.buffer, payload.byteOffset);
            expect(view.getBigUint64(100)).toBe(BigInt(data.length));
            expect(hex.encode(sha256(data))).toBe(s.digest_hex);
        }
    });

    it("EVERY SLOT IS COVERED, PASSING AND FAILING", () => {
        const covered = new Set(allCases.map((c) => c.op));
        const passes = new Set(allCases.filter((c) => c.expect.ok).map((c) => c.op));
        const fails = new Set(
            allCases
                .filter(
                    (c) => !c.expect.ok && c.expect.stage === "step" && c.expect.failed_op === c.op,
                )
                .map((c) => c.op),
        );
        const missing = opcodes.flatMap((o) => {
            const gaps = [];
            if (!covered.has(o.name)) gaps.push("any");
            if (!ALWAYS_FAIL.has(o.name) && !passes.has(o.name)) gaps.push("pass");
            if (!ALWAYS_SUCCEED.has(o.name) && !fails.has(o.name)) gaps.push("fail");
            return gaps.length ? [`${o.name}: ${gaps.join(",")}`] : [];
        });
        expect(missing).toEqual([]);
    });

    it("EVERY §3 HAZARD MAPS TO A NAMED CASE", () => {
        const hazards = read<{ hazards: { id: string }[] }>("hazards.json").hazards;
        const used = new Set(allCases.map((c) => c.hazard));
        expect(hazards.length).toBeGreaterThan(0);
        expect(hazards.filter((hz) => !used.has(hz.id)).map((hz) => hz.id)).toEqual([]);
    });
});

for (const family of FAMILIES) {
    const file = files[family];
    describe(family, () => {
        // Upper-cased so the lowercase `-t` family filters (e.g. "ec", "sig") match only these blocks.
        for (const c of file.cases) {
            it(c.name.toUpperCase(), () => {
                if (c.mode === "expression") runExpression(c, file);
                else if (c.mode === "covenant") runCovenant(c, file);
                else runService(c);
            });
        }
    });
}
