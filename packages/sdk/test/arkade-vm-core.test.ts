import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { tapLeafHash as scureTapLeafHash } from "@scure/btc-signer/payment.js";
import { describe, expect, it } from "vitest";
import { getOpcodeName, OPCODE_VALUES } from "../src/arkade/opcodes";
import {
    BigNum,
    ComputeBudget,
    DefaultComputeLimits,
    type Engine,
    type EngineOptions,
    ErrUnsupportedByPort,
    ExecutionError,
    type ExtensionCodec,
    evalExpression,
    executeCovenant,
    MapArkPrevOutFetcher,
    MaxScriptElementSize,
    MaxScriptSize,
    newEngine,
    OpcodeByName,
    parseTx,
    ScriptError,
    ScriptTokenizer,
    serializeTx,
    serializeTxOut,
    serializeTxStripped,
    txid,
    type VmTx,
} from "../src/arkade/vm";
import { minimallyEncode } from "../src/arkade/vm/bignum";
import { newTaprootExecutionCtx } from "../src/arkade/vm/engine";
import {
    AggregateComputeLimits,
    MaxStackSize,
    maxCombinedStackByteSize,
} from "../src/arkade/vm/limits";
import { checkMinimalDataPush } from "../src/arkade/vm/minimalpush";
import { opcodeArray } from "../src/arkade/vm/opcodes";
import { type FamilyName, OPCODE_FAMILIES } from "../src/arkade/vm/opnames";
import { arithHandlers } from "../src/arkade/vm/ops/arith";
import { assetsHandlers } from "../src/arkade/vm/ops/assets";
import { coreHandlers } from "../src/arkade/vm/ops/core";
import { ecopsHandlers } from "../src/arkade/vm/ops/ecops";
import { hashopsHandlers } from "../src/arkade/vm/ops/hashops";
import { introspectHandlers } from "../src/arkade/vm/ops/introspect";
import { packetsHandlers } from "../src/arkade/vm/ops/packets";
import { sigHandlers } from "../src/arkade/vm/ops/sig";
import { timeHandlers } from "../src/arkade/vm/ops/time";
import { makeScriptNum, scriptNumBytes } from "../src/arkade/vm/scriptnum";
import { asBool, OpCondFalse, OpCondTrue, Stack } from "../src/arkade/vm/stack";
import { isExtensionScript, isPushOnlyScript } from "../src/arkade/vm/tokenizer";
import {
    computeTxSigHashes,
    Reader,
    readTx,
    serializeSizeStripped,
    taggedHash,
    tapLeafHash,
    vmTxFromTransaction,
} from "../src/arkade/vm/tx";
import limitsDump from "./fixtures/arkade-vm/compute_limits.json";
import opcodesDump from "./fixtures/arkade-vm/opcodes.json";

const h = hex.decode;
const s = (...parts: (number | string | Uint8Array)[]): Uint8Array =>
    concatBytes(
        ...parts.map((p) =>
            typeof p === "number" ? Uint8Array.of(p) : typeof p === "string" ? h(p) : p,
        ),
    );
const bytes = (n: number, fill = 0x01) => new Uint8Array(n).fill(fill);

const P2TR = h(`5120${"11".repeat(32)}`);
const PREV = { txid: bytes(32, 0xaa), index: 0 };
const PREV2 = { txid: bytes(32, 0xbb), index: 1 };
const TX: VmTx = {
    version: 2,
    locktime: 0,
    inputs: [{ ...PREV, sequence: 0xffffffff, scriptSig: new Uint8Array(0) }],
    outputs: [],
};
const FETCHER = new MapArkPrevOutFetcher().setPrevOut(PREV, { value: 1000n, script: P2TR });
const LEAF = { leafVersion: 0xc0, script: h("51") };

const engineFor = (script: Uint8Array, opts: Partial<EngineOptions> = {}): Engine =>
    newEngine({
        script,
        tx: TX,
        inputIndex: 0,
        inputAmount: 0n,
        fetcher: FETCHER,
        now: 0n,
        ...opts,
    });

const metered = (script: Uint8Array, limits: [number, number][]): Engine => {
    const vm = engineFor(script);
    vm.taprootCtx = newTaprootExecutionCtx(LEAF);
    vm.limits = new Map(limits);
    return vm;
};

const runAll = (vm: Engine): string[] => {
    for (let done = false; !done; ) done = vm.step();
    return vm.getStack().map((e) => hex.encode(e));
};

type Thrown = Error & { code?: string; kind?: string };
function thrown(fn: () => unknown): Thrown {
    try {
        fn();
    } catch (err) {
        return err as Thrown;
    }
    throw new Error("expected a throw");
}
const failure = (fn: () => unknown): string | undefined => {
    const err = thrown(fn);
    expect(err instanceof ScriptError || err instanceof ExecutionError, String(err)).toBe(true);
    return err.code ?? err.kind;
};

// executor vectors v1 (af8d9eb): onchain.json, counter.json, splice-locking.json
const ONCHAIN_UNSIGNED =
    "0200000001f6387b8a34751ae4a084b49c520a936b198ca7e90f825761132862a99e4c36400000000000ffffffff019e85010000000000225120f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f900000000";
