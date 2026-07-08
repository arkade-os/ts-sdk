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
