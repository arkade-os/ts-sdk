import { collectIntents } from "../src/repositories/intentRepository";
import { afterEach, describe, it, expect, vi } from "vitest";
import { createNodeSQLExecutor } from "../../../config/test-helpers/nodeSqlExecutor";
import { SQLiteIntentRepository } from "../src/repositories/sqlite/intentRepository";
import { SQLiteVirtualTxRepository } from "../src/repositories/sqlite/virtualTxRepository";
import { SQLiteWalletRepository } from "../src/repositories/sqlite/walletRepository";
import { SQLiteContractRepository } from "../src/repositories/sqlite/contractRepository";
import type { Contract } from "../src/contracts/types";
import { getSerializedExecutor, runInTransaction } from "../src/repositories/sqlite/transaction";
import { ChainedTxType, type VirtualTx } from "../src/repositories/virtualTxRepository";
import type { ArkIntent } from "../src/repositories/intentRepository";

// Regression coverage for the shared-connection transaction races: SQLite
// cannot nest BEGIN IMMEDIATE, so overlapping transactions on one executor
// used to fail with "cannot start a transaction within a transaction".

const intent = (id: string): ArkIntent => ({
    proofTxId: id,
    state: "waiting_for_batch",
    createdAt: 1,
    updatedAt: 1,
    registerProof: "rp",
    registerProofMessage: "rpm",
    deleteProof: "dp",
    deleteProofMessage: "dpm",
    partialForfeits: [],
    proofInputs: [{ txid: id, vout: 0 }],
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
    it.each([false, true])(
        "keeps unrelated SDK operations outside an atomic wallet transaction (rollback=%s)",
        async (rollback) => {
            const db = createNodeSQLExecutor();
            const wallet = new SQLiteWalletRepository(db, { walletStateTransactions: true });
            const contracts = new SQLiteContractRepository(db);
            const intents = new SQLiteIntentRepository(db);
            const virtual = new SQLiteVirtualTxRepository(db);
            const existing: Contract = {
                script: "existing",
                address: "existing",
                type: "test",
                state: "active",
                params: {},
                createdAt: 1,
            };
            const added: Contract = { ...existing, script: "added", address: "added" };
            await wallet.saveWalletState({ settings: { initial: true } });
            await contracts.saveContract(existing);
            await collectIntents(intents);
            await virtual.getVirtualTx("x");
            let enter!: () => void;
            const entered = new Promise<void>((resolve) => {
                enter = resolve;
            });
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const get = db.get.bind(db);
            const read = vi.spyOn(db, "get").mockImplementationOnce(async (sql, params) => {
                const row = await get(sql, params);
                enter();
                await gate;
                return row;
            });
            const error = new Error("wallet update failed");
            const updating = wallet
                .atomicWalletState!.update((state) => {
                    if (rollback) throw error;
                    return { ...state, settings: { ...state.settings, committed: true } };
                })
                .catch((failure) => failure);
            await entered;
            const settled: string[] = [];
            const operations = [
                contracts.saveContract(added),
                contracts.getContractsPage(undefined, { limit: 10 }),
                contracts.deleteContract(existing.script),
                wallet.saveWalletState({ settings: { outside: true } }),
                wallet.getWalletState(),
                intents.saveBatchRegistration(intent("outside")),
                virtual.upsertVirtualTxs([vtx("outside")]),
            ].map((operation, index) =>
                operation.then((value) => {
                    settled.push(String(index));
                    return value;
                }),
            );
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            const settledBeforeRelease = [...settled];
            release();
            const outcome = await updating;
            await Promise.all(operations);
            read.mockRestore();
            expect(outcome).toBe(rollback ? error : undefined);
            expect(
                (await contracts.getContractsPage(undefined, { limit: 10 })).items.map(
                    (row) => row.script,
                ),
            ).toEqual(["added"]);
            expect(await wallet.getWalletState()).toEqual({
                settings: { outside: true },
                lastSyncTime: undefined,
            });
            expect(settledBeforeRelease).toEqual([]);
            expect((await collectIntents(intents)).map((row) => row.proofTxId)).toEqual([
                "outside",
            ]);
            expect(await virtual.getVirtualTx("outside")).not.toBeNull();
            await wallet.atomicWalletState!.update((state) => ({ ...state, lastSyncTime: 99 }));
            expect((await wallet.getWalletState())?.lastSyncTime).toBe(99);
        },
    );

    it("serializes concurrent transactions across two repos on one executor", async () => {
        const db = createNodeSQLExecutor();
        const intents = new SQLiteIntentRepository(db);
        const vtxs = new SQLiteVirtualTxRepository(db);
        await collectIntents(intents); // init
        await vtxs.getVirtualTx("x"); // init

        await Promise.all([
            intents.saveBatchRegistration(intent("a")),
            vtxs.upsertVirtualTxs([vtx("t1")]),
            intents.saveBatchRegistration(intent("b")),
            vtxs.upsertVirtualTxs([vtx("t2")]),
        ]);

        expect((await collectIntents(intents)).map((i) => i.proofTxId).sort()).toEqual(["a", "b"]);
        expect(await vtxs.getVirtualTx("t1")).not.toBeNull();
        expect(await vtxs.getVirtualTx("t2")).not.toBeNull();
    });

    it("serializes concurrent saveBatchRegistration on one repository", async () => {
        const db = createNodeSQLExecutor();
        const intents = new SQLiteIntentRepository(db);
        await collectIntents(intents);

        const ids = Array.from({ length: 8 }, (_, i) => `i${i}`);
        await Promise.all(ids.map((id) => intents.saveBatchRegistration(intent(id))));

        expect((await collectIntents(intents)).map((i) => i.proofTxId).sort()).toEqual(
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
        await collectIntents(intents);

        // getWalletState triggers the migration transaction; race it against an
        // intent transaction on the same connection.
        await Promise.all([wallet.getWalletState(), intents.saveBatchRegistration(intent("z"))]);

        const cols = await db.all<{ name: string; notnull: number }>(
            "PRAGMA table_info(ark_vtxos)",
        );
        expect(cols.find((c) => c.name === "script")?.notnull).toBe(1); // migrated
        expect((await collectIntents(intents)).map((i) => i.proofTxId)).toContain("z");
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

describe("SQLite stalled-transaction warning", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("warns with the call site when a transaction callback calls the queue", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const db = createNodeSQLExecutor();
        const facade = getSerializedExecutor(db);
        let reached!: () => void;
        const nested = new Promise<void>((resolve) => {
            reached = resolve;
        });
        // Deadlocks by design; the transaction never settles.
        void runInTransaction(db, async () => {
            const read = facade.get("SELECT 1");
            reached();
            await read;
        });
        await nested;
        await vi.advanceTimersByTimeAsync(9_999);
        expect(warn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(warn).toHaveBeenCalledOnce();
        const site = warn.mock.calls[0][0] as Error;
        expect(site.message).toMatch(/inside a runInTransaction callback deadlocks/);
        expect(site.stack).toContain("sqlite-transaction-serialization.test.ts");
    });

    it("stays quiet for a call that only waits for a transaction to finish", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const db = createNodeSQLExecutor();
        let started!: () => void;
        const running = new Promise<void>((resolve) => {
            started = resolve;
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const transaction = runInTransaction(db, async () => {
            started();
            await gate;
        });
        await running;
        const read = getSerializedExecutor(db).get<{ one: number }>("SELECT 1 AS one");
        release();
        await transaction;
        expect(await read).toEqual({ one: 1 });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(warn).not.toHaveBeenCalled();
    });
});
