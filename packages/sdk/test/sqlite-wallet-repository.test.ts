import { collectScriptVtxos } from "../src/repositories/walletRepository";
import { collectTransactionHistory } from "../src/repositories/walletRepository";
import { collectVtxos } from "../src/repositories/walletRepository";
import { collectUtxos } from "../src/repositories/walletRepository";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import { TaprootControlBlock } from "@scure/btc-signer";
import { SQLiteWalletRepository } from "../src/repositories/sqlite/walletRepository";
import type { SQLExecutor } from "../src/repositories/sqlite/types";
import type { ExtendedVirtualCoin, ExtendedCoin, ArkTransaction, TxType } from "../src/wallet";
import type { TapLeafScript } from "../src/script/base";
import type { WalletState } from "../src/repositories/walletRepository";
import { createMockSQLExecutor } from "./helpers/mockSqlExecutor";
import { createNodeSQLExecutor } from "../../../config/test-helpers/nodeSqlExecutor";
import { isVtxoSpent } from "../src/wallet/vtxo";

// ── Test fixtures ───────────────────────────────────────────────────────

function createMockTapLeafScript(): TapLeafScript {
    const version = 0xc0;
    const internalKey = new Uint8Array(32).fill(1);
    const controlBlockBytes = new Uint8Array([version, ...internalKey]);
    const controlBlock = TaprootControlBlock.decode(controlBlockBytes);
    const script = new Uint8Array(20).fill(2);
    return [controlBlock, script];
}

function createMockVtxo(txid: string, vout: number, value: number): ExtendedVirtualCoin {
    const tapLeaf = createMockTapLeafScript();
    return {
        txid,
        vout,
        value,
        status: {
            confirmed: true,
            block_height: 100,
            block_hash: hex.encode(new Uint8Array(32).fill(1)),
            block_time: 1700000000,
        },
        isPreconfirmed: true,
        createdAt: new Date("2024-01-15T12:00:00Z"),
        isUnrolled: false,
        isSpent: false,
        script: "5120" + "00".repeat(32),
        forfeitTapLeafScript: tapLeaf,
        intentTapLeafScript: tapLeaf,
        tapTree: new Uint8Array(32).fill(3),
    };
}

function createMockVtxoWithExtras(txid: string, vout: number, value: number): ExtendedVirtualCoin {
    const tapLeaf = createMockTapLeafScript();
    return {
        txid,
        vout,
        value,
        status: {
            confirmed: true,
            block_height: 200,
            block_hash: hex.encode(new Uint8Array(32).fill(4)),
            block_time: 1700001000,
        },
        commitmentTxIds: ["commit-tx-1", "commit-tx-2"],
        expiresAt: new Date(1700100000 * 1000),
        createdAt: new Date("2024-02-20T08:30:00Z"),
        isUnrolled: true,
        isSpent: true,
        spentBy: "spent-by-tx",
        settledBy: "settled-by-tx",
        arkTxId: "ark-tx-123",
        forfeitTapLeafScript: tapLeaf,
        intentTapLeafScript: tapLeaf,
        tapTree: new Uint8Array(32).fill(5),
        extraWitness: [new Uint8Array([0xab, 0xcd]), new Uint8Array([0xef])],
        assets: [{ assetId: "asset-1", amount: 500n }],
        script: "5120deadbeef",
    };
}

function createMockUtxo(txid: string, vout: number, value: number): ExtendedCoin {
    const tapLeaf = createMockTapLeafScript();
    return {
        txid,
        vout,
        value,
        status: {
            confirmed: true,
            block_height: 100,
            block_hash: hex.encode(new Uint8Array(32).fill(1)),
            block_time: 1700000000,
        },
        forfeitTapLeafScript: tapLeaf,
        intentTapLeafScript: tapLeaf,
        tapTree: new Uint8Array(32).fill(3),
    };
}

