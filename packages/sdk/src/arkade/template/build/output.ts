import { hex } from "@scure/base";

import { Estimator } from "../../../arkfee";
import type { FeeAmount } from "../../../arkfee/types";
import { ErrUnsupportedByPort, ScriptTokenizer } from "../../vm";
import { parseXOnlyPubKey } from "../../vm/closures";
import { parseScriptNum } from "../asm";
import { type AssetRoute, type ByteTemplate, sinks, within } from "../compile";
import { Failure, fail, isKind } from "../errors";
import type { Fee } from "./build";
import { type Draft, messageOf, pkScriptOf, type Src } from "./draft";
import type { Instance } from "./instance";

/** Per output: sats; per output then burn: hex asset id to amount; per issue, per output: units. */
export interface Allocation {
    sats: bigint[];
    assets: Map<string, bigint>[];
    minted: bigint[][];
    fee: bigint;
}

const MAX_AMOUNT = 2_100_000_000_000_000n;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_FEE_ROUNDS = 32;
const q = JSON.stringify;
const unaffordable = (message: string) => new Failure(["ineligible", "unaffordable"], message);

/** Balances every input apart; the fee comes out of fees.from and dust is the least output. */
export function allocate(
    i: Instance,
    d: Draft,
    sources: readonly Src[],
    fee: bigint,
    dust: bigint,
): Allocation {
    const t = i.tmpl;
    const cap = i.feeCap();
    if (fee > 0n && !t.fee) throw unaffordable(`the template pays no fee, asked ${fee}`);
    if (t.fee && fee > cap) throw unaffordable(`fee ${fee} exceeds the cap ${cap}`);
    if (sources.length !== t.inputs.length) {
        throw fail("ineligible", `${sources.length} sources for ${t.inputs.length} inputs`);
    }
    const a: Allocation = {
        sats: t.outputs.map(() => 0n),
        assets: [...t.outputs, ...t.burns].map(() => new Map()),
        minted: [],
        fee,
    };
    for (const coins of t.groups) {
        const name = q(t.inputs[coins[0]].name);
        let pool = 0n;
        const pooled = new Map<string, bigint>();
        for (const c of coins) {
            const s = sources[c];
            if (s.amount > MAX_AMOUNT) {
                throw fail("ineligible", `input ${name} holds more than 21e14 satoshis`);
            }
            const held = new Map<string, bigint>();
            for (const as of s.assets) {
                if (as.id.length !== 34) {
                    throw fail(
                        "ineligible",
                        `input ${name} holds an asset id of ${as.id.length} bytes`,
                    );
                }
                within(`input ${name}`, () => credit(held, hex.encode(as.id), as.amount));
            }
            // the copies of an each output take from their own coin first
            pool += routeSats(i, d, c, s.amount, true, a);
            routeAssets(i, d, c, held, a, true);
            for (const [key, n] of held) within(`input ${name}`, () => credit(pooled, key, n));
        }
        routeSats(i, d, coins[0], pool, false, a);
        routeAssets(i, d, coins[0], pooled, a, false);
        for (const [key, n] of pooled) {
            if (n > 0n) {
                throw fail("ineligible", `input ${name} has ${n} of asset ${key} without a route`);
            }
        }
    }
    mint(i, d, a);
    t.outputs.forEach((o, k) => {
        if (a.sats[k] < dust) {
            throw unaffordable(`output ${q(o.name)} holds ${a.sats[k]}, minimum ${dust}`);
        }
    });
    return a;
}

/** Serves the draws on slot of the copies of each outputs, or of the others and the fee. */
function routeSats(
    i: Instance,
    d: Draft,
    slot: number,
    amount: bigint,
    copies: boolean,
    a: Allocation,
): bigint {
    const t = i.tmpl;
    let left = amount;
    const mine = (coin: number, from: number) => from === slot && coin >= 0 === copies;
    t.outputs.forEach((o, k) => {
        for (const dr of o.draws) {
            if (!mine(o.coin, dr.from) || dr.amount === undefined) continue;
            const amount = dr.amount;
            const n = within(`output ${q(o.name)}`, () => fixedAmount(i, amount, d, o.from));
            if (n > left)
                throw fail("ineligible", `output ${q(o.name)} draws ${n} of ${left} left`);
            left -= n;
            a.sats[k] += n;
        }
    });
    if (!copies && t.fee && t.fee.from === slot) {
        if (a.fee > left) {
            throw new Failure(
                ["ineligible", "unaffordable"],
                `input ${q(t.inputs[slot].name)} cannot pay fee ${a.fee}`,
            );
        }
        left -= a.fee;
    }
    t.outputs.forEach((o, k) => {
        for (const dr of o.draws) {
            if (mine(o.coin, dr.from) && dr.amount === undefined) {
                a.sats[k] += left;
                left = 0n;
            }
        }
    });
    return left;
}

