import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import { TaprootControlBlock } from "@scure/btc-signer";
import { SQLiteWalletRepository } from "../src/repositories/sqlite/walletRepository";
import type { SQLExecutor } from "../src/repositories/sqlite/types";
import type {
    ExtendedVirtualCoin,
    ExtendedCoin,
    ArkTransaction,
    TxType,
} from "../src/wallet";
import type { TapLeafScript } from "../src/script/base";
import type { WalletState } from "../src/repositories/walletRepository";

// ── Mock SQLExecutor ────────────────────────────────────────────────────
// A lightweight in-memory SQL engine that supports the subset of SQL
// used by SQLiteWalletRepository: CREATE TABLE, INSERT OR REPLACE,
// SELECT, DELETE, and ORDER BY.

interface TableDef {
    primaryKey: string[];
    rows: Map<string, Record<string, unknown>>;
}

function createMockSQLExecutor(): SQLExecutor {
    const tables = new Map<string, TableDef>();

    function parseCreateTable(sql: string): { name: string; pk: string[] } {
        const nameMatch = sql.match(
            /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i
        );
        if (!nameMatch) throw new Error(`Cannot parse CREATE TABLE: ${sql}`);
        const name = nameMatch[1];
        const pkMatch = sql.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
        let pk: string[] = [];
        if (pkMatch) {
            pk = pkMatch[1].split(",").map((s) => s.trim());
        } else {
            // check for column-level PRIMARY KEY
            const colPkMatch = sql.match(/(\w+)\s+TEXT\s+PRIMARY\s+KEY/i);
            if (colPkMatch) pk = [colPkMatch[1]];
        }
        return { name, pk };
    }

    function parseInsertOrReplace(sql: string): {
        table: string;
        columns: string[];
    } {
        const match = sql.match(
            /INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)/i
        );
        if (!match) throw new Error(`Cannot parse INSERT OR REPLACE: ${sql}`);
        const table = match[1];
        const columns = match[2].split(",").map((s) => s.trim());
        return { table, columns };
    }

    function parseSelect(sql: string): {
        table: string;
        whereCol?: string;
        orderByCol?: string;
        orderDir?: string;
    } {
        const match = sql.match(/SELECT\s+\*\s+FROM\s+(\w+)/i);
        if (!match) throw new Error(`Cannot parse SELECT: ${sql}`);
        const table = match[1];
        const whereMatch = sql.match(/WHERE\s+(\w+)\s*=\s*\?/i);
        const orderMatch = sql.match(/ORDER\s+BY\s+(\w+)\s+(ASC|DESC)/i);
        return {
            table,
            whereCol: whereMatch?.[1],
            orderByCol: orderMatch?.[1],
            orderDir: orderMatch?.[2],
        };
    }

    function parseDelete(sql: string): { table: string; whereCol?: string } {
        const match = sql.match(/DELETE\s+FROM\s+(\w+)/i);
        if (!match) throw new Error(`Cannot parse DELETE: ${sql}`);
        const table = match[1];
        const whereMatch = sql.match(/WHERE\s+(\w+)\s*=\s*\?/i);
        return { table, whereCol: whereMatch?.[1] };
    }

    function getTable(name: string): TableDef {
        const t = tables.get(name);
        if (!t) throw new Error(`Table ${name} does not exist`);
        return t;
    }

    function rowKey(pk: string[], row: Record<string, unknown>): string {
        return pk.map((col) => String(row[col] ?? "")).join("\x00");
    }

    const executor: SQLExecutor = {
        async run(sql: string, params?: unknown[]): Promise<void> {
            const trimmed = sql.trim();

            if (/^CREATE\s+TABLE/i.test(trimmed)) {
                const { name, pk } = parseCreateTable(trimmed);
                if (!tables.has(name)) {
                    tables.set(name, { primaryKey: pk, rows: new Map() });
                }
                return;
            }

            if (/^INSERT\s+OR\s+REPLACE/i.test(trimmed)) {
                const { table, columns } = parseInsertOrReplace(trimmed);
                const t = getTable(table);
                const row: Record<string, unknown> = {};
                columns.forEach((col, i) => {
                    row[col] = params?.[i] ?? null;
                });
                const key = rowKey(t.primaryKey, row);
                t.rows.set(key, row);
                return;
            }

            if (/^DELETE/i.test(trimmed)) {
                const { table, whereCol } = parseDelete(trimmed);
                const t = getTable(table);
                if (!whereCol) {
                    t.rows.clear();
                } else {
                    const value = params?.[0];
                    for (const [key, row] of t.rows) {
                        if (row[whereCol] === value) {
                            t.rows.delete(key);
                        }
                    }
                }
                return;
            }

            throw new Error(`Unsupported SQL in run(): ${trimmed}`);
        },

        async get<T = Record<string, unknown>>(
            sql: string,
            params?: unknown[]
        ): Promise<T | undefined> {
            const trimmed = sql.trim();
            const { table, whereCol } = parseSelect(trimmed);
            const t = getTable(table);

            if (!whereCol) {
                const first = t.rows.values().next();
                return first.done ? undefined : (first.value as T);
            }

            const value = params?.[0];
            for (const row of t.rows.values()) {
                if (row[whereCol] === value) {
                    return row as T;
                }
            }
            return undefined;
        },

        async all<T = Record<string, unknown>>(
            sql: string,
            params?: unknown[]
        ): Promise<T[]> {
            const trimmed = sql.trim();
            const { table, whereCol, orderByCol, orderDir } =
                parseSelect(trimmed);
            const t = getTable(table);

            let results: Record<string, unknown>[] = [];

            if (!whereCol) {
                results = Array.from(t.rows.values());
            } else {
                const value = params?.[0];
                for (const row of t.rows.values()) {
                    if (row[whereCol] === value) {
                        results.push(row);
                    }
                }
            }

            if (orderByCol) {
                results.sort((a, b) => {
                    const va = a[orderByCol] as number | string;
                    const vb = b[orderByCol] as number | string;
                    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
                    return orderDir === "DESC" ? -cmp : cmp;
                });
            }

            return results as T[];
        },
    };

    return executor;
}

