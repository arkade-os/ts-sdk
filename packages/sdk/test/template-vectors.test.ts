import { readdirSync, readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";

import { parseTx } from "../src/arkade/vm";
import {
    type Action,
    type Bindings,
    type BuildRequest,
    bind,
    build,
    instantiate,
} from "../src/arkade/template";
import { decodeArtifact } from "../src/arkade/template/abi";
import {
    compileDocument,
    encodeAdvertisement,
    type PacketSpec,
    records,
    type Template,
} from "../src/arkade/template/compile";
import { decodeDocument } from "../src/arkade/template/document";
import { Failure, fail, TemplateError, wrap } from "../src/arkade/template/errors";
import { canonical, checkNumbers, decode, JcsError } from "../src/arkade/template/jcs";
import { Transaction } from "../src/utils/transaction";

interface Vector {
    name: string;
    template?: unknown;
    template_text?: string;
    expected: {
        template_id?: string;
        spend_id?: string;
        canonical_hex?: string;
        error?: { stage: string; code: string };
    };
    raw: Uint8Array;
}

const DIR = new URL("./fixtures/template-v1/", import.meta.url);
const utf8 = new TextEncoder();
const text = new TextDecoder();

// Go keeps `template` as json.RawMessage, so the document is that member's bytes as written.
function rawMember(file: string, key: string): string {
    const marker = `\n  ${JSON.stringify(key)}: `;
    const start = file.indexOf(marker) + marker.length;
    let depth = 0;
    let quoted = false;
    for (let i = start; i < file.length; i++) {
        const c = file[i];
        if (quoted) {
            if (c === "\\") i++;
            else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === "{" || c === "[") depth++;
        else if ((c === "}" || c === "]") && --depth === 0) return file.slice(start, i + 1);
    }
    throw new Error(`no ${key} member`);
}

function load(name: string): Vector {
    const file = readFileSync(new URL(name, DIR), "utf8");
    const v = JSON.parse(file);
    if (v.template_text !== undefined) return { ...v, raw: utf8.encode(v.template_text) };
    const member = rawMember(file, "template");
    if (JSON.stringify(JSON.parse(member)) !== JSON.stringify(v.template)) {
        throw new Error(`${name}: template member misread`);
    }
    return { ...v, raw: utf8.encode(member) };
}

const vectors = readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map(load);
const byName = (name: string) => vectors.find((v) => v.name === name) as Vector;
const builds = vectors.filter((v) => !v.expected.error);
const rejects = (stage: string) => vectors.filter((v) => v.expected.error?.stage === stage);

function thrown(f: () => unknown): TemplateError {
    try {
        f();
    } catch (e) {
        if (e instanceof TemplateError) return e;
        throw e;
    }
    throw new Error("expected a TemplateError");
}

const edited = (name: string, edit: (doc: any) => void) => {
    const doc = JSON.parse(text.decode(byName(name).raw));
    edit(doc);
    return utf8.encode(JSON.stringify(doc));
};

describe("decode", () => {
    it("reads all 80 vectors: 23 builds, 57 rejects", () => {
        expect([vectors.length, builds.length]).toEqual([80, 23]);
    });

    for (const v of rejects("decode")) {
        it(`rejects ${v.name} as decode/${v.expected.error?.code}`, () => {
            const e = thrown(() => decodeDocument(v.raw));
            expect({ stage: e.stage, code: e.code }).toEqual(v.expected.error);
        });
    }

    for (const v of builds) {
        it(`identifies ${v.name}`, () => {
            const d = decodeDocument(v.raw);
            expect({ id: d.id, spendId: d.spendId, canonical: hex.encode(d.canonical) }).toEqual({
                id: v.expected.template_id,
                spendId: v.expected.spend_id,
                canonical: v.expected.canonical_hex,
            });
            const again = decodeDocument(d.canonical);
            expect([again.id, hex.encode(again.canonical)]).toEqual([
                d.id,
                hex.encode(d.canonical),
            ]);
        });
    }

    for (const v of vectors.filter(
        (x) => x.expected.error && x.expected.error.stage !== "decode",
    )) {
        it(`accepts ${v.name}, refused later at ${v.expected.error?.stage}`, () => {
            expect(() => decodeDocument(v.raw)).not.toThrow();
        });
    }

    it("gives an undelegated renewal the delegated renewal's spend id", () => {
        const undelegated = decodeDocument(byName("renew-undelegated").raw);
        expect(undelegated.id).toBe(decodeDocument(byName("renew-fee").raw).spendId);
        expect(undelegated.spendId).toBe(undelegated.id);
    });

    it("dispatches on format before any v1 rule", () => {
        const code = (doc: string) => thrown(() => decodeDocument(utf8.encode(doc))).code;
        expect(code(`{"format":"template/v2","new":1.5}`)).toBe("unsupported_version");
        expect(code(`{"format":"template/v99","inputs":null}`)).toBe("unsupported_version");
        expect(code(`{"format":"template/v1","format":"template/v2"}`)).toBe("invalid_template");
        expect(code(`{"format":"template/v1","locktime":1.0}`)).toBe("invalid_template");
    });

    it("names the JSON Pointer of the field it refuses", () => {
        const doc = edited("onchain", (d) => {
            d.inputs[0].spend.leaf = false;
        });
        const e = thrown(() => decodeDocument(doc));
        expect([e.stage, e.code, e.path]).toEqual([
            "decode",
            "invalid_template",
            "/inputs/0/spend/leaf",
        ]);
    });

    it("drops defaults and keeps shapes no build vector exercises", () => {
        const id = (doc: Uint8Array) => decodeDocument(doc).id;
        const canon = (doc: Uint8Array) => text.decode(decodeDocument(doc).canonical);
        const same = (name: string, edit: (doc: any) => void) =>
            expect(id(edited(name, edit))).toBe(id(byName(name).raw));
        same("onchain", (d) => (d.inputs[0].type = "onchain"));
        same("vhtlc-claim", (d) => (d.outputs[0].type = "offchain"));
        same("supplied-taptree", (d) => delete d.delegation.trigger.htlc.decode);
        same("onchain", (d) => delete d.inputs[0].contract.definition.structs);
        const trigger = canon(
            edited("supplied-taptree", (d) => (d.delegation.trigger.htlc.min_value = 0)),
        );
        expect(trigger).not.toContain("min_value");
        expect(canon(edited("renew-fee", (d) => (d.packets = { unmatched: "reject" })))).toContain(
            `"packets":{}`,
        );
        expect(
            canon(edited("onchain", (d) => (d.outputs[0].value = [d.outputs[0].value]))),
        ).toContain(`"value":[{"from":"funds"}]`);
        const sealed = [{ name: "preimage", scheme: "ecies" }];
        expect(canon(edited("vhtlc-claim", (d) => (d.delegation.sealed = sealed)))).toContain(
            `"sealed":[{"name":"preimage","scheme":"ecies"}]`,
        );
        const uninjected = edited("onchain", (d) => {
            for (const w of d.inputs[0].contract.definition.functions[0].leaves[0].witness) {
                w.injected = false;
            }
        });
        expect(canon(uninjected)).not.toContain("injected");
    });

    it("reports an inline definition's own fault as invalid_artifact", () => {
        const doc = edited("onchain", (d) => {
            d.inputs[0].contract.definition.functions = [];
        });
        expect(thrown(() => decodeDocument(doc)).code).toBe("invalid_artifact");
    });

    it("refuses a null injected flag as invalid_artifact", () => {
        const doc = edited("onchain", (d) => {
            d.inputs[0].contract.definition.functions[0].leaves[0].witness[0].injected = null;
        });
        const e = thrown(() => decodeDocument(doc));
        expect([e.stage, e.code]).toEqual(["decode", "invalid_artifact"]);
    });

    it("codes an error by the fixed precedence walk, not its deepest cause", () => {
        const code = (err: unknown) => wrap("build", err).code;
        expect(code(fail("invalid_template", "x", fail("invalid_artifact", "y")))).toBe(
            "invalid_artifact",
        );
        expect(code(new Failure(["ineligible", "unaffordable"], "fee"))).toBe("unaffordable");
        expect(code(new Error("no sentinel"))).toBe("internal");
        expect(wrap("compile", wrap("build", fail("ineligible", "z"))).stage).toBe("compile");
    });

    describe("jcs", () => {
        it.each([
            [`{"b":1,"a":2}`, `{"a":2,"b":1}`],
            [`{"z":[3,1,2],"a":{"y":true,"x":null}}`, `{"a":{"x":null,"y":true},"z":[3,1,2]}`],
            ['{ "a" :\t1 }', `{"a":1}`],
            [`{"a":"\\u0001\\"\\\\é\\n"}`, `{"a":"\\u0001\\"\\\\é\\n"}`],
            [`{"😀":1,"￿":2}`, `{"😀":1,"￿":2}`],
            [`{"a":9007199254740991}`, `{"a":9007199254740991}`],
            [`{"a":-5}`, `{"a":-5}`],
            [`{"a":"\\ud83d\\uDE00"}`, `{"a":"😀"}`],
            [`{"a":"\\\\ud800"}`, `{"a":"\\\\ud800"}`],
            [`{"a":"�"}`, `{"a":"�"}`],
            ["[".repeat(64) + "]".repeat(64), "[".repeat(64) + "]".repeat(64)],
        ])("canonicalizes %s", (input, want) => {
            expect(text.decode(canonical(decode(utf8.encode(input))))).toBe(want);
        });

        it.each([
            `{"a":1,"a":2}`,
            `{"a":{"b":1,"b":1}}`,
            `{"a":1} {}`,
            `{"a":1.5}`,
            `{"a":1e3}`,
            `{"a":9007199254740992}`,
            `{"a":-0}`,
            `{"a":"\\ud800"}`,
            `{"a":"\\uDC00"}`,
            `{"\\ud800":1}`,
            `{"a":"\\ud800\\u0041"}`,
            "[".repeat(65) + "]".repeat(65),
            "﻿{}",
        ])("refuses %s", (input) => {
            expect(() => checkNumbers(decode(utf8.encode(input)))).toThrow(JcsError);
        });

        it("refuses invalid utf-8", () => {
            expect(() =>
                decode(new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])),
            ).toThrow(JcsError);
        });
    });
});