const routePass = (r: AssetRoute) => (r.amount !== undefined ? 0 : r.asset !== undefined ? 1 : 2);

/** Fixed amounts, then named remainders, then the catch-all; what stays in held has no route. */
function routeAssets(
    i: Instance,
    d: Draft,
    slot: number,
    held: Map<string, bigint>,
    a: Allocation,
    copies: boolean,
): void {
    const named = new Set<string>();
    const all = sinks(i.tmpl);
    const name = q(i.tmpl.inputs[slot].name);
    for (let pass = 0; pass < 3; pass++) {
        all.forEach((o, k) => {
            for (const r of o.routes) {
                if (r.from !== slot || o.copy !== copies || pass !== routePass(r)) continue;
                const asset = r.asset;
                const key =
                    asset === undefined
                        ? ""
                        : hex.encode(
                              within(`${o.name} asset`, () => i.decoded(asset, "asset", d, o.ctx)),
                          );
                if (pass === 0) {
                    const amount = r.amount as ByteTemplate;
                    const n = within(`${o.name} asset ${key}`, () =>
                        fixedAmount(i, amount, d, o.ctx),
                    );
                    const h = held.get(key) ?? 0n;
                    if (n > h) {
                        throw fail(
                            "ineligible",
                            `${o.name} draws ${n} of asset ${key}, input ${name} holds ${h}`,
                        );
                    }
                    held.set(key, h - n);
                    within(o.name, () => credit(a.assets[k], key, n));
                } else if (pass === 1) {
                    if (named.has(key)) {
                        throw fail(
                            "ineligible",
                            `input ${name} has two remainder routes for asset ${key}`,
                        );
                    }
                    named.add(key);
                    within(o.name, () => credit(a.assets[k], key, held.get(key) ?? 0n));
                    held.delete(key);
                } else {
                    try {
                        within(o.name, () => {
                            for (const [id, n] of held) credit(a.assets[k], id, n);
                        });
                    } finally {
                        held.clear();
                    }
                }
            }
        });
    }
}

/** More of an existing asset joins that asset; a new one is counted apart, its id the tx's. */
function mint(i: Instance, d: Draft, a: Allocation): void {
    const t = i.tmpl;
    a.minted = t.issues.map(() => t.outputs.map(() => 0n));
    t.outputs.forEach((o, k) => {
        for (const r of o.assets) {
            if (r.issue < 0) continue;
            const is = t.issues[r.issue];
            const amount = r.amount as ByteTemplate;
            const n = within(`output ${q(o.name)} issue ${q(is.name)}`, () =>
                fixedAmount(i, amount, d, o.from),
            );
            const asset = is.asset;
            if (asset === undefined) {
                const sum = a.minted[r.issue][k] + n;
                if (sum > MAX_UINT64) throw fail("ineligible", `issue ${q(is.name)} overflows`);
                a.minted[r.issue][k] = sum;
                continue;
            }
            const id = within(`issue ${q(is.name)} asset`, () =>
                i.decoded(asset, "asset", d, o.from),
            );
            within(`output ${q(o.name)}`, () => credit(a.assets[k], hex.encode(id), n));
        }
    });
}

function credit(m: Map<string, bigint>, key: string, n: bigint): void {
    if (n === 0n) return;
    const sum = (m.get(key) ?? 0n) + n;
    if (sum > MAX_UINT64) throw fail("ineligible", `asset ${key} overflows`);
    m.set(key, sum);
}

