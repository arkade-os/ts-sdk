import { equalBytes } from "@noble/curves/utils.js";
import { hex } from "@scure/base";
import { BigNum } from "../bignum";
import type { Engine } from "../engine";
import { ErrUnsupportedByPort, prefixed, scriptError } from "../errors";
import { MaxScriptElementSize } from "../limits";
import type { FamilyHandlers } from "../opcodes";
import type { VmTx } from "../tx";
import type { AssetPacketLike } from "../types";
import { popAssetID, resolveAssetID, stackError } from "./assets";

const tunnelScriptPubKey = 1;
const tunnelValue = 2;
const tunnelAssets = 4;
const assetLocal = 1;
const maxIntentMessageSize = 1 << 20;
const maxBigNumDecimalDigitCount = 1255;
// encoding/json's nesting limit, so the strict-JSON gate refuses what json.Valid refuses
const maxJSONDepth = 10000;

function findPacketByType(vm: Engine, tx: VmTx, type: number): Uint8Array | undefined {
    const codec = vm.codecFor(tx);
    return prefixed(
        "failed to parse extension",
        () =>
            codec
                .readExtension(tx)
                ?.packets.find((p) => p.type === type)
                ?.serialize(),
        stackError,
    );
}

function pushPacket(vm: Engine, content: Uint8Array | undefined): void {
    if (content === undefined) {
        vm.dstack.pushByteArray(new Uint8Array(0));
        vm.dstack.pushInt(0);
        return;
    }
    if (content.length > MaxScriptElementSize) {
        throw scriptError(
            "ErrElementTooBig",
            `packet content size ${content.length} exceeds max allowed size ${MaxScriptElementSize}`,
        );
    }
    vm.dstack.pushByteArray(content);
    vm.dstack.pushInt(1);
}

function checkPacketType(type: number): number {
    if (type < 0 || type > 255) throw stackError("packet type out of range");
    return type;
}

// ignoreBOM: the default decoder drops a leading BOM that Go's byte-level checks would see
const utf8Decoder = (fatal = false) => new TextDecoder("utf-8", { fatal, ignoreBOM: true });

function checkTunnelAssets(
    txHash: Uint8Array,
    packet: AssetPacketLike | undefined,
    inputIndex: number,
    outputIndex: number,
    exceptions: ReadonlySet<string>,
): void {
    const ins = new Map<string, bigint>();
    const outs = new Map<string, bigint>();
    // uint64 += in Go, so a sum wraps (unreachable while ark-lib forbids duplicate ids and vins)
    const add = (m: Map<string, bigint>, key: string, amount: bigint) =>
        m.set(key, BigInt.asUintN(64, (m.get(key) ?? 0n) + amount));
    for (const [k, group] of (packet ?? []).entries()) {
        const id = resolveAssetID(txHash, k, group);
        const key = `${hex.encode(id.txid)}:${id.index}`;
        if (exceptions.has(key)) continue;
        for (const i of group.inputs)
            if (i.type === assetLocal && i.vin === inputIndex) add(ins, key, i.amount);
        for (const o of group.outputs)
            if (o.type === assetLocal && o.vout === outputIndex) add(outs, key, o.amount);
    }
    // maps.Equal: an asset present with amount 0 differs from an absent one
    if (ins.size !== outs.size || [...ins].some(([key, amount]) => outs.get(key) !== amount)) {
        throw stackError("selected output does not preserve source assets");
    }
}

const isJSONSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

function skipSpace(s: string, i: number): number {
    while (isJSONSpace(s[i])) i++;
    return i;
}

function stringEnd(s: string, i: number): number {
    for (i++; s[i] !== '"'; i++) if (s[i] === "\\") i++;
    return i + 1;
}

function valueEnd(s: string, i: number): number {
    if (s[i] === '"') return stringEnd(s, i);
    if (s[i] !== "{" && s[i] !== "[") {
        while (i < s.length && !isJSONSpace(s[i]) && !",]}".includes(s[i])) i++;
        return i;
    }
    for (let depth = 0; ; i++) {
        if (s[i] === '"') i = stringEnd(s, i) - 1;
        else if (s[i] === "{" || s[i] === "[") depth++;
        else if ((s[i] === "}" || s[i] === "]") && --depth === 0) return i + 1;
    }
}

/** The text, if it is UTF-8, strict JSON (json.Valid) and free of duplicate keys at any depth. */
function strictUniqueJSON(message: Uint8Array): string | undefined {
    let s: string;
    try {
        s = utf8Decoder(true).decode(message);
        JSON.parse(s);
    } catch {
        return undefined;
    }
    const encoder = new TextEncoder();
    const decoder = utf8Decoder();
    const scopes: (Set<string> | undefined)[] = [];
    let expectKey = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '"') {
            const end = stringEnd(s, i);
            const keys = scopes[scopes.length - 1];
            if (expectKey && keys) {
                // Go decodes an unpaired surrogate escape to U+FFFD before comparing
                const key = decoder.decode(encoder.encode(JSON.parse(s.slice(i, end))));
                if (keys.has(key)) return undefined;
                keys.add(key);
            }
            expectKey = false;
            i = end - 1;
        } else if (c === "{" || c === "[") {
            scopes.push(c === "{" ? new Set() : undefined);
            if (scopes.length > maxJSONDepth) return undefined;
            expectKey = c === "{";
        } else if (c === "}" || c === "]") {
            scopes.pop();
        } else if (c === ",") {
            expectKey = scopes[scopes.length - 1] !== undefined;
        }
    }
    return s;
}

