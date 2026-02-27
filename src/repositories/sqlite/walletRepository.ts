import {
    ArkTransaction,
    ExtendedCoin,
    ExtendedVirtualCoin,
} from "../../wallet";
import { WalletRepository, WalletState } from "../walletRepository";
import {
    serializeVtxo,
    serializeUtxo,
    deserializeVtxo,
    deserializeUtxo,
    SerializedTapLeaf,
} from "../serialization";
import { SQLExecutor } from "./types";

interface SQLiteWalletRepositoryOptions {
    /** Table name prefix (default: "ark_") */
    prefix?: string;
}

/**
 * SQLite-based implementation of WalletRepository.
 *
 * Uses the SQLExecutor interface so consumers can plug in any SQLite driver
 * (expo-sqlite, better-sqlite3, etc.).
 *
 * Tables are created lazily on first operation via `ensureInit()`.
 * The consumer owns the SQLExecutor lifecycle — `[Symbol.asyncDispose]` is a no-op.
 */
export class SQLiteWalletRepository implements WalletRepository {
    readonly version = 1 as const;
    private initialized = false;
    private readonly prefix: string;
    private readonly tables: {
        vtxos: string;
        utxos: string;
        transactions: string;
        walletState: string;
    };

    constructor(
        private readonly db: SQLExecutor,
        options?: SQLiteWalletRepositoryOptions
    ) {
        this.prefix = options?.prefix ?? "ark_";
        this.tables = {
            vtxos: `${this.prefix}vtxos`,
            utxos: `${this.prefix}utxos`,
            transactions: `${this.prefix}transactions`,
            walletState: `${this.prefix}wallet_state`,
        };
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    private async ensureInit(): Promise<void> {
        if (this.initialized) return;
        await this.init();
        this.initialized = true;
    }

    private async init(): Promise<void> {
        await this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.tables.vtxos} (
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
        `);

        await this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.tables.utxos} (
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
                extra_witness_json TEXT,
                PRIMARY KEY (txid, vout)
            )
        `);

        await this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.tables.transactions} (
                address TEXT NOT NULL,
                boarding_txid TEXT NOT NULL,
                commitment_txid TEXT NOT NULL,
                ark_txid TEXT NOT NULL,
                type TEXT NOT NULL,
                amount INTEGER NOT NULL,
                settled INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                assets_json TEXT,
                PRIMARY KEY (address, boarding_txid, commitment_txid, ark_txid)
            )
        `);

        await this.db.run(`
            CREATE TABLE IF NOT EXISTS ${this.tables.walletState} (
                key TEXT PRIMARY KEY,
                last_sync_time INTEGER,
                settings_json TEXT
            )
        `);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // no-op — consumer owns the SQLExecutor lifecycle
    }

    // ── Clear ──────────────────────────────────────────────────────────

    async clear(): Promise<void> {
        await this.ensureInit();
        await this.db.run(`DELETE FROM ${this.tables.vtxos}`);
        await this.db.run(`DELETE FROM ${this.tables.utxos}`);
        await this.db.run(`DELETE FROM ${this.tables.transactions}`);
        await this.db.run(`DELETE FROM ${this.tables.walletState}`);
    }

    // ── VTXO management ────────────────────────────────────────────────

    async getVtxos(address: string): Promise<ExtendedVirtualCoin[]> {
        await this.ensureInit();
        const rows = await this.db.all<VtxoRow>(
            `SELECT * FROM ${this.tables.vtxos} WHERE address = ?`,
            [address]
        );
        return rows.map(vtxoRowToDomain);
    }

    async saveVtxos(
        address: string,
        vtxos: ExtendedVirtualCoin[]
    ): Promise<void> {
        await this.ensureInit();
        for (const vtxo of vtxos) {
            const s = serializeVtxo(vtxo);
            await this.db.run(
                `INSERT OR REPLACE INTO ${this.tables.vtxos}
                    (txid, vout, value, address,
                     tap_tree, forfeit_cb, forfeit_s, intent_cb, intent_s,
                     status_json, virtual_status_json, created_at,
                     is_unrolled, is_spent, spent_by, settled_by, ark_tx_id,
                     extra_witness_json, assets_json)
                 VALUES (?, ?, ?, ?,
                         ?, ?, ?, ?, ?,
                         ?, ?, ?,
                         ?, ?, ?, ?, ?,
                         ?, ?)`,
                [
                    s.txid,
                    s.vout,
                    s.value,
                    address,
                    s.tapTree,
                    s.forfeitTapLeafScript.cb,
                    s.forfeitTapLeafScript.s,
                    s.intentTapLeafScript.cb,
                    s.intentTapLeafScript.s,
                    JSON.stringify(s.status),
                    JSON.stringify(s.virtualStatus),
                    typeof s.createdAt === "string"
                        ? s.createdAt
                        : s.createdAt instanceof Date
                          ? s.createdAt.toISOString()
                          : new Date(s.createdAt).toISOString(),
                    s.isUnrolled ? 1 : 0,
                    s.isSpent === undefined ? null : s.isSpent ? 1 : 0,
                    s.spentBy ?? null,
                    s.settledBy ?? null,
                    s.arkTxId ?? null,
                    s.extraWitness ? JSON.stringify(s.extraWitness) : null,
                    s.assets ? JSON.stringify(s.assets) : null,
                ]
            );
        }
    }

    async deleteVtxos(address: string): Promise<void> {
        await this.ensureInit();
        await this.db.run(
            `DELETE FROM ${this.tables.vtxos} WHERE address = ?`,
            [address]
        );
    }

    // ── UTXO management ────────────────────────────────────────────────

    async getUtxos(address: string): Promise<ExtendedCoin[]> {
        await this.ensureInit();
        const rows = await this.db.all<UtxoRow>(
            `SELECT * FROM ${this.tables.utxos} WHERE address = ?`,
            [address]
        );
        return rows.map(utxoRowToDomain);
    }

    async saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void> {
        await this.ensureInit();
        for (const utxo of utxos) {
            const s = serializeUtxo(utxo);
            await this.db.run(
                `INSERT OR REPLACE INTO ${this.tables.utxos}
                    (txid, vout, value, address,
                     tap_tree, forfeit_cb, forfeit_s, intent_cb, intent_s,
                     status_json, extra_witness_json)
                 VALUES (?, ?, ?, ?,
                         ?, ?, ?, ?, ?,
                         ?, ?)`,
                [
                    s.txid,
                    s.vout,
                    s.value,
                    address,
                    s.tapTree,
                    s.forfeitTapLeafScript.cb,
                    s.forfeitTapLeafScript.s,
                    s.intentTapLeafScript.cb,
                    s.intentTapLeafScript.s,
                    JSON.stringify(s.status),
                    s.extraWitness ? JSON.stringify(s.extraWitness) : null,
                ]
            );
        }
    }

    async deleteUtxos(address: string): Promise<void> {
        await this.ensureInit();
        await this.db.run(
            `DELETE FROM ${this.tables.utxos} WHERE address = ?`,
            [address]
        );
    }

    // ── Transaction history ────────────────────────────────────────────

    async getTransactionHistory(address: string): Promise<ArkTransaction[]> {
        await this.ensureInit();
        const rows = await this.db.all<TransactionRow>(
            `SELECT * FROM ${this.tables.transactions} WHERE address = ? ORDER BY created_at ASC`,
            [address]
        );
        return rows.map(txRowToDomain);
    }

    async saveTransactions(
        address: string,
        txs: ArkTransaction[]
    ): Promise<void> {
        await this.ensureInit();
        for (const tx of txs) {
            await this.db.run(
                `INSERT OR REPLACE INTO ${this.tables.transactions}
                    (address, boarding_txid, commitment_txid, ark_txid,
                     type, amount, settled, created_at, assets_json)
                 VALUES (?, ?, ?, ?,
                         ?, ?, ?, ?, ?)`,
                [
                    address,
                    tx.key.boardingTxid,
                    tx.key.commitmentTxid,
                    tx.key.arkTxid,
                    tx.type,
                    tx.amount,
                    tx.settled ? 1 : 0,
                    tx.createdAt,
                    tx.assets ? JSON.stringify(tx.assets) : null,
                ]
            );
        }
    }

    async deleteTransactions(address: string): Promise<void> {
        await this.ensureInit();
        await this.db.run(
            `DELETE FROM ${this.tables.transactions} WHERE address = ?`,
            [address]
        );
    }

    // ── Wallet state ───────────────────────────────────────────────────

    async getWalletState(): Promise<WalletState | null> {
        await this.ensureInit();
        const row = await this.db.get<WalletStateRow>(
            `SELECT * FROM ${this.tables.walletState} WHERE key = ?`,
            ["state"]
        );
        if (!row) return null;

        const state: WalletState = {};
        if (row.last_sync_time !== null && row.last_sync_time !== undefined) {
            state.lastSyncTime = row.last_sync_time;
        }
        if (row.settings_json) {
            state.settings = JSON.parse(row.settings_json);
        }
        return state;
    }

    async saveWalletState(state: WalletState): Promise<void> {
        await this.ensureInit();
        await this.db.run(
            `INSERT OR REPLACE INTO ${this.tables.walletState}
                (key, last_sync_time, settings_json)
             VALUES (?, ?, ?)`,
            [
                "state",
                state.lastSyncTime ?? null,
                state.settings ? JSON.stringify(state.settings) : null,
            ]
        );
    }
}

// ── Row types ──────────────────────────────────────────────────────────

interface VtxoRow {
    txid: string;
    vout: number;
    value: number;
    address: string;
    tap_tree: string;
    forfeit_cb: string;
    forfeit_s: string;
    intent_cb: string;
    intent_s: string;
    status_json: string;
    virtual_status_json: string;
    created_at: string;
    is_unrolled: number;
    is_spent: number | null;
    spent_by: string | null;
    settled_by: string | null;
    ark_tx_id: string | null;
    extra_witness_json: string | null;
    assets_json: string | null;
}

interface UtxoRow {
    txid: string;
    vout: number;
    value: number;
    address: string;
    tap_tree: string;
    forfeit_cb: string;
    forfeit_s: string;
    intent_cb: string;
    intent_s: string;
    status_json: string;
    extra_witness_json: string | null;
}

interface TransactionRow {
    address: string;
    boarding_txid: string;
    commitment_txid: string;
    ark_txid: string;
    type: string;
    amount: number;
    settled: number;
    created_at: number;
    assets_json: string | null;
}

interface WalletStateRow {
    key: string;
    last_sync_time: number | null;
    settings_json: string | null;
}

// ── Row → Domain converters ────────────────────────────────────────────

function vtxoRowToDomain(row: VtxoRow): ExtendedVirtualCoin {
    const serialized = {
        txid: row.txid,
        vout: row.vout,
        value: row.value,
        tapTree: row.tap_tree,
        forfeitTapLeafScript: {
            cb: row.forfeit_cb,
            s: row.forfeit_s,
        } as SerializedTapLeaf,
        intentTapLeafScript: {
            cb: row.intent_cb,
            s: row.intent_s,
        } as SerializedTapLeaf,
        status: JSON.parse(row.status_json),
        virtualStatus: JSON.parse(row.virtual_status_json),
        createdAt: row.created_at,
        isUnrolled: row.is_unrolled === 1,
        isSpent: row.is_spent === null ? undefined : row.is_spent === 1,
        spentBy: row.spent_by ?? undefined,
        settledBy: row.settled_by ?? undefined,
        arkTxId: row.ark_tx_id ?? undefined,
        extraWitness: row.extra_witness_json
            ? JSON.parse(row.extra_witness_json)
            : undefined,
        assets: row.assets_json ? JSON.parse(row.assets_json) : undefined,
    };

    return deserializeVtxo(serialized);
}

function utxoRowToDomain(row: UtxoRow): ExtendedCoin {
    const serialized = {
        txid: row.txid,
        vout: row.vout,
        value: row.value,
        tapTree: row.tap_tree,
        forfeitTapLeafScript: {
            cb: row.forfeit_cb,
            s: row.forfeit_s,
        } as SerializedTapLeaf,
        intentTapLeafScript: {
            cb: row.intent_cb,
            s: row.intent_s,
        } as SerializedTapLeaf,
        status: JSON.parse(row.status_json),
        extraWitness: row.extra_witness_json
            ? JSON.parse(row.extra_witness_json)
            : undefined,
    };

    return deserializeUtxo(serialized);
}

function txRowToDomain(row: TransactionRow): ArkTransaction {
    const tx: ArkTransaction = {
        key: {
            boardingTxid: row.boarding_txid,
            commitmentTxid: row.commitment_txid,
            arkTxid: row.ark_txid,
        },
        type: row.type as ArkTransaction["type"],
        amount: row.amount,
        settled: row.settled === 1,
        createdAt: row.created_at,
    };
    if (row.assets_json) {
        tx.assets = JSON.parse(row.assets_json);
    }
    return tx;
}
