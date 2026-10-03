import { ArkTransaction, ExtendedCoin, ExtendedVirtualCoin } from "../../wallet";
import type { Outpoint } from "../../wallet";
import {
    WalletRepository,
    WalletState,
    VtxoRepositoryKey,
    assertHistoryPageFilter,
    compareHistoryCursors,
    type TransactionHistoryPageFilter,
    type TransactionHistoryPageCursor,
    type ScriptVtxoCursor,
    type StoredVtxo,
    type ScriptVtxoPageOptions,
} from "../walletRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";
import {
    serializeVtxo,
    serializeUtxo,
    deserializeVtxo,
    deserializeUtxo,
    serializeAssets,
    deserializeAssets,
    SerializedTapLeaf,
    createdAtToIso,
} from "../serialization";
import { scriptFromArkAddress } from "../scriptFromAddress";
import { checkSaveVtxosForScript } from "../../contracts/vtxoOwnership";
import { isVtxoSpent } from "../../wallet/vtxo";
import { RealmLike } from "./types";

/**
 * Realm-based implementation of WalletRepository.
 *
 * Consumers must open Realm with the schemas from `./schemas.ts` and pass
 * the instance to the constructor.
 *
 * Realm handles schema creation on open, so `ensureInit()` is a no-op.
 * The consumer owns the Realm lifecycle — `[Symbol.asyncDispose]` is a no-op.
 */
export class RealmWalletRepository implements WalletRepository {
    readonly version = 2 as const;

    constructor(private readonly realm: RealmLike) {}

    // ── Lifecycle ──────────────────────────────────────────────────────

    private async ensureInit(): Promise<void> {
        // Realm handles schema on open — nothing to initialise.
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // no-op — consumer owns the Realm lifecycle
    }

    // ── Clear ──────────────────────────────────────────────────────────