const ONCHAIN_PSBT =
    "70736274ff01005e0200000001f6387b8a34751ae4a084b49c520a936b198ca7e90f825761132862a99e4c36400000000000ffffffff019e85010000000000225120f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9000000000001012ba08601000000000022512089b13f1de2d5bc700695813283363c8c3464dd9597994c072ca5e4df022c39472215c050929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0232079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798acc008de746170747265652500c0222079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac0000";
const ONCHAIN_SOURCE = {
    txid: "40364c9ea96228136157820fe9a78c196b930a529cb484a0e41a75348a7b38f6",
    tx: "0300000001000000000000000000000000000000000000000000000000000000000000000001000000000000000001a08601000000000022512089b13f1de2d5bc700695813283363c8c3464dd9597994c072ca5e4df022c394700000000",
};
const COUNTER_SOURCE = {
    txid: "bb9207fc026718e1885f374fc552d33ce1142ea1be33f81285f6930129de7869",
    tx: "0300000001000000000000000000000000000000000000000000000000000000000000000001000000000000000003a086010000000000225120deaa67e89e71ebcb866f50fb0ab7a9565ac542f3e59ead5d8251d3daf1185bf0a08601000000000022512069161656f8ba739f86392f44244d6fe93cf563998f15fd065035e07c27a6c6900000000000000000386a3641524b0208050000000000000005270124009c9b59518d972f5473773b52d57bd18280ed89b4b7143000d979558c8af49a080000010000000000",
};
const SPLICE_UNSIGNED =
    "0300000001db93a521a410c0719818b1578ebbd8a3ba3bcb1994e8f85c32e351d0a7b855320000000000ffffffff02a0860100000000002251202f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe40000000000000000386a3641524b01310100002bcd76d15188202f8bde4d1a07209355b4a7250a5c5128e88b84bddc619ab7cba8d569b240efe488cfcdc9a2010000000000";

describe("opcode table", () => {
    it("matches opcodes.json in all 256 slots, aliases included", () => {
        expect(opcodeArray).toHaveLength(256);
        for (const o of opcodesDump.opcodes) {
            const { value, name, length } = opcodeArray[o.value];
            expect({ value, name, length }).toEqual({
                value: o.value,
                name: o.name,
                length: o.length,
            });
            for (const alias of o.aliases) expect(OpcodeByName.get(alias), alias).toBe(o.value);
        }
        expect(OpcodeByName.size).toBe(256 + 5);
    });

    it("agrees with src/arkade/opcodes.ts in both directions", () => {
        const sdkToVm: Record<string, string> = {
            OP_NOP4: "OP_MERKLEBRANCHROOT",
            OP_INVALID: "OP_INVALIDOPCODE",
        };
        const unknownToSdk = [0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xc1, 0xc2, 0xd0, 0xdd, 0xde, 0xdf];
        unknownToSdk.push(0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe);
        for (const op of opcodeArray) {
            const sdk = getOpcodeName(op.value);
            if (unknownToSdk.includes(op.value)) expect(sdk, op.name).toBeUndefined();
            else expect(OpcodeByName.get(sdkToVm[sdk ?? ""] ?? sdk ?? ""), op.name).toBe(op.value);
        }
        for (const [raw, value] of Object.entries(OPCODE_VALUES)) {
            const name = raw.startsWith("OP_") ? raw : `OP_${raw}`;
            expect(OpcodeByName.get(sdkToVm[name] ?? name), raw).toBe(value);
        }
    });

    it("dispatches every slot, each family filling all of its names", () => {
        const maps: Record<FamilyName, Record<string, unknown>> = {
            core: coreHandlers,
            arith: arithHandlers,
            hashops: hashopsHandlers,
            introspect: introspectHandlers,
            time: timeHandlers,
            sig: sigHandlers,
            ecops: ecopsHandlers,
            assets: assetsHandlers,
            packets: packetsHandlers,
        };
        expect(opcodeArray.every((op) => typeof op.handler === "function")).toBe(true);
        const unfilled = (Object.keys(OPCODE_FAMILIES) as FamilyName[]).flatMap((family) =>
            Object.entries(OPCODE_FAMILIES[family]).filter(([name]) => !maps[family][name]),
        );
        expect(unfilled).toEqual([]);
    });

    it("engine-owned slots: pushes push, reserved and invalid fail ErrReservedOpcode", () => {
        expect(runAll(engineFor(s(0x00, 0x4f, 0x51, 0x60, 0x02, "abcd")))).toEqual([
            "",
            "81",
            "01",
            "10",
            "abcd",
        ]);
        const failing = [0x50, 0x62, 0x89, 0x8a, 0xbc, 0xc2, 0xd0, 0xdd, 0xdf, 0xf9, 0xfa, 0xff];
        for (const v of failing)
            expect(failure(() => engineFor(s(v)).step())).toBe("ErrReservedOpcode");
    });
});

