import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";

import {
    bind,
    build,
    compile,
    decode,
    decodeArtifact,
    type Fee,
    instantiate,
    type Source,
    type Template,
    TemplateError,
} from "../src/arkade/template";
import { Failure } from "../src/arkade/template/errors";
import { parseTx, serializeTx, serializeWitness, txid } from "../src/arkade/vm";
import { Extension } from "../src/extension";

// Rules no vector reaches, with the outcomes of the Go executor's own tests at af8d9eb.
const DIR = new URL("./fixtures/template-v1/", import.meta.url);
const vector = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, DIR), "utf8"));
const keys = (() => {
    const k = vector("onchain").bindings.keys;
    return {
        server: hex.decode(k.server),
        emulator: hex.decode(k.emulator),
        cosigner: hex.decode(k.cosigner),
    };
})();
const P2TR = "5120f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const A1 = `${"01".repeat(32)}0000`;

function edited(name: string, edit: (doc: any) => void): Template {
    const doc = structuredClone(vector(name).template);
    edit(doc);
    return compile(decode(new TextEncoder().encode(JSON.stringify(doc))));
}

/** One transaction paying `amounts` to the address a watch of `t` derives. */
function funded(t: Template, variables: Record<string, Uint8Array>, coins: [number, string?][]) {
    const script = instantiate(t, { keys, variables }).pkScript(0);
    const tx = {
        version: 3,
        locktime: 0,
        inputs: [
            {
                txid: new Uint8Array(32).fill(7),
                index: 0,
                scriptSig: new Uint8Array(),
                sequence: 0,
            },
        ],
        outputs: coins.map(([value]) => ({ value: BigInt(value), script })),
    };
    const id = hex.encode(txid(tx).reverse());
    return coins.map(
        ([value, asset], vout): Source => ({
            txid: id,
            vout,
            tx: serializeTx(tx),
            amount: BigInt(value),
            assets: asset ? [{ id: hex.decode(asset), amount: 3n }] : [],
        }),
    );
}

const thrown = (f: () => unknown): string | undefined => {
    try {
        f();
    } catch (e) {
        if (e instanceof TemplateError) return `${e.stage}/${e.code}`;
        throw e;
    }
    return undefined;
};
const snapshot = (t: Template) =>
    JSON.stringify(t, (_, v) =>
        v instanceof Map || v instanceof Set ? [...v] : v instanceof Uint8Array ? hex.encode(v) : v,
    );