// Later stages add their assertions here as compile, bind and build land.
describe("compile", () => {
    type Raw = Record<string, unknown>;
    const artifactsOf = (name: string): Raw =>
        (byName(name) as Vector & { artifacts?: Raw }).artifacts ?? {};
    // Filed under the id the vector claims, so compile's own check judges reject-artifact-identity.
    const compiled = (raw: Uint8Array, artifacts: Raw) => {
        const d = decodeDocument(raw);
        const given = d.artifactIds.filter((id) => id in artifacts);
        const parse = (id: string) => decodeArtifact(utf8.encode(JSON.stringify(artifacts[id])));
        return compileDocument(d, new Map(given.map((id) => [id, parse(id)])));
    };
    const compiledEdit = (name: string, edit: (doc: any) => void) =>
        compiled(edited(name, edit), artifactsOf(name));
    const refused = (name: string, edit: (doc: any) => void, want: string) => {
        const e = thrown(() => compiledEdit(name, edit));
        const [code, ...message] = want.split(": ");
        expect([e.stage, e.code, e.path, e.message]).toEqual([
            "compile",
            code,
            "",
            `compile: ${message.join(": ")}`,
        ]);
    };

    for (const v of rejects("compile")) {
        it(`rejects ${v.name} as compile/${v.expected.error?.code}`, () => {
            const e = thrown(() => compiled(v.raw, artifactsOf(v.name)));
            expect({ stage: e.stage, code: e.code, path: e.path }).toEqual({
                ...v.expected.error,
                path: "",
            });
        });
    }

    const later = vectors.filter((v) => ["bind", "build"].includes(v.expected.error?.stage ?? ""));
    for (const v of [...builds, ...later]) {
        it(`compiles ${v.name}`, () => {
            const t = compiled(v.raw, artifactsOf(v.name));
            const d = decodeDocument(v.raw);
            expect([t.id, t.spendId]).toEqual([d.id, d.spendId]);
        });
    }

    // Each rule no vector reaches, with the Go executor's outcome at af8d9eb.
    const P2TR = `5120${"f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"}`;
    const in0 = (d: any) => d.inputs[0];
    const args = (d: any) => d.inputs[0].contract.arguments;
    const fn = (d: any, name: string) =>
        d.inputs[0].contract.definition.functions.find((f: any) => f.name === name);
    const trigger = (d: any) => d.delegation.trigger.htlc;
    const rule = (type: number, action: string, from: string, data?: string) => ({
        type,
        action,
        from,
        ...(data === undefined ? {} : { data }),
    });
    const adverts = (n: number) => (d: any) => {
        for (let k = 0; k < n; k++) {
            const name = `o${k}`;
            d.outputs.push({
                name,
                index: k + 1,
                value: { from: "funds", amount: 1 },
                locking: P2TR,
            });
        }
        d.packets = {
            output_index: n + 1,
            advertise: d.outputs
                .slice(1)
                .map((o: any) => ({ template: "ab".repeat(32), outputs: [o.name] })),
        };
    };
    it.each<[string, (d: any) => void, string]>([
        [
            "vhtlc-claim",
            (d) => (d.delegation.sealed = [{ name: "preimage", scheme: "ecies" }]),
            "unsupported: sealed scheme ecies is not supported",
        ],
        [
            "vhtlc-claim",
            (d) => {
                d.delegation.sealed = [{ name: "preimage", scheme: "x" }];
                in0(d).spend.function = "missing";
            },
            "unsupported: sealed scheme x is not supported",
        ],
        [
            "supplied-taptree",
            (d) => (trigger(d).all_outputs = true),
            "invalid_template: no entry has an index when a rule sets all_outputs",
        ],
        [
            "counter",
            (d) => ((d.inputs[0].index = 0), (d.inputs[1].index = 2)),
            "invalid_template: input indexes must fill 0..1 once",
        ],
        [
            "counter",
            (d) => {
                d.inputs[1].name = "counter";
                delete d.delegation;
            },
            'invalid_template: duplicate input "counter"',
        ],
        [
            "vhtlc-claim",
            (d) => (in0(d).type = "onchain"),
            "invalid_template: onchain slot in a template of type virtual",
        ],
        [
            "supplied-taptree",
            (d) => (d.variables.taptree = "bytes32"),
            'invalid_template: taptree must name a bytes variable, got "<taptree>"',
        ],
        [
            "vhtlc-claim",
            (d) => delete args(d).sender,
            'invalid_template: missing argument "sender"',
        ],
        [
            "vhtlc-claim",
            (d) => (args(d).extra = "00"),
            'invalid_template: contract "VHTLC" has arguments outside its constructor',
        ],
        [
            "boarding",
            (d) => (args(d).owner = { program: "funds" }),
            'invalid_template: output program "funds" cannot fill a pubkey field',
        ],
        [
            "vhtlc-claim",
            (d) => (in0(d).spend.leaf = "nope"),
            'invalid_template: unknown leaf "nope"',
        ],
        [
            "proof-plain-leaf",
            (d) => {
                const leaf = fn(d, "spend").leaves[0];
                leaf.asm.unshift("100", "OP_CHECKLOCKTIMEVERIFY", "OP_DROP");
                delete leaf.witness[1].injected;
            },
            'unsupported: leaf "spend" needs an absolute locktime, which a proof does not set',
        ],
        [
            "witness-order",
            (d) => {
                const bytes = (name: string) => ({ name, type: "bytes[1024]" });
                fn(d, "claim").arkade.inputs = [bytes("a"), bytes("b")];
            },
            "invalid_artifact: constructor flattens to more than 1024 fields",
        ],
        [
            "vhtlc-claim",
            (d) => (in0(d).spend.arguments = ["00"]),
            'invalid_template: function "nonInteractiveClaim" takes 0 arguments, got 1',
        ],
        [
            "vhtlc-claim",
            (d) => delete in0(d).spend.witness.preimage,
            'invalid_template: witness item "preimage" is not bound',
        ],
        [
            "witness-order",
            (d) => (in0(d).spend.witness.serverSig = "00"),
            'invalid_template: spend binds witness items that are signatures or absent from leaf "claim"',
        ],
        [
            "vhtlc-claim",
            (d) => (in0(d).spend.witness.preimage = { program: "payout" }),
            'invalid_template: output program "payout" can only fill a contract argument',
        ],
        [
            "vhtlc-claim",
            (d) => (in0(d).spend.witness.preimage = 5),
            "invalid_template: an integer cannot fill a bytes32 field",
        ],
        [
            "witness-order",
            (d) => (in0(d).spend.witness.a = true),
            "invalid_template: a boolean cannot fill a int field",
        ],
        [
            "vhtlc-claim",
            (d) => (args(d).sender = `02${"ff".repeat(32)}`),
            "invalid_template: bad value: pubkey must be a valid 33-byte key",
        ],
        [
            "vhtlc-claim",
            (d) => (args(d).receiverProgram = "<sender>"),
            'invalid_template: pubkey "sender" cannot fill a bytes32 field',
        ],
        [
            "vhtlc-claim",
            (d) => (args(d).receiverProgram = "$(<preimage> OP_SHA256 OP_DROP <preimage>)"),
            'invalid_template: sealed "preimage" must be hashed in a contract argument',
        ],
        [
            "proof-plain-leaf",
            (d) => (d.outputs[1].value.amount = 0),
            "invalid_template: an amount must be positive",
        ],
        [
            "virtual-plain-leaf",
            (d) => (d.issues = [{ name: "coin" }, { name: "coin" }]),
            'invalid_template: duplicate issue "coin"',
        ],
        [
            "virtual-plain-leaf",
            (d) => (d.issues = [{ name: "coin", control: { issue: "coin" } }]),
            'invalid_template: issue "coin": control "coin" names no other new asset',
        ],
        [
            "virtual-plain-leaf",
            (d) => d.outputs[0].assets.push({ issue: "nope", amount: 1 }),
            'invalid_template: asset route names no issue "nope"',
        ],
        [
            "virtual-plain-leaf",
            (d) => (d.issues = [{ name: "coin" }]),
            'invalid_template: issue "coin" is routed to no output',
        ],
        [
            "boarding",
            (d) => (d.outputs[0].assets = [{ from: "deposit" }]),
            'invalid_template: onchain input "deposit" carries no assets',
        ],
        [
            "proof-plain-leaf",
            (d) => (d.outputs[1].name = "change"),
            'invalid_template: duplicate output "change"',
        ],
        [
            "proof-plain-leaf",
            (d) => (d.outputs[1].index = 65536),
            'invalid_template: output "payment" index out of range',
        ],
        [
            "proof-plain-leaf",
            (d) => (d.outputs[1].value = { from: "nope", amount: 5 }),
            'invalid_template: value names no input: "nope"',
        ],
        [
            "proof-plain-leaf",
            (d) => (d.outputs[1].value = [{ from: "funds", amount: 5 }, { from: "funds" }]),
            'invalid_template: output "payment" draws from input "funds" twice',
        ],
        [
            "proof-plain-leaf",
            (d) => (d.outputs[1].assets = [{ from: "funds", asset: "ab".repeat(34), amount: 1 }]),
            'invalid_template: output "payment" cannot carry assets',
        ],
        [
            "virtual-plain-leaf",
            (d) => d.outputs[0].assets.push({ from: "funds" }),
            'invalid_template: output "change" routes an asset of an input twice',
        ],
        [
            "counter",
            (d) => (d.outputs[1].each = "counter"),
            'invalid_template: output "next_reserve" repeats per coin of "counter" and takes from it alone',
        ],
        [
            "supplied-taptree",
            (d) => (d.outputs[0].locking = { contract: in0(d).contract }),
            "invalid_template: a contract checked against a given taptree cannot lock an output",
        ],
        [
            "boarding",
            (d) =>
                (d.outputs[0].locking.contract = {
                    definition: {
                        contractName: "P",
                        constructorInputs: [{ name: "p", type: "bytes32" }],
                        functions: [
                            {
                                name: "f",
                                leaves: [{ name: "f", asm: ["<p>", "OP_DROP"], witness: [] }],
                            },
                        ],
                    },
                    arguments: { p: { program: "funds" } },
                }),
            'invalid_template: output "funds" binds an output program',
        ],
        [
            "boarding",
            (d) => (args(d).renewalProgram = { program: "nope" }),
            'invalid_template: program "nope" names no output built from a contract',
        ],
        [
            "proof-plain-leaf",
            (d) => (d.outputs[0].value.amount = 5),
            'invalid_template: input "funds" needs exactly one remainder draw, has 0',
        ],
        [
            "virtual-plain-leaf",
            (d) => (d.outputs[1].assets = [{ from: "funds" }]),
            'invalid_template: input "funds" has two remainder routes for one asset',
        ],
        [
            "renew-fee",
            (d) => {
                d.variables.lead = "bytes";
                d.delegation.schedule.funds = { before_expiry_seconds: "<lead>" };
            },
            'invalid_template: "<lead>" is not an int variable',
        ],
        [
            "default-renew",
            (d) => (d.packets = { output_index: 1 }),
            "invalid_template: output_index goes with indexed outputs only",
        ],
        [
            "vhtlc-claim",
            (d) => delete d.packets.output_index,
            "invalid_template: indexed outputs place the extension with packets.output_index",
        ],
        [
            "vhtlc-claim",
            (d) => (d.packets.output_index = 65536),
            "invalid_template: output_index out of range",
        ],
        [
            "counter",
            (d) => d.packets.rules.push(rule(2, "emit", "reserve", "01")),
            "invalid_template: two emit rules for packet type 2",
        ],
        [
            "counter",
            (d) => (d.packets.rules = [rule(3, "copy", "counter"), rule(3, "copy", "reserve")]),
            "invalid_template: copy conflicts with another rule for packet type 3",
        ],
        [
            "counter",
            (d) => (d.packets.advertise = [{ template: "self", outputs: ["next_counter"] }]),
            "invalid_template: advertising self takes one output per input",
        ],
        [
            "counter",
            (d) => (d.packets.advertise[0].outputs = ["next_counter", "next_counter"]),
            'invalid_template: output "next_counter" is advertised twice',
        ],
        [
            "mixed-fees",
            (d) => (d.packets.advertise = [{ template: "ab".repeat(32), outputs: ["payment"] }]),
            "invalid_template: an intent advertises only offchain outputs",
        ],
        [
            "boarding",
            (d) => (d.packets.advertise = [{ template: "self", outputs: ["funds"] }]),
            'invalid_template: output "funds" does not match the type of input slot "deposit"',
        ],
        [
            "renew-fee",
            (d) => (d.packets.advertise = [{ template: "self", outputs: ["renewed"] }]),
            "invalid_template: a template with variables cannot advertise itself",
        ],
        [
            "onchain",
            adverts(15),
            "invalid_template: packets: advertisement too long: 541 bytes, max 520",
        ],
        [
            "boarding",
            (d) => {
                d.outputs[0].locking.contract.arguments.exitDelay = "$(OP_PUSHCURRENTINPUTINDEX)";
                d.delegation = {
                    trigger: {
                        deposit: {
                            packet: 4,
                            require: { "tlv:1": "0x01" },
                            capture: { owner: "tlv:2" },
                            expires_after_seconds: 5,
                        },
                    },
                };
            },
            "invalid_template: a trigger template is watched: its contract arguments must be context-free",
        ],
        [
            "supplied-taptree",
            (d) => {
                d.type = "proof";
                in0(d).type = "onchain";
                delete d.outputs[0].assets;
            },
            'invalid_template: trigger of "htlc": a triggered input is offchain',
        ],
        [
            "supplied-taptree",
            (d) => (trigger(d).require = { raw: "0x00" }),
            'invalid_template: trigger of "htlc": source "raw" does not fit the rule',
        ],
        [
            "supplied-taptree",
            (d) => (trigger(d).require = { "tlv:3": "<COSIGNER_KEY>" }),
            'invalid_template: trigger of "htlc": require "tlv:3" names undeclared variable "COSIGNER_KEY"',
        ],
        [
            "supplied-taptree",
            (d) => (trigger(d).require = { "tlv:3": "abcd" }),
            'invalid_template: trigger of "htlc": require "tlv:3": "abcd" is not a literal, a key, a variable, a source or an expression',
        ],
        [
            "supplied-taptree",
            (d) => (trigger(d).require["tlv:4"] = "$(<tlv:4> <nope> OP_EQUAL)"),
            'invalid_template: trigger of "htlc": require "tlv:4": undeclared name "nope"',
        ],
        [
            "supplied-taptree",
            (d) => (trigger(d).require["tlv:4"] = "$(OP_TXID)"),
            'invalid_template: trigger of "htlc": require "tlv:4": expression: bad expression: forbidden opcode OP_TXID',
        ],
        [
            "supplied-taptree",
            (d) => (trigger(d).capture.nope = "tlv:9"),
            'invalid_template: trigger of "htlc": captures undeclared variable "nope"',
        ],
        [
            "supplied-taptree",
            (d) => (trigger(d).capture.receiver_program = "output:taptree"),
            'invalid_template: trigger of "htlc": captures a taptree into bytes32 variable "receiver_program"',
        ],
        [
            "supplied-taptree",
            (d) => (d.outputs[0].locking = "5120<taptree>"),
            'invalid_template: taptree variable "taptree" is used outside the taptree field',
        ],
        [
            "default-renew",
            (d) =>
                d.outputs.unshift({
                    name: "pay",
                    type: "onchain",
                    value: { from: "funds", amount: 1000 },
                    locking: P2TR,
                }),
            "invalid_template: a proof template lists its offchain outputs before its onchain ones",
        ],
        [
            "vhtlc-claim",
            (d) => (d.outputs[0].index = 2),
            "invalid_template: output indexes must fill 0..1 once",
        ],
        [
            "mixed-fees",
            (d) => ((d.outputs[0].index = 2), (d.outputs[1].index = 0)),
            "invalid_template: an intent places offchain outputs, the extension, then onchain outputs",
        ],
        [
            "mixed-fees",
            (d) => ((d.outputs[1].index = 1), (d.packets.output_index = 2)),
            "invalid_template: an intent places its extension after the offchain outputs",
        ],
        ["renew-fee", (d) => (d.locktime = 5), "unsupported: locktime in a proof template"],
        [
            "vhtlc-claim",
            (d) => (in0(d).sequence = 5),
            "unsupported: sequence in a virtual template",
        ],
        [
            "vhtlc-claim",
            (d) => ((d.locktime = 5), (d.outputs[0].index = 2)),
            "invalid_template: output indexes must fill 0..1 once",
        ],
    ])("refuses an edit of %s: %#", (name, edit, want) => refused(name, edit, want));

    it.each([
        ["5120<Bad>", "bad placeholder at 4"],
        ["5120$(OP_1", "unclosed expression at 4"],
        ["5120$(OP_1  OP_2)", "bad expression at 4"],
        ["$(<x OP_1)", 'bad placeholder "<x"'],
        ["512", "odd number of hex digits at 0"],
        ["5120\u00e9", "unexpected '\u00c3' at 4"],
        ["5120\t", "unexpected '\\t' at 4"],
        ["$(\u00e9 OP_1) <bad", "unexpected ' ' at 10"],
        ["5120<nope>", 'undeclared name "nope"'],
        ["$(<!n>)", 'spliced variable "n" is not bytes'],
        ["5120$(OP_TXID)", "expression: bad expression: forbidden opcode OP_TXID"],
        [
            "$(OP_ECPAIRING OP_ECPAIRING OP_ECPAIRING)",
            "expression: bad expression: OP_ECPAIRING exceeds its limit of 2",
        ],
    ])("refuses the locking %j as Go does", (locking, message) => {
        const edit = (d: any) => {
            d.variables = { x: "bytes", n: "int" };
            d.outputs[0].locking = locking;
        };
        refused("witness-order", edit, `invalid_template: ${message}`);
    });

    it("lays inputs out in transaction order, artifacts as first resolved", () => {
        const renew = JSON.parse(text.decode(byName("renew-fee").raw));
        const doc = edited("boarding", (d) => {
            Object.assign(d.variables, renew.variables);
            d.inputs[0].index = 1;
            d.inputs.push({ ...renew.inputs[0], index: 0 });
            d.outputs.push({ name: "more", index: 1, value: { from: "funds" }, locking: P2TR });
            d.packets.output_index = 2;
        });
        const t = compiled(doc, { ...artifactsOf("boarding"), ...artifactsOf("renew-fee") });
        expect(t.inputs.map((i) => i.name)).toEqual(["funds", "deposit"]);
        expect(t.outputs.map((o) => o.from)).toEqual([1, 0]);
        expect(t.artifacts).toEqual([...decodeDocument(doc).artifactIds].reverse());
    });

    it("keeps Go's model where it is not the obvious one", () => {
        const onchain = compiledEdit("onchain", (d) => (d.packets = { unmatched: "drop" }));
        expect(onchain.packets).toBeUndefined();
        expect(compiled(byName("default-renew").raw, artifactsOf("default-renew")).packets).toEqual(
            { index: -1, drop: false, rules: [], adverts: [] },
        );
        const empty = compiledEdit("boarding", (d) => (args(d).renewalProgram = { program: "" }));
        expect(empty.inputs[0].contract.args.get("renewalProgram")).toEqual([
            { hex: new Uint8Array() },
        ]);
        const metadata = { b: "01", a: "02", "\u{1f600}": "03", "\uffff": "04" };
        const issued = compiledEdit("virtual-plain-leaf", (d) => {
            d.issues = [{ name: "coin", metadata }];
            d.outputs[0].assets.push({ issue: "coin", amount: 1 });
        });
        expect(issued.issues[0].metadata.map((m) => m.key)).toEqual([
            "a",
            "b",
            "\uffff",
            "\u{1f600}",
        ]);
        const unselected = compiledEdit("proof-plain-leaf", (d) =>
            fn(d, "pay").leaves[0].asm.unshift("100", "OP_CHECKLOCKTIMEVERIFY", "OP_DROP"),
        );
        expect(unselected.inputs[0].leaf).toBe("spend");
        expect(() => compiledEdit("onchain", adverts(14))).not.toThrow();
    });

    it("encodes counter's self-advertisement as its expected transaction carries it", () => {
        const v = byName("counter");
        const t = compiled(v.raw, artifactsOf("counter"));
        const ad = encodeAdvertisement(records(t, t.packets as PacketSpec, hex.decode(t.id)));
        const tx = (v.expected as { unsigned_tx_hex: string }).unsigned_tx_hex;
        expect(tx).toContain(`012400${t.id}00000100`);
        expect(hex.encode(ad)).toBe(`012400${t.id}00000100`);
    });

    it("sorts triggers by input, requirements by source and captures by variable", () => {
        const t = compiledEdit("counter", (d) => {
            const watch = (require: object, capture: object, ttl: number) => ({
                packet: 7,
                group: "tlv:1",
                require,
                capture,
                expires_after_seconds: ttl,
            });
            d.variables = { a: "bytes", b: "bytes" };
            d.delegation = {
                trigger: {
                    counter: watch({ "tlv:0": "0x01" }, { a: "tlv:3" }, 60),
                    reserve: watch({ "tlv:2": "<a>", "tlv:0": "0x02" }, { b: "tlv:4" }, 120),
                },
            };
            delete d.packets.advertise;
            d.inputs[0].index = 1;
            d.inputs[1].index = 0;
        });
        expect(
            t.triggers.map((tr) => [tr.input, tr.ttlSeconds, tr.require.map((r) => r.source)]),
        ).toEqual([
            [0, 120, ["tlv:0", "tlv:2"]],
            [1, 60, ["tlv:0"]],
        ]);
        expect(t.triggers[0].require[1]).toEqual({ source: "tlv:2", variable: "a" });
    });

    it("judges every sequence of up to three packet rules as Go's pairwise loop does", () => {
        type R = [number, string, string];
        // packets.go:72-90
        const go = (rules: R[]): string => {
            for (let k = 0; k < rules.length; k++) {
                const x = rules[k];
                for (const o of rules.slice(0, k).filter((r) => r[0] === x[0])) {
                    if (o[1] === "emit" && x[1] === "emit")
                        return `two emit rules for packet type ${x[0]}`;
                    const [cp, other] = x[1] === "copy" ? [x, o] : [o, x];
                    const clash =
                        other[1] === "emit" ||
                        (other[1] === "copy" && other[2] !== cp[2]) ||
                        (other[1] === "drop" && other[2] === cp[2]);
                    if (cp[1] === "copy" && clash) {
                        return `copy conflicts with another rule for packet type ${x[0]}`;
                    }
                }
            }
            return "ok";
        };
        const one = ["copy", "drop", "emit"].flatMap((a) =>
            ["counter", "reserve"].map((f): R => [3, a, f]),
        );
        const all: R[][] = [];
        for (let seqs: R[][] = [[]], n = 0; n < 3; n++) {
            seqs = seqs.flatMap((s) => one.map((r) => [...s, r]));
            all.push(...seqs);
        }
        all.push(
            [
                [3, "emit", "counter"],
                [4, "emit", "counter"],
            ],
            [
                [3, "copy", "counter"],
                [4, "copy", "reserve"],
            ],
        );
        for (const seq of all) {
            let got = "ok";
            try {
                compiledEdit("counter", (d) => {
                    d.packets.rules = seq.map(([t, a, f]) =>
                        rule(t, a, f, a === "emit" ? "01" : undefined),
                    );
                });
            } catch (e) {
                got = (e as Error).message.replace(/^compile: /, "");
            }
            expect([seq, got]).toEqual([seq, go(seq)]);
        }
    });

    // A duplicate check that scans every earlier entry, as Go's do, takes seconds to minutes here.
    describe("finishes a document of up to 1 MiB quickly", () => {
        const LIMIT = 1 << 20;
        const nm = (i: number) =>
            String.fromCharCode(97 + Math.floor(i / 46656)) +
            (i % 46656).toString(36).padStart(3, "0");
        const names = (n: number) => Array.from({ length: n }, (_, i) => nm(i));
        // the most fixed-width distinct names that keep the edited vector under the cap
        const sized = (name: string, edit: (d: any, names: string[]) => void) => {
            const doc = (n: number) => edited(name, (d) => edit(d, names(n)));
            const at1000 = doc(1000).length;
            const per = (doc(2000).length - at1000) / 1000;
            const n = 1000 + Math.floor((LIMIT - at1000) / per);
            const raw = doc(n);
            expect([raw.length <= LIMIT, raw.length > LIMIT - per]).toEqual([true, true]);
            return { raw, n };
        };
        // ms: over 10x each case's time here, under the scans' 157 s, 102 s, 12 s, 7.4 s and 5.3 s
        const timed = (bound: number, f: () => unknown) => {
            const start = performance.now();
            let outcome: unknown;
            try {
                outcome = f();
            } catch (e) {
                outcome = e instanceof TemplateError ? `${e.stage}/${e.code}: ${e.message}` : e;
            }
            expect(performance.now() - start).toBeLessThan(bound);
            return outcome;
        };
        const def = (d: any) => d.inputs[0].contract.definition;

        it("of sealed names", () => {
            const { raw, n } = sized("vhtlc-claim", (d, names) => (d.delegation.sealed = names));
            const d = timed(10_000, () => decodeDocument(raw)) as ReturnType<typeof decodeDocument>;
            expect(d.template.delegation?.sealed).toHaveLength(n);
        }, 60_000);

        it("of placeholders", () => {
            const { raw } = sized("onchain", (d, names) => {
                d.outputs[0].locking = names.map((x) => `<${x}>`).join("");
            });
            const d = decodeDocument(raw);
            expect(timed(10_000, () => compileDocument(d))).toBe(
                'compile/invalid_template: compile: undeclared name "a000"',
            );
        }, 60_000);

        it("of packet rules", () => {
            const { raw, n } = sized("counter", (d, names) => {
                d.packets.rules = names.map(() => rule(3, "drop", "counter"));
            });
            const t = timed(6_000, () => compiled(raw, artifactsOf("counter"))) as Template;
            expect(t.packets?.rules).toHaveLength(n);
        }, 60_000);

        it("of constructor fields", () => {
            const { raw } = sized("onchain", (d, names) => {
                def(d).constructorInputs = names.map((name) => ({ name, type: "int" }));
            });
            expect(timed(3_000, () => decodeDocument(raw))).toBe(
                "decode/invalid_artifact: decode: constructor flattens to more than 1024 fields",
            );
        }, 60_000);

        it("of leaves", () => {
            const { raw, n } = sized("onchain", (d, names) => {
                def(d).functions[0].leaves = names.map((name) => ({
                    name,
                    asm: ["OP_1"],
                    witness: [],
                }));
            });
            const d = timed(3_000, () => decodeDocument(raw)) as ReturnType<typeof decodeDocument>;
            expect(def(d.template).def.functions[0].leaves).toHaveLength(n);
        }, 60_000);
    });
});