describe("tokenizer", () => {
    it("parses each push width, counting opcodes and copying data", () => {
        const script = s(
            0x51,
            0x02,
            "abcd",
            0x4c,
            "01",
            "ee",
            0x4d,
            "0100",
            "ff",
            0x4e,
            "00000000",
        );
        const t = new ScriptTokenizer(script);
        expect(t.opcodePosition()).toBe(-1);
        const seen: [string, string, number, number][] = [];
        while (t.next()) {
            seen.push([t.op?.name ?? "", hex.encode(t.data), t.byteIndex(), t.opcodePosition()]);
        }
        expect(t.err).toBeUndefined();
        expect(seen).toEqual([
            ["OP_1", "", 1, 0],
            ["OP_DATA_2", "abcd", 4, 1],
            ["OP_PUSHDATA1", "ee", 7, 2],
            ["OP_PUSHDATA2", "ff", 11, 3],
            ["OP_PUSHDATA4", "", 16, 4],
        ]);
        const pushed = new ScriptTokenizer(s(0x01, "aa"));
        pushed.next();
        pushed.data[0] = 0;
        expect(hex.encode(pushed.script)).toBe("01aa");
    });

    it("reports truncated pushes as ErrMalformedPush", () => {
        for (const bad of ["02aa", "4c", "4c02aa", "4d01", "4d0100", "4effffffff00"]) {
            const t = new ScriptTokenizer(h(bad));
            while (t.next());
            expect(t.err?.code, bad).toBe("ErrMalformedPush");
            expect(t.done()).toBe(true);
        }
    });

    it("isPushOnlyScript counts OP_RESERVED as a push, as btcd does", () => {
        expect(isPushOnlyScript(s(0x50, 0x60, 0x01, "aa"))).toBe(true);
        expect(isPushOnlyScript(s(0x61))).toBe(false);
        expect(isPushOnlyScript(h("02aa"))).toBe(false);
    });

    it("isExtensionScript inspects only OP_RETURN and the next push", () => {
        const counter = parseTx(h(COUNTER_SOURCE.tx));
        expect(counter.outputs.map((o) => isExtensionScript(o.script))).toEqual([
            false,
            false,
            true,
        ]);
        expect(isExtensionScript(h("6a4d030041524b"))).toBe(true);
        expect(isExtensionScript(h("6a0341524b02aa"))).toBe(true);
        expect(isExtensionScript(h("6a024152"))).toBe(false);
        expect(isExtensionScript(h("510341524b"))).toBe(false);
    });
});

describe("scriptNum", () => {
    it("decodes up to 4 bytes, minimally", () => {
        const cases: [string, number][] = [
            ["", 0],
            ["7f", 127],
            ["ff", -127],
            ["8000", 128],
            ["8080", -128],
            ["ff00", 255],
            ["ffffff7f", 2 ** 31 - 1],
            ["ffffffff", -(2 ** 31 - 1)],
        ];
        for (const [v, n] of cases) expect(makeScriptNum(h(v), true), v).toBe(n);
        for (const v of ["00", "80", "7f00", "0080"]) {
            expect(
                failure(() => makeScriptNum(h(v), true)),
                v,
            ).toBe("ErrMinimalData");
        }
        expect(makeScriptNum(h("0100"), false)).toBe(1);
        expect(failure(() => makeScriptNum(h("0000000001"), true))).toBe("ErrNumberTooBig");
    });

    it("encodes the int64 domain and panics on MinInt64 like Go", () => {
        const cases: [bigint, string][] = [
            [0n, ""],
            [-1n, "81"],
            [127n, "7f"],
            [128n, "8000"],
            [-255n, "ff80"],
            [2n ** 31n, "0000008000"],
            [2n ** 63n - 1n, "ffffffffffffff7f"],
            [-(2n ** 63n - 1n), "ffffffffffffffff"],
        ];
        for (const [n, v] of cases) expect(hex.encode(scriptNumBytes(n)), String(n)).toBe(v);
        expect(failure(() => scriptNumBytes(-(2n ** 63n)))).toBe("ErrPanic");
    });
});

