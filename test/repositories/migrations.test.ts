import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import { TaprootControlBlock } from "@scure/btc-signer";
import Database from "better-sqlite3";
import { ArkAddress } from "../../src";
import type { TapLeafScript } from "../../src/script/base";
import { runArkRealmMigrations } from "../../src/repositories/realm/schemas";
import {
    openDatabase,
    closeDatabase,
} from "../../src/repositories/indexedDB/manager";
import {
    initDatabase,
    STORE_VTXOS,
    backfillVtxoScripts,
    DB_VERSION,
} from "../../src/repositories/indexedDB/schema";
import { IndexedDBWalletRepository } from "../../src/repositories/indexedDB/walletRepository";
import { SQLiteWalletRepository } from "../../src/repositories/sqlite/walletRepository";
import type { SQLExecutor } from "../../src/repositories/sqlite/types";

// Deterministic Ark address to exercise the real bech32m decode path in
// the backfill helper — using "test-address-123" everywhere else is fine
// because the mock VTXOs already carry a `script`, but migrations derive
// the script from the address so they need a real one.
const TEST_SERVER_PUBKEY = new Uint8Array(32).fill(7);
const TEST_VTXO_TAPROOT_KEY = new Uint8Array(32).fill(9);
const TEST_ARK_ADDRESS = new ArkAddress(
    TEST_SERVER_PUBKEY,
    TEST_VTXO_TAPROOT_KEY,
    "ark"
).encode();
const EXPECTED_PK_SCRIPT_HEX = hex.encode(
    new ArkAddress(TEST_SERVER_PUBKEY, TEST_VTXO_TAPROOT_KEY, "ark").pkScript
);

describe("Realm migration: runArkRealmMigrations", () => {
    // A minimal stand-in for the Realm handles passed to `onMigration`. The
    // real Realm exposes `.objects(name)` returning an indexable array-like;
    // we only need the subset the migration touches.
    function makeRealm(
        schemaVersion: number,
        vtxos: Record<string, unknown>[]
    ) {
        return {
            schemaVersion,
            objects: (name: string) => {
                if (name !== "ArkVtxo") {
                    throw new Error(`Unexpected object name: ${name}`);
                }
                return vtxos;
            },
        };
    }

    it("backfills script for legacy rows missing it (v1 → v2)", () => {
        // Realm's migration API provides parallel old/new arrays in the same
        // order, so mutating new[i] is what persists.
        const oldVtxos = [
            { address: TEST_ARK_ADDRESS, script: null },
            { address: TEST_ARK_ADDRESS, script: "5120abcd" },
        ];
        const newVtxos = [
            { address: TEST_ARK_ADDRESS, script: null },
            { address: TEST_ARK_ADDRESS, script: "5120abcd" },
        ];

        runArkRealmMigrations(makeRealm(1, oldVtxos), makeRealm(2, newVtxos));

        expect(newVtxos[0].script).toBe(EXPECTED_PK_SCRIPT_HEX);
        // Row that already had a script must be left alone — we don't want
        // to rewrite scripts the indexer already populated.
        expect(newVtxos[1].script).toBe("5120abcd");
    });

    it("is a no-op when every row already has a script", () => {
        const newVtxos = [{ address: TEST_ARK_ADDRESS, script: "5120abcd" }];

        runArkRealmMigrations(makeRealm(2, newVtxos), makeRealm(2, newVtxos));

        // Per-row guard: rows that already have a script are left alone.
        expect(newVtxos[0].script).toBe("5120abcd");
    });

    it("backfills legacy rows even when the app schema is at a higher version", () => {
        // Consumers share a global `schemaVersion` across their own schemas
        // and ours. An app that was already at version 10 when it adopted
        // Arkade must still get its legacy ArkVtxo rows backfilled — the
        // migration gates on per-row `script` presence, not on our constant.
        const newVtxos = [{ address: TEST_ARK_ADDRESS, script: null }];

        runArkRealmMigrations(makeRealm(10, newVtxos), makeRealm(11, newVtxos));

        expect(newVtxos[0].script).toBe(EXPECTED_PK_SCRIPT_HEX);
    });
});

