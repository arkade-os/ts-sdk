import { describe, expect, it } from "vitest";
import { createMockRealm } from "../../../../config/test-helpers/mockRealm";
import { createNodeSQLExecutor } from "../../../../config/test-helpers/nodeSqlExecutor";
import { TxType, type ArkTransaction } from "../../src/wallet";
import type { WalletRepository } from "../../src/repositories/walletRepository";
import { InMemoryWalletRepository } from "../../src/repositories/inMemory/walletRepository";
import { IndexedDBWalletRepository } from "../../src/repositories/indexedDB/walletRepository";
import { RealmWalletRepository } from "../../src/repositories/realm/walletRepository";
import { SQLiteWalletRepository } from "../../src/repositories/sqlite/walletRepository";

const backends: [string, () => WalletRepository][] = [
    ["memory", () => new InMemoryWalletRepository()],
    ["indexeddb", () => new IndexedDBWalletRepository(`page-wallet-${crypto.randomUUID()}`)],
    ["realm", () => new RealmWalletRepository(createMockRealm({ ArkTransaction: "pk" }))],
    ["sqlite", () => new SQLiteWalletRepository(createNodeSQLExecutor())],
];

const tx = (arkTxid: string, createdAt: number): ArkTransaction => ({
    key: { boardingTxid: "", commitmentTxid: "", arkTxid },
    type: TxType.TxSent,
    amount: 100,
    settled: true,
    createdAt,
});

describe.each(backends)("wallet history pages (%s)", (_, create) => {
    it("orders empty and populated transaction-key fields consistently", async () => {
        await using repository = create();
        const boarding = {
            ...tx("", 100),
            key: { boardingTxid: "a", commitmentTxid: "", arkTxid: "" },
        };
        const commitment = {
            ...tx("", 100),
            key: { boardingTxid: "", commitmentTxid: "a", arkTxid: "" },
        };
        await repository.saveTransactions("mine", [boarding, tx("a", 100), commitment]);
        const first = await repository.getTransactionHistoryPage({ address: "mine" }, { limit: 2 });
        expect(first.items.map((row) => row.key)).toEqual([tx("a", 100).key, commitment.key]);
        const second = await repository.getTransactionHistoryPage(
            { address: "mine" },
            { limit: 2, after: first.nextCursor },
        );
        expect(second.items.map((row) => row.key)).toEqual([boarding.key]);
    });

    it("keeps date and address filters across exclusive pages", async () => {
        await using repository = create();
        await repository.saveTransactions("mine", [
            tx("b", 100),
            tx("B", 100),
            tx("a", 100),
            tx("c", 1),
        ]);
        await repository.saveTransactions("other", [tx("d", 100)]);

        const filter = { address: "mine", since: 100 };
        const first = await repository.getTransactionHistoryPage(filter, { limit: 2 });
        expect(first.items.map((row) => row.key.arkTxid)).toEqual(["B", "a"]);
        expect(first.nextCursor).toEqual({ createdAt: 100, key: tx("a", 100).key });
        const second = await repository.getTransactionHistoryPage(filter, {
            after: first.nextCursor,
            limit: 2,
        });
        expect(second.items.map((row) => row.key.arkTxid)).toEqual(["b"]);
        expect(second.nextCursor).toBeUndefined();
        expect(await repository.getTransactionHistory("mine")).toHaveLength(4);
        const chronological = await repository.getTransactionHistoryPage(
            { address: "mine" },
            { limit: 2 },
        );
        expect(chronological.items.map((row) => row.key.arkTxid)).toEqual(["c", "B"]);
        await expect(repository.getTransactionHistoryPage(filter, { limit: 0 })).rejects.toThrow(
            RangeError,
        );
    });
});