describe("BigNum", () => {
    const n = (v: number | bigint) => BigNum.fromInt64(v);
    const at = (x: BigNum) => [x.value, x.useBig];

    it("decodes the int64 path up to 8 bytes and the big path from 9", () => {
        expect(at(BigNum.fromBytes(h("ffffffffffffff7f")))).toEqual([2n ** 63n - 1n, false]);
        expect(at(BigNum.fromBytes(h("000000000000008000")))).toEqual([2n ** 63n, true]);
        expect(failure(() => BigNum.fromBytes(h("80")))).toBe("ErrMinimalData");
        expect(failure(() => BigNum.fromBytes(bytes(521)))).toBe("ErrNumberTooBig");
        expect(at(BigNum.fromUint64(2n ** 63n))).toEqual([2n ** 63n, true]);
        expect(() => BigNum.fromUint64(-1n)).toThrow(RangeError);
    });

    it("promotes on overflow and never demotes", () => {
        const big = n(2n ** 63n - 1n).add(n(1));
        expect(at(big)).toEqual([2n ** 63n, true]);
        expect(at(big.sub(n(1)))).toEqual([2n ** 63n - 1n, true]);
        expect(at(n(-(2n ** 63n)).mul(n(-1)))).toEqual([2n ** 63n, true]);
        expect(at(n(-1).mul(n(-(2n ** 63n))))).toEqual([2n ** 63n, true]);
        expect(at(n(-(2n ** 63n)).negate())).toEqual([2n ** 63n, true]);
        expect(at(n(3).mul(n(4)))).toEqual([12n, false]);
    });

    it("divides truncating toward zero; MinInt64 % -1 lands on the big path", () => {
        expect(at(n(-7).div(n(2)))).toEqual([-3n, false]);
        expect(at(n(-7).mod(n(2)))).toEqual([-1n, false]);
        expect(at(n(-(2n ** 63n)).div(n(-1)))).toEqual([2n ** 63n, true]);
        expect(at(n(-(2n ** 63n)).mod(n(-1)))).toEqual([0n, true]);
        expect(failure(() => n(1).div(n(0)))).toBe("ErrBigNumDivisionByZero");
        expect(failure(() => n(1).mod(n(0)))).toBe("ErrBigNumModuloByZero");
    });

    it("shifts: rshift floors, lshift caps at 4160 bits and 520 bytes", () => {
        expect(at(n(-7).rshift(1))).toEqual([-4n, true]);
        expect(at(n(-1).rshift(100_000))).toEqual([-1n, true]);
        expect(at(n(0).rshift(5))).toEqual([0n, false]);
        expect(n(1).lshift(4158).bytes()).toHaveLength(520);
        expect(failure(() => n(1).lshift(4159))).toBe("ErrNumberTooBig");
        expect(failure(() => n(1).lshift(4161))).toBe("ErrNumberTooBig");
        expect(at(n(0).lshift(10_000))).toEqual([0n, false]);
    });

    it("modexp normalises into [0, m) and rejects bad operands", () => {
        expect(at(n(0).modexp(n(0), n(7)))).toEqual([1n, true]);
        expect(at(n(5).modexp(n(3), n(1)))).toEqual([0n, true]);
        expect(at(n(-5).modexp(n(3), n(7)))).toEqual([1n, true]);
        expect(at(n(2).modexp(n(10), n(1000)))).toEqual([24n, true]);
        expect(failure(() => n(2).modexp(n(1), n(0)))).toBe("ErrBigNumModulusNotPositive");
        expect(failure(() => n(2).modexp(n(1), n(-7)))).toBe("ErrBigNumModulusNotPositive");
        expect(failure(() => n(2).modexp(n(-1), n(7)))).toBe("ErrBigNumNegativeExponent");
        const huge = new BigNum(2n ** 4160n, true);
        expect(failure(() => huge.modexp(n(1), n(7)))).toBe("ErrBigNumModexpOperandTooLarge");
    });

    it("fixedBytes moves the sign bit to the last byte", () => {
        const fixed = (v: number, size: number) => hex.encode(n(v).fixedBytes(size));
        expect(fixed(-1, 4)).toBe("01000080");
        expect(fixed(128, 2)).toBe("8000");
        expect(fixed(-128, 3)).toBe("800080");
        expect(fixed(0, 3)).toBe("000000");
        expect(failure(() => n(256).fixedBytes(1))).toBe("ErrFixedBytes");
        expect(failure(() => n(1).fixedBytes(-1))).toBe("ErrFixedBytes");
    });

    it("minimallyEncode normalises padding and every negative zero", () => {
        const cases: [string, string][] = [
            ["80", ""],
            ["000080", ""],
            ["0100", "01"],
            ["0180", "81"],
            ["ff80", "ff80"],
            ["800000", "8000"],
        ];
        for (const [v, want] of cases) expect(hex.encode(minimallyEncode(h(v))), v).toBe(want);
    });
});

describe("Stack", () => {
    const stackOf = (...items: string[]) => {
        const st = new Stack();
        st.verifyMinimalData = true;
        for (const i of items) st.pushByteArray(h(i));
        return st;
    };
    const dump = (st: Stack) => st.stk.map((e) => hex.encode(e));

    it("asBool treats 0x80 as false only in the last byte", () => {
        expect(["", "00", "000000", "80", "0080"].map((v) => asBool(h(v)))).toEqual(
            Array(5).fill(false),
        );
        expect(["01", "8000", "0001"].map((v) => asBool(h(v)))).toEqual([true, true, true]);
    });

    it("nipN covers the top, bottom and middle branches", () => {
        const st = stackOf("01", "02", "03", "04");
        expect(hex.encode(st.nipN(1))).toBe("03");
        expect(hex.encode(st.nipN(2))).toBe("01");
        expect(hex.encode(st.nipN(0))).toBe("04");
        expect(dump(st)).toEqual(["02"]);
        expect(failure(() => st.nipN(1))).toBe("ErrInvalidStackOperation");
    });

    it("rot, swap, over, dup, tuck, pick, roll and put follow btcd's transforms", () => {
        const st = stackOf("01", "02", "03", "04", "05", "06");
        st.rotN(2);
        expect(dump(st)).toEqual(["03", "04", "05", "06", "01", "02"]);
        st.swapN(2);
        expect(dump(st)).toEqual(["03", "04", "01", "02", "05", "06"]);
        st.overN(2);
        expect(dump(st).slice(-2)).toEqual(["01", "02"]);
        st.dupN(2);
        expect(dump(st).slice(-4)).toEqual(["01", "02", "01", "02"]);
        const small = stackOf("0a", "0b");
        small.tuck();
        expect(dump(small)).toEqual(["0b", "0a", "0b"]);
        small.pickN(2);
        small.rollN(0);
        expect(dump(small)).toEqual(["0b", "0a", "0b", "0b"]);
        small.rollN(3);
        small.putN(0, h("ff"));
        expect(dump(small)).toEqual(["0a", "0b", "0b", "ff"]);
        for (const op of [
            () => small.dropN(0),
            () => small.pickN(4),
            () => small.putN(-1, h("")),
        ]) {
            expect(failure(op)).toBe("ErrInvalidStackOperation");
        }
    });

    it("pops numbers at their two widths", () => {
        expect(stackOf("ffffff7f").popInt()).toBe(2 ** 31 - 1);
        expect(failure(() => stackOf("0000008000").popInt())).toBe("ErrNumberTooBig");
        expect(failure(() => stackOf("0100").popInt())).toBe("ErrMinimalData");
        expect(stackOf("0000008000").popBigNum().value).toBe(2n ** 31n);
    });
});

