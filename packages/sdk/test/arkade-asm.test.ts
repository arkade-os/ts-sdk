import { readdirSync, readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { concatBytes, equalBytes, hash160 } from "@scure/btc-signer/utils.js";
import { describe, expect, it } from "vitest";

import { decodeArtifact, type Definition, parseDefinition } from "../src/arkade/template/abi";
import {
    AsmError,
    assemble,
    canonicalBytes,
    checkExpression,
    checkProgram,
    checkScript,
    isContextFree,
    type Lookup,
    opcode,
    parseDecimal,
    parseScriptNum,
    scriptNum,
    type Value,
} from "../src/arkade/template/asm";
import { buildContract, type Contract } from "../src/arkade/template/contract";
import { fail, wrap } from "../src/arkade/template/errors";
import { decode } from "../src/arkade/template/jcs";
import { Extension } from "../src/extension";
import { scriptFromTapLeafScript, type TapLeafScript, TapTreeCoder } from "../src/script/base";

type Json = any;

const utf8 = (s: string) => new TextEncoder().encode(s);
const bytes = (h: string) => hex.decode(h);

function caught(f: () => unknown): AsmError | undefined {
    try {
        f();
    } catch (e) {
        if (e instanceof AsmError) return e;
        throw e;
    }
    return undefined;
}

// Ported from the executor's pkg/template/internal/asm/asm_test.go.
describe("assemble", () => {
    const values: Record<string, Value> = {
        SERVER_KEY: { type: "bytes32", raw: new Uint8Array(32).fill(0x11) },
        delay: { type: "int", raw: scriptNum(4194306) },
        zero: { type: "int", raw: new Uint8Array() },
        empty: { type: "bytes", raw: new Uint8Array() },
        one: { type: "bool", raw: Uint8Array.of(1) },
        nul: { type: "bytes", raw: Uint8Array.of(0) },
        big: { type: "bytes", raw: new Uint8Array(521) },
        badint: { type: "int", raw: Uint8Array.of(0x80) },
    };
    const lookup: Lookup = (name) => {
        if (!Object.hasOwn(values, name)) throw new Error(`unknown ${name}`);
        return values[name];
    };
    const asm = (tokens: string[]) => hex.encode(assemble(tokens, lookup));

    it("pushes placeholders, decimals and hex as btcd's ScriptBuilder", () => {
        expect(
            asm(["<delay>", "OP_CHECKSEQUENCEVERIFY", "OP_DROP", "<SERVER_KEY>", "OP_CHECKSIG"]),
        ).toBe(`03020040b27520${"11".repeat(32)}ac`);
        expect(
            asm(["4194306", "0x74797065", "OP_INSPECTINTENTMESSAGE", "<zero>", "16", "17", "-1"]),
        ).toBe("030200400474797065f80060" + "01114f");
        expect(
            asm(["0x05", "0x81", "<empty>", "<one>", "9007199254740991", "-9007199254740991"]),
        ).toBe("554f0051" + "07ffffffffffff1f" + "07ffffffffffff9f");
    });

    it("pushes a lone zero byte as OP_DATA_1 0x00, not OP_0", () => {
        expect([asm(["0x00"]), asm(["<nul>"]), asm(["<empty>"]), asm([])]).toEqual([
            "0100",
            "0100",
            "00",
            "",
        ]);
    });

    it.each<[string, string[]]>([
        ["unknown opcode", ["OP_NOPE"]],
        ["uppercase hex", ["0xAB"]],
        ["odd hex", ["0xabc"]],
        ["unknown name", ["<nope>"]],
        ["leading zero", ["007"]],
        ["empty", [""]],
        ["negative zero", ["-0"]],
        ["too large", ["9007199254740992"]],
        ["too small", ["-9007199254740992"]],
        ["overflow", ["99999999999999999999"]],
        ["long hex", [`0x${"ab".repeat(521)}`]],
        ["long value", ["<big>"]],
        ["empty placeholder", ["<>"]],
        ["placeholder without a lookup", ["<x>"]],
    ])("refuses %s", (_, tokens) => {
        const e = caught(() => assemble(tokens, tokens[0] === "<x>" ? undefined : lookup));
        expect(e).toBeInstanceOf(AsmError);
        expect(e?.sentinel).toBeUndefined();
    });

    it("refuses a non-canonical int value as a bad value", () => {
        expect(caught(() => assemble(["<badint>"], lookup))?.sentinel).toBe("bad_value");
    });

    it("refuses push opcodes as tokens", () => {
        for (const op of [
            "OP_DATA_1",
            "OP_DATA_75",
            "OP_PUSHDATA1",
            "OP_PUSHDATA2",
            "OP_PUSHDATA4",
        ]) {
            expect(() => assemble([op, "0x01"]), op).toThrow("push opcode");
        }
    });

    it("splices raw bytes, which checkScript then screens", () => {
        const terms = Uint8Array.of(0x02, 0x10, 0x27, 0xa2);
        const script = assemble(["<quote>", "<!terms>"], (n) =>
            n === "terms" ? { type: "bytes", raw: terms } : { type: "int", raw: scriptNum(10_000) },
        );
        expect(hex.encode(script)).toBe("021027" + "021027a2");
        checkScript(script, true);
        checkExpression(["<quote>", "<!terms>"]);
    });

    it("refuses a script over 10000 bytes, but only after every token assembled", () => {
        const spliced =
            (n: number): Lookup =>
            () => ({ type: "bytes", raw: new Uint8Array(n) });
        expect(assemble(["<!x>"], spliced(10_000))).toHaveLength(10_000);
        expect(assemble(["<!x>", "0x00"], spliced(9_998))).toHaveLength(10_000);
        expect(() => assemble(["<!x>", "0x00"], spliced(9_999))).toThrow("exceeds 10000");
        expect(() => assemble(["<!x>", "OP_1"], spliced(10_000))).toThrow("exceeds 10000");
        expect(() => assemble(["<!x>", "OP_NOPE"], spliced(10_001))).toThrow("unknown opcode");
    });
});

// Ported from expr_test.go.
describe("checkExpression and checkScript", () => {
    it("counts every occurrence against the compute limits", () => {
        const modexp = (n: number) => "2 3 5 OP_MODEXP OP_DROP ".repeat(n).trim().split(" ");
        checkExpression(modexp(64));
        expect(caught(() => checkExpression(modexp(65)))?.sentinel).toBe("bad_expression");
        checkScript(bytes("525355da75".repeat(64)), false);
        expect(caught(() => checkScript(bytes("525355da75".repeat(65)), false))?.sentinel).toBe(
            "bad_expression",
        );
    });

    it.each([
        "OP_INSPECTOUTPUTVALUE",
        "OP_INSPECTOUTPUTSCRIPTPUBKEY",
        "OP_INSPECTNUMOUTPUTS",
        "OP_TUNNEL",
        "OP_INSPECTPACKET",
        "OP_INSPECTNUMASSETGROUPS",
        "OP_FINDASSETGROUPBYASSETID",
        "OP_INSPECTINPUTARKADESCRIPTHASH",
        "OP_INSPECTINTENTMESSAGE",
        "OP_TXID",
        "OP_TXWEIGHT",
        "OP_SIGHASH",
        "OP_CHECKSIG",
        "OP_CHECKSIGVERIFY",
        "OP_CHECKSIGADD",
        "OP_INSPECTINASSETCOUNT",
        "OP_INSPECTOUTASSETCOUNT",
    ])("refuses %s in an expression", (op) => {
        expect(caught(() => checkExpression([op]))?.sentinel).toBe("bad_expression");
    });

    it("allows the current input's packet, which is not context-free", () => {
        checkExpression("2 OP_PUSHCURRENTINPUTINDEX OP_INSPECTINPUTPACKET OP_VERIFY".split(" "));
        expect(isContextFree(["<preimage>", "OP_HASH160"])).toBe(true);
        for (const op of [
            "OP_INSPECTINPUTPACKET",
            "OP_PUSHCURRENTINPUTINDEX",
            "OP_INSPECTINPUTVALUE",
            "OP_PUSHEXPIRY",
            "OP_CHECKTIME",
            "OP_INSPECTVERSION",
            "OP_INSPECTLOCKTIME",
            "OP_CHECKLOCKTIMEVERIFY",
            "OP_NOP2",
            "OP_CHECKSEQUENCEVERIFY",
            "OP_NOP3",
        ]) {
            expect(isContextFree([op]), op).toBe(false);
        }
    });

    it("refuses a push opcode that would hide the next push as code", () => {
        const hidden = (op: number) => `0x01${op.toString(16)}`;
        expect(caught(() => checkExpression(["OP_DATA_2", hidden(0xd5), "OP_NIP"]))?.sentinel).toBe(
            "bad_expression",
        );
        const many = Array.from({ length: 100 }, () => [
            "OP_DATA_2",
            hidden(0xf8),
            "OP_NIP",
        ]).flat();
        expect(caught(() => checkExpression(many))?.sentinel).toBe("bad_expression");
    });

    it("screens spliced programs", () => {
        checkScript(Uint8Array.of(0x01, 0x00), true);
        checkScript(Uint8Array.of(0xcd), false);
        for (const [script, free] of [
            ["4c0107", false],
            ["0207", false],
            ["f3", false],
            ["cd", true],
        ] as const) {
            expect(caught(() => checkScript(bytes(script), free))?.sentinel, script).toBe(
                "bad_expression",
            );
        }
    });
});

// Verdicts of the executor's asm.Program at af8d9eb.
describe("checkProgram", () => {
    const ab = (n: number) => "ab".repeat(n);
    it.each<[string, boolean]>([
        ["", true],
        ["00", true],
        ["0100", true],
        ["0105", false],
        ["0181", false],
        ["0110", false],
        ["0111", true],
        ["4f", true],
        ["4c00", false],
        ["4c0101", false],
        ["4c0111", false],
        [`4b${ab(75)}`, true],
        [`4c4b${ab(75)}`, false],
        [`4c4c${ab(76)}`, true],
        [`4d4c00${ab(76)}`, false],
        [`4cff${ab(255)}`, true],
        [`4d0001${ab(256)}`, true],
        [`4d0802${ab(520)}`, true],
        [`4d0902${ab(521)}`, false],
        ["4e01000000ab", false],
        ["0207", false],
        ["4c", false],
        ["4e010000", false],
        ["0281ff", true],
    ])("%s: %s", (script, ok) => {
        const e = caught(() => checkProgram(bytes(script)));
        expect(e?.sentinel).toBe(ok ? undefined : "bad_expression");
    });
});

// Ported from value_test.go, plus an int long enough for the plaintext check to bite.
describe("values", () => {
    const key = bytes("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798");
    const n = (len: number, fill = 0) => new Uint8Array(len).fill(fill);
    it.each<[string, string, Uint8Array, boolean]>([
        ["pubkey", "pubkey", key, true],
        ["x-only is not a pubkey", "pubkey", key.subarray(1), false],
        ["above the field", "pubkey", concatBytes(Uint8Array.of(2), n(32, 0xff)), false],
        ["not on curve", "pubkey", concatBytes(Uint8Array.of(2), n(32, 0x05)), false],
        ["bytes32", "bytes32", n(32), true],
        ["bytes32 short", "bytes32", n(31), false],
        ["bytes20", "bytes20", n(20), true],
        ["bytes any", "bytes", Uint8Array.of(1, 2, 3), true],
        ["bytes of a push", "bytes", n(520), true],
        ["bytes over a push", "bytes", n(521), true],
        ["asset", "asset", n(34), true],
        ["asset of 32 bytes", "asset", n(32), false],
        ["int zero is empty", "int", n(0), true],
        ["int 1024", "int", Uint8Array.of(0x00, 0x04), true],
        ["int with a padding byte", "int", Uint8Array.of(0x01, 0x00), false],
        ["int negative zero", "int", Uint8Array.of(0x80), false],
        ["int padded at three bytes", "int", Uint8Array.of(0xaa, 0x3b, 0x00), false],
        ["int whose last byte is a sign", "int", Uint8Array.of(0xaa, 0xbb, 0x00), true],
        ["bool true", "bool", Uint8Array.of(1), true],
        ["bool false", "bool", n(0), true],
        ["bool two", "bool", Uint8Array.of(2), false],
        ["signature", "signature", n(64), true],
        ["no signature", "signature", n(0), true],
        ["short signature", "signature", n(63), false],
    ])("%s", (_, type, raw, ok) => {
        const e = caught(() => canonicalBytes(type, raw));
        expect(e?.sentinel).toBe(ok ? undefined : "bad_value");
        if (e && raw.length > 2) expect(e.message).not.toContain(hex.encode(raw.subarray(1, 4)));
    });

    it("encodes script numbers and parses only minimal ones up to 2^53-1", () => {
        const max = 2 ** 53 - 1;
        for (const [num, want] of [
            [0, ""],
            [1, "01"],
            [-1, "81"],
            [127, "7f"],
            [128, "8000"],
            [1024, "0004"],
            [1791000000, "c07dc06a"],
            [max, "ffffffffffff1f"],
            [-max, "ffffffffffff9f"],
        ] as const) {
            expect(hex.encode(scriptNum(num))).toBe(want);
            expect(parseScriptNum(scriptNum(num))).toBe(num);
        }
        for (const raw of ["0100", "80", "00", "0180", "00000000000020", "010203040506070809"]) {
            expect(caught(() => parseScriptNum(bytes(raw)))?.sentinel, raw).toBe("bad_value");
        }
    });

    it("parses decimals as strconv.ParseInt does, within 2^53-1", () => {
        expect(["0", "-0", "+5", "007", "-9007199254740991"].map(parseDecimal)).toEqual([
            0, 0, 5, 7, -9007199254740991,
        ]);
        for (const tok of ["", "0x10", " 5", "5 ", "1_000", "1.0", "9007199254740992", "٣"]) {
            expect(() => parseDecimal(tok), tok).toThrow(AsmError);
        }
    });
});

const DUMP: { value: number; name: string; aliases: string[] }[] = JSON.parse(
    readFileSync(new URL("./fixtures/arkade-vm/opcodes.json", import.meta.url), "utf8"),
).opcodes;
const NAMES = DUMP.flatMap((o) => [o.name, ...o.aliases].map((name) => [name, o.value] as const));
const isPush = (value: number) => value >= 0x01 && value <= 0x4e;

describe("opcode names against the emulator's table", () => {
    it("accepts its 261 names except the 78 pushes, at their bytes", () => {
        expect(NAMES).toHaveLength(261);
        for (const [name, value] of NAMES) {
            if (isPush(value)) expect(() => opcode(name), name).toThrow("push opcode");
            else expect(opcode(name), name).toBe(value);
        }
        expect(NAMES.filter(([, value]) => !isPush(value))).toHaveLength(183);
    });

    it.each(["OP_NOP4", "OP_INVALID", "OP_OP_1", "OP_17", "op_1", "OP_1 ", "CHECKSIG", ""])(
        "refuses %j",
        (name) => expect(() => opcode(name)).toThrow("unknown opcode"),
    );

    it("lets an artifact leaf use the names a scure-derived table missed", () => {
        for (const name of [
            "OP_UNKNOWN188",
            "OP_UNKNOWN208",
            "OP_UNKNOWN252",
            "OP_SMALLINTEGER",
            "OP_PUBKEYS",
            "OP_PUBKEYHASH",
            "OP_PUBKEY",
            "OP_INVALIDOPCODE",
            "OP_MERKLEBRANCHVERIFY",
        ]) {
            const leaf = { name: "l", asm: [name], witness: [] };
            const def = {
                contractName: "C",
                constructorInputs: [],
                functions: [{ name: "f", leaves: [leaf] }],
            };
            expect(() => parseDefinition(decode(utf8(JSON.stringify(def)))), name).not.toThrow();
        }
    });
});

// The executor's CheckExpression and ContextFree over every emulator name, at af8d9eb.
const FORBIDDEN = [
    "OP_CHECKSIG",
    "OP_CHECKSIGADD",
    "OP_CHECKSIGVERIFY",
    "OP_FINDASSETGROUPBYASSETID",
    "OP_INSPECTASSETGROUP",
    "OP_INSPECTASSETGROUPASSETID",
    "OP_INSPECTASSETGROUPCTRL",
    "OP_INSPECTASSETGROUPMETADATAHASH",
    "OP_INSPECTASSETGROUPNUM",
    "OP_INSPECTASSETGROUPSUM",
    "OP_INSPECTINASSETAT",
    "OP_INSPECTINASSETCOUNT",
    "OP_INSPECTINASSETLOOKUP",
    "OP_INSPECTINPUTARKADESCRIPTHASH",
    "OP_INSPECTINPUTARKADEWITNESSHASH",
    "OP_INSPECTINTENTMESSAGE",
    "OP_INSPECTNUMASSETGROUPS",
    "OP_INSPECTNUMOUTPUTS",
    "OP_INSPECTOUTASSETAT",
    "OP_INSPECTOUTASSETCOUNT",
    "OP_INSPECTOUTASSETLOOKUP",
    "OP_INSPECTOUTPUTSCRIPTPUBKEY",
    "OP_INSPECTOUTPUTVALUE",
    "OP_INSPECTPACKET",
    "OP_SIGHASH",
    "OP_TUNNEL",
    "OP_TXID",
    "OP_TXWEIGHT",
];
const CONTEXT = [
    "OP_CHECKLOCKTIMEVERIFY",
    "OP_CHECKSEQUENCEVERIFY",
    "OP_CHECKTIME",
    "OP_INSPECTINPUTOUTPOINT",
    "OP_INSPECTINPUTPACKET",
    "OP_INSPECTINPUTSCRIPTPUBKEY",
    "OP_INSPECTINPUTSEQUENCE",
    "OP_INSPECTINPUTVALUE",
    "OP_INSPECTLOCKTIME",
    "OP_INSPECTNUMINPUTS",
    "OP_INSPECTVERSION",
    "OP_NOP2",
    "OP_NOP3",
    "OP_PUSHCURRENTINPUTINDEX",
    "OP_PUSHEXPIRY",
];

describe("opcode policy", () => {
    const usable = NAMES.filter(([, value]) => !isPush(value)).map(([name]) => name);

    it("refuses exactly the forbidden names in an expression", () => {
        const refused = usable.filter((name) => caught(() => checkExpression([name])));
        expect(refused.sort()).toEqual(FORBIDDEN);
    });

    it("treats exactly the forbidden and context names as context-bound", () => {
        const bound = usable.filter((name) => !isContextFree([name]));
        expect(bound.sort()).toEqual([...FORBIDDEN, ...CONTEXT].sort());
    });

    it("screens every byte of a spliced program by the names it carries", () => {
        for (const { value, name, aliases } of DUMP) {
            const names = [name, ...aliases];
            const loose = caught(() => checkScript(Uint8Array.of(value), false)) !== undefined;
            const free = caught(() => checkScript(Uint8Array.of(value), true)) !== undefined;
            const forbidden = names.some((n) => FORBIDDEN.includes(n));
            const bound = forbidden || names.some((n) => CONTEXT.includes(n));
            // a lone push byte is a truncated push
            const truncated = isPush(value);
            expect([loose, free], name).toEqual([truncated || forbidden, truncated || bound]);
        }
    });

    it.each<[string, number]>([
        ["OP_CHECKSIGFROMSTACK", 50],
        ["OP_ECADD", 1000],
        ["OP_ECMUL", 50],
        ["OP_ECMULSCALARVERIFY", 50],
        ["OP_TWEAKVERIFY", 50],
        ["OP_ECPAIRING", 2],
        ["OP_MODEXP", 64],
    ])("caps %s at %d occurrences", (name, limit) => {
        const op = opcode(name);
        checkExpression(Array(limit).fill(name));
        checkScript(new Uint8Array(limit).fill(op), false);
        expect(caught(() => checkExpression(Array(limit + 1).fill(name)))?.sentinel).toBe(
            "bad_expression",
        );
        expect(caught(() => checkScript(new Uint8Array(limit + 1).fill(op), false))?.sentinel).toBe(
            "bad_expression",
        );
    });
});

describe("errors", () => {
    it("carries no failure kind, so a bare asm error codes internal", () => {
        expect(
            wrap(
                "compile",
                caught(() => checkExpression(["OP_TXID"])),
            ).code,
        ).toBe("internal");
        expect(
            wrap(
                "build",
                caught(() => checkScript(bytes("4c0101"), false)),
            ).code,
        ).toBe("internal");
    });

    it("keeps a lookup's kinds as Go's %w does; a caller's %v replaces them", () => {
        const e = caught(() =>
            assemble(["<x>"], () => {
                throw fail("invalid_template", "unknown name");
            }),
        ) as AsmError;
        expect(wrap("build", e).code).toBe("invalid_template");
        expect(wrap("build", fail("ineligible", `expression: ${e.message}`)).code).toBe(
            "ineligible",
        );
        expect(wrap("compile", fail("invalid_template", "expression", e)).code).toBe(
            "invalid_template",
        );
    });

    it("never shows the bytes of a number, which may be sealed", () => {
        const e = caught(() => assemble(["<v>"], () => ({ type: "int", raw: bytes("aabb3c00") })));
        expect([e?.sentinel, e?.message]).toEqual([
            "bad_value",
            "<v>: bad value: bad number of 4 bytes",
        ]);
    });
});

const VECTORS = new URL("./fixtures/template-v1/", import.meta.url);
const OPTS = { allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true };
const builds: Json[] = readdirSync(VECTORS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(new URL(f, VECTORS), "utf8")))
    .filter((v) => !v.expected.error);
