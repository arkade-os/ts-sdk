import { hex } from "@scure/base";
import type { Activity, ActivityResolver } from "../wallet/activity";
import { buildActivities } from "../wallet/activity";
import { TxType, type ArkTransaction } from "../wallet";
import { ArkadeCash } from ".";

export type ArkadeCashAction = "issued" | "claimed";

/** One transaction of a voucher and the voucher's share of it, in sats. */
export interface ArkadeCashTx {
    txid: string;
    amount: number;
}

export interface ArkadeCashRecord {
    id: string;
    action: ArkadeCashAction;
    createdAt: number;
    outcome: string;
    issues: ArkadeCashTx[];
    claims: ArkadeCashTx[];
}

export class ArkadeCashTracker {
    readonly records = new Map<string, ArkadeCashRecord>();

    get(id: string): ArkadeCashRecord | undefined {
        return this.records.get(id);
    }

    list(): ArkadeCashRecord[] {
        return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
    }
}

export function createArkadeCashTracker(): ArkadeCashTracker {
    return new ArkadeCashTracker();
}

const unionByTxid = (a: ArkadeCashTx[], b: ArkadeCashTx[]): ArkadeCashTx[] => [
    ...new Map([...a, ...b].map((entry) => [entry.txid, entry])).values(),
];

/**
 * Combine two records of one voucher. Transactions are unioned by txid and the earliest
 * `createdAt` is kept. A claim outranks an issue for `action` and `outcome`; between records
 * with the same action, `next` wins.
 */
export function mergeArkadeCashRecord(
    prev: ArkadeCashRecord | undefined,
    next: ArkadeCashRecord,
): ArkadeCashRecord {
    if (!prev) return next;
    const lead = prev.action === "claimed" && next.action === "issued" ? prev : next;
    return {
        id: next.id,
        action: lead.action,
        outcome: lead.outcome,
        createdAt: Math.min(prev.createdAt, next.createdAt),
        issues: unionByTxid(prev.issues, next.issues),
        claims: unionByTxid(prev.claims, next.claims),
    };
}

/** Whether a stored wallet-state entry has the current record shape. */
export function isArkadeCashRecord(value: unknown): value is ArkadeCashRecord {
    if (!value || typeof value !== "object") return false;
    const v = value as Partial<ArkadeCashRecord>;
    return (
        typeof v.id === "string" &&
        (v.action === "issued" || v.action === "claimed") &&
        typeof v.createdAt === "number" &&
        typeof v.outcome === "string" &&
        Array.isArray(v.issues) &&
        Array.isArray(v.claims)
    );
}

/** Inject a public record, merging it into any record already held for the voucher. */
export function addArkadeCashRecord(records: ArkadeCashTracker, record: ArkadeCashRecord): void {
    records.records.set(record.id, mergeArkadeCashRecord(records.get(record.id), record));
}

export function arkadeCashId(cash: ArkadeCash): string {
    return hex.encode(cash.vtxoScript.pkScript);
}

export function arkadeCashResolver(records: ArkadeCashTracker): ActivityResolver {
    // txid -> records touching it, in `list()` order. Rebuilt by every `prepare()` so a resolver
    // kept across builds sees records added in between.
    let index: Map<string, ArkadeCashRecord[]> | undefined;
    const build = () => {
        const next = new Map<string, ArkadeCashRecord[]>();
        for (const record of records.list()) {
            for (const { txid } of [...record.issues, ...record.claims]) {
                const touching = next.get(txid) ?? [];
                if (touching[touching.length - 1] !== record) touching.push(record);
                next.set(txid, touching);
            }
        }
        return next;
    };
    return {
        id: "arkade-cash",
        async prepare() {
            index = build();
        },
        resolve(tx) {
            // No voucher transaction is a boarding: such a row only shares a commitment.
            if (tx.key.boardingTxid) return [];
            index ??= build();
            // A row is one transaction: an offchain one by its ark txid, a batch output by the
            // commitment its round shares with every other row of that round.
            const txid = tx.key.arkTxid || tx.key.commitmentTxid;
            const isBatchRow = !tx.key.arkTxid;
            // An issue is money leaving the wallet into a voucher and a claim is money arriving
            // from one, so a row of the other direction is somebody else's.
            const direction = tx.type === TxType.TxSent ? "issued" : "claimed";
            return (index.get(txid) ?? []).flatMap((record) => {
                const entries = direction === "issued" ? record.issues : record.claims;
                // A batch row is exactly one output, and the voucher's share of its round is
                // exactly one output too, so only the row of that value is the voucher's.
                const match = entries.find(
                    (entry) => entry.txid === txid && (!isBatchRow || entry.amount === tx.amount),
                );
                if (!match) return [];
                return [
                    {
                        groupId: `arkade-cash:${record.id}:${direction}`,
                        label: direction === "issued" ? "Cash issued" : "Cash claimed",
                        kind: "arkade-cash",
                        outcome: record.outcome,
                        metadata: { cashId: record.id, direction },
                        amount: match.amount,
                    },
                ];
            });
        },
    };
}

export async function arkadeCashActivity(
    records: ArkadeCashTracker,
    txs: ArkTransaction[],
): Promise<Activity[]> {
    const activities = await buildActivities(txs, [arkadeCashResolver(records)]);
    return activities.filter((activity) => activity.intent?.kind === "arkade-cash");
}