describe("limits", () => {
    const pairs = (m: ReadonlyMap<number, number>) => [...m].sort((a, b) => a[0] - b[0]);
    const dumped = (l: { opcode: number; limit: number }[]) => l.map((e) => [e.opcode, e.limit]);

    it("match compute_limits.json", () => {
        expect(pairs(DefaultComputeLimits())).toEqual(dumped(limitsDump.default));
        expect(pairs(AggregateComputeLimits(DefaultComputeLimits()))).toEqual(
            dumped(limitsDump.aggregate),
        );
        expect([
            MaxScriptElementSize,
            MaxScriptSize,
            MaxStackSize,
            maxCombinedStackByteSize,
        ]).toEqual([
            limitsDump.engine.max_script_element_size,
            limitsDump.engine.max_script_size,
            limitsDump.engine.max_stack_size,
            limitsDump.engine.max_combined_stack_byte_size,
        ]);
    });

    it("aggregate saturates and a non-integer limit is refused", () => {
        expect(AggregateComputeLimits(new Map([[0xac, Number.MAX_SAFE_INTEGER]])).get(0xac)).toBe(
            Number.MAX_SAFE_INTEGER,
        );
        expect(() => new ComputeBudget(new Map([[0xac, Number.NaN]]))).toThrow(RangeError);
    });
});