    async clear(): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            this.realm.delete(this.realm.objects("ArkVtxo"));
            this.realm.delete(this.realm.objects("ArkUtxo"));
            this.realm.delete(this.realm.objects("ArkTransaction"));
            this.realm.delete(this.realm.objects("ArkWalletState"));
        });
    }

    // ── VTXO management ────────────────────────────────────────────────

    async getVtxosPage(
        address: string,
        page: PageRequest<Outpoint>,
    ): Promise<PageResult<ExtendedVirtualCoin, Outpoint>> {
        return this.pageByAddress("ArkVtxo", address, page, vtxoObjectToDomain);
    }

    async saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            for (const vtxo of vtxos) {
                const s = serializeVtxo(vtxo);
                this.realm.create(
                    "ArkVtxo",
                    {
                        pk: `${s.txid}:${s.vout}`,
                        address,
                        txid: s.txid,
                        vout: s.vout,
                        value: s.value,
                        tapTree: s.tapTree,
                        forfeitCb: s.forfeitTapLeafScript.cb,
                        forfeitS: s.forfeitTapLeafScript.s,
                        intentCb: s.intentTapLeafScript.cb,
                        intentS: s.intentTapLeafScript.s,
                        statusJson: JSON.stringify(s.status),
                        createdAt: createdAtToIso(s.createdAt),
                        isUnrolled: s.isUnrolled ?? false,
                        isSpent: s.isSpent === undefined ? null : s.isSpent,
                        isSwept: s.isSwept === undefined ? null : s.isSwept,
                        isPreconfirmed: s.isPreconfirmed === undefined ? null : s.isPreconfirmed,
                        commitmentTxIdsJson: s.commitmentTxIds
                            ? JSON.stringify(s.commitmentTxIds)
                            : null,
                        expiresAt:
                            s.expiresAt === undefined ? null : new Date(s.expiresAt).toISOString(),
                        expiresAtHeight: s.expiresAtHeight ?? null,
                        spentBy: s.spentBy ?? null,
                        settledBy: s.settledBy ?? null,
                        arkTxId: s.arkTxId ?? null,
                        extraWitnessJson: s.extraWitness ? JSON.stringify(s.extraWitness) : null,
                        assetsJson: s.assets ? JSON.stringify(s.assets) : null,
                        script: s.script ?? null,
                    },
                    "modified",
                );
            }
        });
    }

    async deleteVtxos(address: string): Promise<void> {
        return this.deleteWhere("ArkVtxo", "address", address);
    }

    async getVtxosForScriptPage(
        script: string,
        page: PageRequest<ScriptVtxoCursor>,
        options?: ScriptVtxoPageOptions,
    ): Promise<PageResult<StoredVtxo, ScriptVtxoCursor>> {
        assertPageRequest(page);
        await this.ensureInit();
        let results = this.realm
            .objects<{ address: string; txid: string; vout: number }>("ArkVtxo")
            .filtered("script == $0", script);
        if (options?.unspentOnly) {
            results = results.filtered(
                "(isSpent == null OR isSpent == $0) AND (spentBy == null OR spentBy == $1) AND (settledBy == null OR settledBy == $1)",
                false,
                "",
            );
        }
        if (page.after) {
            results = results.filtered(
                "address > $0 OR (address == $0 AND (txid > $1 OR (txid == $1 AND vout > $2)))",
                page.after.address,
                page.after.txid,
                page.after.vout,
            );
        }
        const rows: StoredVtxo[] = [];
        for (const row of results.sorted([
            ["address", false],
            ["txid", false],
            ["vout", false],
        ])) {
            rows.push({ address: row.address, vtxo: vtxoObjectToDomain(row) });
            if (rows.length > page.limit) break;
        }
        const result = pageResult(rows, page.limit, (row) => ({
            address: row.address,
            txid: row.vtxo.txid,
            vout: row.vtxo.vout,
        }));
        return options?.unspentOnly
            ? { ...result, items: result.items.filter((row) => !isVtxoSpent(row.vtxo)) }
            : result;
    }

    async saveVtxosForScript(key: VtxoRepositoryKey, vtxos: ExtendedVirtualCoin[]): Promise<void> {
        return this.saveVtxos(checkSaveVtxosForScript("RealmWalletRepository", key, vtxos), vtxos);
    }

    async deleteVtxosForScript(script: string): Promise<void> {
        return this.deleteWhere("ArkVtxo", "script", script);
    }

    // ── UTXO management ────────────────────────────────────────────────

    async getUtxosPage(
        address: string,
        page: PageRequest<Outpoint>,
    ): Promise<PageResult<ExtendedCoin, Outpoint>> {
        return this.pageByAddress("ArkUtxo", address, page, utxoObjectToDomain);
    }

    private async pageByAddress<Item>(
        schema: string,
        address: string,
        page: PageRequest<Outpoint>,
        deserialize: (row: any) => Item,
    ): Promise<PageResult<Item, Outpoint>> {
        assertPageRequest(page);
        await this.ensureInit();
        let results = this.realm
            .objects<{ txid: string; vout: number }>(schema)
            .filtered("address == $0", address);
        if (page.after) {
            results = results.filtered(
                "txid > $0 OR (txid == $0 AND vout > $1)",
                page.after.txid,
                page.after.vout,
            );
        }
        const rows: { key: Outpoint; item: Item }[] = [];
        for (const row of results.sorted([
            ["txid", false],
            ["vout", false],
        ])) {
            rows.push({ key: { txid: row.txid, vout: row.vout }, item: deserialize(row) });
            if (rows.length > page.limit) break;
        }
        const result = pageResult(rows, page.limit, (row) => row.key);
        return { items: result.items.map((row) => row.item), nextCursor: result.nextCursor };
    }

    async saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            for (const utxo of utxos) {
                const s = serializeUtxo(utxo);
                this.realm.create(
                    "ArkUtxo",
                    {
                        pk: `${s.txid}:${s.vout}`,
                        address,
                        txid: s.txid,
                        vout: s.vout,
                        value: s.value,
                        tapTree: s.tapTree,
                        forfeitCb: s.forfeitTapLeafScript.cb,
                        forfeitS: s.forfeitTapLeafScript.s,
                        intentCb: s.intentTapLeafScript.cb,
                        intentS: s.intentTapLeafScript.s,
                        statusJson: JSON.stringify(s.status),
                        extraWitnessJson: s.extraWitness ? JSON.stringify(s.extraWitness) : null,
                    },
                    "modified",
                );
            }
        });
    }

    async deleteUtxos(address: string): Promise<void> {
        return this.deleteWhere("ArkUtxo", "address", address);
    }

    // ── Transaction history ────────────────────────────────────────────

    async getTransactionHistoryPage(
        filter: TransactionHistoryPageFilter,
        page: PageRequest<TransactionHistoryPageCursor>,
    ): Promise<PageResult<ArkTransaction, TransactionHistoryPageCursor>> {
        assertPageRequest(page);
        assertHistoryPageFilter(filter);
        let results = this.realm
            .objects("ArkTransaction")
            .filtered("address == $0", filter.address);
        results = results.filtered(
            "createdAt >= $0",
            Math.max(filter.since ?? 0, page.after?.createdAt ?? 0),
        );
        const rows: ArkTransaction[] = [];
        for (const row of results.sorted([
            ["createdAt", false],
            ["boardingTxid", false],
            ["commitmentTxid", false],
            ["arkTxid", false],
        ])) {
            const tx = txObjectToDomain(row);
            if (
                page.after !== undefined &&
                compareHistoryCursors({ createdAt: tx.createdAt, key: tx.key }, page.after) <= 0
            )
                continue;
            rows.push(tx);
            if (rows.length > page.limit) break;
        }
        return pageResult(rows, page.limit, (tx) => ({ createdAt: tx.createdAt, key: tx.key }));
    }

    async saveTransactions(address: string, txs: ArkTransaction[]): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            for (const tx of txs) {
                this.realm.create(
                    "ArkTransaction",
                    {
                        pk: `${address}:${tx.key.boardingTxid}:${tx.key.commitmentTxid}:${tx.key.arkTxid}`,
                        address,
                        boardingTxid: tx.key.boardingTxid,
                        commitmentTxid: tx.key.commitmentTxid,
                        arkTxid: tx.key.arkTxid,
                        type: tx.type,
                        amount: tx.amount,
                        settled: tx.settled,
                        createdAt: tx.createdAt,
                        assetsJson: tx.assets ? JSON.stringify(serializeAssets(tx.assets)) : null,
                    },
                    "modified",
                );
            }
        });
    }

    async deleteTransactions(address: string): Promise<void> {
        return this.deleteWhere("ArkTransaction", "address", address);
    }

    private async deleteWhere(objectType: string, field: string, value: string): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            const toDelete = this.realm.objects(objectType).filtered(`${field} == $0`, value);
            this.realm.delete(toDelete);
        });
    }

    // ── Wallet state ───────────────────────────────────────────────────

    async getWalletState(): Promise<WalletState | null> {
        await this.ensureInit();
        const results = this.realm
            .objects<WalletStateObject>("ArkWalletState")
            .filtered("key == $0", "state");
        const items = [...results];
        if (items.length === 0) return null;

        const obj = items[0];
        const state: WalletState = {};
        if (obj.settingsJson) {
            state.settings = JSON.parse(obj.settingsJson);
        }
        state.lastSyncTime = obj.lastSyncTime ?? undefined;
        return state;
    }

    async saveWalletState(state: WalletState): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            this.realm.create(
                "ArkWalletState",
                {
                    key: "state",
                    lastSyncTime: state.lastSyncTime,
                    settingsJson: state.settings ? JSON.stringify(state.settings) : null,
                },
                "modified",
            );
        });
    }
}