/** gjson.Get's raw span for a simple path, over strict JSON with unique keys. */
function lookup(s: string, path: string): string | undefined {
    let i = skipSpace(s, 0);
    for (const segment of path.split(".")) {
        const open = s[i];
        if (open !== "{" && open !== "[") return undefined;
        i = skipSpace(s, i + 1);
        for (let n = 0; ; n++) {
            if (s[i] === "}" || s[i] === "]") return undefined;
            let hit = String(n) === segment;
            if (open === "{") {
                const end = stringEnd(s, i);
                hit = JSON.parse(s.slice(i, end)) === segment;
                i = skipSpace(s, skipSpace(s, end) + 1);
            }
            if (hit) break;
            i = skipSpace(s, valueEnd(s, i));
            if (s[i] === ",") i = skipSpace(s, i + 1);
        }
    }
    return s.slice(i, valueEnd(s, i));
}

const ESCAPES: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
};

// gjson's unescape, not JSON.parse: a surrogate escape always swallows the next \u escape.
function unescape(raw: string): string {
    let out = "";
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== "\\") {
            out += raw[i];
            continue;
        }
        const c = raw[++i];
        if (c !== "u") {
            out += ESCAPES[c];
            continue;
        }
        let r = Number.parseInt(raw.slice(i + 1, i + 5), 16);
        i += 4;
        if (r >= 0xd800 && r < 0xe000 && raw[i + 1] === "\\" && raw[i + 2] === "u") {
            const low = Number.parseInt(raw.slice(i + 3, i + 7), 16);
            const paired = r < 0xdc00 && low >= 0xdc00 && low < 0xe000;
            r = paired ? 0x10000 + ((r - 0xd800) << 10) + (low - 0xdc00) : 0xfffd;
            i += 6;
        }
        out += String.fromCodePoint(r >= 0xd800 && r < 0xe000 ? 0xfffd : r);
    }
    return out;
}

const numberTooBig = () =>
    scriptError("ErrNumberTooBig", "intent message number exceeds the BigNum range");

/** intent_message.go parseJSONInteger over a strict JSON number; undefined is not an integer. */
function parseJSONInteger(raw: string): bigint | undefined {
    const negative = raw[0] === "-";
    const body = negative ? raw.slice(1) : raw;
    const e = body.search(/[eE]/);
    let mantissa = e < 0 ? body : body.slice(0, e);
    const dot = mantissa.indexOf(".");
    const fractionDigits = dot < 0 ? 0 : mantissa.length - dot - 1;
    if (dot >= 0) mantissa = mantissa.slice(0, dot) + mantissa.slice(dot + 1);
    let digits = mantissa.replace(/^0+/, "");
    if (digits === "") return 0n;
    const exponent = e < 0 ? 0n : BigInt(body.slice(e + 1));
    if (BigInt.asIntN(64, exponent) !== exponent) {
        if (exponent > 0n) throw numberTooBig();
        return undefined;
    }
    if (exponent < BigInt(fractionDigits - digits.length)) return undefined;
    const scale = exponent - BigInt(fractionDigits);
    if (scale < 0n) {
        const trim = Number(-scale);
        if (trim > digits.length || /[^0]/.test(digits.slice(digits.length - trim)))
            return undefined;
        digits = digits.slice(0, digits.length - trim).replace(/^0+/, "");
        if (digits === "") return 0n;
    } else if (scale > 0n) {
        const max = BigInt(maxBigNumDecimalDigitCount);
        if (scale > max || BigInt(digits.length) + scale > max) throw numberTooBig();
        digits += "0".repeat(Number(scale));
    }
    if (digits.length > maxBigNumDecimalDigitCount) throw numberTooBig();
    return negative ? -BigInt(digits) : BigInt(digits);
}

const isSimpleIntentMessagePath = (path: string): boolean =>
    path
        .split(".")
        .every((segment) =>
            /^[0-9]/.test(segment)
                ? /^(0|[1-9][0-9]*)$/.test(segment) && Number(segment) < maxIntentMessageSize
                : /^[a-z_][a-z0-9_]*$/.test(segment),
        );

function pushIntentMiss(vm: Engine): void {
    vm.dstack.pushByteArray(new Uint8Array(0));
    vm.dstack.pushBool(false);
}

function pushIntentBytes(vm: Engine, value: Uint8Array): void {
    if (value.length > MaxScriptElementSize) {
        throw scriptError(
            "ErrElementTooBig",
            `intent message result size ${value.length} exceeds max allowed size ${MaxScriptElementSize}`,
        );
    }
    vm.dstack.pushByteArray(value);
    vm.dstack.pushBool(true);
}