// ── Test fixtures ───────────────────────────────────────────────────────

function createMockTapLeafScript(): TapLeafScript {
    const version = 0xc0;
    const internalKey = new Uint8Array(32).fill(1);
    const controlBlockBytes = new Uint8Array([version, ...internalKey]);
    const controlBlock = TaprootControlBlock.decode(controlBlockBytes);
    const script = new Uint8Array(20).fill(2);
    return [controlBlock, script];
}

function createMockVtxo(
    txid: string,
    vout: number,
    value: number
): ExtendedVirtualCoin {
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
        virtualStatus: {
            state: "preconfirmed",
        },
        createdAt: new Date("2024-01-15T12:00:00Z"),
        isUnrolled: false,
        isSpent: false,
        forfeitTapLeafScript: tapLeaf,
        intentTapLeafScript: tapLeaf,
        tapTree: new Uint8Array(32).fill(3),
    };
}

function createMockVtxoWithExtras(
    txid: string,
    vout: number,
    value: number
): ExtendedVirtualCoin {
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
        virtualStatus: {
            state: "settled",
            commitmentTxIds: ["commit-tx-1", "commit-tx-2"],
            batchExpiry: 1700100000,
        },
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
        assets: [{ assetId: "asset-1", amount: 500 }],
    };
}