const vector = (name: string) => builds.find((v) => v.name === name);
const templateOf = (v: Json): Json => v.template ?? JSON.parse(v.template_text);
const unsigned = (v: Json) => Transaction.fromRaw(bytes(v.expected.unsigned_tx_hex), OPTS);
const psbtOf = (v: Json) => Transaction.fromPSBT(bytes(v.expected.psbt_hex), OPTS);
const outputsOf = (tx: Transaction) =>
    Array.from({ length: tx.outputsLength }, (_, i) =>
        hex.encode(tx.getOutput(i).script as Uint8Array),
    );
const inputsOf = (tx: Transaction) =>
    Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i));
const taptreeOf = (input: Json): string[] => {
    const field = input.unknown?.find(
        ([k]: Json) => k.type === 0xde && new TextDecoder().decode(k.key) === "taptree",
    );
    return TapTreeCoder.decode(field[1]).map((l) => hex.encode(l.script));
};
const packetOf = (tx: Transaction, type: number) =>
    hex.encode(Extension.fromTx(tx).getPacketByType(type)?.serialize() ?? new Uint8Array());

// A variable as the executor's Instance.lookup sees it: the plaintext of a sealed one.
const variables =
    (v: Json): Lookup =>
    (name) => {
        const type = templateOf(v).variables[name];
        const raw = v.bindings.variables[name];
        if (type === undefined || raw === undefined) throw new Error(`unknown name ${name}`);
        return { type, raw: bytes(v.request.decryption?.[raw] ?? raw) };
    };

