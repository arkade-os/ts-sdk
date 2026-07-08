import { describe, it, expect } from "vitest";
import { createNodeSQLExecutor } from "./helpers/nodeSqlExecutor";
import { SQLiteIntentRepository } from "../src/repositories/sqlite/intentRepository";
import { SQLiteVirtualTxRepository } from "../src/repositories/sqlite/virtualTxRepository";
import { SQLiteWalletRepository } from "../src/repositories/sqlite/walletRepository";
import { runInTransaction } from "../src/repositories/sqlite/transaction";
import { ChainedTxType, type VirtualTx } from "../src/repositories/virtualTxRepository";
import type { ArkIntent } from "../src/repositories/intentRepository";

// Regression coverage for the shared-connection transaction races: SQLite
// cannot nest BEGIN IMMEDIATE, so overlapping transactions on one executor
// used to fail with "cannot start a transaction within a transaction".

const intent = (id: string): ArkIntent => ({
    intentTxId: id,
    state: "waiting_for_batch",
    createdAt: 1,
    updatedAt: 1,
    registerProof: "rp",
    registerProofMessage: "rpm",
    deleteProof: "dp",
    deleteProofMessage: "dpm",
    partialForfeits: [],
    intentVtxos: [{ txid: id, vout: 0 }],
});

const vtx = (txid: string): VirtualTx => ({
    txid,
    psbt: "00",
    expiresAt: null,
    type: ChainedTxType.Checkpoint,
});

// Legacy vtxos with NO `script` column (V0): SQLiteWalletRepository.init must
// ADD it, backfill, and rebuild as NOT NULL.
const LEGACY_VTXOS_V0 = `CREATE TABLE ark_vtxos (
    txid TEXT NOT NULL, vout INTEGER NOT NULL, value INTEGER NOT NULL,
    address TEXT NOT NULL, tap_tree TEXT NOT NULL, forfeit_cb TEXT NOT NULL,
    forfeit_s TEXT NOT NULL, intent_cb TEXT NOT NULL, intent_s TEXT NOT NULL,
    status_json TEXT NOT NULL, virtual_status_json TEXT NOT NULL, created_at TEXT NOT NULL,
    is_unrolled INTEGER NOT NULL DEFAULT 0, is_spent INTEGER, spent_by TEXT,
    settled_by TEXT, ark_tx_id TEXT, extra_witness_json TEXT, assets_json TEXT,
    PRIMARY KEY (txid, vout))`;

// V0B: post-`script` column but pre-NOT NULL, so init only backfills + rebuilds.
const LEGACY_VTXOS = LEGACY_VTXOS_V0.replace(
    "PRIMARY KEY (txid, vout)",
    "script TEXT, PRIMARY KEY (txid, vout)",
);

describe("SQLite transaction serialization (shared connection)", () => {
    it("serializes concurrent transactions across two repos on one executor", async () => {
        const db = createNodeSQLExecutor();
        const intents = new SQLiteIntentRepository(db);
        const vtxs = new SQLiteVirtualTxRepository(db);
        await intents.getIntents(); // init
        await vtxs.getVirtualTx("x"); // init

        await Promise.all([
            intents.saveIntent(intent("a")),
            vtxs.upsertVirtualTxs([vtx("t1")]),
            intents.saveIntent(intent("b")),
            vtxs.upsertVirtualTxs([vtx("t2")]),
        ]);

        expect((await intents.getIntents()).map((i) => i.intentTxId).sort()).toEqual(["a", "b"]);
        expect(await vtxs.getVirtualTx("t1")).not.toBeNull();
        expect(await vtxs.getVirtualTx("t2")).not.toBeNull();
    });

    it("serializes concurrent saveIntent on one repository", async () => {
        const db = createNodeSQLExecutor();
        const intents = new SQLiteIntentRepository(db);
        await intents.getIntents();

        const ids = Array.from({ length: 8 }, (_, i) => `i${i}`);
        await Promise.all(ids.map((id) => intents.saveIntent(intent(id))));

        expect((await intents.getIntents()).map((i) => i.intentTxId).sort()).toEqual(
            [...ids].sort(),
        );
    });

    it("rolls back a failed transaction without wedging the chain", async () => {
        const db = createNodeSQLExecutor();
        await db.run("CREATE TABLE t (id TEXT PRIMARY KEY)");

        await expect(
            runInTransaction(db, async () => {
                await db.run("INSERT INTO t (id) VALUES ('x')");
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");

        await runInTransaction(db, async () => {
            await db.run("INSERT INTO t (id) VALUES ('y')");
        });

        const rows = await db.all<{ id: string }>("SELECT id FROM t");
        expect(rows.map((r) => r.id)).toEqual(["y"]); // 'x' rolled back, 'y' committed
    });

    it("serializes the wallet-repo migration against concurrent writes", async () => {
        const db = createNodeSQLExecutor();
        await db.run(LEGACY_VTXOS);
        const wallet = new SQLiteWalletRepository(db);
        const intents = new SQLiteIntentRepository(db);
        await intents.getIntents();

        // getWalletState triggers the migration transaction; race it against an
        // intent transaction on the same connection.
        await Promise.all([wallet.getWalletState(), intents.saveIntent(intent("z"))]);

        const cols = await db.all<{ name: string; notnull: number }>(
            "PRAGMA table_info(ark_vtxos)",
        );
        expect(cols.find((c) => c.name === "script")?.notnull).toBe(1); // migrated
        expect((await intents.getIntents()).map((i) => i.intentTxId)).toContain("z");
    });

    it("serializes two wallet-repo migrations on a legacy table without a script column", async () => {
        const db = createNodeSQLExecutor();
        await db.run(LEGACY_VTXOS_V0);
        // Two instances share the connection: the migration decision (does the
        // script column exist?) must be read inside the transaction, or the
        // second migration re-runs ADD COLUMN and fails with "duplicate column".
        const r1 = new SQLiteWalletRepository(db);
        const r2 = new SQLiteWalletRepository(db);
        await Promise.all([r1.getWalletState(), r2.getWalletState()]);

        const cols = await db.all<{ name: string; notnull: number }>(
            "PRAGMA table_info(ark_vtxos)",
        );
        expect(cols.find((c) => c.name === "script")?.notnull).toBe(1);
    });
});
