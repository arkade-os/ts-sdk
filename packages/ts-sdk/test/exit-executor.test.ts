import { describe, expect, it } from "vitest";
import { Executor, ExecutorEvent } from "../src/wallet/exit/executor";
import { ExitPackage, ExitStep } from "../src/wallet/exit/types";

// The executor must never parse hex — fixtures use opaque tokens as "hex"
// and the scripted provider maps token -> txid.

function scriptedProvider(opts?: { rejectTxids?: Set<string> }) {
    const state = new Map<
        string,
        { confirmed: boolean; blockHeight?: number; blockTime?: number }
    >();
    const hexToTxid = new Map<string, string>();
    const broadcasts: string[][] = [];
    const tip = { height: 100, time: 60_000 };

    return {
        broadcasts,
        tip,
        register(hex: string, txid: string) {
            hexToTxid.set(hex, txid);
        },
        confirm(txid: string, blockHeight = tip.height) {
            state.set(txid, { confirmed: true, blockHeight, blockTime: blockHeight * 600 });
        },
        provider: {
            async getTxStatus(txid: string) {
                const s = state.get(txid);
                if (!s) throw new Error("not found");
                return s;
            },
            async getChainTip() {
                return { ...tip };
            },
            async broadcastTransaction(...txs: string[]) {
                broadcasts.push(txs);
                const txid = hexToTxid.get(txs[0]);
                if (!txid) throw new Error(`unknown hex token: ${txs[0]}`);
                if (opts?.rejectTxids?.has(txid)) throw new Error("rejected by mempool");
                state.set(txid, { confirmed: false });
                return txid;
            },
        } as never,
    };
}

function pkgOf(steps: ExitStep[], validUntil?: number): ExitPackage {
    return {
        version: 1,
        network: "regtest",
        createdAt: 1,
        validUntil,
        feeRate: 2,
        sweepAddress: "bcrt1unused",
        totals: { txCount: 0, totalFeeSats: 0, fundingRequiredSats: 0, recoveredSats: 0 },
        vtxos: [],
        steps,
    };
}

const P1 = "p1".repeat(16);
const C1 = "c1".repeat(16);
const P2 = "p2".repeat(16);
const C2 = "c2".repeat(16);
const SW1 = "51".repeat(32);
const SW2 = "52".repeat(32);

async function run(
    executor: Executor,
    drive: (e: ExecutorEvent, script: ReturnType<typeof scriptedProvider>) => void,
    script: ReturnType<typeof scriptedProvider>,
): Promise<ExecutorEvent[]> {
    const events: ExecutorEvent[] = [];
    for await (const event of executor) {
        events.push(event);
        drive(event, script);
    }
    return events;
}