function fixedAmount(i: Instance, b: ByteTemplate, d: Draft, slot: number): bigint {
    let raw: Uint8Array;
    try {
        raw = i.resolve(b, d, d.index(slot));
    } catch (e) {
        if (e instanceof ErrUnsupportedByPort || isKind(e, "ineligible")) throw e;
        const kinds = e instanceof Failure ? e.kinds : [];
        throw new Failure(["ineligible", ...kinds], messageOf(e));
    }
    let n = 0;
    try {
        n = parseScriptNum(raw);
    } catch {
        n = 0;
    }
    if (n < 1) {
        throw fail("ineligible", `amount of ${raw.length} bytes is not a positive number`);
    }
    return BigInt(n);
}

export function outputScripts(i: Instance, d: Draft, sources: readonly Src[]): Uint8Array[] {
    return i.tmpl.outputs.map((o) =>
        within(`output ${q(o.name)}`, () => {
            const l = o.locking;
            if (l.from >= 0) return pkScriptOf(sources[l.from]).slice();
            if (l.contract) return i.contractOf(l.contract, d, o.from, false).script.pkScript;
            const s = i.resolve(l.script as ByteTemplate, d, d.index(o.from));
            checkScript(s, o.onchain);
            return s;
        }),
    );
}

/** P2TR off chain, and a script that parses on chain. */
function checkScript(s: Uint8Array, onchain: boolean): void {
    if (!onchain) {
        if (s.length !== 34 || s[0] !== 0x51 || s[1] !== 0x20) {
            throw fail(
                "ineligible",
                `an offchain output needs a P2TR script, got ${s.length} bytes`,
            );
        }
        try {
            parseXOnlyPubKey(s.subarray(2));
        } catch {
            throw fail("ineligible", "an offchain output needs a valid taproot key");
        }
        return;
    }
    const t = new ScriptTokenizer(s);
    while (t.next());
    if (s.length === 0 || t.err) throw fail("ineligible", `malformed script of ${s.length} bytes`);
}

/** The Ark server charges inputs, plus outputs at the amounts they receive once it is paid. */
export function intentFee(
    i: Instance,
    d: Draft,
    sources: readonly Src[],
    scripts: readonly Uint8Array[],
    fee: Fee,
): bigint {
    let est: Estimator;
    try {
        est = new Estimator(fee.intent ?? {});
    } catch (e) {
        throw new Error(`intent fee programs: ${messageOf(e)}`); // no sentinel: codes "internal"
    }
    const t = i.tmpl;
    const date = (s?: number) => (s === undefined ? undefined : new Date(s * 1000));
    let inputs = 0n;
    sources.forEach((s, slot) => {
        const input = t.inputs[slot];
        inputs = within(`input ${q(input.name)}`, () =>
            addFee(inputs, () =>
                input.onchain
                    ? est.evalOnchainInput({ amount: s.amount })
                    : est.evalOffchainInput({
                          amount: s.amount,
                          expiry: date(s.expiry),
                          birth: date(s.createdAt),
                          type: s.swept ? "recoverable" : "vtxo",
                          weight: 0,
                      }),
            ),
        );
    });
    let charged = inputs;
    for (let round = 0; round < MAX_FEE_ROUNDS; round++) {
        const a = allocate(i, d, sources, charged, fee.dust);
        let next = inputs;
        t.outputs.forEach((o, k) => {
            const out = { amount: a.sats[k], script: hex.encode(scripts[k]) };
            next = within(`output ${q(o.name)}`, () =>
                addFee(next, () =>
                    o.onchain ? est.evalOnchainOutput(out) : est.evalOffchainOutput(out),
                ),
            );
        });
        if (next === charged) return charged;
        charged = next;
    }
    throw fail("ineligible", "the intent fee does not converge");
}

/** Each term rounds up to whole satoshis before it is summed. */
function addFee(sum: bigint, evaluate: () => FeeAmount): bigint {
    let v: number;
    try {
        v = evaluate().value;
    } catch (e) {
        throw fail("ineligible", `fee program: ${messageOf(e)}`);
    }
    // FeeAmount has none of Go's guards against NaN, a negative or an infinite fee
    if (Number.isNaN(v) || v < 0 || v > 21e14) throw fail("ineligible", `fee ${v} out of range`);
    return sum + BigInt(Math.ceil(v));
}
