import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { ArkAddress } from "../src";
import { IndexedDBWalletRepository } from "../src/repositories/indexedDB/walletRepository";
import { openDatabase, closeDatabase } from "../src/repositories/indexedDB/manager";
import {
    initDatabase,
    STORE_VTXOS,
    DB_VERSION,
    unspentFlag,
} from "../src/repositories/indexedDB/schema";
import { isVtxoSpent } from "../src/wallet/vtxo";
import type { ExtendedVirtualCoin, VirtualCoin } from "../src/wallet";

// `unspentOnly` reads come from the `scriptUnspent` index. The oracle for
// every case is the same method's full-history read,
// deserialized and folded by the production dedup, then filtered by the public
// predicate — if skipping a row ever changes the answer, these fail.

const arkAddress = (fill: number) =>
    new ArkAddress(new Uint8Array(32).fill(7), new Uint8Array(32).fill(fill), "ark");
const ADDR_A = arkAddress(9);
const ADDR_B = arkAddress(11);
const A = ADDR_A.encode();
const B = ADDR_B.encode();
const SCRIPT_A = hex.encode(ADDR_A.pkScript);
const SCRIPT_B = hex.encode(ADDR_B.pkScript);

type Row = Record<string, unknown>;

// Rows are written raw so shapes `saveVtxos` cannot produce — a missing
// `script`, an absent `spentBy` — are reachable.
const controlBlock = new Uint8Array(33);
controlBlock[0] = 0xc0;
const TAP_LEAF = { cb: hex.encode(controlBlock), s: hex.encode(new Uint8Array(20).fill(2)) };

function row(address: string, txid: string, over: Row = {}): Row {
    const out: Row = {
        address,
        txid,
        vout: 0,
        value: 1000,
        status: { confirmed: true },
        virtualStatus: { state: "preconfirmed" },
        createdAt: new Date(0),
        isUnrolled: false,
        isSpent: false,
        script: SCRIPT_A,
        tapTree: hex.encode(new Uint8Array(32).fill(3)),
        forfeitTapLeafScript: TAP_LEAF,
        intentTapLeafScript: TAP_LEAF,
        ...over,
    };
    if (out.script === null) delete out.script;
    return out;
}

let seq = 0;
async function seed(rows: Row[]): Promise<{ repo: IndexedDBWalletRepository; name: string }> {
    const name = `idb-unspent-${Date.now()}-${seq++}`;
    const db = await openDatabase(name, DB_VERSION, initDatabase);
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([STORE_VTXOS], "readwrite");
        const store = tx.objectStore(STORE_VTXOS);
        for (const r of rows) store.put({ ...r, ...unspentFlag(r as unknown as VirtualCoin) });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
    await closeDatabase(name);
    return { repo: new IndexedDBWalletRepository(name), name };
}

const ids = (vtxos: ExtendedVirtualCoin[]) =>
    vtxos.map((v) => `${v.script}:${v.txid}:${v.vout}@${v.spentBy ?? ""}`).sort();

async function expectMatchesOracle(repo: IndexedDBWalletRepository, scripts: string[]) {
    const full = await repo.getVtxosForScripts(scripts);
    const oracle = full.filter((v) => !isVtxoSpent(v));
    const actual = await repo.getVtxosForScripts(scripts, { unspentOnly: true });
    expect(ids(actual)).toEqual(ids(oracle));
    // Same winning copy per outpoint, not just the same outpoint set.
    expect([...actual].sort((x, y) => (x.txid < y.txid ? -1 : 1))).toEqual(
        [...oracle].sort((x, y) => (x.txid < y.txid ? -1 : 1)),
    );
    return actual;
}

