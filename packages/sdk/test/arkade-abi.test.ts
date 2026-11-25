import { readdirSync, readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { ScriptNum, Transaction } from "@scure/btc-signer";
import { concatBytes, hash160 } from "@scure/btc-signer/utils.js";
import { describe, expect, it } from "vitest";

import { programFromArtifact } from "../src/arkade/artifact";
import { ArkadeProgramScript } from "../src/arkade/program";
import { computeArkadeScriptPublicKey } from "../src/arkade/tweak";
import {
    type Definition,
    decodeArtifact,
    flatten,
    parseDefinition,
} from "../src/arkade/template/abi";
import { buildContract, type Contract, type ContractKeys } from "../src/arkade/template/contract";
import { Failure } from "../src/arkade/template/errors";
import { decode } from "../src/arkade/template/jcs";
import { TapTreeCoder, type TapLeafScript } from "../src/script/base";
import delegatedBoarding from "../src/script/executor/delegated_boarding.json";
import delegatedVtxo from "../src/script/executor/delegated_vtxo.json";
import { defaultContract } from "../src/script/executor/executorTemplate";
import { VHTLC } from "../src/script/vhtlc";
import { sequenceToTimelock } from "../src/utils/timelock";

const VECTORS = new URL("./fixtures/template-v1/", import.meta.url);

type Json = any;

const files = readdirSync(VECTORS)
    .filter((f) => f.endsWith(".json"))
    .sort();
const vectors: Json[] = files.map((f) => JSON.parse(readFileSync(new URL(f, VECTORS), "utf8")));
const vector = (name: string): Json => vectors.find((v) => v.name === name);

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const sn = (n: number) => ScriptNum().encode(BigInt(n));
const pub = (n: number) => {
    const secret = new Uint8Array(32);
    secret[31] = n;
    return secp256k1.getPublicKey(secret, true);
};

function kinds(f: () => unknown): readonly string[] {
    try {
        f();
        return [];
    } catch (e) {
        return e instanceof Failure ? e.kinds : [`not a Failure: ${e}`];
    }
}

function templateOf(v: Json): Json | undefined {
    if (v.template) return v.template;
    try {
        return JSON.parse(v.template_text);
    } catch {
        return undefined;
    }
}

function constructionsOf(t: Json): Json[] {
    const out: Json[] = [];
    const walk = (o: Json) => {
        if (Array.isArray(o)) o.forEach(walk);
        else if (o && typeof o === "object") {
            if (o.definition) out.push(o);
            Object.values(o).forEach(walk);
        }
    };
    walk([t.inputs, t.outputs]);
    return out;
}

function definitionOf(v: Json, c: Json): Definition | undefined {
    const ref = c.definition.artifact;
    if (ref === undefined) return parseDefinition(decode(bytes(c.definition)));
    return v.artifacts[ref] && decodeArtifact(bytes(v.artifacts[ref])).definition;
}

// The binding forms vector contract arguments use: hex literals, <variable> and $(<x> OP_HASH160).
function resolve(s: string, vars: Record<string, string>): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const [, lit, name, hashed] of s.matchAll(
        /([0-9a-f]+)|<(\w+)>|\$\(<(\w+)> OP_HASH160\)/g,
    )) {
        if (lit) parts.push(hex.decode(lit));
        else if (name) parts.push(hex.decode(vars[name]));
        else parts.push(hash160(hex.decode(vars[hashed])));
    }
    return concatBytes(...parts);
}

const keysOf = (v: Json): ContractKeys =>
    Object.fromEntries(
        Object.entries(v.bindings.keys).map(([k, h]) => [k, hex.decode(h as string)]),
    );

function build(v: Json, c: Json): Contract {
    const t = templateOf(v);
    const vars = v.bindings.variables;
    const args: Record<string, Uint8Array> = {};
    for (const [field, b] of Object.entries<Json>(c.arguments ?? {})) {
        if (typeof b === "string") args[field] = resolve(b, vars);
        else {
            const out = t.outputs.find((o: Json) => o.name === b.program).locking.contract;
            args[field] = build(v, out).script.pkScript.subarray(2);
        }
    }
    const taptree = c.taptree && hex.decode(vars[c.taptree.slice(1, -1)]);
    return buildContract(definitionOf(v, c) as Definition, args, keysOf(v), taptree);
}

