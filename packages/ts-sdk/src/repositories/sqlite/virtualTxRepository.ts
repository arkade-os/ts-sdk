import { Outpoint } from "../../wallet";
import { ChainedTxType, VirtualTx, VirtualTxRepository, VtxoBranch } from "../virtualTxRepository";
import { SQLExecutor } from "./types";
import { runInTransaction } from "./transaction";

const SAFE_PREFIX = /^[a-zA-Z0-9_]+$/;
function sanitizePrefix(p: string): string {
    if (!SAFE_PREFIX.test(p)) throw new Error(`Invalid table prefix "${p}"`);
    return p;
}

interface VtxRow {
    txid: string;
    psbt: string | null;
    expires_at: number | null;
    type: number;
}
export class SQLiteVirtualTxRepository implements VirtualTxRepository {
    readonly version = 1 as const;
    private initPromise: Promise<void> | null = null;
    private readonly prefix: string;
    private readonly tTx: string;
    private readonly tBranch: string;

    constructor(
        private readonly db: SQLExecutor,
        options?: { prefix?: string },
    ) {
        this.prefix = sanitizePrefix(options?.prefix ?? "ark_");
        this.tTx = `${this.prefix}virtual_txs`;
        this.tBranch = `${this.prefix}vtxo_branches`;
    }

    private ensureInit(): Promise<void> {
        if (!this.initPromise) this.initPromise = this.init();
        return this.initPromise;
    }

    private async init(): Promise<void> {
        await this.db.run(`CREATE TABLE IF NOT EXISTS ${this.tTx} (
            txid TEXT PRIMARY KEY,
            psbt TEXT,
            expires_at INTEGER,
            type INTEGER NOT NULL DEFAULT 0
        )`);
        await this.db.run(`CREATE TABLE IF NOT EXISTS ${this.tBranch} (
            vtxo_txid TEXT NOT NULL,
            vtxo_vout INTEGER NOT NULL,
            virtual_txid TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY (vtxo_txid, vtxo_vout, position)
        )`);
        await this.db.run(
            `CREATE INDEX IF NOT EXISTS idx_${this.prefix}branch_vtxid ON ${this.tBranch} (virtual_txid)`,
        );
    }

    private tx(fn: () => Promise<void>): Promise<void> {
        return runInTransaction(this.db, fn);
    }

    async clear(): Promise<void> {
        await this.ensureInit();
        await this.tx(async () => {
            await this.db.run(`DELETE FROM ${this.tTx}`);
            await this.db.run(`DELETE FROM ${this.tBranch}`);
        });
    }

    async upsertVirtualTxs(txs: VirtualTx[]): Promise<void> {
        if (txs.length === 0) return;
        await this.ensureInit();
        await this.tx(async () => {
            // Prefetch existing rows in one query instead of a SELECT per tx,
            // then merge (new value wins, else keep the stored one) in memory.
            const placeholders = txs.map(() => "?").join(", ");
            const existing = await this.db.all<VtxRow>(
                `SELECT * FROM ${this.tTx} WHERE txid IN (${placeholders})`,
                txs.map((t) => t.txid),
            );
            const prevByTxid = new Map(existing.map((r) => [r.txid, r]));
            for (const t of txs) {
                const prev = prevByTxid.get(t.txid);
                const psbt = t.psbt ?? prev?.psbt ?? null;
                const expires = t.expiresAt ?? prev?.expires_at ?? null;
                const type = t.type ?? prev?.type ?? ChainedTxType.Unspecified;
                await this.db.run(
                    `INSERT OR REPLACE INTO ${this.tTx} (txid, psbt, expires_at, type) VALUES (?, ?, ?, ?)`,
                    [t.txid, psbt, expires, type],
                );
                // A txid repeated later in the same batch must merge onto this
                // just-written row, matching the original per-tx-read behavior.
                prevByTxid.set(t.txid, { txid: t.txid, psbt, expires_at: expires, type });
            }
        });
    }

    async getVirtualTx(txid: string): Promise<VirtualTx | null> {
        await this.ensureInit();
        const row = await this.db.get<VtxRow>(`SELECT * FROM ${this.tTx} WHERE txid = ?`, [txid]);
        return row ? rowToTx(row) : null;
    }

    async setBranch(vtxo: Outpoint, branch: VtxoBranch[]): Promise<void> {
        await this.ensureInit();
        await this.tx(async () => {
            await this.db.run(`DELETE FROM ${this.tBranch} WHERE vtxo_txid = ? AND vtxo_vout = ?`, [
                vtxo.txid,
                vtxo.vout,
            ]);
            for (const b of branch) {
                await this.db.run(
                    `INSERT OR REPLACE INTO ${this.tBranch} (vtxo_txid, vtxo_vout, virtual_txid, position) VALUES (?, ?, ?, ?)`,
                    [b.vtxoTxid, b.vtxoVout, b.virtualTxid, b.position],
                );
            }
        });
    }

    async getBranch(vtxo: Outpoint): Promise<VirtualTx[]> {
        await this.ensureInit();
        // Single JOIN instead of one lookup per branch row; the inner join
        // naturally drops branch rows whose tx no longer exists.
        const rows = await this.db.all<VtxRow>(
            `SELECT t.txid, t.psbt, t.expires_at, t.type
             FROM ${this.tBranch} b
             JOIN ${this.tTx} t ON t.txid = b.virtual_txid
             WHERE b.vtxo_txid = ? AND b.vtxo_vout = ?
             ORDER BY b.position ASC`,
            [vtxo.txid, vtxo.vout],
        );
        return rows.map(rowToTx);
    }

    async hasBranch(vtxo: Outpoint): Promise<boolean> {
        await this.ensureInit();
        const r = await this.db.get<{ c: number }>(
            `SELECT COUNT(*) AS c FROM ${this.tBranch} WHERE vtxo_txid = ? AND vtxo_vout = ?`,
            [vtxo.txid, vtxo.vout],
        );
        return (r?.c ?? 0) > 0;
    }

    async pruneForSpentVtxo(vtxo: Outpoint): Promise<void> {
        await this.ensureInit();
        await this.tx(async () => {
            // Capture the txs this vtxo's branch referenced, then delete its
            // branch rows and — in one set-based pass — drop only those txs
            // that no other branch still references. Scoping the delete to the
            // captured txids preserves txs inserted without a branch.
            const removed = await this.db.all<{ virtual_txid: string }>(
                `SELECT DISTINCT virtual_txid FROM ${this.tBranch} WHERE vtxo_txid = ? AND vtxo_vout = ?`,
                [vtxo.txid, vtxo.vout],
            );
            await this.db.run(`DELETE FROM ${this.tBranch} WHERE vtxo_txid = ? AND vtxo_vout = ?`, [
                vtxo.txid,
                vtxo.vout,
            ]);
            if (removed.length === 0) return;
            const placeholders = removed.map(() => "?").join(", ");
            await this.db.run(
                `DELETE FROM ${this.tTx}
                 WHERE txid IN (${placeholders})
                 AND NOT EXISTS (
                     SELECT 1 FROM ${this.tBranch} b WHERE b.virtual_txid = ${this.tTx}.txid
                 )`,
                removed.map((r) => r.virtual_txid),
            );
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}

function rowToTx(r: VtxRow): VirtualTx {
    return {
        txid: r.txid,
        psbt: r.psbt ?? null,
        expiresAt: r.expires_at ?? null,
        type: r.type as ChainedTxType,
    };
}
