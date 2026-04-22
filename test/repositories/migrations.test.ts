import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { TaprootControlBlock } from "@scure/btc-signer";
import { ArkAddress } from "../../src";
import type { TapLeafScript } from "../../src/script/base";
import { scriptFromArkAddress } from "../../src/repositories/scriptFromAddress";
import { runArkRealmMigrations } from "../../src/repositories/realm/schemas";
import { SQLiteWalletRepository } from "../../src/repositories/sqlite/walletRepository";
import type { SQLExecutor } from "../../src/repositories/sqlite/types";
import {
    openDatabase,
    closeDatabase,
} from "../../src/repositories/indexedDB/manager";
import {
    initDatabase,
    STORE_VTXOS,
    backfillVtxoScripts,
} from "../../src/repositories/indexedDB/schema";
import { IndexedDBWalletRepository } from "../../src/repositories/indexedDB/walletRepository";

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

describe("scriptFromArkAddress", () => {
    it("derives the hex scriptPubKey from an encoded Ark address", () => {
        // `scriptFromArkAddress(addr)` must match `hex.encode(addr.pkScript)`
        // exactly — that's the value the indexer would have returned, and the
        // backfill's whole job is to produce it without re-hitting the indexer.
        expect(scriptFromArkAddress(TEST_ARK_ADDRESS)).toBe(
            EXPECTED_PK_SCRIPT_HEX
        );
    });

    it("throws on malformed addresses", () => {
        expect(() => scriptFromArkAddress("not-a-real-address")).toThrow();
    });
});

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

    it("is a no-op when the old schema is already at v2", () => {
        const oldVtxos = [{ address: TEST_ARK_ADDRESS, script: null }];
        const newVtxos = [{ address: TEST_ARK_ADDRESS, script: null }];

        runArkRealmMigrations(makeRealm(2, oldVtxos), makeRealm(2, newVtxos));

        // Nothing should have changed — the guard is `oldRealm.schemaVersion < 2`.
        expect(newVtxos[0].script).toBeNull();
    });
});