const leafHex = ([cb, script]: TapLeafScript) => [
    cb.version,
    hex.encode(cb.internalKey),
    ...cb.merklePath.map(hex.encode),
    hex.encode(script),
];

describe("artifact/v1 identity", () => {
    it("reads the 80 vectors", () => expect(files).toHaveLength(80));

    it("files every artifact under its id, except the body reject-artifact-identity alters", () => {
        const mismatched: string[] = [];
        let entries = 0;
        for (const v of vectors) {
            for (const [id, doc] of Object.entries(v.artifacts)) {
                entries++;
                if (decodeArtifact(bytes(doc)).id !== id)
                    mismatched.push(`${v.name}/${id.slice(0, 8)}`);
            }
        }
        expect(entries).toBe(40);
        expect(mismatched).toEqual(["reject-artifact-identity/e3c0fa05"]);
    });

    it("gives the bundled artifacts the ids executorTemplate files them under", () => {
        expect(decodeArtifact(bytes(delegatedVtxo)).id).toBe(
            "faa3249b8a28e999963994e4020e832285351eb7ce3b4821bcb3b4498f5b8ef3",
        );
        expect(decodeArtifact(bytes(delegatedBoarding)).id).toBe(
            "e3c0fa053fbb529a252a1025e3453a41f01949f4e49d50de7dfe5d3510470ed3",
        );
    });

    it("flattens each constructor to the argument names its constructions bind", () => {
        const mismatched: string[] = [];
        const unread: string[] = [];
        let constructions = 0;
        for (const v of vectors) {
            const t = templateOf(v);
            if (!t) {
                unread.push(v.name);
                continue;
            }
            for (const c of constructionsOf(t)) {
                constructions++;
                const def = definitionOf(v, c);
                const want = def ? flatten(def, def.constructorInputs).map((f) => f.name) : null;
                if (
                    want?.sort().join() !==
                    Object.keys(c.arguments ?? {})
                        .sort()
                        .join()
                ) {
                    mismatched.push(`${v.name}/${(c.definition.artifact ?? "inline").slice(0, 8)}`);
                }
            }
        }
        expect(unread).toEqual(["reject-trailing-document"]);
        expect(constructions).toBe(87);
        // A DelegatedVtxo body filed under the boarding id, and two artifacts never supplied.
        expect(mismatched).toEqual([
            "reject-artifact-identity/e3c0fa05",
            "reject-missing-artifact/e3c0fa05",
            "reject-missing-artifact/faa3249b",
        ]);
    });
});

