import { describe, it, expect } from "vitest";
import { openDatabase, closeDatabase } from "../src/repositories/indexedDB/manager";
import {
    initDatabase,
    DB_VERSION,
    STORE_TRANSACTIONS,
    STORE_VTXOS,
} from "../src/repositories/indexedDB/schema";
import { IndexedDBWalletRepository } from "../src/repositories/indexedDB/walletRepository";
import { IndexedDBContractRepository } from "../src/repositories/indexedDB/contractRepository";
import { awaitTransaction } from "../src/repositories/indexedDB/idbUtils";
import { TxType } from "../src/wallet";

// IndexedDB is provided globally by test/polyfill.js (indexeddbshim).

// The shared wallet DB upgrades only its history index; opt-in intent stores
// remain confined to a separate database name.
describe("IndexedDB wallet history index migration", () => {
    async function schema(dbName: string) {
        // Opening at DB_VERSION returns the repos' cached connection (refcount++),
        // so we can read its version/stores without triggering an upgrade.
        const db = await openDatabase(dbName, DB_VERSION, initDatabase);
        const result = {
            version: db.version,
            names: Array.from(db.objectStoreNames),
            historyIndex: db
                .transaction(STORE_TRANSACTIONS, "readonly")
                .objectStore(STORE_TRANSACTIONS)
                .indexNames.contains("addressCreatedAt"),
            unspentIndex: db
                .transaction(STORE_VTXOS, "readonly")
                .objectStore(STORE_VTXOS)
                .indexNames.contains("scriptUnspent"),
        };
        await closeDatabase(dbName);
        return result;
    }

    // v4 is the released 0.4.77 shape: `scriptUnspent` without the history index.
    it.each([3, 4])(
        "upgrades v%i to the current version without losing history or adding intent stores",
        async (from) => {
            const dbName = `wallet-history-v${from}-${crypto.randomUUID()}`;

            const seeded = await openDatabase(dbName, from, (db, oldVersion, transaction) => {
                initDatabase(db, oldVersion, transaction);
                transaction?.objectStore(STORE_TRANSACTIONS).deleteIndex("addressCreatedAt");
            });
            expect(seeded.version).toBe(from);
            const tx = seeded.transaction(STORE_TRANSACTIONS, "readwrite");
            tx.objectStore(STORE_TRANSACTIONS).put({
                address: "mine",
                keyBoardingTxid: "",
                keyCommitmentTxid: "",
                keyArkTxid: "legacy",
                key: { boardingTxid: "", commitmentTxid: "", arkTxid: "legacy" },
                type: TxType.TxSent,
                amount: 100,
                settled: true,
                createdAt: 123,
            });
            await awaitTransaction(tx);
            await closeDatabase(dbName);

            // Open the same DB through the default repos, exercising both.
            const wallet = new IndexedDBWalletRepository(dbName);
            const contract = new IndexedDBContractRepository(dbName);
            try {
                await wallet.getWalletState();
                await contract.getContractsPage(undefined, { limit: 1 });

                const { version, names, historyIndex, unspentIndex } = await schema(dbName);
                expect(version).toBe(DB_VERSION);
                expect(historyIndex).toBe(true);
                expect(unspentIndex).toBe(true);
                expect(names).not.toContain("intents");
                expect(names).not.toContain("virtualTxs");
                expect(names).not.toContain("vtxoBranches");
                const history = await wallet.getTransactionHistoryPage(
                    { address: "mine" },
                    { limit: 1 },
                );
                expect(history.items.map((row) => row.key.arkTxid)).toEqual(["legacy"]);
            } finally {
                await wallet[Symbol.asyncDispose]();
                await contract[Symbol.asyncDispose]();
            }
        },
    );
});