describe("IndexedDB migration: backfillVtxoScripts", () => {
    // indexeddbshim's in-memory DB does NOT persist across `db.close()` + reopen,
    // so these tests exercise the cursor logic on a live DB rather than
    // driving it through `onupgradeneeded`. The production wiring in
    // `initDatabase` is guarded by `oldVersion >= 1 && oldVersion < 3`; that
    // predicate is plain arithmetic and not worth a separate test.
    let nameSeq = 0;
    const getUniqueDbName = () =>
        `ark-migration-test-${Date.now()}-${nameSeq++}`;

    function makeTapLeaf(): TapLeafScript {
        const controlBlockBytes = new Uint8Array(33);
        controlBlockBytes[0] = 0xc0;
        return [
            TaprootControlBlock.decode(controlBlockBytes),
            new Uint8Array(20).fill(2),
        ];
    }

    it("backfills script on legacy rows missing it", async () => {
        const dbName = getUniqueDbName();
        const db = await openDatabase(dbName, 3, initDatabase);
        try {
            // Insert a legacy-shaped row directly (no `script`). We can't
            // insert via `saveVtxos` because the repo always writes `script`.
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction([STORE_VTXOS], "readwrite");
                tx.objectStore(STORE_VTXOS).put({
                    address: TEST_ARK_ADDRESS,
                    txid: "legacy-tx",
                    vout: 0,
                    value: 1000,
                });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });

            // Run the backfill cursor inside a readwrite transaction and
            // wait for the transaction to commit — cursor updates flush
            // on `oncomplete`.
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction([STORE_VTXOS], "readwrite");
                backfillVtxoScripts(tx);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });

            const backfilled = await new Promise<
                { script?: string } | undefined
            >((resolve, reject) => {
                const tx = db.transaction([STORE_VTXOS], "readonly");
                const req = tx
                    .objectStore(STORE_VTXOS)
                    .get([TEST_ARK_ADDRESS, "legacy-tx", 0]);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });

            expect(backfilled?.script).toBe(EXPECTED_PK_SCRIPT_HEX);
        } finally {
            await closeDatabase(dbName);
        }
    });

    it("leaves existing scripts untouched", async () => {
        // Rows that already have a script are left alone — we don't want
        // the backfill to rewrite values the indexer populated.
        const dbName = getUniqueDbName();
        const db = await openDatabase(dbName, 3, initDatabase);
        try {
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction([STORE_VTXOS], "readwrite");
                tx.objectStore(STORE_VTXOS).put({
                    address: TEST_ARK_ADDRESS,
                    txid: "preset-tx",
                    vout: 0,
                    value: 1000,
                    script: "5120abcd",
                });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });

            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction([STORE_VTXOS], "readwrite");
                backfillVtxoScripts(tx);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });

            const row = await new Promise<{ script?: string } | undefined>(
                (resolve, reject) => {
                    const tx = db.transaction([STORE_VTXOS], "readonly");
                    const req = tx
                        .objectStore(STORE_VTXOS)
                        .get([TEST_ARK_ADDRESS, "preset-tx", 0]);
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                }
            );

            expect(row?.script).toBe("5120abcd");
        } finally {
            await closeDatabase(dbName);
        }
    });

    it("read-time backfill kicks in when a legacy row slips through", async () => {
        // Belt-and-suspenders: if a row somehow reaches read path with no
        // script (migration skipped, racing client, etc.), `getVtxos`
        // derives it from the address via `deserializeVtxoWithBackfill`.
        const dbName = getUniqueDbName();
        const repo = new IndexedDBWalletRepository(dbName);
        try {
            // Seed the real repo's DB with a full vtxo, then poke the raw
            // row to drop `script` — simulates a legacy record that escaped
            // the upgrade-path backfill.
            await repo.saveVtxos(TEST_ARK_ADDRESS, [
                {
                    txid: "read-backfill-tx",
                    vout: 0,
                    value: 1000,
                    status: { confirmed: true },
                    virtualStatus: { state: "preconfirmed" },
                    createdAt: new Date(),
                    isUnrolled: false,
                    isSpent: false,
                    script: "5120deadbeef",
                    forfeitTapLeafScript: makeTapLeaf(),
                    intentTapLeafScript: makeTapLeaf(),
                    tapTree: new Uint8Array(32),
                },
            ]);

            // Reopen at the current DB_VERSION: the repo above already
            // created this DB at DB_VERSION, and IndexedDB rejects opening
            // an existing database at a lower version.
            const db = await openDatabase(dbName, DB_VERSION, initDatabase);
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction([STORE_VTXOS], "readwrite");
                const store = tx.objectStore(STORE_VTXOS);
                const getReq = store.get([
                    TEST_ARK_ADDRESS,
                    "read-backfill-tx",
                    0,
                ]);
                getReq.onsuccess = () => {
                    const row = getReq.result as Record<string, unknown>;
                    delete row.script;
                    const putReq = store.put(row);
                    putReq.onerror = () => reject(putReq.error);
                };
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            // Release the extra ref we took via openDatabase.
            await closeDatabase(dbName);

            const [retrieved] = await repo.getVtxos(TEST_ARK_ADDRESS);
            expect(retrieved.script).toBe(EXPECTED_PK_SCRIPT_HEX);
        } finally {
            await repo[Symbol.asyncDispose]();
        }
    });

    it("creates the `script` index and populates it via backfill", async () => {
        // Covers two things: (1) opening at DB_VERSION=3 creates a `script`
        // index on the vtxos store, (2) rows inserted without `script` are
        // added to the index automatically when the backfill's
        // `cursor.update()` sets the field.
        const dbName = getUniqueDbName();
        const db = await openDatabase(dbName, 3, initDatabase);
        try {
            expect(
                db
                    .transaction([STORE_VTXOS], "readonly")
                    .objectStore(STORE_VTXOS)
                    .indexNames.contains("script")
            ).toBe(true);

            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction([STORE_VTXOS], "readwrite");
                tx.objectStore(STORE_VTXOS).put({
                    address: TEST_ARK_ADDRESS,
                    txid: "indexed-backfill-tx",
                    vout: 0,
                    value: 1000,
                });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });

            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction([STORE_VTXOS], "readwrite");
                backfillVtxoScripts(tx);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });

            const hits = await new Promise<{ txid: string }[]>(
                (resolve, reject) => {
                    const tx = db.transaction([STORE_VTXOS], "readonly");
                    const req = tx
                        .objectStore(STORE_VTXOS)
                        .index("script")
                        .getAll(EXPECTED_PK_SCRIPT_HEX);
                    req.onsuccess = () =>
                        resolve(req.result as { txid: string }[]);
                    req.onerror = () => reject(req.error);
                }
            );

            expect(hits.map((h) => h.txid)).toContain("indexed-backfill-tx");
        } finally {
            await closeDatabase(dbName);
        }
    });
});