export const packetsHandlers: FamilyHandlers<"packets"> = {
    OP_INSPECTPACKET: (_op, _data, vm) => {
        const type = checkPacketType(vm.dstack.popInt());
        pushPacket(vm, findPacketByType(vm, vm.tx, type));
    },
    OP_INSPECTINPUTPACKET: (_op, _data, vm) => {
        const index = vm.dstack.popInt();
        const rawType = vm.dstack.popInt();
        if (index < 0) throw scriptError("ErrInvalidIndex", "input index cannot be negative");
        if (index >= vm.tx.inputs.length)
            throw scriptError("ErrInvalidIndex", "input index out of range");
        const type = checkPacketType(rawType);
        const prevTx = vm.prevOutFetcher.fetchPrevOutArkTx(vm.tx.inputs[index]);
        if (!prevTx) throw stackError(`prevout tx not available for input ${index}`);
        pushPacket(vm, findPacketByType(vm, prevTx, type));
    },
    OP_TUNNEL: (_op, _data, vm) => {
        const exceptionCount = vm.dstack.popInt();
        const remaining = vm.dstack.depth();
        if (
            exceptionCount < 0 ||
            remaining < 2 ||
            exceptionCount > Math.floor((remaining - 2) / 2)
        ) {
            throw stackError("invalid asset exception count");
        }
        const exceptions = new Set<string>();
        for (let i = 0; i < exceptionCount; i++) {
            const id = popAssetID(vm);
            exceptions.add(`${hex.encode(id.txid)}:${id.index}`);
        }
        const flags = vm.dstack.popInt();
        if (flags <= 0 || (flags & ~(tunnelScriptPubKey | tunnelValue | tunnelAssets)) !== 0) {
            throw stackError("invalid tunnel flags");
        }
        if ((flags & tunnelAssets) === 0 && exceptions.size > 0) {
            throw stackError("asset exceptions require asset tunneling");
        }
        const outputIndex = vm.dstack.popInt();
        if (outputIndex < 0 || outputIndex >= vm.tx.outputs.length) {
            throw scriptError("ErrInvalidIndex", "output index out of range");
        }
        const outpoint = vm.tx.inputs[vm.txIdx];
        const output = vm.tx.outputs[outputIndex];
        if (flags & tunnelScriptPubKey) {
            // the one soft miss: a missing vtxo script falls back to the spent output's
            const script =
                vm.prevOutFetcher.fetchVtxoPrevOutPkScript(outpoint) ??
                vm.prevOutFetcher.fetchPrevOutput(outpoint)?.script;
            if (!script) throw scriptError("ErrInvalidIndex", "previous output not found");
            if (!equalBytes(script, output.script)) {
                throw stackError("selected output does not preserve source script");
            }
        }
        if (flags & tunnelValue) {
            const prevout = vm.prevOutFetcher.fetchPrevOutput(outpoint);
            if (!prevout) throw scriptError("ErrInvalidIndex", "previous output not found");
            if (prevout.value !== output.value) {
                throw stackError("selected output does not preserve source value");
            }
        }
        if (flags & tunnelAssets) {
            checkTunnelAssets(vm.txID(), vm.assetPacket, vm.txIdx, outputIndex, exceptions);
        }
        vm.dstack.pushBool(true);
    },
    OP_INSPECTINTENTMESSAGE: (_op, _data, vm) => {
        // byte for byte, as Go checks it: a valid path is ASCII, and a BOM must not be dropped
        const path = Array.from(vm.dstack.popByteArray(), (b) => String.fromCharCode(b)).join("");
        const message = vm.intentMessage;
        if (message === undefined) return pushIntentMiss(vm);
        if (message.length > maxIntentMessageSize) {
            throw scriptError("ErrElementTooBig", "intent message exceeds 1 MiB");
        }
        if (!isSimpleIntentMessagePath(path)) {
            throw stackError(`invalid intent message path ${JSON.stringify(path)}`);
        }
        const text = strictUniqueJSON(message);
        // gjson scans a top-level string for brackets, so only a bracket-free one is a plain miss
        if (text === undefined || (text[skipSpace(text, 0)] === '"' && /[[{]/.test(text))) {
            throw new ErrUnsupportedByPort(
                "OP_INSPECTINTENTMESSAGE: only strict JSON with unique keys is ported",
            );
        }
        const raw = lookup(text, path);
        if (raw === undefined || raw[0] === "n") return pushIntentMiss(vm);
        const utf8 = new TextEncoder();
        switch (raw[0]) {
            case '"':
                return pushIntentBytes(vm, utf8.encode(unescape(raw.slice(1, -1))));
            case "{":
            case "[":
                return pushIntentBytes(vm, utf8.encode(raw));
            case "t":
                return pushIntentBytes(vm, Uint8Array.of(1));
            case "f":
                return pushIntentBytes(vm, new Uint8Array(0));
        }
        const n = parseJSONInteger(raw);
        if (n === undefined) return pushIntentMiss(vm);
        vm.dstack.pushBigNum(new BigNum(n, true));
        vm.dstack.pushBool(true);
    },
};