describe("engine", () => {
    it("checks always-illegal opcodes first, even in a dead branch", () => {
        const vm = engineFor(s(0x65));
        vm.condStack.push(OpCondFalse);
        expect(failure(() => vm.step())).toBe("ErrReservedOpcode");
    });

    it("checks element size in a dead branch, before minimal push", () => {
        const vm = engineFor(s(0x4d, "0902", bytes(521)));
        vm.condStack.push(OpCondFalse);
        expect(failure(() => vm.step())).toBe("ErrElementTooBig");
    });

    it("skips minimal-push and the handler in a dead branch", () => {
        const vm = engineFor(s(0x01, "05", 0x51));
        vm.condStack.push(OpCondFalse);
        expect(vm.step()).toBe(false);
        expect(vm.getStack()).toEqual([]);
        expect(failure(() => vm.step())).toBe("ErrUnbalancedConditional");
    });

    it("enforces minimal pushes on executing branches only", () => {
        for (const bad of [s(0x01, "05"), s(0x01, "81"), s(0x4c, "01", "aa"), s(0x4c, "00")]) {
            expect(
                failure(() => runAll(engineFor(bad))),
                hex.encode(bad),
            ).toBe("ErrMinimalData");
        }
        expect(runAll(engineFor(s(0x01, "11", 0x4c, "4c", bytes(76))))).toHaveLength(2);
    });

    it("never requires OP_PUSHDATA4 (no >65535 case)", () => {
        expect(() => checkMinimalDataPush(opcodeArray[0x4e], bytes(65_536))).not.toThrow();
        expect(() => checkMinimalDataPush(opcodeArray[0x4d], bytes(65_535))).not.toThrow();
        expect(failure(() => checkMinimalDataPush(opcodeArray[0x4e], bytes(256)))).toBe(
            "ErrMinimalData",
        );
    });

    it("meters only with a taproot context, after the minimal-push check", () => {
        expect(runAll(engineFor(s(0x51, 0x51, 0x51)))).toHaveLength(3);
        const unmetered = engineFor(s(0x51, 0x51, 0x51));
        unmetered.limits = new Map([[0x51, 2]]);
        expect(runAll(unmetered)).toHaveLength(3);
        expect(failure(() => runAll(metered(s(0x51, 0x51, 0x51), [[0x51, 2]])))).toBe(
            "ErrScriptTooBig",
        );
        expect(failure(() => runAll(metered(s(0x01, "05"), [[0x01, 0]])))).toBe("ErrMinimalData");
        expect(failure(() => runAll(metered(s(0x01, "11"), [[0x01, 0]])))).toBe("ErrScriptTooBig");
    });

    it("charges the per-input limit before the shared budget", () => {
        const perInput = metered(s(0x51, 0x51), [[0x51, 1]]);
        perInput.budget = new ComputeBudget(new Map([[0x51, 5]]));
        expect(thrown(() => runAll(perInput)).message).toContain("exceeded execution limit of 1");
        const budget = new ComputeBudget(new Map([[0x51, 2]]));
        for (const expectOk of [true, false]) {
            const vm = metered(s(0x51, 0x51), []);
            vm.budget = budget;
            if (expectOk) expect(runAll(vm)).toHaveLength(2);
            else expect(thrown(() => runAll(vm)).message).toContain("request execution limit of 2");
        }
    });

    it("counts both stacks after each step, for elements and for bytes", () => {
        const items = (n: number, size = 1) => Array.from({ length: n }, () => bytes(size));
        const atCap = engineFor(s(0x51));
        atCap.setStack(items(599));
        atCap.setAltStack(items(400));
        expect(runAll(atCap)).toHaveLength(600);
        const over = engineFor(s(0x51));
        over.setStack(items(600));
        over.setAltStack(items(400));
        expect(failure(() => over.step())).toBe("ErrStackOverflow");
        const half = (maxCombinedStackByteSize - 32) / 2 / 520;
        for (const [push, ok] of [
            [32, true],
            [33, false],
        ] as const) {
            const vm = engineFor(s(push, bytes(push)));
            vm.setStack(items(half, 520));
            vm.setAltStack(items(half, 520));
            if (ok) expect(() => vm.step()).not.toThrow();
            else expect(failure(() => vm.step())).toBe("ErrStackOverflow");
        }
    });

    it("drops the alt stack between scripts and skips an empty scriptSig", () => {
        const tx: VmTx = { ...TX, inputs: [{ ...TX.inputs[0], scriptSig: s(0x51) }] };
        const vm = engineFor(s(0x51), { tx });
        expect(vm.scriptIdx).toBe(0);
        vm.setAltStack([h("aa")]);
        expect(vm.step()).toBe(false);
        expect([vm.scriptIdx, vm.getAltStack()]).toEqual([1, []]);
        expect(engineFor(s(0x51)).scriptIdx).toBe(1);
    });

    it("rejects a conditional left open at the end of a script", () => {
        const vm = engineFor(s(0x51));
        vm.condStack.push(OpCondTrue);
        expect(failure(() => vm.step())).toBe("ErrUnbalancedConditional");
    });

    it("validates at construction like NewEngine", () => {
        expect(failure(() => engineFor(s(0x51), { inputIndex: 1 }))).toBe("ErrInvalidIndex");
        expect(failure(() => engineFor(s(0x51), { inputIndex: -1 }))).toBe("ErrInvalidIndex");
        expect(failure(() => engineFor(s()))).toBe("ErrEvalFalse");
        const notPush: VmTx = { ...TX, inputs: [{ ...TX.inputs[0], scriptSig: s(0x61) }] };
        expect(failure(() => engineFor(s(0x51), { tx: notPush }))).toBe("ErrNotPushOnly");
        expect(failure(() => engineFor(bytes(10_001, 0x61)))).toBe("ErrScriptTooBig");
        expect(failure(() => engineFor(h("02aa")))).toBe("ErrMalformedPush");
    });

    it("execute locates the failing opcode and checks the final stack", () => {
        const err = thrown(() => engineFor(s(0x51, 0x65)).execute());
        expect(err).toBeInstanceOf(ExecutionError);
        const located = err as ExecutionError;
        expect([located.scriptIndex, located.position, located.opcode, located.code]).toEqual([
            1,
            1,
            "OP_VERIF",
            "ErrReservedOpcode",
        ]);
        expect(() => engineFor(s(0x51)).execute()).not.toThrow();
        const unclean = thrown(() => engineFor(s(0x51, 0x51)).execute()) as ExecutionError;
        expect([unclean.code, unclean.position]).toEqual(["ErrCleanStack", 1]);
        expect(unclean.message).toContain("final script validation failed");
        expect(failure(() => engineFor(s(0x00)).execute())).toBe("ErrEvalFalse");
    });

    it("refuses to step past the end or check an unfinished script", () => {
        const vm = engineFor(s(0x51));
        expect(failure(() => vm.checkErrorCondition(true))).toBe("ErrScriptUnfinished");
        expect(vm.step()).toBe(true);
        expect(failure(() => vm.step())).toBe("ErrInvalidProgramCounter");
    });

    it("takes the clock and options at construction", () => {
        const vm = engineFor(s(0x51), { now: 1_700_000_000n, intentMessage: "" });
        expect([vm.currentTime.value, vm.currentTime.useBig]).toEqual([1_700_000_000n, false]);
        expect(vm.intentMessage).toEqual(new Uint8Array(0));
        expect(engineFor(s(0x51)).intentMessage).toBeUndefined();
        const wall = engineFor(s(0x51), { now: undefined }).currentTime.value;
        expect(Number(wall)).toBeCloseTo(Date.now() / 1000, -1);
        expect(() => engineFor(s(0x51), { expiry: 2n ** 63n })).toThrow(RangeError);
    });

    it("keeps the uint32 view of a negative int32 version", () => {
        const signed: VmTx = { ...TX, version: -1 };
        const vm = engineFor(s(0x51), { tx: signed });
        expect(vm.tx.version).toBe(0xffffffff);
        expect(vm.txID()).toEqual(txid({ ...TX, version: 0xffffffff }));
    });

    it("without a codec reads only a tx that carries no extension output", () => {
        const vm = engineFor(s(0x51));
        expect(vm.codecFor(TX).readExtension(TX)).toBeNull();
        const withExtension = parseTx(h(COUNTER_SOURCE.tx));
        expect(() => vm.codecFor(withExtension)).toThrow(ErrUnsupportedByPort);
    });

    it("copies stack elements in and out, and memoises txID as a copy", () => {
        const item = h("aabb");
        const vm = engineFor(s(0x51));
        vm.setStack([item]);
        item[0] = 0;
        vm.getStack()[0][1] = 0;
        expect(vm.getStack().map((e) => hex.encode(e))).toEqual(["aabb"]);
        const id = vm.txID();
        id[0] ^= 0xff;
        expect(vm.txID()).toEqual(txid(TX));
    });
});