describe("contract build parity", () => {
    const builds = vectors.filter((v) => !v.expected.error);

    it("covers the 23 build vectors", () => expect(builds).toHaveLength(23));

    it.each(builds.map((v) => [v.name, v]))("%s: pkScripts, spent leaf and tree", (_, v) => {
        const t = templateOf(v);
        const opts = { allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true };
        const psbt = Transaction.fromPSBT(hex.decode(v.expected.psbt_hex), opts);
        const tx = Transaction.fromRaw(hex.decode(v.expected.unsigned_tx_hex), opts);
        const outputs = Array.from({ length: tx.outputsLength }, (_, i) =>
            hex.encode(tx.getOutput(i).script as Uint8Array),
        );
        t.inputs.forEach((input: Json, i: number) => {
            const c = build(v, input.contract);
            const pk = hex.encode(c.script.pkScript);
            const source = v.request.sources[i];
            const prev = Transaction.fromRaw(hex.decode(source.tx_hex), opts).getOutput(
                source.vout,
            );
            expect(pk).toBe(hex.encode(prev.script as Uint8Array));

            const spent = Array.from({ length: psbt.inputsLength }, (_, j) =>
                psbt.getInput(j),
            ).find((p) => hex.encode(p.witnessUtxo?.script ?? new Uint8Array()) === pk);
            const proof = c.proofs.get(input.spend.function)?.get(input.spend.leaf);
            expect(spent?.tapLeafScript).toHaveLength(1);
            expect(leafHex((spent?.tapLeafScript as TapLeafScript[])[0])).toEqual(
                leafHex(proof as TapLeafScript),
            );
            const taptree = spent?.unknown?.find(
                ([k]) => k.type === 0xde && new TextDecoder().decode(k.key) === "taptree",
            );
            expect(
                TapTreeCoder.decode((taptree as [unknown, Uint8Array])[1]).map((l) =>
                    hex.encode(l.script),
                ),
            ).toEqual(c.script.scripts.map((s) => hex.encode(s)));
        });
        for (const o of t.outputs) {
            if (o.locking?.contract) {
                expect(outputs).toContain(hex.encode(build(v, o.locking.contract).script.pkScript));
            }
        }
    });

    it("matches defaultContract for the bundled DelegatedVtxo and DelegatedBoarding", () => {
        const [server, owner, emulator] = [pub(1), pub(2), pub(3)];
        const keys = {
            cosignerPubkey: hex.encode(server),
            serverPubkey: hex.encode(server),
            emulatorPubkey: hex.encode(emulator),
        };
        const params = {
            exitDelay: (1 << 22) | 2,
            renewalWindow: 1024,
            maxFee: 1000,
            boardingExitDelay: (1 << 22) | 4,
        };
        const vtxo = buildContract(
            decodeArtifact(bytes(delegatedVtxo)).definition,
            {
                owner,
                exitDelay: sn(params.exitDelay),
                renewalWindow: sn(params.renewalWindow),
                maxFee: sn(params.maxFee),
            },
            { server, emulator },
        );
        const board = buildContract(
            decodeArtifact(bytes(delegatedBoarding)).definition,
            {
                owner,
                boardingExitDelay: sn(params.boardingExitDelay),
                renewalProgram: vtxo.script.pkScript.subarray(2),
                maxFee: sn(params.maxFee),
            },
            { server, emulator },
        );
        for (const [ours, kind] of [
            [vtxo, "renewal"],
            [board, "boarding"],
        ] as const) {
            const sdk = defaultContract(kind, keys, owner, params);
            expect(ours.script.scripts.map((s) => hex.encode(s))).toEqual(
                sdk.scripts.map((s) => hex.encode(s)),
            );
            expect(hex.encode(ours.script.pkScript)).toBe(hex.encode(sdk.pkScript));
        }
    });

    it("matches VHTLC.ScriptV2 for vhtlc-claim's bindings", () => {
        const v = vector("vhtlc-claim");
        const vars = v.bindings.variables;
        const num = (k: string) => ScriptNum().decode(hex.decode(vars[k]));
        const delay = (k: string) => sequenceToTimelock(Number(num(k)));
        const program = (k: string) =>
            concatBytes(new Uint8Array([0x51, 0x20]), hex.decode(vars[k]));
        const sdk = new VHTLC.ScriptV2({
            sender: hex.decode(vars.sender).subarray(1),
            receiver: hex.decode(vars.receiver).subarray(1),
            server: hex.decode(v.bindings.keys.server).subarray(1),
            preimageHash: hash160(hex.decode(vars.preimage)),
            refundLocktime: num("refund_locktime"),
            unilateralClaimDelay: delay("unilateral_claim_delay"),
            unilateralRefundDelay: delay("unilateral_refund_delay"),
            unilateralRefundWithoutReceiverDelay: delay("unilateral_refund_without_receiver_delay"),
            nonInteractiveParameters: {
                emulatorPubkey: hex.decode(v.bindings.keys.emulator),
                receiverPkScript: program("receiver_program"),
                senderPkScript: program("sender_program"),
            },
        });
        const ours = build(v, templateOf(v).inputs[0].contract);
        expect(ours.script.scripts).toHaveLength(9);
        expect(ours.script.scripts.map((s) => hex.encode(s))).toEqual(
            sdk.scripts.map((s) => hex.encode(s)),
        );
        expect(hex.encode(ours.script.pkScript)).toBe(hex.encode(sdk.pkScript));
    });

    it("tweaks a constructor key as ArkadeProgramScript does", () => {
        const artifact = {
            contractName: "Tweak",
            constructorInputs: [{ name: "owner", type: "pubkey" }],
            structs: [],
            functions: [
                {
                    name: "exit",
                    leaves: [
                        {
                            name: "exit",
                            asm: ["<owner>", "OP_CHECKSIGVERIFY", "<SERVER_KEY>", "OP_CHECKSIG"],
                            witness: [],
                        },
                    ],
                },
                {
                    name: "pay",
                    arkade: { inputs: [], asm: ["<owner>", "OP_DROP", "OP_1"] },
                    leaves: [
                        {
                            name: "pay",
                            asm: [
                                "<SERVER_KEY>",
                                "OP_CHECKSIGVERIFY",
                                "<TWEAK:owner:pay>",
                                "OP_CHECKSIG",
                            ],
                            witness: [],
                        },
                    ],
                },
            ],
        };
        const [server, owner] = [pub(1), pub(2)];
        const ours = buildContract(
            decodeArtifact(bytes(artifact)).definition,
            { owner },
            { server },
        );
        const sdk = new ArkadeProgramScript(
            programFromArtifact(artifact),
            { owner: owner.subarray(1), server: server.subarray(1) },
            { serverKey: server.subarray(1) },
        );
        expect(hex.encode(ours.script.pkScript)).toBe(hex.encode(sdk.pkScript));
        expect(hex.encode(ours.covenants.get("pay") as Uint8Array)).toBe(
            `20${hex.encode(owner.subarray(1))}7551`,
        );
    });
});

