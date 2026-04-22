import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { TaprootControlBlock } from "@scure/btc-signer";
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
