import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hex } from "@scure/base";
import { TaprootControlBlock } from "@scure/btc-signer";
import { RealmWalletRepository } from "../src/repositories/realm/walletRepository";
import type {
    ExtendedVirtualCoin,
    ExtendedCoin,
    ArkTransaction,
    TxType,
} from "../src/wallet";
import type { TapLeafScript } from "../src/script/base";
import type { WalletState } from "../src/repositories/walletRepository";

// ── Mock Realm ──────────────────────────────────────────────────────────
// A lightweight in-memory mock that simulates the Realm API surface
// used by RealmWalletRepository.

function createMockRealm() {
    // schema name -> (primary key value -> object)
    const store = new Map<string, Map<string, any>>();

    // Map schema names to their PK fields
    const pkFields: Record<string, string> = {
        ArkVtxo: "pk",
        ArkUtxo: "pk",
        ArkTransaction: "pk",
        ArkWalletState: "key",
        ArkContract: "script",
    };

    function getSchemaStore(schemaName: string): Map<string, any> {
        if (!store.has(schemaName)) {
            store.set(schemaName, new Map());
        }
        return store.get(schemaName)!;
    }

    function getPk(schemaName: string, obj: any): string {
        const field = pkFields[schemaName] ?? "pk";
        return String(obj[field]);
    }

    /**
     * Parse a Realm-style filter string and evaluate it against an object.
     * Supports: `field == $N`, `AND`, `OR`, and parentheses grouping.
     */
    function matchesFilter(obj: any, query: string, args: any[]): boolean {
        // Split on AND (top level)
        // For simplicity handle OR inside parentheses
        const andParts = splitTopLevel(query, " AND ");
        return andParts.every((part) => {
            const trimmed = part.trim();
            // Handle OR groups like (field == $0 OR field == $1)
            if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
                const inner = trimmed.slice(1, -1);
                const orParts = inner.split(" OR ");
                return orParts.some((orPart) =>
                    evaluateCondition(obj, orPart.trim(), args)
                );
            }
            return evaluateCondition(obj, trimmed, args);
        });
    }

    function splitTopLevel(str: string, delimiter: string): string[] {
        const parts: string[] = [];
        let depth = 0;
        let current = "";
        let i = 0;
        while (i < str.length) {
            if (str[i] === "(") depth++;
            if (str[i] === ")") depth--;
            if (
                depth === 0 &&
                str.substring(i, i + delimiter.length) === delimiter
            ) {
                parts.push(current);
                current = "";
                i += delimiter.length;
                continue;
            }
            current += str[i];
            i++;
        }
        if (current) parts.push(current);
        return parts;
    }

    function evaluateCondition(
        obj: any,
        condition: string,
        args: any[]
    ): boolean {
        const match = condition.match(/(\w+)\s*==\s*\$(\d+)/);
        if (!match) return true; // skip unknown conditions
        const field = match[1];
        const argIdx = parseInt(match[2], 10);
        return obj[field] === args[argIdx];
    }

    function createFilteredResult(items: any[], schemaName: string) {
        const result: any = {
            filtered(query: string, ...args: any[]) {
                const filtered = items.filter((item) =>
                    matchesFilter(item, query, args)
                );
                return createFilteredResult(filtered, schemaName);
            },
            [Symbol.iterator]: () => items[Symbol.iterator](),
            length: items.length,
            snapshot() {
                return [...items];
            },
        };
        return result;
    }

    const realm = {
        write(callback: () => void) {
            callback();
        },

        create(schemaName: string, obj: any, mode?: string) {
            const schemaStore = getSchemaStore(schemaName);
            const pk = getPk(schemaName, obj);
            if (mode === "modified") {
                // upsert: merge with existing
                const existing = schemaStore.get(pk);
                if (existing) {
                    schemaStore.set(pk, { ...existing, ...obj });
                } else {
                    schemaStore.set(pk, { ...obj });
                }
            } else {
                schemaStore.set(pk, { ...obj });
            }
        },

        objects(schemaName: string) {
            const schemaStore = getSchemaStore(schemaName);
            const items = [...schemaStore.values()];
            return createFilteredResult(items, schemaName);
        },

        delete(objects: any) {
            // Handle both arrays and filtered results (iterables)
            const toRemove = [...objects];
            for (const [schemaName, schemaStore] of store) {
                const pkField = pkFields[schemaName] ?? "pk";
                for (const item of toRemove) {
                    const pk = String(item[pkField]);
                    if (schemaStore.has(pk)) {
                        schemaStore.delete(pk);
                    }
                }
            }
        },
    };

    return realm;
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

describe("RealmWalletRepository", () => {
    let realm: ReturnType<typeof createMockRealm>;
    let repository: RealmWalletRepository;
    const testAddress = "test-address-123";

    beforeEach(() => {
        realm = createMockRealm();
        repository = new RealmWalletRepository(realm);
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
            const sorted = retrieved.sort((a, b) =>
                a.txid.localeCompare(b.txid)
            );
            expect(sorted[0].txid).toBe("tx1");
            expect(sorted[0].vout).toBe(0);
            expect(sorted[0].value).toBe(10000);
            expect(sorted[1].txid).toBe("tx2");
            expect(sorted[1].vout).toBe(1);
            expect(sorted[1].value).toBe(20000);
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
            const sorted = retrieved.sort((a, b) =>
                a.txid.localeCompare(b.txid)
            );
            expect(sorted[0].txid).toBe("tx1");
            expect(sorted[0].vout).toBe(0);
            expect(sorted[0].value).toBe(10000);
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
            // sorted by createdAt ASC
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
        it("should clear all data from all schemas", async () => {
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

    // ── asyncDispose ───────────────────────────────────────────────────

    describe("[Symbol.asyncDispose]", () => {
        it("should be a no-op and not throw", async () => {
            await expect(
                repository[Symbol.asyncDispose]()
            ).resolves.toBeUndefined();
        });
    });
});