interface WalletStateObject {
    key: string;
    lastSyncTime: number | null;
    settingsJson: string | null;
}

// ── Realm object → Domain converters ─────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function vtxoObjectToDomain(obj: any): ExtendedVirtualCoin {
    const serialized = {
        txid: obj.txid,
        vout: obj.vout,
        value: obj.value,
        tapTree: obj.tapTree,
        forfeitTapLeafScript: {
            cb: obj.forfeitCb,
            s: obj.forfeitS,
        } as SerializedTapLeaf,
        intentTapLeafScript: {
            cb: obj.intentCb,
            s: obj.intentS,
        } as SerializedTapLeaf,
        status: JSON.parse(obj.statusJson),
        createdAt: new Date(obj.createdAt),
        isUnrolled: obj.isUnrolled,
        isSpent: obj.isSpent === null ? undefined : obj.isSpent,
        isSwept: obj.isSwept == null ? undefined : obj.isSwept,
        isPreconfirmed: obj.isPreconfirmed == null ? undefined : obj.isPreconfirmed,
        commitmentTxIds: obj.commitmentTxIdsJson ? JSON.parse(obj.commitmentTxIdsJson) : undefined,
        expiresAt: obj.expiresAt ? new Date(obj.expiresAt) : undefined,
        expiresAtHeight: obj.expiresAtHeight ?? undefined,
        spentBy: obj.spentBy ?? undefined,
        settledBy: obj.settledBy ?? undefined,
        arkTxId: obj.arkTxId ?? undefined,
        extraWitness: obj.extraWitnessJson ? JSON.parse(obj.extraWitnessJson) : undefined,
        assets: obj.assetsJson ? JSON.parse(obj.assetsJson) : undefined,
        // Post-migration every row has `script`, but the backfill is
        // idempotent: derive from `address` if the legacy column is still
        // null (e.g. the migration hasn't run yet on this handle).
        script: obj.script ?? scriptFromArkAddress(obj.address),
    };

    return deserializeVtxo(serialized);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function utxoObjectToDomain(obj: any): ExtendedCoin {
    const serialized = {
        txid: obj.txid,
        vout: obj.vout,
        value: obj.value,
        tapTree: obj.tapTree,
        forfeitTapLeafScript: {
            cb: obj.forfeitCb,
            s: obj.forfeitS,
        } as SerializedTapLeaf,
        intentTapLeafScript: {
            cb: obj.intentCb,
            s: obj.intentS,
        } as SerializedTapLeaf,
        status: JSON.parse(obj.statusJson),
        extraWitness: obj.extraWitnessJson ? JSON.parse(obj.extraWitnessJson) : undefined,
    };

    return deserializeUtxo(serialized);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function txObjectToDomain(obj: any): ArkTransaction {
    const tx: ArkTransaction = {
        key: {
            boardingTxid: obj.boardingTxid,
            commitmentTxid: obj.commitmentTxid,
            arkTxid: obj.arkTxid,
        },
        type: obj.type as ArkTransaction["type"],
        amount: obj.amount,
        settled: obj.settled,
        createdAt: obj.createdAt,
    };
    if (obj.assetsJson) {
        tx.assets = deserializeAssets(JSON.parse(obj.assetsJson));
    }
    return tx;
}