describe("bind", () => {
    const fixture = (v: Vector) => v as Vector & Record<string, any>;
    for (const v of rejects("bind")) {
        it(`rejects ${v.name} as bind/${v.expected.error?.code}`, () => {
            const { artifacts = {}, bindings } = fixture(v);
            const d = decodeDocument(v.raw);
            const parse = (id: string) =>
                decodeArtifact(utf8.encode(JSON.stringify(artifacts[id])));
            const given = d.artifactIds.filter((id) => id in artifacts);
            const t = compileDocument(d, new Map(given.map((id) => [id, parse(id)])));
            const keys = Object.fromEntries(
                Object.entries(bindings.keys as Record<string, string>)
                    .filter(([, h]) => h)
                    .map(([k, h]) => [k, hex.decode(h)]),
            );
            const variables = Object.fromEntries(
                Object.entries((bindings.variables ?? {}) as Record<string, string>).map(
                    ([n, h]) => [n, hex.decode(h)],
                ),
            );
            const e = thrown(() => bind(t, { keys, variables }));
            expect({ stage: e.stage, code: e.code }).toEqual(v.expected.error);
        });
    }
});

// Mirrors the Go harness (template_test.go): decode, compile, bind, then build from the request.
describe("build", () => {
    const fixture = (v: Vector) => v as unknown as Record<string, any>;
    // Go's zero time stands for "unset"
    const seconds = (s: string) =>
        s.startsWith("0001-01-01T00:00:00") ? undefined : Date.parse(s) / 1000;

    function compiledOf(v: Vector) {
        const { artifacts = {} } = fixture(v);
        const d = decodeDocument(v.raw);
        const parse = (id: string) => decodeArtifact(utf8.encode(JSON.stringify(artifacts[id])));
        const given = d.artifactIds.filter((id) => id in artifacts);
        return compileDocument(d, new Map(given.map((id) => [id, parse(id)])));
    }

    function bindingsOf(v: Vector): Bindings {
        const { keys, variables = {} } = fixture(v).bindings;
        const key = (h: string) => (h ? hex.decode(h) : undefined);
        return {
            keys: {
                server: key(keys.server),
                emulator: key(keys.emulator),
                cosigner: key(keys.cosigner),
            },
            variables: Object.fromEntries(
                Object.entries(variables as Record<string, string>).map(([n, h]) => [
                    n,
                    hex.decode(h),
                ]),
            ),
        };
    }

    function requestOf(v: Vector): BuildRequest {
        const { sources, fee, decryption } = fixture(v).request;
        const rate = fee.onchain_sat_per_vbyte;
        const responses = (decryption ?? {}) as Record<string, string>;
        return {
            sources: sources.map((s: any) => ({
                txid: s.txid,
                vout: s.vout,
                tx: hex.decode(s.tx_hex),
                amount: BigInt(s.amount),
                assets: (s.assets ?? []).map((a: any) => ({
                    id: hex.decode(a.id),
                    amount: BigInt(a.amount),
                })),
                expiry: seconds(s.expiry),
                createdAt: seconds(s.created_at),
                swept: s.swept,
            })),
            fee: {
                dust: BigInt(fee.dust),
                intent: {
                    offchainInput: fee.intent.offchain_input,
                    onchainInput: fee.intent.onchain_input,
                    offchainOutput: fee.intent.offchain_output,
                    onchainOutput: fee.intent.onchain_output,
                },
                onchain: rate === undefined ? undefined : (n) => BigInt(n) * BigInt(rate),
            },
            // null is "already plaintext"; {} answers every ciphertext with an error
            decrypt:
                decryption === null
                    ? undefined
                    : (ct) => {
                          const p = responses[hex.encode(ct)];
                          if (p === undefined)
                              throw new Error("fixture has no decryption response");
                          return hex.decode(p);
                      },
        };
    }

    // template_test.go psbtMaps: every key/value per section, order ignored, no duplicate.
    function psbtMaps(raw: Uint8Array): Record<string, string>[] {
        expect(hex.encode(raw.subarray(0, 5))).toBe("70736274ff");
        let at = 5;
        const size = () => {
            const b = raw[at++];
            if (b < 0xfd) return b;
            const n = b === 0xfd ? 2 : b === 0xfe ? 4 : 8;
            let v = 0;
            for (let k = n - 1; k >= 0; k--) v = v * 256 + raw[at + k];
            at += n;
            return v;
        };
        const bytes = () => {
            const n = size();
            at += n;
            return hex.encode(raw.subarray(at - n, at));
        };
        const section = () => {
            const m: Record<string, string> = {};
            for (let key = bytes(); key !== ""; key = bytes()) {
                if (key in m) throw new Error(`duplicate PSBT key ${key}`);
                m[key] = bytes();
            }
            return m;
        };
        const global = section();
        const tx = parseTx(hex.decode(global["00"]));
        const maps = [global, ...tx.inputs.map(section), ...tx.outputs.map(section)];
        expect(at).toBe(raw.length);
        return maps;
    }

    for (const v of rejects("build")) {
        it(`rejects ${v.name} as build/${v.expected.error?.code}`, () => {
            const e = thrown(() => build(bind(compiledOf(v), bindingsOf(v)), requestOf(v)));
            expect({ stage: e.stage, code: e.code }).toEqual(v.expected.error);
        });
    }

    for (const v of builds) {
        it(`builds ${v.name}: unsigned tx, PSBT maps, fee and extension`, () => {
            const want = fixture(v).expected;
            const check = (a: Action) => {
                expect(hex.encode(a.tx)).toBe(want.unsigned_tx_hex);
                expect(psbtMaps(a.psbt)).toEqual(psbtMaps(hex.decode(want.psbt_hex)));
                expect([a.fee, a.extension]).toEqual([BigInt(want.fee), want.extension ?? 0]);
            };
            const t = compiledOf(v);
            const r = requestOf(v);
            const a = build(bind(t, bindingsOf(v)), r);
            check(a);
            // the compatibility path Go also checks: instantiate, then build the instance
            check(instantiate(t, { ...bindingsOf(v), ...r }).build(r.sources, r.fee));
            // the SDK signer reads it back
            expect(hex.encode(Transaction.fromPSBT(a.psbt).unsignedTx)).toBe(want.unsigned_tx_hex);
        });
    }
});