describe("coins (coins_test.go TestEachCoin)", () => {
    const pool = (all: boolean) =>
        edited("proof-plain-leaf", (d) => {
            d.variables = { note: "bytes" };
            d.outputs = [
                {
                    name: "keep",
                    each: "funds",
                    value: { from: "funds", amount: 1000 },
                    locking: { from: "funds" },
                    assets: [{ from: "funds", asset: A1, amount: 1 }],
                },
                {
                    name: "pooled",
                    value: { from: "funds" },
                    locking: { from: "funds" },
                    assets: [{ from: "funds" }],
                },
                {
                    name: "payment",
                    type: "onchain",
                    value: { from: "funds", amount: 25000 },
                    locking: P2TR,
                },
            ];
            if (!all) return;
            d.delegation = {
                trigger: {
                    funds: {
                        packet: 7,
                        decode: "tlv",
                        require: { "tlv:0": "<SERVER_KEY>" },
                        capture: { note: "tlv:1" },
                        expires_after_seconds: 60,
                        all_outputs: true,
                    },
                },
            };
        });
    const variables = { note: Uint8Array.of(1) };
    const fee: Fee = { dust: 330n };

    it("repeats an each output per coin and pools the rest, on both paths", () => {
        const t = pool(true);
        const before = snapshot(t);
        const sources = funded(t, variables, [
            [10_000, A1],
            [20_000, A1],
            [30_000, A1],
        ]);
        const a = build(bind(t, { keys, variables }), { sources, coins: [3], fee });
        const tx = parseTx(a.tx);
        expect(tx.inputs).toHaveLength(3);
        expect(tx.outputs.map((o) => o.value)).toEqual([1000n, 1000n, 1000n, 32_000n, 0n, 25_000n]);
        expect(a.extension).toBe(4);
        expect(a.onchain).toEqual([5]);
        const groups = Extension.fromBytes(tx.outputs[4].script).getAssetPacket()?.groups ?? [];
        expect(groups.map((g) => g.outputs.map((o) => [o.vout, o.amount]))).toEqual([
            [
                [0, 1n],
                [1, 1n],
                [2, 1n],
                [3, 6n],
            ],
        ]);
        // a watch takes the coins as built
        const again = instantiate(t, { keys, variables }).buildCoins(sources, [3], fee);
        expect(hex.encode(again.tx)).toBe(hex.encode(a.tx));
        expect(snapshot(t)).toBe(before);
    });

    it("refuses layouts the template does not allow", () => {
        const sources = funded(pool(true), variables, [
            [10_000, A1],
            [20_000, A1],
            [30_000, A1],
        ]);
        const r = (t: Template, coins?: number[]) => () =>
            build(bind(t, { keys, variables }), { sources, coins, fee });
        expect(thrown(r(pool(true)))).toBe("build/ineligible");
        expect(thrown(r(pool(false), [3]))).toBe("build/ineligible");
        const instance = instantiate(pool(true), { keys, variables, sources, coins: [3] });
        expect(thrown(() => instance.buildCoins(sources, [3], fee))).toBe("build/unsupported");
    });
});

describe("locks (positions_test.go TestLeafTimelocks)", () => {
    const locked = (edit: (d: any) => void = () => {}) =>
        edited("onchain", (d) => {
            d.inputs[0].contract.definition.functions[0].leaves[0].asm = [
                ...["700", "OP_CHECKLOCKTIMEVERIFY", "OP_DROP", "144", "OP_CHECKSEQUENCEVERIFY"],
                ...["OP_DROP", "<COSIGNER_KEY>", "OP_CHECKSIG"],
            ];
            edit(d);
        });
    const fee: Fee = { dust: 330n, onchain: () => 600n };
    const sources = funded(locked(), {}, [[100_000]]);
    const built = (t: Template) =>
        parseTx(build(bind(t, { keys, variables: {} }), { sources, fee }).tx);

    it("takes the leaf's locks, or stated ones it accepts", () => {
        const leaf = built(locked());
        expect([leaf.locktime, leaf.inputs[0].sequence]).toEqual([700, 144]);
        const stated = built(locked((d) => ((d.locktime = 800), (d.inputs[0].sequence = 200))));
        expect([stated.locktime, stated.inputs[0].sequence]).toEqual([800, 200]);
        for (const edit of [
            (d: any) => (d.locktime = 600),
            (d: any) => (d.locktime = 1_800_000_000),
            (d: any) => (d.inputs[0].sequence = 100),
        ]) {
            expect(thrown(() => built(locked(edit)))).toBe("build/ineligible");
        }
    });
});

it("puts the first declared covenant input on top of the stack", () => {
    const t = edited("virtual-plain-leaf", (d) => {
        d.packets = { output_index: 2 };
        d.inputs[0].contract.definition.functions[1].arkade = {
            inputs: [
                { name: "x", type: "int" },
                { name: "y", type: "bytes" },
            ],
            asm: ["OP_2DROP", "OP_1"],
        };
        d.inputs[0].spend = { function: "pay", leaf: "pay", arguments: [5, "abcd"] };
    });
    const sources = funded(t, {}, [[100_000]]);
    const a = build(bind(t, { keys, variables: {} }), { sources, fee: { dust: 330n } });
    const ext = Extension.fromBytes(parseTx(a.tx).outputs[a.extension].script);
    const witness = ext.getEmulatorPacket()?.entries[0].witness ?? new Uint8Array();
    expect(hex.encode(witness)).toBe(
        hex.encode(serializeWitness([hex.decode("abcd"), Uint8Array.of(5)])),
    );
});