function expressionsOf(v: Json): { at: string; tokens: string[] }[] {
    const out: { at: string; tokens: string[] }[] = [];
    const walk = (o: Json, path: string): void => {
        if (typeof o === "string") {
            for (const [, body] of o.matchAll(/\$\(([^)]*)\)/g)) {
                out.push({ at: `${v.name}${path}`, tokens: body.split(" ") });
            }
        } else if (o && typeof o === "object") {
            for (const [k, x] of Object.entries(o)) walk(x, `${path}/${k}`);
        }
    };
    walk(templateOf(v), "");
    return out;
}

// The VM's hash and introspection ops are not ported yet, so each value is derived here.
describe("the 9 expressions of the 23 build vectors", () => {
    const all = builds.flatMap(expressionsOf);
    const shaped = (body: string) => all.filter((e) => e.tokens.join(" ") === body);

    it("are these", () => {
        expect(builds).toHaveLength(23);
        expect(all.map((e) => `${e.at}: ${e.tokens.join(" ")}`)).toEqual([
            "counter/packets/rules/0/data: 2 OP_PUSHCURRENTINPUTINDEX OP_INSPECTINPUTPACKET OP_VERIFY OP_BIN2NUM OP_1ADD 8 OP_NUM2BIN",
            "example-vhtlc-non-interactive-claim/inputs/0/contract/arguments/preimageHash: <preimage> OP_HASH160",
            "splice-locking/inputs/0/contract/arguments/preimageHash: <preimage> OP_HASH160",
            "splice-locking/outputs/0/locking: <!terms> OP_VERIFY <receiver_program>",
            "supplied-taptree-undelegated/inputs/0/contract/arguments/preimageHash: <preimage> OP_HASH160",
            "supplied-taptree/inputs/0/contract/arguments/preimageHash: <preimage> OP_HASH160",
            "supplied-taptree/delegation/trigger/htlc/capture/receiver_program: <tlv:2> 6 32 OP_SUBSTR",
            "vhtlc-claim-plaintext/inputs/0/contract/arguments/preimageHash: <preimage> OP_HASH160",
            "vhtlc-claim/inputs/0/contract/arguments/preimageHash: <preimage> OP_HASH160",
        ]);
        for (const e of all) checkExpression(e.tokens);
    });

    it("hashes the preimage into the leaf each PSBT carries", () => {
        const hashed = shaped("<preimage> OP_HASH160");
        expect(hashed).toHaveLength(6);
        for (const { at, tokens } of hashed) {
            const v = vector(at.split("/")[0]);
            const preimage = variables(v)("preimage").raw;
            const script = assemble(tokens, variables(v));
            expect(hex.encode(script), at).toBe(`20${hex.encode(preimage)}a9`);
            checkScript(script, true);
            const leaves = inputsOf(psbtOf(v)).flatMap(taptreeOf);
            const claim = `a914${hex.encode(hash160(preimage))}87`;
            expect(
                leaves.some((l) => l.includes(claim)),
                at,
            ).toBe(true);
        }
    });

    it("splices the terms, then leaves the program the payout locks to", () => {
        const [{ at, tokens }] = shaped("<!terms> OP_VERIFY <receiver_program>");
        const v = vector(at.split("/")[0]);
        const { terms, receiver_program: program } = v.bindings.variables;
        const script = assemble(tokens, variables(v));
        expect(hex.encode(script)).toBe(`${terms}6920${program}`);
        checkScript(script, false);
        expect(caught(() => checkScript(script, true))?.message).toContain("is not context-free");
        expect(outputsOf(unsigned(v))).toContain(`5120${program}`);
    });

    it("emits the counter input's packet plus one, in 8 bytes", () => {
        const [{ at, tokens }] = shaped(
            "2 OP_PUSHCURRENTINPUTINDEX OP_INSPECTINPUTPACKET OP_VERIFY OP_BIN2NUM OP_1ADD 8 OP_NUM2BIN",
        );
        const v = vector(at.split("/")[0]);
        const script = assemble(tokens);
        expect(hex.encode(script)).toBe("52cdf569d88b58d7");
        checkScript(script, false);
        expect(caught(() => checkScript(script, true))).toBeInstanceOf(AsmError);
        expect(templateOf(v).inputs[0].name).toBe("counter");
        const source = Transaction.fromRaw(bytes(v.request.sources[0].tx_hex), OPTS);
        expect([packetOf(source, 2), packetOf(unsigned(v), 2)]).toEqual([
            "0500000000000000",
            "0600000000000000",
        ]);
    });

    it("assembles the trigger capture, whose value no build derives", () => {
        const [{ tokens }] = shaped("<tlv:2> 6 32 OP_SUBSTR");
        const tlv = new Uint8Array(40).fill(0x07);
        const script = assemble(tokens, () => ({ type: "bytes", raw: tlv }));
        expect(hex.encode(script)).toBe(`28${hex.encode(tlv)}5601207f`);
        expect(isContextFree(tokens)).toBe(true);
        checkScript(script, true);
    });
});

