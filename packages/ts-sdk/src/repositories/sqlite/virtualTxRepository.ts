import { Outpoint } from "../../wallet";
import { ChainedTxType, VirtualTx, VirtualTxRepository, VtxoBranch } from "../virtualTxRepository";
import { SQLExecutor } from "./types";

const SAFE_PREFIX = /^[a-zA-Z0-9_]+$/;
function sanitizePrefix(p: string): string {
    if (!SAFE_PREFIX.test(p)) throw new Error(`Invalid table prefix "${p}"`);
    return p;
}

interface VtxRow {
    txid: string;
    hex: string | null;
    expires_at: number | null;
    type: number;
}
interface BranchRow {
    vtxo_txid: string;
    vtxo_vout: number;
    virtual_txid: string;
    position: number;
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
            hex TEXT,
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

    private async tx(fn: () => Promise<void>): Promise<void> {
        await this.db.run("BEGIN IMMEDIATE");
        try {
            await fn();
            await this.db.run("COMMIT");
        } catch (e) {
            try {
                await this.db.run("ROLLBACK");
            } catch {
                /* already rolled back */
            }
            throw e;
        }
    }

    async clear(): Promise<void> {
        await this.ensureInit();
        await this.tx(async () => {
            await this.db.run(`DELETE FROM ${this.tTx}`);
            await this.db.run(`DELETE FROM ${this.tBranch}`);
        });
    }

    async upsertVirtualTxs(txs: VirtualTx[]): Promise<void> {
        await this.ensureInit();
        await this.tx(async () => {
            for (const t of txs) {
                const prev = await this.db.get<VtxRow>(`SELECT * FROM ${this.tTx} WHERE txid = ?`, [
                    t.txid,
                ]);
                const hex = t.hex ?? prev?.hex ?? null;
                const expires = t.expiresAt ?? prev?.expires_at ?? null;
                const type = t.type ?? prev?.type ?? ChainedTxType.Unspecified;
                await this.db.run(
                    `INSERT OR REPLACE INTO ${this.tTx} (txid, hex, expires_at, type) VALUES (?, ?, ?, ?)`,
                    [t.txid, hex, expires, type],
                );
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
        const rows = await this.db.all<BranchRow>(
            `SELECT * FROM ${this.tBranch} WHERE vtxo_txid = ? AND vtxo_vout = ? ORDER BY position ASC`,
            [vtxo.txid, vtxo.vout],
        );
        const out: VirtualTx[] = [];
        for (const b of rows) {
            const t = await this.db.get<VtxRow>(`SELECT * FROM ${this.tTx} WHERE txid = ?`, [
                b.virtual_txid,
            ]);
            if (t) out.push(rowToTx(t));
        }
        return out;
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
            const removed = await this.db.all<BranchRow>(
                `SELECT * FROM ${this.tBranch} WHERE vtxo_txid = ? AND vtxo_vout = ?`,
                [vtxo.txid, vtxo.vout],
            );
            await this.db.run(`DELETE FROM ${this.tBranch} WHERE vtxo_txid = ? AND vtxo_vout = ?`, [
                vtxo.txid,
                vtxo.vout,
            ]);
            for (const e of removed) {
                const ref = await this.db.get<{ c: number }>(
                    `SELECT COUNT(*) AS c FROM ${this.tBranch} WHERE virtual_txid = ?`,
                    [e.virtual_txid],
                );
                if ((ref?.c ?? 0) === 0)
                    await this.db.run(`DELETE FROM ${this.tTx} WHERE txid = ?`, [e.virtual_txid]);
            }
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}

function rowToTx(r: VtxRow): VirtualTx {
    return {
        txid: r.txid,
        hex: r.hex ?? null,
        expiresAt: r.expires_at ?? null,
        type: r.type as ChainedTxType,
    };
}
