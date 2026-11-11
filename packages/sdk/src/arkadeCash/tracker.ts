import { hex } from "@scure/base";
import type { Activity, ActivityResolver } from "../wallet/activity";
import { buildActivities } from "../wallet/activity";
import type { ArkTransaction } from "../wallet";
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
    // txid -> records touching it, each with its rank in `list()` order. Rebuilt by every
    // `prepare()` so a resolver kept across builds sees records added in between.
    let index: Map<string, { record: ArkadeCashRecord; rank: number }[]> | undefined;
    const build = () => {
        const next = new Map<string, { record: ArkadeCashRecord; rank: number }[]>();
        records.list().forEach((record, rank) => {
            for (const { txid } of [...record.issues, ...record.claims]) {
                const entries = next.get(txid) ?? [];
                if (entries[entries.length - 1]?.record !== record) entries.push({ record, rank });
                next.set(txid, entries);
            }
        });
        return next;
    };
    return {
        id: "arkade-cash",
        async prepare() {
            index = build();
        },
        resolve(tx) {
            index ??= build();
            const txids = new Set(Object.values(tx.key));
            const candidates = new Map<ArkadeCashRecord, number>();
            for (const txid of txids) {
                for (const { record, rank } of index.get(txid) ?? []) candidates.set(record, rank);
            }
            return [...candidates]
                .sort((a, b) => a[1] - b[1])
                .flatMap(([record]) => {
                    const issue = record.issues.find((entry) => txids.has(entry.txid));
                    const claim = record.claims.find((entry) => txids.has(entry.txid));
                    const match = claim ?? issue;
                    if (!match) return [];
                    const direction = claim ? "claimed" : "issued";
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
