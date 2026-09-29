import { describe, expect, it } from "vitest";
import { createMockRealm } from "../../../../config/test-helpers/mockRealm";
import { createNodeSQLExecutor } from "../../../../config/test-helpers/nodeSqlExecutor";
import {
    collectScriptVtxos,
    collectUtxos,
    collectVtxos,
    type WalletRepository,
} from "../../src/repositories/walletRepository";
import { InMemoryWalletRepository } from "../../src/repositories/inMemory/walletRepository";
import { IndexedDBWalletRepository } from "../../src/repositories/indexedDB/walletRepository";
import { RealmWalletRepository } from "../../src/repositories/realm/walletRepository";
import { SQLiteWalletRepository } from "../../src/repositories/sqlite/walletRepository";
import { createMockUtxo, createMockVtxo } from "./helpers";

const backends: [string, () => WalletRepository][] = [
    ["memory", () => new InMemoryWalletRepository()],
    ["indexeddb", () => new IndexedDBWalletRepository(`page-inventory-${crypto.randomUUID()}`)],
    ["realm", () => new RealmWalletRepository(createMockRealm({ ArkVtxo: "pk", ArkUtxo: "pk" }))],
    ["sqlite", () => new SQLiteWalletRepository(createNodeSQLExecutor())],
];

describe.each(backends)("wallet inventory pages (%s)", (_, create) => {
    it("pages VTXOs and UTXOs by outpoint without crossing addresses", async () => {
        await using repository = create();
        const rows = [
            createMockVtxo("b", 0, 1_000),
            createMockVtxo("a", 1, 2_000),
            createMockVtxo("a", 0, 3_000),
        ];
        await repository.saveVtxos("mine", rows);
        await repository.saveVtxos("other", [createMockVtxo("c", 0, 4_000)]);
        await repository.saveUtxos(
            "mine",
            rows.map((row) => createMockUtxo(row.txid, row.vout, row.value)),
        );
        await repository.saveUtxos("other", [createMockUtxo("c", 0, 4_000)]);

        for (const read of [
            repository.getVtxosPage.bind(repository),
            repository.getUtxosPage.bind(repository),
        ]) {
            const first = await read("mine", { limit: 2 });
            expect(first.items.map(({ txid, vout }) => [txid, vout])).toEqual([
                ["a", 0],
                ["a", 1],
            ]);
            expect(first.nextCursor).toEqual({ txid: "a", vout: 1 });
            const second = await read("mine", { limit: 2, after: first.nextCursor });
            expect(second.items.map(({ txid, vout }) => [txid, vout])).toEqual([["b", 0]]);
            expect(second.nextCursor).toBeUndefined();
        }
    });

    it("collects every coin across the maximum page boundary", async () => {
        await using repository = create();
        const vtxos = Array.from({ length: 501 }, (_, i) =>
            createMockVtxo(`tx-${String(i).padStart(4, "0")}`, 0, 1_000),
        );
        await repository.saveVtxos("mine", vtxos);
        await repository.saveUtxos(
            "mine",
            vtxos.map((vtxo) => createMockUtxo(vtxo.txid, 0, vtxo.value)),
        );

        expect((await collectVtxos(repository, "mine")).map((vtxo) => vtxo.txid)).toEqual(
            vtxos.map((vtxo) => vtxo.txid),
        );
        expect((await collectUtxos(repository, "mine")).map((utxo) => utxo.txid)).toEqual(
            vtxos.map((vtxo) => vtxo.txid),
        );
        const script = vtxos[0].script!;
        const first = await repository.getVtxosForScriptPage!(script, { limit: 500 });
        const second = await repository.getVtxosForScriptPage!(script, {
            limit: 500,
            after: first.nextCursor,
        });
        expect(first.items).toHaveLength(500);
        expect(second.items).toHaveLength(1);
        expect((await collectScriptVtxos(repository, script)).map((vtxo) => vtxo.txid)).toEqual(
            vtxos.map((vtxo) => vtxo.txid),
        );
    });
});