describe("Executor", () => {
    it("drives package + sweep to completion, relaying hex verbatim", async () => {
        const script = scriptedProvider();
        script.register("parent1-hex", P1);
        script.register("sweep1-hex", SW1);
        const pkg = pkgOf([
            {
                kind: "package",
                parentTxid: P1,
                parentHex: "parent1-hex",
                childTxid: C1,
                childHex: "child1-hex",
                forVtxos: [`${P1}:0`],
            },
            {
                kind: "sweep",
                vtxo: `${P1}:0`,
                txid: SW1,
                hex: "sweep1-hex",
                dependsOnTxid: P1,
                delay: { type: "blocks", value: 10 },
            },
        ]);

        const executor = new Executor(pkg, script.provider, { pollIntervalMs: 1 });
        const events = await run(
            executor,
            (e, s) => {
                if (e.status === "broadcast" && e.txid) s.confirm(e.txid);
                if (e.status === "waiting_csv") s.tip.height = e.maturesAtHeight!;
            },
            script,
        );

        expect(events.map((e) => `${e.kind}:${e.status}`)).toEqual([
            "package:broadcast",
            "package:confirmed",
            "sweep:waiting_csv",
            "sweep:broadcast",
            "sweep:confirmed",
        ]);
        // 1P1C relayed as TWO args, hex verbatim
        expect(script.broadcasts[0]).toEqual(["parent1-hex", "child1-hex"]);
        expect(script.broadcasts[1]).toEqual(["sweep1-hex"]);
        // waiting event carries the absolute maturity height
        const waiting = events.find((e) => e.status === "waiting_csv")!;
        expect(waiting.maturesAtHeight).toBe(100 + 10);
    });

    it("graph mode: builds the CPFP child from the fee wallet, relays 1P1C", async () => {
        const script = scriptedProvider();
        script.register("parent1-hex", P1);
        script.register("bumpchild1-hex", C1);
        script.register("sweep1-hex", SW1);

        // Fee wallet builds+signs the child on demand and returns the package
        // hexes WITHOUT broadcasting — the executor owns broadcast.
        const feeCalls: [string, number][] = [];
        const feeWallet = {
            async bumpAnchor(parentHex: string, feeRate: number) {
                feeCalls.push([parentHex, feeRate]);
                return ["parent1-hex", "bumpchild1-hex"] as [string, string];
            },
        };

        const pkg: ExitPackage = {
            ...pkgOf([
                { kind: "bump", parentTxid: P1, parentHex: "parent1-hex", forVtxos: [`${P1}:0`] },
                {
                    kind: "sweep",
                    vtxo: `${P1}:0`,
                    txid: SW1,
                    hex: "sweep1-hex",
                    dependsOnTxid: P1,
                    delay: { type: "blocks", value: 10 },
                },
            ]),
            mode: "graph",
        };

        const executor = new Executor(pkg, script.provider, { pollIntervalMs: 1, feeWallet });
        const events = await run(
            executor,
            (e, s) => {
                if (e.status === "broadcast" && e.txid) s.confirm(e.txid);
                if (e.status === "waiting_csv") s.tip.height = e.maturesAtHeight!;
            },
            script,
        );

        expect(events.map((e) => `${e.kind}:${e.status}`)).toEqual([
            "bump:broadcast",
            "bump:confirmed",
            "sweep:waiting_csv",
            "sweep:broadcast",
            "sweep:confirmed",
        ]);
        // fee wallet was asked to bump the parent at the package fee rate
        expect(feeCalls).toEqual([["parent1-hex", 2]]);
        // executor broadcast the freshly built 1P1C package verbatim
        expect(script.broadcasts[0]).toEqual(["parent1-hex", "bumpchild1-hex"]);
    });

    it("graph mode: fails a bump step when no fee wallet is provided", async () => {
        const script = scriptedProvider();
        script.register("parent1-hex", P1);
        const pkg: ExitPackage = {
            ...pkgOf([
                { kind: "bump", parentTxid: P1, parentHex: "parent1-hex", forVtxos: [`${P1}:0`] },
            ]),
            mode: "graph",
        };
        const events = await run(
            new Executor(pkg, script.provider, { pollIntervalMs: 1 }),
            () => {},
            script,
        );
        expect(events).toHaveLength(1);
        expect(events[0].status).toBe("failed");
        expect(events[0].reason).toMatch(/fee wallet/i);
        expect(script.broadcasts).toHaveLength(0);
    });

    it("skips steps whose parent is already confirmed", async () => {
        const script = scriptedProvider();
        script.confirm(P1);
        const pkg = pkgOf([
            {
                kind: "package",
                parentTxid: P1,
                parentHex: "parent1-hex",
                childTxid: C1,
                childHex: "child1-hex",
                forVtxos: [`${P1}:0`],
            },
        ]);
        const events = await run(
            new Executor(pkg, script.provider, { pollIntervalMs: 1 }),
            () => {},
            script,
        );
        expect(events.map((e) => e.status)).toEqual(["skipped"]);
        expect(script.broadcasts).toHaveLength(0);
    });

    it("isolates failures to the affected vtxo's branch", async () => {
        const script = scriptedProvider({ rejectTxids: new Set([P1]) });
        script.register("parent1-hex", P1);
        script.register("parent2-hex", P2);
        script.register("sweep2-hex", SW2);
        const pkg = pkgOf([
            {
                kind: "package",
                parentTxid: P1,
                parentHex: "parent1-hex",
                childTxid: C1,
                childHex: "child1-hex",
                forVtxos: ["vtxoA:0"],
            },
            {
                kind: "package",
                parentTxid: P2,
                parentHex: "parent2-hex",
                childTxid: C2,
                childHex: "child2-hex",
                forVtxos: ["vtxoB:0"],
            },
            {
                kind: "sweep",
                vtxo: "vtxoA:0",
                txid: SW1,
                hex: "sweep1-hex",
                dependsOnTxid: P1,
                delay: { type: "blocks", value: 0 },
            },
            {
                kind: "sweep",
                vtxo: "vtxoB:0",
                txid: SW2,
                hex: "sweep2-hex",
                dependsOnTxid: P2,
                delay: { type: "blocks", value: 0 },
            },
        ]);

        const events = await run(
            new Executor(pkg, script.provider, { pollIntervalMs: 1 }),
            (e, s) => {
                if (e.status === "broadcast" && e.txid) s.confirm(e.txid);
            },
            script,
        );

        const byStep = events.map((e) => `${e.stepIndex}:${e.status}`);
        expect(byStep).toContain("0:failed"); // vtxoA package rejected
        expect(byStep).toContain("1:broadcast"); // vtxoB proceeds
        expect(byStep).toContain("1:confirmed");
        expect(byStep).toContain("2:failed"); // vtxoA sweep dead
        expect(byStep).toContain("3:confirmed"); // vtxoB sweep completes
        const deadSweep = events.find((e) => e.stepIndex === 2 && e.status === "failed")!;
        expect(deadSweep.reason).toMatch(/branch failed earlier/);
    });

    it("warns when validUntil has passed but still executes", async () => {
        const script = scriptedProvider();
        script.confirm(P1);
        const pkg = pkgOf(
            [
                {
                    kind: "package",
                    parentTxid: P1,
                    parentHex: "parent1-hex",
                    childTxid: C1,
                    childHex: "child1-hex",
                    forVtxos: [`${P1}:0`],
                },
            ],
            1, // far in the past
        );
        const events = await run(
            new Executor(pkg, script.provider, { pollIntervalMs: 1 }),
            () => {},
            script,
        );
        expect(events[0].status).toBe("warning");
        expect(events[0].reason).toMatch(/validUntil/);
        expect(events.map((e) => e.status)).toEqual(["warning", "skipped"]);
    });

    it("retries a sweep rejected as non-BIP68-final instead of failing it", async () => {
        const script = scriptedProvider();
        script.register("sweep1-hex", SW1);
        script.confirm(P1, 80); // matured by height math already
        script.tip.height = 200;

        // first broadcast attempt: consensus says not final yet
        let rejectedOnce = false;
        const provider = {
            ...script.provider,
            async broadcastTransaction(...txs: string[]) {
                if (!rejectedOnce) {
                    rejectedOnce = true;
                    throw new Error("sendrawtransaction RPC error: non-BIP68-final");
                }
                return (script.provider as never as typeof script.provider).broadcastTransaction(
                    ...txs,
                );
            },
        } as never;

        const pkg = pkgOf([
            {
                kind: "sweep",
                vtxo: `${P1}:0`,
                txid: SW1,
                hex: "sweep1-hex",
                dependsOnTxid: P1,
                delay: { type: "blocks", value: 10 },
            },
        ]);

        const events = await run(
            new Executor(pkg, provider, { pollIntervalMs: 1 }),
            (e, s) => {
                if (e.status === "broadcast" && e.txid) s.confirm(e.txid);
            },
            script,
        );

        // no "failed" event: the rejection was transient and retried
        expect(events.map((e) => e.status)).toEqual(["broadcast", "confirmed"]);
        expect(rejectedOnce).toBe(true);
    });

    it("matures time-based delays via blockTime, not height", async () => {
        const script = scriptedProvider();
        script.register("sweep1-hex", SW1);
        script.confirm(P1, 100); // blockTime = 60_000
        const pkg = pkgOf([
            {
                kind: "sweep",
                vtxo: `${P1}:0`,
                txid: SW1,
                hex: "sweep1-hex",
                dependsOnTxid: P1,
                delay: { type: "seconds", value: 512 },
            },
        ]);

        const events = await run(
            new Executor(pkg, script.provider, { pollIntervalMs: 1 }),
            (e, s) => {
                if (e.status === "waiting_csv") s.tip.time = e.maturesAtTime!;
                if (e.status === "broadcast" && e.txid) s.confirm(e.txid);
            },
            script,
        );

        expect(events.map((e) => e.status)).toEqual(["waiting_csv", "broadcast", "confirmed"]);
        expect(events[0].maturesAtTime).toBe(60_000 + 512);
    });
});