describe("buildContract", () => {
    const def = (functions: Json[], constructorInputs: Json[] = []) =>
        decodeArtifact(bytes({ contractName: "C", constructorInputs, functions })).definition;
    const fn = (name: string, asm: string[], leaf = name) => ({
        name,
        leaves: [{ name: leaf, asm, witness: [] }],
    });
    const keys = { server: pub(1), emulator: pub(3) };

    it("pushes the cosigner as hex text in a covenant and x-only in a leaf", () => {
        const c = buildContract(
            def([
                {
                    name: "f",
                    arkade: { inputs: [], asm: ["<COSIGNER_KEY>", "OP_EQUAL"] },
                    leaves: [{ name: "f", asm: ["<COSIGNER_KEY>", "OP_CHECKSIG"], witness: [] }],
                },
            ]),
            {},
            { ...keys, cosigner: pub(4) },
        );
        const text = new TextEncoder().encode(hex.encode(pub(4)));
        expect(hex.encode(c.covenants.get("f") as Uint8Array)).toBe(`42${hex.encode(text)}87`);
        expect(hex.encode(c.script.scripts[0])).toBe(`20${hex.encode(pub(4).subarray(1))}ac`);
    });

    it("tweaks the emulator key with another function's covenant", () => {
        const c = buildContract(
            def([
                {
                    name: "f",
                    arkade: { inputs: [], asm: ["OP_1"] },
                    leaves: [{ name: "f", asm: ["OP_1"], witness: [] }],
                },
                fn("g", ["<EMULATOR_KEY:f>", "OP_CHECKSIG"]),
            ]),
            {},
            keys,
        );
        const tweaked = computeArkadeScriptPublicKey(keys.emulator, new Uint8Array([0x51]));
        expect(hex.encode(c.script.scripts[1])).toBe(`20${hex.encode(tweaked)}ac`);
    });

    it("refuses duplicate leaves, missing values and keys as a bad leaf", () => {
        const twice = def([fn("a", ["OP_1"]), fn("b", ["OP_1"])]);
        expect(kinds(() => buildContract(twice, {}, keys))).toEqual(["invalid_template"]);
        const n = def([fn("a", ["<n>", "OP_DROP", "OP_1"])], [{ name: "n", type: "int" }]);
        expect(kinds(() => buildContract(n, {}, keys))).toEqual(["invalid_template"]);
        expect(kinds(() => buildContract(n, { n: new Uint8Array([5, 0]) }, keys))).toEqual([
            "invalid_template",
        ]);
        const cosigned = def([fn("a", ["<COSIGNER_KEY>", "OP_CHECKSIG"])]);
        expect(kinds(() => buildContract(cosigned, {}, keys))).toEqual(["invalid_template"]);
    });

    it("keys proofs by function and leaf, not a joined name", () => {
        const c = buildContract(
            def([fn("a/b", ["OP_1"], "c"), fn("a", ["OP_2"], "b/c")]),
            {},
            keys,
        );
        expect(c.proofs.get("a/b")?.get("c")?.[1]).not.toEqual(c.proofs.get("a")?.get("b/c")?.[1]);
    });

    const leaf = (script: string) => ({
        depth: 1,
        version: 0xc0,
        script: hex.decode(script) as Uint8Array<ArrayBuffer>,
    });
    const tree = (...s: string[]) => TapTreeCoder.encode(s.map(leaf));
    const declared = `20${hex.encode(pub(1).subarray(1))}ac`;

    it("takes a given tree's leaves only when it holds every declared leaf", () => {
        const k = def([fn("a", ["<SERVER_KEY>", "OP_CHECKSIG"])]);
        const other = `20${hex.encode(pub(5).subarray(1))}ac`;
        const c = buildContract(k, {}, keys, tree(other, declared));
        expect(c.script.scripts.map((s) => hex.encode(s))).toEqual([other, declared]);
        expect(kinds(() => buildContract(k, {}, keys, tree(other)))).toEqual(["ineligible"]);
        expect(
            kinds(() => buildContract(k, {}, keys, tree(`517e69${declared}`, declared))),
        ).toEqual(["ineligible"]);
        expect(kinds(() => buildContract(k, {}, keys, new Uint8Array()))).toEqual(["ineligible"]);
    });

    it("refuses a given tree that repeats a leaf, as the Executor does since executor#19", () => {
        const k = def([fn("a", ["<SERVER_KEY>", "OP_CHECKSIG"])]);
        const other = `20${hex.encode(pub(5).subarray(1))}ac`;
        for (const t of [tree(declared, declared), tree(declared, other, declared)]) {
            expect(() => buildContract(k, {}, keys, t)).toThrow(
                `bad taptree: leaf ${declared} is repeated`,
            );
            expect(kinds(() => buildContract(k, {}, keys, t))).toEqual(["ineligible"]);
        }
    });

    it("takes a tree's other leaves only when DecodeClosure accepts them, as Go does", () => {
        const k = def([fn("a", ["<SERVER_KEY>", "OP_CHECKSIG"])]);
        const [g, g2] = [pub(1), pub(2)].map((p) => hex.encode(p.subarray(1)));
        const [ff, h] = ["ff".repeat(32), "07".repeat(32)];
        // the Go executor's verdicts at af8d9eb
        const refused = [
            `20${ff}ac`,
            `20${"00".repeat(31)}05ac`,
            `20${g}ad20${ff}ac`,
            `20${g}ac20${ff}ba529c`,
            `02bc02b17520${ff}ac`,
            `0105b17520${g2}ac`,
            `4c01aa7520${h}75516920${g2}ac`,
            `050000008000b27520${g2}ac`,
            "51",
        ];
        const accepted = [
            `20${g2}ac`,
            `20${g}ad20${g2}ac`,
            `20${g}ac20${g2}ba529c`,
            `02bc02b17520${g2}ac`,
            `029000b27520${g2}ac`,
            `a820${h}876920${g2}ac`,
            `a820${h}8769029000b27520${g2}ac`,
        ];
        const verdict = (s: string) => [
            s,
            kinds(() => buildContract(k, {}, keys, tree(declared, s))),
        ];
        expect(refused.map(verdict)).toEqual(refused.map((s) => [s, ["ineligible"]]));
        expect(accepted.map(verdict)).toEqual(accepted.map((s) => [s, []]));
    });
});