function definitionOf(v: Json, c: Json): Definition {
    const ref = c.definition.artifact;
    if (ref === undefined) return parseDefinition(decode(utf8(JSON.stringify(c.definition))));
    return decodeArtifact(utf8(JSON.stringify(v.artifacts[ref]))).definition;
}

// The binding forms vector contract arguments use; the expression's bytes are asserted above.
function argument(v: Json, b: Json): Uint8Array {
    if (typeof b !== "string") {
        const out = templateOf(v).outputs.find((o: Json) => o.name === b.program);
        return build(v, out.locking.contract).script.pkScript.subarray(2);
    }
    const parts: Uint8Array[] = [];
    for (const [, lit, name, hashed] of b.matchAll(
        /([0-9a-f]+)|<(\w+)>|\$\(<(\w+)> OP_HASH160\)/g,
    )) {
        if (lit) parts.push(bytes(lit));
        else if (name) parts.push(variables(v)(name).raw);
        else parts.push(hash160(variables(v)(hashed).raw));
    }
    return concatBytes(...parts);
}

function build(v: Json, c: Json): Contract {
    const args = Object.fromEntries(
        Object.entries<Json>(c.arguments ?? {}).map(([field, b]) => [field, argument(v, b)]),
    );
    const keys = Object.fromEntries(
        Object.entries<string>(v.bindings.keys).map(([k, h]) => [k, bytes(h)]),
    );
    const taptree = c.taptree && bytes(v.bindings.variables[c.taptree.slice(1, -1)]);
    return buildContract(definitionOf(v, c), args, keys, taptree);
}