describe("Executor cancellation", () => {
    /** A package whose single step never confirms, so the executor parks in
     * waitConfirmed — the loop that `iterator.return()` cannot interrupt. */
    function neverConfirmingPkg() {
        const script = scriptedProvider();
        script.register("parent1-hex", P1);
        const pkg = pkgOf([
            {
                kind: "package",
                parentTxid: P1,
                parentHex: "parent1-hex",
                childTxid: C1,
                childHex: "child1-hex",
                forVtxos: [`${P1}:0`],
            },
        ]);
        return { script, pkg };
    }

    it("rejects with AbortError when aborted while waiting for confirmation", async () => {
        const { script, pkg } = neverConfirmingPkg();
        const ac = new AbortController();
        const executor = new Executor(pkg, script.provider, {
            pollIntervalMs: 5,
            signal: ac.signal,
        });

        const events: ExecutorEvent[] = [];
        const consumed = (async () => {
            for await (const e of executor) events.push(e);
        })();

        // Let it broadcast and enter waitConfirmed, then stop it.
        await new Promise((r) => setTimeout(r, 30));
        ac.abort();

        await expect(consumed).rejects.toMatchObject({ name: "AbortError" });
        // It broadcast once and never progressed past the un-confirming step.
        expect(script.broadcasts).toHaveLength(1);
        expect(events.map((e) => e.status)).toEqual(["broadcast"]);
    });

    it("throws before broadcasting anything when the signal is already aborted", async () => {
        const { script, pkg } = neverConfirmingPkg();
        const ac = new AbortController();
        ac.abort();
        const executor = new Executor(pkg, script.provider, {
            pollIntervalMs: 5,
            signal: ac.signal,
        });

        await expect(
            (async () => {
                for await (const _ of executor) void _;
            })(),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(script.broadcasts).toEqual([]);
    });

    it("rejects when aborted during the sweep wait loop, broadcasting no sweep", async () => {
        const script = scriptedProvider();
        script.register("parent1-hex", P1);
        script.register("sweep1-hex", SW1);
        const pkg = pkgOf([
            {
                kind: "package",
                parentTxid: P1,
                parentHex: "parent1-hex",
                childTxid: C1,
                childHex: "child1-hex",
                forVtxos: [`${P1}:0`],
            },
            {
                kind: "sweep",
                vtxo: `${P1}:0`,
                txid: SW1,
                hex: "sweep1-hex",
                dependsOnTxid: P1,
                // Far in the future, so the sweep never matures on its own.
                delay: { type: "blocks", value: 10_000 },
            },
        ]);

        const ac = new AbortController();
        const executor = new Executor(pkg, script.provider, {
            pollIntervalMs: 5,
            signal: ac.signal,
        });

        const consumed = (async () => {
            for await (const e of executor) {
                if (e.status === "broadcast" && e.txid) script.confirm(e.txid);
            }
        })();

        await new Promise((r) => setTimeout(r, 40));
        ac.abort();

        await expect(consumed).rejects.toMatchObject({ name: "AbortError" });
        // Only the package was broadcast; the sweep never went out.
        expect(script.broadcasts).toEqual([["parent1-hex", "child1-hex"]]);
    });

    // The whole point of making sleep() abortable rather than only checking
    // `aborted` between polls: abort latency must track the signal, not the
    // poll interval.
    //
    // This one needs the real clock. Fake timers would let the 10s interval
    // elapse instantly, so the assertion would hold even for an implementation
    // that merely checks `aborted` between polls — exactly the version this
    // test exists to rule out. The 10s-vs-1s margin is the flake budget.
    it("aborts promptly rather than waiting out the poll interval", async () => {
        const { script, pkg } = neverConfirmingPkg();
        const ac = new AbortController();
        const executor = new Executor(pkg, script.provider, {
            pollIntervalMs: 10_000,
            signal: ac.signal,
        });

        const consumed = (async () => {
            for await (const _ of executor) void _;
        })();

        await new Promise((r) => setTimeout(r, 20));
        const started = Date.now();
        ac.abort();
        await expect(consumed).rejects.toMatchObject({ name: "AbortError" });
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it("removes every abort listener it registers", async () => {
        const { script, pkg } = neverConfirmingPkg();
        const ac = new AbortController();
        let added = 0;
        let removed = 0;
        // Wrap the real signal so listener bookkeeping stays honest while abort
        // still works for real.
        const signal = new Proxy(ac.signal, {
            get(target, prop) {
                if (prop === "addEventListener") {
                    return (...args: Parameters<AbortSignal["addEventListener"]>) => {
                        added++;
                        return target.addEventListener(...args);
                    };
                }
                if (prop === "removeEventListener") {
                    return (...args: Parameters<AbortSignal["removeEventListener"]>) => {
                        removed++;
                        return target.removeEventListener(...args);
                    };
                }
                const v = Reflect.get(target, prop, target);
                return typeof v === "function" ? v.bind(target) : v;
            },
        });

        const executor = new Executor(pkg, script.provider, { pollIntervalMs: 5, signal });
        const consumed = (async () => {
            for await (const _ of executor) void _;
        })();

        // Long enough for many sleep cycles to complete via timeout.
        await new Promise((r) => setTimeout(r, 60));
        ac.abort();
        await expect(consumed).rejects.toMatchObject({ name: "AbortError" });

        expect(added).toBeGreaterThan(1);
        // Not `=== 0`: every sleep that ends by timing out calls
        // removeEventListener explicitly, but the final sleep is the one that
        // gets aborted, and its `{ once: true }` listener is dropped internally
        // by the event target — that removal does not go through the proxied
        // removeEventListener. So exactly one registration is unaccounted for,
        // and a slack larger than 1 would mean a genuine leak.
        expect(added - removed).toBeLessThanOrEqual(1);
    });

    it("behaves exactly as before when no signal is passed", async () => {
        const script = scriptedProvider();
        script.register("parent1-hex", P1);
        script.register("sweep1-hex", SW1);
        const pkg = pkgOf([
            {
                kind: "package",
                parentTxid: P1,
                parentHex: "parent1-hex",
                childTxid: C1,
                childHex: "child1-hex",
                forVtxos: [`${P1}:0`],
            },
            {
                kind: "sweep",
                vtxo: `${P1}:0`,
                txid: SW1,
                hex: "sweep1-hex",
                dependsOnTxid: P1,
                delay: { type: "blocks", value: 10 },
            },
        ]);

        const executor = new Executor(pkg, script.provider, { pollIntervalMs: 1 });
        const events = await run(
            executor,
            (e, s) => {
                if (e.status === "broadcast" && e.txid) s.confirm(e.txid);
                if (e.status === "waiting_csv") s.tip.height = e.maturesAtHeight!;
            },
            script,
        );

        expect(events.map((e) => `${e.kind}:${e.status}`)).toEqual([
            "package:broadcast",
            "package:confirmed",
            "sweep:waiting_csv",
            "sweep:broadcast",
            "sweep:confirmed",
        ]);
    });
});

describe("Executor exit observation", () => {
    type Observed = { txid: string; vout: number };

    // `seenAt` records `<step>:<status>=<observations so far>`: the hook fires BEFORE the
    // matching yield, so the count read at an event includes that event's own observation.

    it("observes a vtxo when its branch confirms, and again when its sweep confirms", async () => {
        const script = scriptedProvider();
        script.register("parent1-hex", P1);
        script.register("sweep1-hex", SW1);
        const observed: Observed[] = [];
        const seenAt: string[] = [];
        const pkg = pkgOf([
            {
                kind: "package",
                parentTxid: P1,
                parentHex: "parent1-hex",
                childTxid: C1,
                childHex: "child1-hex",
                forVtxos: [`${P1}:0`],
            },
            {
                kind: "sweep",
                vtxo: `${P1}:0`,
                txid: SW1,
                hex: "sweep1-hex",
                dependsOnTxid: P1,
                delay: { type: "blocks", value: 10 },
            },
        ]);

        await run(
            new Executor(pkg, script.provider, {
                pollIntervalMs: 1,
                onExitObserved: (o) => void observed.push({ ...o }),
            }),
            (e, s) => {
                seenAt.push(`${e.kind}:${e.status}=${observed.length}`);
                if (e.status === "broadcast" && e.txid) s.confirm(e.txid);
                if (e.status === "waiting_csv") s.tip.height = e.maturesAtHeight!;
            },
            script,
        );

        expect(seenAt).toEqual([
            "package:broadcast=0",
            "package:confirmed=1",
            "sweep:waiting_csv=1",
            "sweep:broadcast=1",
            "sweep:confirmed=2",
        ]);
        // The outpoint is parsed out of `"txid:vout"`, both halves.
        expect(observed).toEqual([
            { txid: P1, vout: 0 },
            { txid: P1, vout: 0 },
        ]);
    });

    it("observes a multi-step branch only once, after its last step confirms", async () => {
        const script = scriptedProvider();
        script.register("parent1-hex", P1);
        script.register("parent2-hex", P2);
        const observed: Observed[] = [];
        const seenAt: string[] = [];
        const pkg = pkgOf([
            {
                kind: "package",
                parentTxid: P1,
                parentHex: "parent1-hex",
                childTxid: C1,
                childHex: "child1-hex",
                forVtxos: ["vtxoA:0"],
            },
            {
                kind: "package",
                parentTxid: P2,
                parentHex: "parent2-hex",
                childTxid: C2,
                childHex: "child2-hex",
                forVtxos: ["vtxoA:0"],
            },
        ]);

        await run(
            new Executor(pkg, script.provider, {
                pollIntervalMs: 1,
                onExitObserved: (o) => void observed.push({ ...o }),
            }),
            (e, s) => {
                seenAt.push(`${e.stepIndex}:${e.status}=${observed.length}`);
                if (e.status === "broadcast" && e.txid) s.confirm(e.txid);
            },
            script,
        );

        expect(seenAt).toEqual([
            "0:broadcast=0",
            "0:confirmed=0", // one of two steps onchain: the branch is not exited yet
            "1:broadcast=0",
            "1:confirmed=1",
        ]);
        expect(observed).toEqual([{ txid: "vtxoA", vout: 0 }]);
    });

    it("counts a step skipped as already-confirmed toward its branch", async () => {
        const script = scriptedProvider();
        script.confirm(P1);
        script.register("parent2-hex", P2);
        const observed: Observed[] = [];
        const seenAt: string[] = [];
        const pkg = pkgOf([
            {
                kind: "package",
                parentTxid: P1,
                parentHex: "parent1-hex",
                childTxid: C1,
                childHex: "child1-hex",
                forVtxos: ["vtxoA:0"],
            },
            {
                kind: "package",
                parentTxid: P2,
                parentHex: "parent2-hex",
                childTxid: C2,
                childHex: "child2-hex",
                forVtxos: ["vtxoA:0"],
            },
        ]);

        await run(
            new Executor(pkg, script.provider, {
                pollIntervalMs: 1,
                onExitObserved: (o) => void observed.push({ ...o }),
            }),
            (e, s) => {
                seenAt.push(`${e.stepIndex}:${e.status}=${observed.length}`);
                if (e.status === "broadcast" && e.txid) s.confirm(e.txid);
            },
            script,
        );

        // Step 0 never broadcasts, yet the branch still completes on step 1.
        expect(seenAt).toEqual(["0:skipped=0", "1:broadcast=0", "1:confirmed=1"]);
        expect(observed).toEqual([{ txid: "vtxoA", vout: 0 }]);
    });

    it("observes nothing for a vtxo whose branch failed", async () => {
        const script = scriptedProvider({ rejectTxids: new Set([P1]) });
        script.register("parent1-hex", P1);
        script.register("parent2-hex", P2);
        script.register("sweep2-hex", SW2);
        const observed: Observed[] = [];
        const pkg = pkgOf([
            {
                kind: "package",
                parentTxid: P1,
                parentHex: "parent1-hex",
                childTxid: C1,
                childHex: "child1-hex",
                forVtxos: ["vtxoA:0"],
            },
            {
                kind: "package",
                parentTxid: P2,
                parentHex: "parent2-hex",
                childTxid: C2,
                childHex: "child2-hex",
                forVtxos: ["vtxoB:0"],
            },
            {
                kind: "sweep",
                vtxo: "vtxoA:0",
                txid: SW1,
                hex: "sweep1-hex",
                dependsOnTxid: P1,
                delay: { type: "blocks", value: 0 },
            },
            {
                kind: "sweep",
                vtxo: "vtxoB:0",
                txid: SW2,
                hex: "sweep2-hex",
                dependsOnTxid: P2,
                delay: { type: "blocks", value: 0 },
            },
        ]);

        await run(
            new Executor(pkg, script.provider, {
                pollIntervalMs: 1,
                onExitObserved: (o) => void observed.push({ ...o }),
            }),
            (e, s) => {
                if (e.status === "broadcast" && e.txid) s.confirm(e.txid);
            },
            script,
        );

        expect(observed).toEqual([
            { txid: "vtxoB", vout: 0 },
            { txid: "vtxoB", vout: 0 },
        ]);
    });

    it("does not let a rejecting hook break the exit", async () => {
        const errors: unknown[] = [];
        const realError = console.error;
        console.error = (...args: unknown[]) => void errors.push(args);
        const script = scriptedProvider();
        script.register("parent1-hex", P1);
        try {
            const pkg = pkgOf([
                {
                    kind: "package",
                    parentTxid: P1,
                    parentHex: "parent1-hex",
                    childTxid: C1,
                    childHex: "child1-hex",
                    forVtxos: [`${P1}:0`],
                },
            ]);
            const events = await run(
                new Executor(pkg, script.provider, {
                    pollIntervalMs: 1,
                    onExitObserved: async () => {
                        throw new Error("repository is gone");
                    },
                }),
                (e, s) => {
                    if (e.status === "broadcast" && e.txid) s.confirm(e.txid);
                },
                script,
            );
            expect(events.map((e) => e.status)).toEqual(["broadcast", "confirmed"]);
        } finally {
            console.error = realError;
        }
        expect(errors).toHaveLength(1);
    });
});