describe("SQLite migration: migrateVtxosTable", () => {
    // Exercises the legacy→v1 paths against a real SQLite database
    // (better-sqlite3 in-memory). The in-memory mock used elsewhere cannot
    // cover these paths: its `PRAGMA table_info` response hardcodes
    // `notnull: 1` (so any `script` column looks already-migrated) and its
    // WHERE parser doesn't handle `IS NULL` (so the backfill probe would
    // return every row regardless).

    // Shape of `vtxos` before 62601da4 — no `script` column at all.
    const LEGACY_V0_SCHEMA = `
        CREATE TABLE ark_vtxos (
            txid TEXT NOT NULL,
            vout INTEGER NOT NULL,
            value INTEGER NOT NULL,
            address TEXT NOT NULL,
            tap_tree TEXT NOT NULL,
            forfeit_cb TEXT NOT NULL,
            forfeit_s TEXT NOT NULL,
            intent_cb TEXT NOT NULL,
            intent_s TEXT NOT NULL,
            status_json TEXT NOT NULL,
            virtual_status_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            is_unrolled INTEGER NOT NULL DEFAULT 0,
            is_spent INTEGER,
            spent_by TEXT,
            settled_by TEXT,
            ark_tx_id TEXT,
            extra_witness_json TEXT,
            assets_json TEXT,
            PRIMARY KEY (txid, vout)
        )
    `;

    // Shape after 62601da4 but before the NOT NULL tightening — a user who
    // upgraded across that window has `script TEXT` nullable.
    const LEGACY_V0B_SCHEMA = LEGACY_V0_SCHEMA.replace(
        "PRIMARY KEY (txid, vout)",
        "script TEXT, PRIMARY KEY (txid, vout)"
    );

    function createExecutor(db: Database.Database): SQLExecutor {
        return {
            async run(sql: string, params?: unknown[]) {
                db.prepare(sql).run(...((params ?? []) as unknown[] as []));
            },
            async get<T>(sql: string, params?: unknown[]) {
                return db
                    .prepare(sql)
                    .get(...((params ?? []) as unknown[] as [])) as
                    | T
                    | undefined;
            },
            async all<T>(sql: string, params?: unknown[]) {
                return db
                    .prepare(sql)
                    .all(...((params ?? []) as unknown[] as [])) as T[];
            },
        };
    }

    // Insert into a table matching `LEGACY_V0_SCHEMA` — no script column.
    function insertV0Row(db: Database.Database, txid: string, address: string) {
        db.prepare(
            `INSERT INTO ark_vtxos (
                txid, vout, value, address, tap_tree,
                forfeit_cb, forfeit_s, intent_cb, intent_s,
                status_json, virtual_status_json, created_at
            ) VALUES (?, 0, 1000, ?, '', '', '', '', '', '{}', '{}', '2024-01-01')`
        ).run(txid, address);
    }

    // Insert into a table matching `LEGACY_V0B_SCHEMA` — nullable script.
    function insertV0bRow(
        db: Database.Database,
        txid: string,
        address: string,
        script: string | null
    ) {
        db.prepare(
            `INSERT INTO ark_vtxos (
                txid, vout, value, address, tap_tree,
                forfeit_cb, forfeit_s, intent_cb, intent_s,
                status_json, virtual_status_json, created_at, script
            ) VALUES (?, 0, 1000, ?, '', '', '', '', '', '{}', '{}', '2024-01-01', ?)`
        ).run(txid, address, script);
    }

    function vtxosCols(
        db: Database.Database
    ): Array<{ name: string; notnull: number }> {
        return db.prepare(`PRAGMA table_info(ark_vtxos)`).all() as Array<{
            name: string;
            notnull: number;
        }>;
    }

    function tempTableExists(db: Database.Database): boolean {
        return !!db
            .prepare(
                `SELECT name FROM sqlite_master
                 WHERE type='table' AND name='ark_vtxos__migrate_tmp'`
            )
            .get();
    }

    let db: Database.Database;
    let executor: SQLExecutor;
    let repo: SQLiteWalletRepository;

    beforeEach(() => {
        db = new Database(":memory:");
        executor = createExecutor(db);
        repo = new SQLiteWalletRepository(executor);
    });

    afterEach(() => {
        db.close();
    });

    it("creates the v1 schema on a fresh install", async () => {
        // No legacy table; migration short-circuits into `vtxosCreateSql`.
        // Trigger ensureInit via a repo method that doesn't deserialize
        // rows — the seed data has placeholder binary for tap_tree/leaf
        // scripts that would fail the TapLeaf decoder, but the migration
        // just copies those bytes verbatim.
        await repo.getWalletState();

        const scriptCol = vtxosCols(db).find((c) => c.name === "script");
        expect(scriptCol).toBeDefined();
        expect(scriptCol!.notnull).toBe(1);
        expect(tempTableExists(db)).toBe(false);
    });

    it("adds the script column, backfills from address, and rebuilds NOT NULL (v0 → v1)", async () => {
        db.exec(LEGACY_V0_SCHEMA);
        insertV0Row(db, "legacy-1", TEST_ARK_ADDRESS);
        insertV0Row(db, "legacy-2", TEST_ARK_ADDRESS);

        // Trigger ensureInit via a repo method that doesn't deserialize
        // rows — the seed data has placeholder binary for tap_tree/leaf
        // scripts that would fail the TapLeaf decoder, but the migration
        // just copies those bytes verbatim.
        await repo.getWalletState();

        const scriptCol = vtxosCols(db).find((c) => c.name === "script");
        expect(scriptCol?.notnull).toBe(1);

        const rows = db
            .prepare(`SELECT txid, script FROM ark_vtxos ORDER BY txid`)
            .all() as Array<{ txid: string; script: string }>;
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.script)).toEqual([
            EXPECTED_PK_SCRIPT_HEX,
            EXPECTED_PK_SCRIPT_HEX,
        ]);
        expect(tempTableExists(db)).toBe(false);
    });

    it("backfills NULL scripts but preserves existing ones (v0b → v1)", async () => {
        db.exec(LEGACY_V0B_SCHEMA);
        insertV0bRow(db, "legacy-null", TEST_ARK_ADDRESS, null);
        insertV0bRow(db, "legacy-preset", TEST_ARK_ADDRESS, "5120cafe");

        await repo.getWalletState();

        expect(vtxosCols(db).find((c) => c.name === "script")?.notnull).toBe(1);

        const rows = Object.fromEntries(
            (
                db
                    .prepare(`SELECT txid, script FROM ark_vtxos`)
                    .all() as Array<{ txid: string; script: string }>
            ).map((r) => [r.txid, r.script])
        );
        // Backfill fills NULLs from the owning address…
        expect(rows["legacy-null"]).toBe(EXPECTED_PK_SCRIPT_HEX);
        // …but must not rewrite values the indexer already populated.
        expect(rows["legacy-preset"]).toBe("5120cafe");
    });

    it("is a no-op when the script column is already NOT NULL", async () => {
        // First migration: v0 → v1.
        db.exec(LEGACY_V0_SCHEMA);
        insertV0Row(db, "already-migrated", TEST_ARK_ADDRESS);
        await repo.getWalletState();

        // Second pass via a fresh repo instance: the early-return path
        // means the table's rowid sequence is not disturbed by a rebuild.
        const beforeRowid = (
            db
                .prepare(`SELECT rowid FROM ark_vtxos WHERE txid = ?`)
                .get("already-migrated") as { rowid: number }
        ).rowid;

        const repo2 = new SQLiteWalletRepository(executor);
        await repo2.getWalletState();

        const afterRowid = (
            db
                .prepare(`SELECT rowid FROM ark_vtxos WHERE txid = ?`)
                .get("already-migrated") as { rowid: number }
        ).rowid;
        expect(afterRowid).toBe(beforeRowid);
        expect(tempTableExists(db)).toBe(false);
    });

    it("rolls back cleanly when a bad address aborts the backfill", async () => {
        // A corrupt address mid-backfill used to leave the DB in an
        // inconsistent state; the BEGIN/ROLLBACK wrap preserves the
        // original table intact.
        db.exec(LEGACY_V0_SCHEMA);
        insertV0Row(db, "valid", TEST_ARK_ADDRESS);
        insertV0Row(db, "bad", "not-a-real-address");

        await expect(repo.getVtxos(TEST_ARK_ADDRESS)).rejects.toThrow();

        // Original rows intact, schema unchanged, no orphan tmp table.
        const rows = db
            .prepare(`SELECT txid FROM ark_vtxos ORDER BY txid`)
            .all() as Array<{ txid: string }>;
        expect(rows.map((r) => r.txid)).toEqual(["bad", "valid"]);
        expect(vtxosCols(db).some((c) => c.name === "script")).toBe(false);
        expect(tempTableExists(db)).toBe(false);
    });

    it("preserves data when a crash hits the DROP → RENAME window", async () => {
        // Regression for the pre-fix scenario: the rebuild dropped the
        // original vtxos table, then died before RENAME. Without the
        // transaction wrap this silently orphaned every row; with it, the
        // ROLLBACK restores the original table.
        db.exec(LEGACY_V0_SCHEMA);
        insertV0Row(db, "keep-me", TEST_ARK_ADDRESS);

        const crashingExecutor: SQLExecutor = {
            async run(sql, params) {
                if (/ALTER\s+TABLE\s+\S+\s+RENAME\s+TO/i.test(sql)) {
                    throw new Error("simulated crash at RENAME");
                }
                return executor.run(sql, params);
            },
            get: executor.get.bind(executor),
            all: executor.all.bind(executor),
        };
        const crashingRepo = new SQLiteWalletRepository(crashingExecutor);

        await expect(crashingRepo.getVtxos(TEST_ARK_ADDRESS)).rejects.toThrow(
            /simulated crash/
        );

        // Data and schema restored exactly as they were pre-migration.
        const rows = db
            .prepare(`SELECT txid, address FROM ark_vtxos`)
            .all() as Array<{ txid: string; address: string }>;
        expect(rows).toEqual([{ txid: "keep-me", address: TEST_ARK_ADDRESS }]);
        expect(vtxosCols(db).some((c) => c.name === "script")).toBe(false);
        expect(tempTableExists(db)).toBe(false);
    });
});