it("flattens a covenant array input by index, its first element nearest the top", () => {
    const [s0, s1] = ["08".repeat(32), "09".repeat(32)];
    const t = edited("virtual-plain-leaf", (d) => {
        d.packets = { output_index: 2 };
        d.inputs[0].contract.definition.functions[1].arkade = {
            inputs: [
                { name: "a", type: "int" },
                { name: "sigs", type: "bytes32[2]" },
            ],
            asm: ["OP_2DROP", "OP_DROP", "OP_1"],
        };
        d.inputs[0].spend = { function: "pay", leaf: "pay", arguments: [7, s0, s1] };
    });
    const sources = funded(t, {}, [[100_000]]);
    const a = build(bind(t, { keys, variables: {} }), { sources, fee: { dust: 330n } });
    const ext = Extension.fromBytes(parseTx(a.tx).outputs[a.extension].script);
    const witness = ext.getEmulatorPacket()?.entries[0].witness ?? new Uint8Array();
    expect(hex.encode(witness)).toBe(
        hex.encode(serializeWitness([hex.decode(s1), hex.decode(s0), Uint8Array.of(7)])),
    );
});

// Go's types rule these out: uint64 fees, time.Time stamps and parsed *btcec.PublicKey keys.
describe("caller inputs Go cannot express", () => {
    const t = edited("onchain", () => {});
    const sources = funded(t, {}, [[100_000]]);
    const fee: Fee = { dust: 330n, onchain: () => 600n };
    const run = (s: Source[], f: Fee) => () =>
        build(bind(t, { keys, variables: {} }), { sources: s, fee: f });

    it("refuses an on-chain fee that is negative or not a bigint", () => {
        expect(thrown(run(sources, fee))).toBeUndefined();
        for (const paid of [-600n, 600, undefined]) {
            const f = { ...fee, onchain: () => paid as bigint };
            expect(thrown(run(sources, f))).toBe("build/ineligible");
        }
    });

    it("refuses an expiry or creation time that is not whole non-negative seconds", () => {
        expect(thrown(run([{ ...sources[0], expiry: 1_800_000_000, createdAt: 0 }], fee))).toBe(
            undefined,
        );
        for (const bad of [1.5, -1, 2 ** 53, Number.NaN]) {
            expect(thrown(run([{ ...sources[0], expiry: bad }], fee))).toBe("build/ineligible");
            expect(thrown(run([{ ...sources[0], createdAt: bad }], fee))).toBe("build/ineligible");
        }
    });

    it("refuses at bind a key that is not a compressed point, as it does a missing one", () => {
        const bound = (k: object) => () => bind(t, { keys: { ...keys, ...k }, variables: {} });
        expect(thrown(bound({ cosigner: undefined }))).toBe("bind/unsupported");
        for (const bad of [new Uint8Array(33), keys.server.subarray(1), new Uint8Array(65)]) {
            for (const role of ["server", "emulator", "cosigner"]) {
                expect(thrown(bound({ [role]: bad }))).toBe("bind/unsupported");
            }
        }
    });
});