// Ported from the executor's pkg/template/artifact/internal/v1/abi_test.go.
describe("artifact/v1 parsing", () => {
    const parse = (doc: unknown) =>
        decodeArtifact(typeof doc === "string" ? new TextEncoder().encode(doc) : bytes(doc));
    const id = (doc: unknown) => parse(doc).id;
    const idDoc = {
        contractName: "C",
        constructorInputs: [
            { name: "k", type: "pubkey" },
            { name: "n", type: "int" },
        ],
        structs: [{ name: "S", fields: [{ name: "x", type: "int" }] }],
        functions: [
            {
                name: "f",
                arkade: { inputs: [{ name: "a", type: "int" }], asm: ["<k>", "OP_CHECKSIG"] },
                leaves: [
                    {
                        name: "l1",
                        witness: [
                            {
                                name: "s",
                                type: "signature",
                                encoding: "schnorr-64",
                                injected: true,
                            },
                        ],
                        asm: [
                            "<SERVER_KEY>",
                            "OP_CHECKSIGVERIFY",
                            "<EMULATOR_KEY:f>",
                            "OP_CHECKSIG",
                        ],
                    },
                    { name: "l2", witness: [], asm: ["OP_1"] },
                ],
            },
            { name: "g", leaves: [{ name: "m", witness: [], asm: ["<n>", "OP_DROP", "OP_1"] }] },
        ],
    };
    const edited = (edit: (m: Json) => void) => {
        const m = structuredClone(idDoc) as Json;
        edit(m);
        return m;
    };
    const leafOf = (m: Json, f: number) => m.functions[f].leaves[0];
    const base = (...asm: string[]) => ({
        contractName: "C",
        constructorInputs: [{ name: "k", type: "pubkey" }],
        functions: [{ name: "f", leaves: [{ name: "l", witness: [], asm }] }],
    });
    const leafless = (functions: Json[], constructorInputs: Json[] = []) => ({
        contractName: "C",
        constructorInputs,
        functions,
    });
    const one = (asm: string[], witness: Json[] = []) => [
        { name: "f", leaves: [{ name: "l", witness, asm }] },
    ];

    it("drops metadata and an empty structs from the id", () => {
        const bare = {
            contractName: "Exit",
            constructorInputs: [
                { name: "user", type: "pubkey" },
                { name: "exit", type: "int" },
            ],
            functions: [
                {
                    name: "unilateral",
                    leaves: [
                        {
                            name: "unilateral",
                            witness: [
                                { name: "userSig", type: "signature", encoding: "schnorr-64" },
                            ],
                            asm: [
                                "<exit>",
                                "OP_CHECKSEQUENCEVERIFY",
                                "OP_DROP",
                                "<user>",
                                "OP_CHECKSIG",
                            ],
                        },
                    ],
                },
            ],
        };
        const meta = `{"formatVersion":1.5,"compiler":{"name":"arkade-compiler","version":0.3},"updatedAt":"2026-07-08T00:00:00Z","structs":[],${JSON.stringify(bare).slice(1)}`;
        expect(parse(bare).definition.structs).toEqual([]);
        expect(id(meta)).toBe(id(bare));
        expect(id(bare)).toMatch(/^[0-9a-f]{64}$/);
    });

    // Ids from the executor's artifact.Parse at af8d9eb; no vector carries structs or covenant inputs.
    it("derives the executor's ids for structs, arrays, covenant inputs and injected items", () => {
        const nested = `{"contractName":"N","constructorInputs":[{"name":"owners","type":"pubkey[2]"},
            {"name":"outer","type":"Outer"}],"structs":[{"name":"Policy","fields":[
            {"name":"owner","type":"pubkey"},{"name":"limit","type":"int"}]},{"name":"Outer","fields":[
            {"name":"inner","type":"Policy"},{"name":"asset","type":"AssetId"}]}],"functions":[{"name":"f",
            "arkade":{"inputs":[{"name":"sigs","type":"signature[2]"},{"name":"amount","type":"int"}],
            "asm":["<outer.inner.owner>","OP_DROP","<outer.asset.txid>","OP_DROP","OP_1"]},"leaves":[
            {"name":"l","witness":[{"name":"w","type":"bytes32","encoding":"raw"},
            {"name":"s","type":"signature","encoding":"schnorr-64","injected":true}],
            "asm":["<SERVER_KEY>","OP_CHECKSIGVERIFY","<TWEAK:owners.1:f>","OP_CHECKSIG"]}]}]}`;
        expect(id(idDoc)).toBe("7a480a9fa3f7e59161d508d0cc0c9cc7ef42683c731f23595b5e4fb3762e131b");
        expect(id(nested)).toBe("2dd4e67f7ecff13105f957e1da49dcb23f8928b2f3f411ad724bcc5f7458119d");
    });

    it("keeps the id across key order, injected false and metadata", () => {
        const reordered = `{"functions":[{"leaves":[{"asm":["<n>","OP_DROP","OP_1"],"witness":[],"name":"m"}],"name":"g"}],"structs":[],"constructorInputs":[{"type":"int","name":"n"}],"contractName":"C"}`;
        const noStructs = leafless(one(["<n>", "OP_DROP", "OP_1"]), [{ name: "n", type: "int" }]);
        noStructs.functions[0].name = "g";
        noStructs.functions[0].leaves[0].name = "m";
        expect(id(reordered)).toBe(id(noStructs));
        const absent = edited((m) => delete leafOf(m, 0).witness[0].injected);
        expect(id(edited((m) => (leafOf(m, 0).witness[0].injected = false)))).toBe(id(absent));
        const meta = edited((m) =>
            Object.assign(m, {
                formatVersion: 1,
                compiler: { name: "x" },
                source: {},
                updatedAt: "now",
                fingerprint: "abc",
            }),
        );
        expect(id(meta)).toBe(id(idDoc));
    });

    it.each<[string, (m: Json) => void]>([
        ["asm token", (m) => (leafOf(m, 1).asm[2] = "OP_2")],
        ["function name", (m) => (m.functions[1].name = "h")],
        ["leaf name", (m) => (leafOf(m, 1).name = "z")],
        ["constructor type", (m) => (m.constructorInputs[1].type = "bytes")],
        ["witness encoding", (m) => (leafOf(m, 0).witness[0].encoding = "raw")],
        ["swap functions", (m) => m.functions.reverse()],
        ["swap leaves", (m) => m.functions[0].leaves.reverse()],
    ])("changes the id with the %s", (_, edit) => {
        expect(id(edited(edit))).not.toBe(id(idDoc));
    });

    it.each<[string, (m: Json) => Json]>([
        ["function", (m) => m.functions[0]],
        ["arkade", (m) => m.functions[0].arkade],
        ["leaf", (m) => leafOf(m, 0)],
        ["witness item", (m) => leafOf(m, 0).witness[0]],
        ["constructor input", (m) => m.constructorInputs[0]],
        ["struct", (m) => m.structs[0]],
        ["struct field", (m) => m.structs[0].fields[0]],
    ])("refuses an unknown field on a %s", (_, at) => {
        expect(kinds(() => parse(edited((m) => (at(m).extra = 1))))).toEqual(["invalid_artifact"]);
    });

    it.each<[string, unknown]>([
        ["unknown field", { ...leafless([]), extra: 1 }],
        ["no function", leafless([])],
        ["unknown opcode", base("OP_NOPE")],
        ["decimal too large", base("9007199254740992")],
        ["decimal too small", base("-9007199254740992")],
        ["unknown placeholder", base("<missing>", "OP_CHECKSIG")],
        ["vtxo import", base("<VTXO:Other(k)>")],
        ["introspection fallback", base("<tx.inputs[?].value>")],
        ["server exit delay", base("<SERVER_EXIT_DELAY>", "OP_DROP", "OP_1")],
        ["child contract", base("<CONTRACT:Single(k)>", "OP_DROP", "OP_1")],
        ["scure-only opcode", base("OP_NOP4")],
        ["doubled prefix", base("OP_OP_1")],
        ["push opcode", base("OP_PUSHDATA1")],
        ["unknown type", leafless(one(["OP_1"]), [{ name: "k", type: "float" }])],
        ["duplicate function", leafless([...one(["OP_1"]), ...one(["OP_1"])])],
        [
            "duplicate leaf",
            leafless([
                {
                    name: "f",
                    leaves: [
                        { name: "l", witness: [], asm: ["OP_1"] },
                        { name: "l", witness: [], asm: ["OP_2"] },
                    ],
                },
            ]),
        ],
        ["emulator key of a plain function", base("<EMULATOR_KEY:f>", "OP_CHECKSIG")],
        [
            "unknown encoding",
            leafless(one(["OP_1"], [{ name: "w", type: "int", encoding: "hex" }])),
        ],
        ["malformed json", "{"],
        ["negative zero", base("-0")],
        ["leading zero", base("007")],
        [
            "duplicate witness name",
            leafless(
                one(
                    ["OP_1"],
                    [
                        { name: "w", type: "int", encoding: "raw" },
                        { name: "w", type: "int", encoding: "raw" },
                    ],
                ),
            ),
        ],
        ["covenant input as a placeholder", edited((m) => (m.functions[0].arkade.asm = ["<a>"]))],
    ])("refuses %s", (_, doc) => {
        expect(kinds(() => parse(doc))).toEqual(["invalid_artifact"]);
    });

    it.each<[string, boolean]>([
        ["<EMULATOR_KEY:>", false],
        ["<EMULATOR_KEY:g>", false],
        ["<TWEAK:k>", false],
        ["<TWEAK:n:f>", false],
        ["<TWEAK:k:f>", true],
        ["<TWEAK:k:g>", false],
        ["<EMULATOR_KEY:f>", true],
        ["OP_TRUE", true],
        ["OP_NOP2", true],
        ["OP_MERKLEBRANCHROOT", true],
    ])("accepts %s: %s", (tok, ok) => {
        const doc = edited((m) => (leafOf(m, 1).asm = [tok, "OP_CHECKSIG"]));
        expect(kinds(() => parse(doc))).toEqual(ok ? [] : ["invalid_artifact"]);
    });

    it("accepts decimals up to 2^53-1, and zero", () => {
        for (const asm of [
            ["9007199254740991", "-9007199254740991", "OP_DROP"],
            ["0", "OP_DROP"],
        ]) {
            expect(kinds(() => parse(edited((m) => (leafOf(m, 1).asm = asm))))).toEqual([]);
        }
    });

    it.each<[string, Json[]]>([
        ["array of struct", [{ name: "a", type: "S[2]" }]],
        ["array over cap", [{ name: "a", type: "pubkey[1025]" }]],
        ["zero-length array", [{ name: "a", type: "pubkey[0]" }]],
        [
            "flat name clash",
            [
                { name: "a", type: "S" },
                { name: "a.x", type: "int" },
            ],
        ],
    ])("refuses the constructor type %s", (_, inputs) => {
        const doc = edited((m) => {
            m.constructorInputs = inputs;
            m.functions[1].leaves[0].asm = ["OP_1"];
            m.functions[0].arkade.asm = ["OP_1"];
        });
        expect(kinds(() => parse(doc))).toEqual(["invalid_artifact"]);
    });

    it("types covenant array inputs of scalars only", () => {
        const withInput = (type: string) =>
            edited((m) => (m.functions[0].arkade.inputs = [{ name: "sigs", type }]));
        for (const type of ["bytes[3]", "signature[3]"]) {
            expect(parse(withInput(type)).definition.functions[0].arkade?.inputs[0].type).toBe(
                type,
            );
        }
        for (const type of ["float[3]", "bytes[0]", "bytes[]", "bytes[3][2]"]) {
            expect(kinds(() => parse(withInput(type)))).toEqual(["invalid_artifact"]);
        }
    });

    it("flattens arrays by index and structs in field order", () => {
        const d: Definition = {
            contractName: "C",
            structs: [
                {
                    name: "Policy",
                    fields: [
                        { name: "owner", type: "pubkey" },
                        { name: "limit", type: "int" },
                    ],
                },
                {
                    name: "Outer",
                    fields: [
                        { name: "inner", type: "Policy" },
                        { name: "asset", type: "AssetId" },
                    ],
                },
            ],
            constructorInputs: [
                { name: "owners", type: "pubkey[2]" },
                { name: "policy", type: "Policy" },
                { name: "outer", type: "Outer" },
                { name: "h", type: "bytes32" },
            ],
            functions: [],
        };
        expect(flatten(d, d.constructorInputs)).toEqual([
            { name: "owners.0", type: "pubkey" },
            { name: "owners.1", type: "pubkey" },
            { name: "policy.owner", type: "pubkey" },
            { name: "policy.limit", type: "int" },
            { name: "outer.inner.owner", type: "pubkey" },
            { name: "outer.inner.limit", type: "int" },
            { name: "outer.asset.txid", type: "bytes32" },
            { name: "outer.asset.gidx", type: "int" },
            { name: "h", type: "bytes32" },
        ]);
    });

    it("caps the flattened constructor at 1024 fields and walk steps", () => {
        const nested = (k: number, fields: Json[]) => {
            const structs = [{ name: "S0", fields }];
            for (let i = 1; i <= k; i++) {
                structs.push({
                    name: `S${i}`,
                    fields: [
                        { name: "a", type: `S${i - 1}` },
                        { name: "b", type: `S${i - 1}` },
                    ],
                });
            }
            return { ...leafless(one(["OP_1"]), [{ name: "x", type: `S${k}` }]), structs };
        };
        const arrays = [
            { name: "a", type: "bytes[1024]" },
            { name: "b", type: "bytes[1024]" },
        ];
        expect(kinds(() => parse(nested(10, arrays)))).toEqual(["invalid_artifact"]);
        expect(kinds(() => parse(nested(40, [])))).toEqual(["invalid_artifact"]);
        expect(kinds(() => parse(nested(0, arrays.slice(0, 1))))).toEqual([]);
    });

    it("caps the flattened constructor names at 1 MiB of UTF-8 (executor#18)", () => {
        const named = (name: string) => () =>
            parse(leafless(one(["OP_1"]), [{ name, type: "int[1024]" }]));
        expect(kinds(named("x".repeat(1024)))).toEqual([]);
        for (const name of ["x".repeat(1025), "é".repeat(513)]) {
            expect(() => named(name)()).toThrow("constructor names flatten to more than 1048576");
        }
    });
});
