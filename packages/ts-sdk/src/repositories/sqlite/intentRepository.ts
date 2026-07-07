import { Outpoint } from "../../wallet";
import {
    ArkIntent,
    ArkIntentState,
    IntentFilter,
    IntentRepository,
    intentMatchesFilter,
    intentPageBounds,
    isTerminalIntentState,
} from "../intentRepository";
import { SQLExecutor } from "./types";
import { runInTransaction } from "./transaction";

const SAFE_PREFIX = /^[a-zA-Z0-9_]+$/;
function sanitizePrefix(p: string): string {
    if (!SAFE_PREFIX.test(p)) throw new Error(`Invalid table prefix "${p}"`);
    return p;
}

interface IntentRow {
    intent_tx_id: string;
    intent_id: string | null;
    state: string;
    valid_from: number | null;
    valid_until: number | null;
    created_at: number;
    updated_at: number;
    register_proof: string;
    register_proof_message: string;
    delete_proof: string;
    delete_proof_message: string;
    batch_id: string | null;
    commitment_txid: string | null;
    cancellation_reason: string | null;
    partial_forfeits_json: string;
    signer_descriptor: string | null;
    intent_vtxos_json: string;
}

export class SQLiteIntentRepository implements IntentRepository {
    readonly version = 1 as const;
    private initPromise: Promise<void> | null = null;
    private readonly prefix: string;
    private readonly t: string;

    constructor(
        private readonly db: SQLExecutor,
        options?: { prefix?: string },
    ) {
        this.prefix = sanitizePrefix(options?.prefix ?? "ark_");
        this.t = `${this.prefix}intents`;
    }

    private ensureInit(): Promise<void> {
        if (!this.initPromise) this.initPromise = this.init();
        return this.initPromise;
    }

    private async init(): Promise<void> {
        await this.db.run(`CREATE TABLE IF NOT EXISTS ${this.t} (
            intent_tx_id TEXT PRIMARY KEY,
            intent_id TEXT,
            state TEXT NOT NULL,
            valid_from INTEGER,
            valid_until INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            register_proof TEXT NOT NULL,
            register_proof_message TEXT NOT NULL,
            delete_proof TEXT NOT NULL,
            delete_proof_message TEXT NOT NULL,
            batch_id TEXT,
            commitment_txid TEXT,
            cancellation_reason TEXT,
            partial_forfeits_json TEXT NOT NULL,
            signer_descriptor TEXT,
            intent_vtxos_json TEXT NOT NULL
        )`);
        await this.db.run(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_${this.prefix}intent_id ON ${this.t} (intent_id) WHERE intent_id IS NOT NULL`,
        );
        await this.db.run(
            `CREATE INDEX IF NOT EXISTS idx_${this.prefix}intent_state ON ${this.t} (state)`,
        );
    }

    private withTx(fn: () => Promise<void>): Promise<void> {
        return runInTransaction(this.db, fn);
    }

    async clear(): Promise<void> {
        await this.ensureInit();
        await this.db.run(`DELETE FROM ${this.t}`);
    }

    async saveIntent(intent: ArkIntent): Promise<void> {
        await this.ensureInit();
        const now = Date.now();
        await this.withTx(async () => {
            // Upsert by the primary key only. INSERT OR REPLACE would also fire
            // on the intent_id unique index, silently deleting the *other* row
            // that holds it; ON CONFLICT(intent_tx_id) updates in place and lets
            // an intent_id collision surface as a constraint error instead.
            await this.db.run(
                `INSERT INTO ${this.t}
                 (intent_tx_id, intent_id, state, valid_from, valid_until,
                  created_at, updated_at, register_proof, register_proof_message,
                  delete_proof, delete_proof_message, batch_id, commitment_txid,
                  cancellation_reason, partial_forfeits_json, signer_descriptor,
                  intent_vtxos_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(intent_tx_id) DO UPDATE SET
                  intent_id = excluded.intent_id,
                  state = excluded.state,
                  valid_from = excluded.valid_from,
                  valid_until = excluded.valid_until,
                  created_at = excluded.created_at,
                  updated_at = excluded.updated_at,
                  register_proof = excluded.register_proof,
                  register_proof_message = excluded.register_proof_message,
                  delete_proof = excluded.delete_proof,
                  delete_proof_message = excluded.delete_proof_message,
                  batch_id = excluded.batch_id,
                  commitment_txid = excluded.commitment_txid,
                  cancellation_reason = excluded.cancellation_reason,
                  partial_forfeits_json = excluded.partial_forfeits_json,
                  signer_descriptor = excluded.signer_descriptor,
                  intent_vtxos_json = excluded.intent_vtxos_json`,
                [
                    intent.intentTxId,
                    intent.intentId ?? null,
                    intent.state,
                    intent.validFrom ?? null,
                    intent.validUntil ?? null,
                    intent.createdAt,
                    now,
                    intent.registerProof,
                    intent.registerProofMessage,
                    intent.deleteProof,
                    intent.deleteProofMessage,
                    intent.batchId ?? null,
                    intent.commitmentTransactionId ?? null,
                    intent.cancellationReason ?? null,
                    JSON.stringify(intent.partialForfeits),
                    intent.signerDescriptor ?? null,
                    JSON.stringify(intent.intentVtxos),
                ],
            );
        });
    }

    async getIntents(filter?: IntentFilter): Promise<ArkIntent[]> {
        await this.ensureInit();
        const rows = await this.db.all<IntentRow>(
            `SELECT * FROM ${this.t} ORDER BY created_at ASC, intent_tx_id ASC`,
        );
        let out = rows.map(rowToIntent);
        if (filter) out = out.filter((i) => intentMatchesFilter(i, filter));
        const { skip, end } = intentPageBounds(filter, out.length);
        return out.slice(skip, end);
    }

    async getLockedVtxoOutpoints(): Promise<Outpoint[]> {
        await this.ensureInit();
        const rows = await this.db.all<IntentRow>(`SELECT * FROM ${this.t}`);
        const out: Outpoint[] = [];
        for (const r of rows) {
            if (isTerminalIntentState(r.state as ArkIntentState)) continue;
            for (const o of JSON.parse(r.intent_vtxos_json) as Outpoint[]) out.push(o);
        }
        return out;
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}

function rowToIntent(r: IntentRow): ArkIntent {
    return {
        intentTxId: r.intent_tx_id,
        intentId: r.intent_id ?? undefined,
        state: r.state as ArkIntentState,
        validFrom: r.valid_from ?? undefined,
        validUntil: r.valid_until ?? undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        registerProof: r.register_proof,
        registerProofMessage: r.register_proof_message,
        deleteProof: r.delete_proof,
        deleteProofMessage: r.delete_proof_message,
        batchId: r.batch_id ?? undefined,
        commitmentTransactionId: r.commitment_txid ?? undefined,
        cancellationReason: r.cancellation_reason ?? undefined,
        partialForfeits: JSON.parse(r.partial_forfeits_json),
        signerDescriptor: r.signer_descriptor ?? undefined,
        intentVtxos: JSON.parse(r.intent_vtxos_json),
    };
}