function createMockUtxo(
    txid: string,
    vout: number,
    value: number
): ExtendedCoin {
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

function createMockUtxoWithExtras(
    txid: string,
    vout: number,
    value: number
): ExtendedCoin {
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
    createdAt?: number
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

    // ── version ────────────────────────────────────────────────────────

    it("should have version 1", () => {
        expect(repository.version).toBe(1);
    });

    // ── VTXO management ────────────────────────────────────────────────

    describe("VTXO management", () => {
        it("should return empty array when no VTXOs exist", async () => {
            const vtxos = await repository.getVtxos(testAddress);
            expect(vtxos).toEqual([]);
        });

        it("should save and retrieve VTXOs", async () => {
            const vtxo1 = createMockVtxo("tx1", 0, 10000);
            const vtxo2 = createMockVtxo("tx2", 1, 20000);

            await repository.saveVtxos(testAddress, [vtxo1, vtxo2]);
            const retrieved = await repository.getVtxos(testAddress);

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
            const [retrieved] = await repository.getVtxos(testAddress);

            expect(retrieved.txid).toBe("tx-full");
            expect(retrieved.value).toBe(50000);
            expect(retrieved.isUnrolled).toBe(true);
            expect(retrieved.isSpent).toBe(true);
            expect(retrieved.spentBy).toBe("spent-by-tx");
            expect(retrieved.settledBy).toBe("settled-by-tx");
            expect(retrieved.arkTxId).toBe("ark-tx-123");
            expect(retrieved.virtualStatus.state).toBe("settled");
            expect(retrieved.virtualStatus.commitmentTxIds).toEqual([
                "commit-tx-1",
                "commit-tx-2",
            ]);
            expect(retrieved.virtualStatus.batchExpiry).toBe(1700100000);
            expect(retrieved.assets).toEqual([
                { assetId: "asset-1", amount: 500 },
            ]);
            // extraWitness round-trip (Uint8Array)
            expect(retrieved.extraWitness).toBeDefined();
            expect(retrieved.extraWitness!.length).toBe(2);
            expect(hex.encode(retrieved.extraWitness![0])).toBe("abcd");
            expect(hex.encode(retrieved.extraWitness![1])).toBe("ef");
        });

        it("should round-trip tap tree and leaf scripts", async () => {
            const vtxo = createMockVtxo("tx-tap", 0, 5000);
            await repository.saveVtxos(testAddress, [vtxo]);
            const [retrieved] = await repository.getVtxos(testAddress);

            // tapTree should survive serialization
            expect(retrieved.tapTree).toBeInstanceOf(Uint8Array);
            expect(hex.encode(retrieved.tapTree)).toBe(
                hex.encode(vtxo.tapTree)
            );

            // TapLeafScript control block fields
            expect(retrieved.forfeitTapLeafScript[0].version).toBe(
                vtxo.forfeitTapLeafScript[0].version
            );
            expect(
                hex.encode(retrieved.forfeitTapLeafScript[0].internalKey)
            ).toBe(hex.encode(vtxo.forfeitTapLeafScript[0].internalKey));
            expect(hex.encode(retrieved.forfeitTapLeafScript[1])).toBe(
                hex.encode(vtxo.forfeitTapLeafScript[1])
            );
        });

        it("should update existing VTXO when saving with same txid/vout (upsert)", async () => {
            const vtxo1 = createMockVtxo("tx1", 0, 10000);
            await repository.saveVtxos(testAddress, [vtxo1]);

            const vtxo1Updated = createMockVtxo("tx1", 0, 15000);
            await repository.saveVtxos(testAddress, [vtxo1Updated]);

            const retrieved = await repository.getVtxos(testAddress);
            expect(retrieved).toHaveLength(1);
            expect(retrieved[0].value).toBe(15000);
        });

        it("should delete VTXOs for an address", async () => {
            const vtxo1 = createMockVtxo("tx1", 0, 10000);
            await repository.saveVtxos(testAddress, [vtxo1]);

            await repository.deleteVtxos(testAddress);
            const retrieved = await repository.getVtxos(testAddress);

            expect(retrieved).toEqual([]);
        });

        it("should handle multiple addresses independently", async () => {
            const address1 = "address-1";
            const address2 = "address-2";
            const vtxo1 = createMockVtxo("tx1", 0, 10000);
            const vtxo2 = createMockVtxo("tx2", 0, 20000);

            await repository.saveVtxos(address1, [vtxo1]);
            await repository.saveVtxos(address2, [vtxo2]);

            const retrieved1 = await repository.getVtxos(address1);
            const retrieved2 = await repository.getVtxos(address2);

            expect(retrieved1).toHaveLength(1);
            expect(retrieved1[0].txid).toBe("tx1");
            expect(retrieved2).toHaveLength(1);
            expect(retrieved2[0].txid).toBe("tx2");
        });

        it("should delete VTXOs for one address without affecting another", async () => {
            const address1 = "address-1";
            const address2 = "address-2";
            await repository.saveVtxos(address1, [
                createMockVtxo("tx1", 0, 10000),
            ]);
            await repository.saveVtxos(address2, [
                createMockVtxo("tx2", 0, 20000),
            ]);

            await repository.deleteVtxos(address1);

            expect(await repository.getVtxos(address1)).toEqual([]);
            expect(await repository.getVtxos(address2)).toHaveLength(1);
        });

        it("should preserve createdAt date through round-trip", async () => {
            const vtxo = createMockVtxo("tx-date", 0, 1000);
            vtxo.createdAt = new Date("2024-06-15T10:30:00.000Z");

            await repository.saveVtxos(testAddress, [vtxo]);
            const [retrieved] = await repository.getVtxos(testAddress);

            expect(retrieved.createdAt).toBeInstanceOf(Date);
            expect(retrieved.createdAt.toISOString()).toBe(
                "2024-06-15T10:30:00.000Z"
            );
        });

        it("should handle VTXO with isSpent undefined", async () => {
            const vtxo = createMockVtxo("tx-nospent", 0, 1000);
            (vtxo as any).isSpent = undefined;

            await repository.saveVtxos(testAddress, [vtxo]);
            const [retrieved] = await repository.getVtxos(testAddress);

            expect(retrieved.isSpent).toBeUndefined();
        });
    });

    // ── UTXO management ────────────────────────────────────────────────

    describe("UTXO management", () => {
        it("should return empty array when no UTXOs exist", async () => {
            const utxos = await repository.getUtxos(testAddress);
            expect(utxos).toEqual([]);
        });

        it("should save and retrieve UTXOs", async () => {
            const utxo1 = createMockUtxo("tx1", 0, 10000);
            const utxo2 = createMockUtxo("tx2", 1, 20000);

            await repository.saveUtxos(testAddress, [utxo1, utxo2]);
            const retrieved = await repository.getUtxos(testAddress);

            expect(retrieved).toHaveLength(2);
            expect(retrieved[0].txid).toBe("tx1");
            expect(retrieved[0].vout).toBe(0);
            expect(retrieved[0].value).toBe(10000);
        });

        it("should round-trip UTXOs with extraWitness", async () => {
            const utxo = createMockUtxoWithExtras("tx-extra", 0, 30000);
            await repository.saveUtxos(testAddress, [utxo]);
            const [retrieved] = await repository.getUtxos(testAddress);

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

            const retrieved = await repository.getUtxos(testAddress);
            expect(retrieved).toHaveLength(1);
            expect(retrieved[0].value).toBe(15000);
        });

        it("should delete UTXOs for an address", async () => {
            const utxo1 = createMockUtxo("tx1", 0, 10000);
            await repository.saveUtxos(testAddress, [utxo1]);

            await repository.deleteUtxos(testAddress);
            const retrieved = await repository.getUtxos(testAddress);

            expect(retrieved).toEqual([]);
        });

        it("should handle multiple addresses independently", async () => {
            const address1 = "address-1";
            const address2 = "address-2";
            await repository.saveUtxos(address1, [
                createMockUtxo("tx1", 0, 10000),
            ]);
            await repository.saveUtxos(address2, [
                createMockUtxo("tx2", 0, 20000),
            ]);

            const retrieved1 = await repository.getUtxos(address1);
            const retrieved2 = await repository.getUtxos(address2);

            expect(retrieved1).toHaveLength(1);
            expect(retrieved1[0].txid).toBe("tx1");
            expect(retrieved2).toHaveLength(1);
            expect(retrieved2[0].txid).toBe("tx2");
        });

        it("should round-trip tap tree and leaf scripts for UTXOs", async () => {
            const utxo = createMockUtxo("tx-tap-utxo", 0, 7000);
            await repository.saveUtxos(testAddress, [utxo]);
            const [retrieved] = await repository.getUtxos(testAddress);

            expect(retrieved.tapTree).toBeInstanceOf(Uint8Array);
            expect(hex.encode(retrieved.tapTree)).toBe(
                hex.encode(utxo.tapTree)
            );
            expect(retrieved.forfeitTapLeafScript[0].version).toBe(
                utxo.forfeitTapLeafScript[0].version
            );
        });
    });

    // ── Transaction history ────────────────────────────────────────────

    describe("Transaction history", () => {
        it("should return empty array when no transactions exist", async () => {
            const txs = await repository.getTransactionHistory(testAddress);
            expect(txs).toEqual([]);
        });

        it("should save and retrieve transactions", async () => {
            const tx1 = createMockTransaction(
                { arkTxid: "atx1" },
                "SENT" as TxType,
                10000,
                1000
            );
            const tx2 = createMockTransaction(
                { boardingTxid: "btx2" },
                "RECEIVED" as TxType,
                20000,
                2000
            );
            const tx3 = createMockTransaction(
                { commitmentTxid: "ctx3" },
                "RECEIVED" as TxType,
                30000,
                3000
            );

            await repository.saveTransactions(testAddress, [tx1, tx2, tx3]);
            const retrieved =
                await repository.getTransactionHistory(testAddress);

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
                3000
            );
            const tx2 = createMockTransaction(
                { arkTxid: "atx-early" },
                "RECEIVED" as TxType,
                7000,
                1000
            );
            const tx3 = createMockTransaction(
                { arkTxid: "atx-mid" },
                "SENT" as TxType,
                3000,
                2000
            );

            await repository.saveTransactions(testAddress, [tx1, tx2, tx3]);
            const retrieved =
                await repository.getTransactionHistory(testAddress);

            expect(retrieved).toHaveLength(3);
            expect(retrieved[0].key.arkTxid).toBe("atx-early");
            expect(retrieved[1].key.arkTxid).toBe("atx-mid");
            expect(retrieved[2].key.arkTxid).toBe("atx-late");
        });

        it("should update existing transaction when saving with same key (upsert)", async () => {
            const tx1 = createMockTransaction(
                { arkTxid: "atx1" },
                "SENT" as TxType,
                10000,
                1000
            );
            await repository.saveTransactions(testAddress, [tx1]);

            const tx1Updated = createMockTransaction(
                { arkTxid: "atx1" },
                "SENT" as TxType,
                15000,
                1000
            );
            await repository.saveTransactions(testAddress, [tx1Updated]);

            const retrieved =
                await repository.getTransactionHistory(testAddress);
            expect(retrieved).toHaveLength(1);
            expect(retrieved[0].amount).toBe(15000);
        });

        it("should delete transactions for an address", async () => {
            const tx1 = createMockTransaction(
                { arkTxid: "atx1" },
                "SENT" as TxType,
                10000,
                1000
            );
            await repository.saveTransactions(testAddress, [tx1]);

            await repository.deleteTransactions(testAddress);
            const retrieved =
                await repository.getTransactionHistory(testAddress);

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
                    { assetId: "asset-a", amount: 100 },
                    { assetId: "asset-b", amount: 200 },
                ],
            };

            await repository.saveTransactions(testAddress, [tx]);
            const [retrieved] =
                await repository.getTransactionHistory(testAddress);

            expect(retrieved.settled).toBe(true);
            expect(retrieved.assets).toEqual([
                { assetId: "asset-a", amount: 100 },
                { assetId: "asset-b", amount: 200 },
            ]);
        });

        it("should handle transactions for multiple addresses independently", async () => {
            const address1 = "address-1";
            const address2 = "address-2";

            const tx1 = createMockTransaction(
                { arkTxid: "atx1" },
                "SENT" as TxType,
                10000,
                1000
            );
            const tx2 = createMockTransaction(
                { arkTxid: "atx2" },
                "RECEIVED" as TxType,
                20000,
                2000
            );

            await repository.saveTransactions(address1, [tx1]);
            await repository.saveTransactions(address2, [tx2]);

            const retrieved1 = await repository.getTransactionHistory(address1);
            const retrieved2 = await repository.getTransactionHistory(address2);

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
                lastSyncTime: 1700000000,
                settings: { theme: "dark" },
            };

            await repository.saveWalletState(state);
            const retrieved = await repository.getWalletState();

            expect(retrieved).toEqual(state);
            expect(retrieved?.lastSyncTime).toBe(1700000000);
            expect(retrieved?.settings).toEqual({ theme: "dark" });
        });

        it("should update existing wallet state", async () => {
            const state1: WalletState = {
                lastSyncTime: 1700000000,
                settings: { theme: "dark" },
            };
            await repository.saveWalletState(state1);

            const state2: WalletState = {
                lastSyncTime: 1700001000,
                settings: { theme: "light" },
            };
            await repository.saveWalletState(state2);

            const retrieved = await repository.getWalletState();
            expect(retrieved?.settings?.theme).toBe("light");
            expect(retrieved?.lastSyncTime).toBe(1700001000);
        });

        it("should handle wallet state with only lastSyncTime", async () => {
            const state: WalletState = { lastSyncTime: 1234567890 };
            await repository.saveWalletState(state);

            const retrieved = await repository.getWalletState();
            expect(retrieved?.lastSyncTime).toBe(1234567890);
            expect(retrieved?.settings).toBeUndefined();
        });

        it("should handle wallet state with only settings", async () => {
            const state: WalletState = {
                settings: { key: "value", nested: { a: 1 } },
            };
            await repository.saveWalletState(state);

            const retrieved = await repository.getWalletState();
            expect(retrieved?.lastSyncTime).toBeUndefined();
            expect(retrieved?.settings).toEqual({
                key: "value",
                nested: { a: 1 },
            });
        });
    });

    // ── Clear ──────────────────────────────────────────────────────────

    describe("clear()", () => {
        it("should clear all data from all tables", async () => {
            await repository.saveVtxos(testAddress, [
                createMockVtxo("tx1", 0, 10000),
            ]);
            await repository.saveUtxos(testAddress, [
                createMockUtxo("tx2", 0, 20000),
            ]);
            await repository.saveTransactions(testAddress, [
                createMockTransaction(
                    { arkTxid: "atx1" },
                    "SENT" as TxType,
                    5000,
                    1000
                ),
            ]);
            await repository.saveWalletState({ lastSyncTime: 1234 });

            await repository.clear();

            expect(await repository.getVtxos(testAddress)).toEqual([]);
            expect(await repository.getUtxos(testAddress)).toEqual([]);
            expect(await repository.getTransactionHistory(testAddress)).toEqual(
                []
            );
            expect(await repository.getWalletState()).toBeNull();
        });
    });

    // ── Table prefix ───────────────────────────────────────────────────

    describe("table prefix", () => {
        it("should use custom prefix for table names", async () => {
            const customRepo = new SQLiteWalletRepository(db, {
                prefix: "myapp_",
            });
            // Should work without interference from the default-prefixed repo
            await customRepo.saveVtxos(testAddress, [
                createMockVtxo("tx-custom", 0, 9000),
            ]);
            const retrieved = await customRepo.getVtxos(testAddress);
            expect(retrieved).toHaveLength(1);
            expect(retrieved[0].txid).toBe("tx-custom");
        });

        it("should isolate data between different prefixes", async () => {
            const repoA = new SQLiteWalletRepository(db, { prefix: "a_" });
            const repoB = new SQLiteWalletRepository(db, { prefix: "b_" });

            await repoA.saveVtxos(testAddress, [
                createMockVtxo("tx-a", 0, 1000),
            ]);
            await repoB.saveVtxos(testAddress, [
                createMockVtxo("tx-b", 0, 2000),
            ]);

            const fromA = await repoA.getVtxos(testAddress);
            const fromB = await repoB.getVtxos(testAddress);

            expect(fromA).toHaveLength(1);
            expect(fromA[0].txid).toBe("tx-a");
            expect(fromB).toHaveLength(1);
            expect(fromB[0].txid).toBe("tx-b");
        });
    });

    // ── asyncDispose ───────────────────────────────────────────────────

    describe("[Symbol.asyncDispose]", () => {
        it("should be a no-op and not throw", async () => {
            await expect(
                repository[Symbol.asyncDispose]()
            ).resolves.toBeUndefined();
        });
    });
});