describe("evalExpression", () => {
    const expr = (script: Uint8Array) =>
        evalExpression({
            script,
            tx: TX,
            inputIndex: 0,
            inputAmount: 0n,
            fetcher: FETCHER,
            now: 0n,
        });

    it("returns the single element, with no clean-stack or truthiness check", () => {
        expect(hex.encode(expr(s(0x55)))).toBe("05");
        expect(hex.encode(expr(s(0x00)))).toBe("");
        expect(failure(() => expr(s(0x51, 0x52)))).toBe("ErrExpressionStackDepth");
    });

    it("surfaces engine errors unlocated, as draft.go's step loop does", () => {
        const err = thrown(() => expr(s(0x51, 0x65)));
        expect([err instanceof ScriptError, err.code]).toEqual([true, "ErrReservedOpcode"]);
    });
});

describe("executeCovenant", () => {
    const covenant = (over: Partial<Parameters<typeof executeCovenant>[0]> = {}) =>
        executeCovenant({
            script: s(0x51),
            tapLeaf: LEAF,
            witness: [],
            tx: TX,
            inputIndex: 0,
            fetcher: FETCHER,
            now: 0n,
            ...over,
        });
    const codec = (over: Partial<ExtensionCodec>): ExtensionCodec => ({
        readExtension: () => null,
        findEmulatorPacket: () => null,
        maskExtensionOutput: () => null,
        ...over,
    });

    it("passes with a clean, truthy stack", () => {
        expect(() => covenant()).not.toThrow();
    });

    it("fails closed when any input's prevout is missing", () => {
        const tx: VmTx = {
            ...TX,
            inputs: [...TX.inputs, { ...PREV2, sequence: 0, scriptSig: new Uint8Array(0) }],
        };
        const err = thrown(() => covenant({ tx }));
        expect([err.kind, err.message]).toEqual(["ErrNoPrevout", "no prevout found for input 1"]);
        expect(failure(() => covenant({ inputIndex: 3 }))).toBe("ErrPanic");
    });

    it("seeds the witness without an element-size check", () => {
        const err = thrown(() => covenant({ witness: [bytes(600)] })) as ExecutionError;
        expect([err.code, err.opcode]).toEqual(["ErrCleanStack", "OP_1"]);
    });

    it("meters with exact-replace limits and a shared budget", () => {
        const err = thrown(() => covenant({ limits: new Map([[0x51, 0]]) })) as ExecutionError;
        expect([err.code, err.opcode, err.position]).toEqual(["ErrScriptTooBig", "OP_1", 0]);
        expect(() => covenant({ limits: new Map() })).not.toThrow();
        const budget = new ComputeBudget(new Map([[0x51, 1]]));
        expect(() => covenant({ budget })).not.toThrow();
        expect(failure(() => covenant({ budget }))).toBe("ErrScriptTooBig");
    });

    it("reads the packets through the codec, wrapping its failures", () => {
        const tlv = codec({
            readExtension: () => {
                throw new Error("bad tlv");
            },
        });
        const err = thrown(() => covenant({ codec: tlv }));
        expect([err.kind, err.message]).toEqual([
            "ErrExtensionParse",
            "failed to parse extension: bad tlv",
        ]);
        const entries = codec({
            findEmulatorPacket: () => {
                throw new Error("duplicate vin");
            },
        });
        expect(failure(() => covenant({ codec: entries }))).toBe("ErrEmulatorPacketParse");
        const refusing = codec({
            readExtension: () => {
                throw new ErrUnsupportedByPort("not ported");
            },
        });
        expect(thrown(() => covenant({ codec: refusing }))).toBeInstanceOf(ErrUnsupportedByPort);
    });

    it("refuses a tx with an extension output when no codec is given", () => {
        const tx: VmTx = { ...TX, outputs: parseTx(h(COUNTER_SOURCE.tx)).outputs };
        expect(thrown(() => covenant({ tx }))).toBeInstanceOf(ErrUnsupportedByPort);
        expect(() => covenant({ tx, codec: codec({}) })).not.toThrow();
    });
});