interface Tally {
    inTaptree: number;
    inEmulatorPacket: number;
    tweakedIntoLeaf: number;
    inOutputKey: number;
}

function gate(v: Json): Tally {
    const t = templateOf(v);
    const tx = unsigned(v);
    const psbt = inputsOf(psbtOf(v));
    const entries =
        v.expected.extension < 0 ? [] : (Extension.fromTx(tx).getEmulatorPacket()?.entries ?? []);
    const tally: Tally = { inTaptree: 0, inEmulatorPacket: 0, tweakedIntoLeaf: 0, inOutputKey: 0 };
    for (const input of t.inputs) {
        const def = definitionOf(v, input.contract);
        const c = build(v, input.contract);
        const vin = psbt.findIndex(
            (p) => p.witnessUtxo && equalBytes(p.witnessUtxo.script, c.script.pkScript),
        );
        const tree = taptreeOf(psbt[vin]);
        const tokens = def.functions.flatMap((f) => f.leaves.flatMap((l) => l.asm));
        for (const fn of def.functions) {
            for (const leaf of fn.leaves) {
                const proof = c.proofs.get(fn.name)?.get(leaf.name) as TapLeafScript;
                expect(tree, `${fn.name}/${leaf.name}`).toContain(
                    hex.encode(scriptFromTapLeafScript(proof)),
                );
                tally.inTaptree++;
            }
            if (!fn.arkade) continue;
            const covenant = hex.encode(c.covenants.get(fn.name) as Uint8Array);
            if (fn.name === input.spend.function) {
                const entry = entries.find((e) => e.vin === vin);
                expect(entry && hex.encode(entry.script), fn.name).toBe(covenant);
                tally.inEmulatorPacket++;
                continue;
            }
            const tweaks = (tok: string) =>
                tok === `<EMULATOR_KEY:${fn.name}>` ||
                (tok.startsWith("<TWEAK:") && tok.endsWith(`:${fn.name}>`));
            expect(tokens.some(tweaks), fn.name).toBe(true);
            tally.tweakedIntoLeaf++;
        }
    }
    expect(entries).toHaveLength(tally.inEmulatorPacket);
    for (const o of t.outputs) {
        if (!o.locking?.contract) continue;
        expect(outputsOf(tx)).toContain(hex.encode(build(v, o.locking.contract).script.pkScript));
        const def = definitionOf(v, o.locking.contract);
        tally.inOutputKey += def.functions.reduce(
            (n, f) => n + f.leaves.length + (f.arkade ? 1 : 0),
            0,
        );
    }
    return tally;
}

describe("leaf and covenant scripts of the 23 build vectors", () => {
    it.each(builds.map((v) => [v.name, v]))("%s", (_, v) => {
        gate(v);
    });

    it("covers all 128 asm arrays, in its PSBT or committed by a key found there", () => {
        const total = builds.map(gate).reduce((a, b) => ({
            inTaptree: a.inTaptree + b.inTaptree,
            inEmulatorPacket: a.inEmulatorPacket + b.inEmulatorPacket,
            tweakedIntoLeaf: a.tweakedIntoLeaf + b.tweakedIntoLeaf,
            inOutputKey: a.inOutputKey + b.inOutputKey,
        }));
        expect(Object.values(total).reduce((a, b) => a + b)).toBe(128);
        expect(total).toEqual({
            inTaptree: 88,
            inEmulatorPacket: 21,
            tweakedIntoLeaf: 7,
            inOutputKey: 12,
        });
    });
});