describe("IndexedDB unspentOnly reads", () => {
    it("matches the oracle on a hand-built v3 store covering every row shape", async () => {
        const rows: Row[] = [
            // Live rows.
            row(A, "live-plain", { spentBy: "" }),
            row(A, "live-no-spentby", { spentBy: undefined }),
            row(B, "live-other-script", { script: SCRIPT_B, spentBy: "" }),
            // Spent history, one shape per terminal signal.
            row(A, "spent-by", { isSpent: true, spentBy: "spender-1" }),
            row(A, "settled-by", { isSpent: true, spentBy: "", settledBy: "commitment-1" }),
            row(A, "spent-flag-only", { isSpent: true, spentBy: "" }),
            row(A, "legacy-virtualstatus", {
                isSpent: undefined,
                spentBy: undefined,
                virtualStatus: { state: "spent" },
            }),
            // Row with no `script` at all: absent from the script index, so no
            // read path can see it.
            row(A, "no-script", { script: null, spentBy: "" }),
            // Duplicated outpoint: canonical bucket spent, other bucket live.
            row(A, "dup-canonical-spent", { isSpent: true, spentBy: "spender-2" }),
            row(B, "dup-canonical-spent", { spentBy: "" }),
            // Duplicated outpoint: canonical bucket live, other bucket spent.
            row(A, "dup-canonical-live", { spentBy: "" }),
            row(B, "dup-canonical-live", { isSpent: true, spentBy: "spender-3" }),
            // Duplicated outpoint, neither bucket canonical: lifecycle weight.
            row("bucket-x", "dup-weight", { spentBy: "" }),
            row("bucket-y", "dup-weight", { isSpent: true, spentBy: "spender-4" }),
        ];
        const { repo, name } = await seed(rows);
        try {
            const live = await expectMatchesOracle(repo, [SCRIPT_A, SCRIPT_B]);
            // Pinned independently of the oracle so the shared fold can't hide
            // a regression in both.
            expect(live.map((v) => v.txid).sort()).toEqual([
                "dup-canonical-live",
                "live-no-spentby",
                "live-other-script",
                "live-plain",
            ]);
            // 14 seeded rows -> 10 outpoints: three are duplicate buckets and
            // the row with no `script` is in no index.
            expect(await repo.getVtxosForScripts([SCRIPT_A, SCRIPT_B])).toHaveLength(10);
        } finally {
            await repo[Symbol.asyncDispose]();
            await closeDatabase(name);
        }
    });

    it("matches the oracle across randomized stores", async () => {
        let state = 0x9e3779b9;
        const rand = () => {
            state = (state + 0x6d2b79f5) | 0;
            let t = Math.imul(state ^ (state >>> 15), 1 | state);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

        for (let iteration = 0; iteration < 25; iteration++) {
            const rows: Row[] = [];
            for (let outpoint = 0; outpoint < 14; outpoint++) {
                const txid = `t${outpoint}`;
                const buckets = rand() < 0.3 ? [A, B] : [pick([A, B, "bucket-x", "bucket-y"])];
                for (const address of buckets) {
                    const shape = pick([
                        "live",
                        "live-undef",
                        "spentBy",
                        "settledBy",
                        "flag",
                        "legacy",
                        "noscript",
                    ]);
                    const over: Row = { script: pick([SCRIPT_A, SCRIPT_B]) };
                    if (shape === "live") over.spentBy = "";
                    if (shape === "live-undef") over.spentBy = undefined;
                    if (shape === "spentBy") Object.assign(over, { isSpent: true, spentBy: txid });
                    if (shape === "settledBy") {
                        Object.assign(over, { isSpent: true, spentBy: "", settledBy: txid });
                    }
                    if (shape === "flag") Object.assign(over, { isSpent: true, spentBy: "" });
                    if (shape === "legacy") {
                        Object.assign(over, {
                            isSpent: undefined,
                            spentBy: undefined,
                            virtualStatus: { state: "spent" },
                        });
                    }
                    if (shape === "noscript") Object.assign(over, { script: null, spentBy: "" });
                    rows.push(row(address, txid, over));
                }
            }
            const { repo, name } = await seed(rows);
            try {
                await expectMatchesOracle(repo, [SCRIPT_A, SCRIPT_B]);
                await expectMatchesOracle(repo, [SCRIPT_A]);
            } finally {
                await repo[Symbol.asyncDispose]();
                await closeDatabase(name);
            }
        }
    });

    it("reads the unspent index and candidate txids, never the script history", async () => {
        const rows: Row[] = [row(A, "live", { spentBy: "" })];
        for (let i = 0; i < 40; i++) {
            rows.push(row(A, `spent-${i}`, { isSpent: true, spentBy: `spender-${i}` }));
        }
        const { repo, name } = await seed(rows);
        const db = await openDatabase(name, DB_VERSION, initDatabase);
        const proto = Object.getPrototypeOf(
            db.transaction([STORE_VTXOS], "readonly").objectStore(STORE_VTXOS).index("script"),
        ) as { getAll: (...args: unknown[]) => unknown };
        const original = proto.getAll;
        const indexes: string[] = [];
        proto.getAll = function (this: IDBIndex, ...args: unknown[]) {
            indexes.push(this.name);
            return original.apply(this, args);
        };
        try {
            const live = await repo.getVtxosForScripts([SCRIPT_A], { unspentOnly: true });
            expect(live.map((v) => v.txid)).toEqual(["live"]);
            expect(live[0]).not.toHaveProperty("unspent");
        } finally {
            proto.getAll = original;
            await closeDatabase(name);
            await repo[Symbol.asyncDispose]();
        }
        expect(indexes).toEqual(["scriptUnspent", "txid"]);
    });

    it("keeps the single-script read delegating with master's empty-script behaviour", async () => {
        const { repo, name } = await seed([
            row(A, "live", { spentBy: "" }),
            row(A, "empty-script", { script: "", spentBy: "" }),
        ]);
        try {
            expect((await repo.getVtxosForScript(SCRIPT_A)).map((v) => v.txid)).toEqual(["live"]);
            // An empty stored script is a real index key, and the read derives
            // the returned script from the address, exactly as before.
            const empty = await repo.getVtxosForScript("");
            expect(empty.map((v) => v.txid)).toEqual(["empty-script"]);
            expect(empty[0].script).toBe(SCRIPT_A);
        } finally {
            await repo[Symbol.asyncDispose]();
            await closeDatabase(name);
        }
    });
});