describe("what a compiled template or instance shares with its caller", () => {
    const utf8 = new TextEncoder();

    it("reports a bad artifact as compile/invalid_artifact", () => {
        expect(thrown(() => decodeArtifact(utf8.encode("{}")))).toBe("compile/invalid_artifact");
        expect(thrown(() => decodeArtifact(utf8.encode("[")))).toBe("compile/invalid_artifact");
    });

    it("takes its id from the template it compiles, not the document's word", () => {
        const json = vector("onchain").template;
        const onchain = decode(utf8.encode(JSON.stringify(json)));
        const other = decode(
            utf8.encode(JSON.stringify({ ...json, fees: { ...json.fees, max: 9 } })),
        );
        expect(other.id).not.toBe(onchain.id);
        const forged = compile({ ...onchain, template: other.template });
        expect([forged.id, forged.spendId]).toEqual([other.id, other.spendId]);
    });

    it("copies the artifact and inline definitions it compiles", () => {
        const v = vector("boarding");
        const artifacts = new Map(
            Object.entries<object>(v.artifacts).map(([id, a]) => [
                id,
                decodeArtifact(utf8.encode(JSON.stringify(a))),
            ]),
        );
        const doc = decode(utf8.encode(JSON.stringify(v.template)));
        const t = compile(doc, artifacts);
        const inline = decode(utf8.encode(JSON.stringify(vector("onchain").template)));
        const u = compile(inline);
        const before = [snapshot(t), snapshot(u)];
        for (const { definition } of artifacts.values()) {
            definition.functions[0].leaves[0].asm.push("OP_DROP");
            definition.constructorInputs.pop();
        }
        const def = (inline.template.inputs[0].contract.definition as { def: any }).def;
        def.functions[0].leaves[0].asm.push("OP_DROP");
        expect([snapshot(t), snapshot(u)]).toEqual(before);
    });

    it("copies the keys it is instantiated with", () => {
        const k = { ...keys, cosigner: keys.cosigner.slice() };
        const i = instantiate(
            edited("onchain", () => {}),
            { keys: k, variables: {} },
        );
        k.cosigner[1] ^= 1;
        expect(i.keys.cosigner).toEqual(keys.cosigner);
    });
});

describe("bounds and codes from arkade-os/executor#18", () => {
    it("bounds delegation seconds by uint32", () => {
        const schedule = (n: number) => () =>
            edited("counter", (d) => (d.delegation.schedule.counter.before_expiry_seconds = n));
        const trigger = (n: number) => () =>
            edited("counter", (d) => {
                d.variables = { a: "bytes" };
                d.delegation = {
                    trigger: {
                        counter: {
                            packet: 7,
                            require: { "tlv:0": "0x01" },
                            capture: { a: "tlv:3" },
                            expires_after_seconds: n,
                        },
                    },
                };
                delete d.packets.advertise;
            });
        for (const f of [schedule, trigger]) {
            expect(thrown(f(2 ** 32 - 1))).toBeUndefined();
            expect(thrown(f(2 ** 32))).toBe("decode/invalid_template");
        }
    });

    it("checks the service keys before it opens the variables", () => {
        const t = edited("onchain", () => {});
        const watch = () =>
            instantiate(t, {
                keys: { ...keys, cosigner: undefined },
                variables: { nope: Uint8Array.of(1) },
            });
        expect(thrown(watch)).toBe("instantiate/unsupported");
    });

    it("codes an input that cannot pay the fee as unaffordable, still ineligible", () => {
        const t = edited("onchain", () => {});
        const sources = funded(t, {}, [[500]]);
        const fee: Fee = { dust: 330n, onchain: () => 600n };
        let e: unknown;
        try {
            build(bind(t, { keys, variables: {} }), { sources, fee });
        } catch (err) {
            e = err;
        }
        expect(e).toBeInstanceOf(TemplateError);
        expect([(e as TemplateError).code, ((e as TemplateError).cause as Failure).kinds]).toEqual([
            "unaffordable",
            ["ineligible", "unaffordable"],
        ]);
    });
});

it("spends offline only through service and emulator signers (locks.go OfflineSpend)", () => {
    const offline = (leaf: string, direct: boolean) => {
        const t = edited("virtual-plain-leaf", (d) => {
            d.packets = { output_index: 2 };
            d.inputs[0].spend = { function: leaf, leaf };
        });
        const i = instantiate(t, { keys, variables: {} });
        return thrown(() => i.offlineSpend(direct)) ?? "ok";
    };
    // pay: <SERVER_KEY> and <EMULATOR_KEY:pay>; spend: <SERVER_KEY> and <owner>
    expect([offline("pay", false), offline("pay", true), offline("spend", false)]).toEqual([
        "ok",
        "spend/unsupported",
        "spend/unsupported",
    ]);
});