describe("tx", () => {
    it("round-trips the vectors' raw transactions byte-exactly", () => {
        for (const raw of [
            ONCHAIN_UNSIGNED,
            SPLICE_UNSIGNED,
            ONCHAIN_SOURCE.tx,
            COUNTER_SOURCE.tx,
        ]) {
            const tx = parseTx(h(raw));
            expect(hex.encode(serializeTxStripped(tx))).toBe(raw);
            expect(hex.encode(serializeTx(tx))).toBe(raw);
            expect(serializeSizeStripped(tx)).toBe(raw.length / 2);
        }
    });

    it("txid is internal byte order: reversed, it is the displayed id", () => {
        for (const src of [ONCHAIN_SOURCE, COUNTER_SOURCE]) {
            expect(hex.encode(txid(parseTx(h(src.tx))).reverse())).toBe(src.txid);
        }
        const spending = parseTx(h(ONCHAIN_UNSIGNED));
        expect(spending.inputs[0].txid).toEqual(txid(parseTx(h(ONCHAIN_SOURCE.tx))));
    });

    it("adapts a scure Transaction through its unsigned tx", () => {
        const psbt = Transaction.fromPSBT(h(ONCHAIN_PSBT));
        expect(vmTxFromTransaction(psbt)).toEqual(parseTx(h(ONCHAIN_UNSIGNED)));
    });

    it("frames witnesses per BIP-144 and leaves them out of the txid", () => {
        const base = parseTx(h(ONCHAIN_UNSIGNED));
        const tx: VmTx = { ...base, inputs: [{ ...base.inputs[0], witness: [h("aa"), h("")] }] };
        const full = serializeTx(tx);
        expect(hex.encode(full.subarray(4, 6))).toBe("0001");
        expect(parseTx(full)).toEqual(tx);
        expect(txid(tx)).toEqual(txid(base));
        expect(serializeSizeStripped(tx)).toBe(ONCHAIN_UNSIGNED.length / 2);
    });

    it("rejects what wire.MsgTx rejects, and leaves trailing bytes unread", () => {
        const raw = ONCHAIN_UNSIGNED;
        const superfluous = `${raw.slice(0, 8)}0001${raw.slice(8, -8)}00${raw.slice(-8)}`;
        for (const bad of [superfluous, `${raw.slice(0, 8)}0002${raw.slice(8)}`]) {
            expect(() => parseTx(h(bad))).toThrow();
        }
        expect(() => parseTx(h(`${raw.slice(0, 8)}fd0100${raw.slice(10)}`))).toThrow(
            /non-canonical/,
        );
        const r = new Reader(h(`${raw}00`));
        expect(readTx(r)).toEqual(parseTx(h(raw)));
        expect(r.offset).toBe(raw.length / 2);
    });

    it("hashes tap leaves like scure", () => {
        for (const script of [h("51"), bytes(300, 0xac)]) {
            expect(tapLeafHash(0xc0, script)).toEqual(scureTapLeafHash(script, 0xc0));
        }
    });

    it("midstates reproduce scure's BIP-341 script-path sighash", () => {
        const psbt = Transaction.fromPSBT(h(ONCHAIN_PSBT));
        const tx = vmTxFromTransaction(psbt);
        const prev = psbt.getInput(0).witnessUtxo as { script: Uint8Array; amount: bigint };
        const fetcher = new MapArkPrevOutFetcher().setPrevOut(tx.inputs[0], {
            value: prev.amount,
            script: prev.script,
        });
        const m = computeTxSigHashes(tx, fetcher);
        const u32 = (v: number) => {
            const b = new Uint8Array(4);
            new DataView(b.buffer).setUint32(0, v, true);
            return b;
        };
        const msg = concatBytes(
            Uint8Array.of(0x00, 0x00),
            u32(tx.version),
            u32(tx.locktime),
            m.hashPrevOutsV1,
            m.hashInputAmountsV1,
            m.hashInputScriptsV1,
            m.hashSequenceV1,
            sha256(concatBytes(...tx.outputs.map(serializeTxOut))),
            Uint8Array.of(0x02),
            u32(0),
            tapLeafHash(0xc0, LEAF.script),
            Uint8Array.of(0x00),
            u32(0xffffffff),
        );
        const want = psbt.preimageWitnessV1(
            0,
            [prev.script],
            0x00,
            [prev.amount],
            -1,
            LEAF.script,
            0xc0,
        );
        expect(hex.encode(taggedHash("TapSighash", msg))).toBe(hex.encode(want));
    });

    it("zeroes the amount and script midstates unless a prevout is P2TR-shaped", () => {
        const plain = new MapArkPrevOutFetcher().setPrevOut(PREV, { value: 5n, script: h("51") });
        const m = computeTxSigHashes(TX, plain);
        expect([m.hashInputAmountsV1, m.hashInputScriptsV1]).toEqual([bytes(32, 0), bytes(32, 0)]);
        expect(m.hashPrevOutsV1).not.toEqual(bytes(32, 0));
        expect(computeTxSigHashes(TX, FETCHER).hashInputAmountsV1).not.toEqual(bytes(32, 0));
    });

    it("MapArkPrevOutFetcher resolves the vtxo script only for an in-range vout", () => {
        const arkTx = parseTx(h(ONCHAIN_SOURCE.tx));
        const f = new MapArkPrevOutFetcher().setArkTx(PREV, arkTx, 0).setArkTx(PREV2, arkTx, 1);
        expect(f.fetchVtxoPrevOutPkScript(PREV)).toEqual(arkTx.outputs[0].script);
        expect(f.fetchVtxoPrevOutPkScript(PREV2)).toBeUndefined();
        expect(f.fetchPrevOutArkTx(PREV2)).toBe(arkTx);
        expect(f.fetchPrevOutput(PREV)).toBeUndefined();
    });
});