function createMockUtxoWithExtras(txid: string, vout: number, value: number): ExtendedCoin {
    const tapLeaf = createMockTapLeafScript();
    return {
        txid,
        vout,
        value,
        status: {
            confirmed: false,
        },
        forfeitTapLeafScript: tapLeaf,
        intentTapLeafScript: tapLeaf,
        tapTree: new Uint8Array(32).fill(6),
        extraWitness: [new Uint8Array([0x11, 0x22])],
    };
}

let txCounter = 0;
function createMockTransaction(
    key: { boardingTxid?: string; commitmentTxid?: string; arkTxid?: string },
    type: TxType,
    amount: number,
    createdAt?: number,
): ArkTransaction {
    return {
        key: {
            boardingTxid: key.boardingTxid || "",
            commitmentTxid: key.commitmentTxid || "",
            arkTxid: key.arkTxid || "",
        },
        type,
        amount,
        settled: false,
        createdAt: createdAt ?? Date.now() + txCounter++,
    };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("SQLiteWalletRepository", () => {
    let db: SQLExecutor;
    let repository: SQLiteWalletRepository;
    const testAddress = "test-address-123";

    beforeEach(() => {
        db = createMockSQLExecutor();
        repository = new SQLiteWalletRepository(db);
    });

    afterEach(async () => {
        await repository.clear();
        await repository[Symbol.asyncDispose]();
    });

    // ── VTXO management ────────────────────────────────────────────────

    describe("VTXO management", () => {
        it("should return empty array when no VTXOs exist", async () => {
            const vtxos = await collectVtxos(repository, testAddress);
            expect(vtxos).toEqual([]);
        });

        it("should save and retrieve VTXOs", async () => {
            const vtxo1 = createMockVtxo("tx1", 0, 10000);
            const vtxo2 = createMockVtxo("tx2", 1, 20000);

            await repository.saveVtxos(testAddress, [vtxo1, vtxo2]);
            const retrieved = await collectVtxos(repository, testAddress);

            expect(retrieved).toHaveLength(2);
            expect(retrieved[0].txid).toBe("tx1");
            expect(retrieved[0].vout).toBe(0);
            expect(retrieved[0].value).toBe(10000);
            expect(retrieved[1].txid).toBe("tx2");
            expect(retrieved[1].vout).toBe(1);
            expect(retrieved[1].value).toBe(20000);
        });

        it("should round-trip VTXOs with all optional fields", async () => {
            const vtxo = createMockVtxoWithExtras("tx-full", 0, 50000);
            await repository.saveVtxos(testAddress, [vtxo]);
            const [retrieved] = await collectVtxos(repository, testAddress);

            expect(retrieved.txid).toBe("tx-full");
            expect(retrieved.value).toBe(50000);
            expect(retrieved.isUnrolled).toBe(true);
            expect(retrieved.isSpent).toBe(true);
            expect(retrieved.spentBy).toBe("spent-by-tx");
            expect(retrieved.settledBy).toBe("settled-by-tx");
            expect(retrieved.arkTxId).toBe("ark-tx-123");
            expect(retrieved.isSwept).toBe(false);
            expect(retrieved.isPreconfirmed).toBe(false);
            expect(retrieved.commitmentTxIds).toEqual(["commit-tx-1", "commit-tx-2"]);
            expect(retrieved.expiresAt?.toISOString()).toBe("2023-11-16T02:00:00.000Z");
            expect(retrieved.assets).toEqual([{ assetId: "asset-1", amount: 500n }]);
            // extraWitness round-trip (Uint8Array)
            expect(retrieved.extraWitness).toBeDefined();
            expect(retrieved.extraWitness!.length).toBe(2);
            expect(hex.encode(retrieved.extraWitness![0])).toBe("abcd");
            expect(hex.encode(retrieved.extraWitness![1])).toBe("ef");
            // script (hex scriptPubKey) round-trip
            expect(retrieved.script).toBe("5120deadbeef");
        });

        it("should round-trip tap tree and leaf scripts", async () => {
            const vtxo = createMockVtxo("tx-tap", 0, 5000);
            await repository.saveVtxos(testAddress, [vtxo]);
            const [retrieved] = await collectVtxos(repository, testAddress);

            // tapTree should survive serialization
            expect(retrieved.tapTree).toBeInstanceOf(Uint8Array);
            expect(hex.encode(retrieved.tapTree)).toBe(hex.encode(vtxo.tapTree));

            // TapLeafScript control block fields
            expect(retrieved.forfeitTapLeafScript[0].version).toBe(
                vtxo.forfeitTapLeafScript[0].version,
            );
            expect(hex.encode(retrieved.forfeitTapLeafScript[0].internalKey)).toBe(
                hex.encode(vtxo.forfeitTapLeafScript[0].internalKey),
            );
            expect(hex.encode(retrieved.forfeitTapLeafScript[1])).toBe(
                hex.encode(vtxo.forfeitTapLeafScript[1]),
            );
        });

        it("should update existing VTXO when saving with same txid/vout (upsert)", async () => {
            const vtxo1 = createMockVtxo("tx1", 0, 10000);
            await repository.saveVtxos(testAddress, [vtxo1]);

            const vtxo1Updated = createMockVtxo("tx1", 0, 15000);
            await repository.saveVtxos(testAddress, [vtxo1Updated]);

            const retrieved = await collectVtxos(repository, testAddress);
            expect(retrieved).toHaveLength(1);
            expect(retrieved[0].value).toBe(15000);
        });

        it("should delete VTXOs for an address", async () => {
            const vtxo1 = createMockVtxo("tx1", 0, 10000);
            await repository.saveVtxos(testAddress, [vtxo1]);

            await repository.deleteVtxos(testAddress);
            const retrieved = await collectVtxos(repository, testAddress);

            expect(retrieved).toEqual([]);
        });

        it("should handle multiple addresses independently", async () => {
            const address1 = "address-1";
            const address2 = "address-2";
            const vtxo1 = createMockVtxo("tx1", 0, 10000);
            const vtxo2 = createMockVtxo("tx2", 0, 20000);

            await repository.saveVtxos(address1, [vtxo1]);
            await repository.saveVtxos(address2, [vtxo2]);

            const retrieved1 = await collectVtxos(repository, address1);
            const retrieved2 = await collectVtxos(repository, address2);

            expect(retrieved1).toHaveLength(1);
            expect(retrieved1[0].txid).toBe("tx1");
            expect(retrieved2).toHaveLength(1);
            expect(retrieved2[0].txid).toBe("tx2");
        });

        it("should delete VTXOs for one address without affecting another", async () => {
            const address1 = "address-1";
            const address2 = "address-2";
            await repository.saveVtxos(address1, [createMockVtxo("tx1", 0, 10000)]);
            await repository.saveVtxos(address2, [createMockVtxo("tx2", 0, 20000)]);

            await repository.deleteVtxos(address1);

            expect(await collectVtxos(repository, address1)).toEqual([]);
            expect(await collectVtxos(repository, address2)).toHaveLength(1);
        });

        it("should preserve createdAt date through round-trip", async () => {
            const vtxo = createMockVtxo("tx-date", 0, 1000);
            vtxo.createdAt = new Date("2024-06-15T10:30:00.000Z");

            await repository.saveVtxos(testAddress, [vtxo]);
            const [retrieved] = await collectVtxos(repository, testAddress);

            expect(retrieved.createdAt).toBeInstanceOf(Date);
            expect(retrieved.createdAt.toISOString()).toBe("2024-06-15T10:30:00.000Z");
        });

        it("derives isSpent for a VTXO stored with a null is_spent column", async () => {
            // Surfacing `undefined` would read as spendable — see the normalizeVtxo cases in
            // vtxo-canonical.test.ts.
            const vtxo = createMockVtxo("tx-nospent", 0, 1000);
            (vtxo as any).isSpent = undefined;

            await repository.saveVtxos(testAddress, [vtxo]);
            const [retrieved] = await collectVtxos(repository, testAddress);

            // The fixture is preconfirmed, so the derivation says "not spent".
            expect(retrieved.isSpent).toBe(false);
            expect(isVtxoSpent(retrieved)).toBe(false);
        });

        it("preserves terminal spend for a VTXO stored with a null is_spent column", async () => {
            const vtxo = createMockVtxo("tx-nospent-spent", 0, 1000);
            (vtxo as any).isSpent = undefined;
            vtxo.spentBy = "spent-by-tx";

            await repository.saveVtxos(testAddress, [vtxo]);
            const [retrieved] = await collectVtxos(repository, testAddress);

            expect(retrieved.isSpent).toBe(false);
            expect(retrieved.spentBy).toBe("spent-by-tx");
            expect(isVtxoSpent(retrieved)).toBe(true);
        });

        describe("Script-scoped VTXO management", () => {
            it("should return empty array when no VTXOs exist for script", async () => {
                const vtxos = await collectScriptVtxos(repository, "script1");
                expect(vtxos).toEqual([]);
            });

            it("should save and retrieve VTXOs by script", async () => {
                const script1 = "script1";
                const address1 = "address1";
                const vtxo1 = {
                    ...createMockVtxo("tx1", 0, 10000),
                    script: script1,
                };

                await repository.saveVtxosForScript({ script: script1, address: address1 }, [
                    vtxo1,
                ]);
                const retrieved = await collectScriptVtxos(repository, script1);

                expect(retrieved).toHaveLength(1);
                expect(retrieved[0].txid).toBe("tx1");
                expect(retrieved[0].script).toBe(script1);
            });

            it("should throw when saving VTXO with mismatched script", async () => {
                const script1 = "script1";
                const address1 = "address1";
                const vtxo1 = {
                    ...createMockVtxo("tx1", 0, 10000),
                    script: "wrong-script",
                };

                await expect(
                    repository.saveVtxosForScript({ script: script1, address: address1 }, [vtxo1]),
                ).rejects.toThrow();
            });

            it("should delete VTXOs by script", async () => {
                const script1 = "script1";
                const address1 = "address1";
                const vtxo1 = {
                    ...createMockVtxo("tx1", 0, 10000),
                    script: script1,
                };

                await repository.saveVtxos(address1, [vtxo1]);
                await repository.deleteVtxosForScript(script1);

                expect(await collectScriptVtxos(repository, script1)).toEqual([]);
            });

            it("should read by script, not address", async () => {
                const address1 = "address1";
                const scriptA = "scriptA";
                const scriptB = "scriptB";
                const vtxoA = {
                    ...createMockVtxo("tx1", 0, 10000),
                    script: scriptA,
                };
                const vtxoB = {
                    ...createMockVtxo("tx2", 0, 20000),
                    script: scriptB,
                };

                await repository.saveVtxos(address1, [vtxoA, vtxoB]);

                const resultA = await collectScriptVtxos(repository, scriptA);
                const resultB = await collectScriptVtxos(repository, scriptB);

                expect(resultA).toHaveLength(1);
                expect(resultA[0].txid).toBe("tx1");
                expect(resultB).toHaveLength(1);
                expect(resultB[0].txid).toBe("tx2");
            });

            it("unspent-only script reads drop every terminal shape", async () => {
                // The regex SQL mock cannot evaluate the unspent predicate, so this needs a real SQLite handle.
                const sqlite = new SQLiteWalletRepository(createNodeSQLExecutor());
                const script = "5120" + "00".repeat(32);
                const live = { ...createMockVtxo("00".repeat(32), 0, 1000), script };
                await sqlite.saveVtxos("address", [
                    live,
                    { ...live, txid: "03".padStart(64, "0"), isSpent: true },
                    { ...live, txid: "04".padStart(64, "0"), spentBy: "spent" },
                    { ...live, txid: "05".padStart(64, "0"), settledBy: "settled" },
                    { ...live, txid: "06".padStart(64, "0"), script: "5120" + "ff".repeat(32) },
                ]);

                expect(await collectScriptVtxos(sqlite, script)).toHaveLength(4);
                const unspent = await collectScriptVtxos(sqlite, script, { unspentOnly: true });
                expect(unspent.map((row) => row.txid)).toEqual([live.txid]);
            });

            it("unspent-only script reads match the full read across address buckets", async () => {
                // VTXOs are keyed by outpoint, so no spent copy can hide in another bucket.
                const sqlite = new SQLiteWalletRepository(createNodeSQLExecutor());
                const script = "5120" + "00".repeat(32);
                const live = { ...createMockVtxo("00".repeat(32), 0, 1000), script };
                await sqlite.saveVtxos("address-a", [live]);
                await sqlite.saveVtxos("address-b", [
                    { ...live, isSpent: true, spentBy: "spender" },
                ]);

                const full = await collectScriptVtxos(sqlite, script);
                const unspent = await collectScriptVtxos(sqlite, script, { unspentOnly: true });
                expect(unspent).toEqual(full.filter((vtxo) => !isVtxoSpent(vtxo)));
            });
        });
    });

    // ── UTXO management ────────────────────────────────────────────────

    describe("UTXO management", () => {
        it("should return empty array when no UTXOs exist", async () => {
            const utxos = await collectUtxos(repository, testAddress);
            expect(utxos).toEqual([]);
        });

        it("should save and retrieve UTXOs", async () => {
            const utxo1 = createMockUtxo("tx1", 0, 10000);
            const utxo2 = createMockUtxo("tx2", 1, 20000);

            await repository.saveUtxos(testAddress, [utxo1, utxo2]);
            const retrieved = await collectUtxos(repository, testAddress);

            expect(retrieved).toHaveLength(2);
            expect(retrieved[0].txid).toBe("tx1");
            expect(retrieved[0].vout).toBe(0);
            expect(retrieved[0].value).toBe(10000);
        });

        it("should round-trip UTXOs with extraWitness", async () => {
            const utxo = createMockUtxoWithExtras("tx-extra", 0, 30000);
            await repository.saveUtxos(testAddress, [utxo]);
            const [retrieved] = await collectUtxos(repository, testAddress);

            expect(retrieved.txid).toBe("tx-extra");
            expect(retrieved.value).toBe(30000);
            expect(retrieved.extraWitness).toBeDefined();
            expect(hex.encode(retrieved.extraWitness![0])).toBe("1122");
            expect(retrieved.status.confirmed).toBe(false);
        });

        it("should update existing UTXO when saving with same txid/vout", async () => {
            const utxo1 = createMockUtxo("tx1", 0, 10000);
            await repository.saveUtxos(testAddress, [utxo1]);

            const utxo1Updated = createMockUtxo("tx1", 0, 15000);
            await repository.saveUtxos(testAddress, [utxo1Updated]);

            const retrieved = await collectUtxos(repository, testAddress);
            expect(retrieved).toHaveLength(1);
            expect(retrieved[0].value).toBe(15000);
        });

        it("should delete UTXOs for an address", async () => {
            const utxo1 = createMockUtxo("tx1", 0, 10000);
            await repository.saveUtxos(testAddress, [utxo1]);

            await repository.deleteUtxos(testAddress);
            const retrieved = await collectUtxos(repository, testAddress);

            expect(retrieved).toEqual([]);
        });

        it("should handle multiple addresses independently", async () => {
            const address1 = "address-1";
            const address2 = "address-2";
            await repository.saveUtxos(address1, [createMockUtxo("tx1", 0, 10000)]);
            await repository.saveUtxos(address2, [createMockUtxo("tx2", 0, 20000)]);

            const retrieved1 = await collectUtxos(repository, address1);
            const retrieved2 = await collectUtxos(repository, address2);

            expect(retrieved1).toHaveLength(1);
            expect(retrieved1[0].txid).toBe("tx1");
            expect(retrieved2).toHaveLength(1);
            expect(retrieved2[0].txid).toBe("tx2");
        });

        it("should round-trip tap tree and leaf scripts for UTXOs", async () => {
            const utxo = createMockUtxo("tx-tap-utxo", 0, 7000);
            await repository.saveUtxos(testAddress, [utxo]);
            const [retrieved] = await collectUtxos(repository, testAddress);

            expect(retrieved.tapTree).toBeInstanceOf(Uint8Array);
            expect(hex.encode(retrieved.tapTree)).toBe(hex.encode(utxo.tapTree));
            expect(retrieved.forfeitTapLeafScript[0].version).toBe(
                utxo.forfeitTapLeafScript[0].version,
            );
        });
    });

    // ── Transaction history ────────────────────────────────────────────

    describe("Transaction history", () => {
        it("should return empty array when no transactions exist", async () => {
            const txs = await collectTransactionHistory(repository, testAddress);
            expect(txs).toEqual([]);
        });

        it("should save and retrieve transactions", async () => {
            const tx1 = createMockTransaction({ arkTxid: "atx1" }, "SENT" as TxType, 10000, 1000);
            const tx2 = createMockTransaction(
                { boardingTxid: "btx2" },
                "RECEIVED" as TxType,
                20000,
                2000,
            );
            const tx3 = createMockTransaction(
                { commitmentTxid: "ctx3" },
                "RECEIVED" as TxType,
                30000,
                3000,
            );

            await repository.saveTransactions(testAddress, [tx1, tx2, tx3]);
            const retrieved = await collectTransactionHistory(repository, testAddress);

            expect(retrieved).toHaveLength(3);
            expect(retrieved[0].key.arkTxid).toBe("atx1");
            expect(retrieved[0].type).toBe("SENT");
            expect(retrieved[1].key.boardingTxid).toBe("btx2");
            expect(retrieved[1].type).toBe("RECEIVED");
            expect(retrieved[2].key.commitmentTxid).toBe("ctx3");
            expect(retrieved[2].type).toBe("RECEIVED");
        });

        it("should return transactions sorted by createdAt ASC", async () => {
            const tx1 = createMockTransaction(
                { arkTxid: "atx-late" },
                "SENT" as TxType,
                5000,
                3000,
            );
            const tx2 = createMockTransaction(
                { arkTxid: "atx-early" },
                "RECEIVED" as TxType,
                7000,
                1000,
            );
            const tx3 = createMockTransaction({ arkTxid: "atx-mid" }, "SENT" as TxType, 3000, 2000);

            await repository.saveTransactions(testAddress, [tx1, tx2, tx3]);
            const retrieved = await collectTransactionHistory(repository, testAddress);

            expect(retrieved).toHaveLength(3);
            expect(retrieved[0].key.arkTxid).toBe("atx-early");
            expect(retrieved[1].key.arkTxid).toBe("atx-mid");
            expect(retrieved[2].key.arkTxid).toBe("atx-late");
        });

        it("should update existing transaction when saving with same key (upsert)", async () => {
            const tx1 = createMockTransaction({ arkTxid: "atx1" }, "SENT" as TxType, 10000, 1000);
            await repository.saveTransactions(testAddress, [tx1]);

            const tx1Updated = createMockTransaction(
                { arkTxid: "atx1" },
                "SENT" as TxType,
                15000,
                1000,
            );
            await repository.saveTransactions(testAddress, [tx1Updated]);

            const retrieved = await collectTransactionHistory(repository, testAddress);
            expect(retrieved).toHaveLength(1);
            expect(retrieved[0].amount).toBe(15000);
        });

        it("should delete transactions for an address", async () => {
            const tx1 = createMockTransaction({ arkTxid: "atx1" }, "SENT" as TxType, 10000, 1000);
            await repository.saveTransactions(testAddress, [tx1]);

            await repository.deleteTransactions(testAddress);
            const retrieved = await collectTransactionHistory(repository, testAddress);

            expect(retrieved).toEqual([]);
        });

        it("should handle transactions with assets", async () => {
            const tx: ArkTransaction = {
                key: {
                    boardingTxid: "",
                    commitmentTxid: "",
                    arkTxid: "atx-assets",
                },
                type: "SENT" as TxType,
                amount: 1000,
                settled: true,
                createdAt: 5000,
                assets: [
                    { assetId: "asset-a", amount: 100n },
                    { assetId: "asset-b", amount: 200n },
                ],
            };

            await repository.saveTransactions(testAddress, [tx]);
            const [retrieved] = await collectTransactionHistory(repository, testAddress);

            expect(retrieved.settled).toBe(true);
            expect(retrieved.assets).toEqual([
                { assetId: "asset-a", amount: 100n },
                { assetId: "asset-b", amount: 200n },
            ]);
        });

        it("should handle transactions for multiple addresses independently", async () => {
            const address1 = "address-1";
            const address2 = "address-2";

            const tx1 = createMockTransaction({ arkTxid: "atx1" }, "SENT" as TxType, 10000, 1000);
            const tx2 = createMockTransaction(
                { arkTxid: "atx2" },
                "RECEIVED" as TxType,
                20000,
                2000,
            );

            await repository.saveTransactions(address1, [tx1]);
            await repository.saveTransactions(address2, [tx2]);

            const retrieved1 = await collectTransactionHistory(repository, address1);
            const retrieved2 = await collectTransactionHistory(repository, address2);

            expect(retrieved1).toHaveLength(1);
            expect(retrieved1[0].key.arkTxid).toBe("atx1");
            expect(retrieved2).toHaveLength(1);
            expect(retrieved2[0].key.arkTxid).toBe("atx2");
        });
    });

    // ── Wallet state ───────────────────────────────────────────────────

    describe("Wallet state", () => {
        it("should return null when no wallet state exists", async () => {
            const state = await repository.getWalletState();
            expect(state).toBeNull();
        });

        it("should save and retrieve wallet state", async () => {
            const state: WalletState = {
                settings: { theme: "dark" },
                lastSyncTime: 1000,
            };

            await repository.saveWalletState(state);
            const retrieved = await repository.getWalletState();

            expect(retrieved).toEqual(state);
        });

        it("should update existing wallet state", async () => {
            const state1: WalletState = {
                settings: { theme: "dark" },
            };
            await repository.saveWalletState(state1);

            const state2: WalletState = {
                settings: { theme: "light" },
            };
            await repository.saveWalletState(state2);

            const retrieved = await repository.getWalletState();
            expect(retrieved).toEqual(state2);
        });

        it("should handle wallet state with only settings", async () => {
            const state: WalletState = {
                settings: { key: "value", nested: { a: 1 } },
            };
            await repository.saveWalletState(state);

            const retrieved = await repository.getWalletState();
            expect(retrieved?.settings).toEqual({
                key: "value",
                nested: { a: 1 },
            });
        });
    });

    // ── Clear ──────────────────────────────────────────────────────────

    describe("clear()", () => {
        it("should clear all data from all tables", async () => {
            await repository.saveVtxos(testAddress, [createMockVtxo("tx1", 0, 10000)]);
            await repository.saveUtxos(testAddress, [createMockUtxo("tx2", 0, 20000)]);
            await repository.saveTransactions(testAddress, [
                createMockTransaction({ arkTxid: "atx1" }, "SENT" as TxType, 5000, 1000),
            ]);
            await repository.clear();

            expect(await collectVtxos(repository, testAddress)).toEqual([]);
            expect(await collectUtxos(repository, testAddress)).toEqual([]);
            expect(await collectTransactionHistory(repository, testAddress)).toEqual([]);
            expect(await repository.getWalletState()).toBeNull();
        });
    });

    // ── Table prefix ───────────────────────────────────────────────────

    describe("table prefix", () => {
        it("should isolate data between different prefixes", async () => {
            const repoA = new SQLiteWalletRepository(db, { prefix: "a_" });
            const repoB = new SQLiteWalletRepository(db, { prefix: "b_" });

            await repoA.saveVtxos(testAddress, [createMockVtxo("tx-a", 0, 1000)]);
            await repoB.saveVtxos(testAddress, [createMockVtxo("tx-b", 0, 2000)]);

            const fromA = await collectVtxos(repoA, testAddress);
            const fromB = await collectVtxos(repoB, testAddress);

            expect(fromA).toHaveLength(1);
            expect(fromA[0].txid).toBe("tx-a");
            expect(fromB).toHaveLength(1);
            expect(fromB[0].txid).toBe("tx-b");
        });
    });
});