describe("SQLite migration: migrateVtxosTable", () => {
    // For the migration path we need a mock that reports the legacy schema
    // (vtxos table exists, `script` column is either missing or nullable) on
    // the first call — which the simple in-memory mock in
    // sqlite-wallet-repository.test.ts doesn't model. This mock tracks the
    // sequence of calls instead, returning pre-scripted responses.

    interface QueryLog {
        sql: string;
        params?: unknown[];
    }

    function makeScriptedExecutor(
        responses: Map<string, (params?: unknown[]) => unknown>
    ): { executor: SQLExecutor; log: QueryLog[] } {
        const log: QueryLog[] = [];
        const match = (sql: string): ((params?: unknown[]) => unknown) => {
            for (const [pattern, handler] of responses) {
                if (new RegExp(pattern, "i").test(sql)) return handler;
            }
            throw new Error(`Unscripted SQL: ${sql}`);
        };
        const executor: SQLExecutor = {
            async run(sql: string, params?: unknown[]): Promise<void> {
                log.push({ sql: sql.trim(), params });
                match(sql)(params);
            },
            async get<T = Record<string, unknown>>(
                sql: string,
                params?: unknown[]
            ): Promise<T | undefined> {
                log.push({ sql: sql.trim(), params });
                return match(sql)(params) as T | undefined;
            },
            async all<T = Record<string, unknown>>(
                sql: string,
                params?: unknown[]
            ): Promise<T[]> {
                log.push({ sql: sql.trim(), params });
                return match(sql)(params) as T[];
            },
        };
        return { executor, log };
    }

    it("creates a fresh table with NOT NULL script when none exists", async () => {
        const responses = new Map<string, (params?: unknown[]) => unknown>([
            [/SELECT\s+name\s+FROM\s+sqlite_master/i.source, () => undefined],
            [/CREATE\s+TABLE/i.source, () => undefined],
            [/CREATE\s+INDEX/i.source, () => undefined],
            // Subsequent save/get calls aren't exercised in this test.
        ]);
        const { executor, log } = makeScriptedExecutor(responses);
        const repo = new SQLiteWalletRepository(executor);

        // Trigger ensureInit via a read — it runs the migration before the
        // first query completes.
        await repo.getVtxos(TEST_ARK_ADDRESS).catch(() => undefined);

        const createVtxos = log.find(
            (q) =>
                /CREATE\s+TABLE\s+ark_vtxos/.test(q.sql) &&
                /NOT NULL/.test(q.sql)
        );
        expect(createVtxos).toBeDefined();
        // Fresh install short-circuits before PRAGMA/table-rebuild logic.
        expect(log.some((q) => /PRAGMA\s+table_info/i.test(q.sql))).toBe(false);
        expect(log.some((q) => /DROP\s+TABLE/i.test(q.sql))).toBe(false);
    });

    it("backfills NULL scripts and rebuilds when legacy column is nullable", async () => {
        // Scenario: the table exists, `script` column exists but `notnull=0`.
        // Expected flow: skip ALTER, run backfill UPDATE for each NULL row,
        // then rebuild via temp table + rename.
        const nullRows = [
            { txid: "tx1", vout: 0, address: TEST_ARK_ADDRESS },
            { txid: "tx2", vout: 1, address: TEST_ARK_ADDRESS },
        ];
        const updateParams: unknown[][] = [];
        const responses = new Map<string, (params?: unknown[]) => unknown>([
            [
                /SELECT\s+name\s+FROM\s+sqlite_master/i.source,
                () => ({ name: "ark_vtxos" }),
            ],
            [
                /PRAGMA\s+table_info/i.source,
                () => [
                    { name: "txid", notnull: 1 },
                    { name: "script", notnull: 0 },
                ],
            ],
            [
                /SELECT\s+txid,\s+vout,\s+address\s+FROM\s+ark_vtxos/i.source,
                () => nullRows,
            ],
            [
                /UPDATE\s+ark_vtxos\s+SET\s+script/i.source,
                (params) => {
                    updateParams.push(params ?? []);
                },
            ],
            [/DROP\s+TABLE/i.source, () => undefined],
            [/CREATE\s+TABLE/i.source, () => undefined],
            [/INSERT\s+INTO/i.source, () => undefined],
            [/ALTER\s+TABLE/i.source, () => undefined],
            [/CREATE\s+INDEX/i.source, () => undefined],
        ]);
        const { executor, log } = makeScriptedExecutor(responses);
        const repo = new SQLiteWalletRepository(executor);

        await repo.getVtxos(TEST_ARK_ADDRESS).catch(() => undefined);

        // Each null row gets backfilled with the derived script.
        expect(updateParams).toHaveLength(2);
        expect(updateParams[0][0]).toBe(EXPECTED_PK_SCRIPT_HEX);
        // Rebuild sequence: DROP IF EXISTS tmp → CREATE tmp → INSERT SELECT →
        // DROP original → ALTER RENAME.
        const insertSelect = log.find((q) =>
            /INSERT\s+INTO\s+ark_vtxos__migrate_tmp/i.test(q.sql)
        );
        expect(insertSelect).toBeDefined();
        const rename = log.find((q) =>
            /ALTER\s+TABLE\s+ark_vtxos__migrate_tmp\s+RENAME\s+TO\s+ark_vtxos/i.test(
                q.sql
            )
        );
        expect(rename).toBeDefined();
    });

    it("skips the rebuild when script column is already NOT NULL", async () => {
        const responses = new Map<string, (params?: unknown[]) => unknown>([
            [
                /SELECT\s+name\s+FROM\s+sqlite_master/i.source,
                () => ({ name: "ark_vtxos" }),
            ],
            [
                /PRAGMA\s+table_info/i.source,
                () => [
                    { name: "txid", notnull: 1 },
                    { name: "script", notnull: 1 },
                ],
            ],
            [/CREATE\s+TABLE/i.source, () => undefined],
            [/CREATE\s+INDEX/i.source, () => undefined],
        ]);
        const { executor, log } = makeScriptedExecutor(responses);
        const repo = new SQLiteWalletRepository(executor);

        await repo.getVtxos(TEST_ARK_ADDRESS).catch(() => undefined);

        // Nothing should touch the vtxos table beyond the schema probe.
        expect(log.some((q) => /ALTER\s+TABLE\s+ark_vtxos/i.test(q.sql))).toBe(
            false
        );
        expect(log.some((q) => /DROP\s+TABLE/i.test(q.sql))).toBe(false);
        expect(log.some((q) => /UPDATE\s+ark_vtxos/i.test(q.sql))).toBe(false);
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

            const db = await openDatabase(dbName, 3, initDatabase);
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
});
