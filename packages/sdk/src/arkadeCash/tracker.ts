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

/** Inject a public record. */
export function addArkadeCashRecord(records: ArkadeCashTracker, record: ArkadeCashRecord): void {
    records.records.set(record.id, record);
}

export function arkadeCashId(cash: ArkadeCash): string {
    return hex.encode(cash.vtxoScript.pkScript);
}

export function arkadeCashResolver(records: ArkadeCashTracker): ActivityResolver {
    return {
        id: "arkade-cash",
        resolve(tx) {
            const txids = new Set(Object.values(tx.key));
            return records.list().flatMap((record) => {
                const issue = record.issues.find((entry) => txids.has(entry.txid));
                const claim = record.claims.find((entry) => txids.has(entry.txid));
                const match = claim ?? issue;
                if (!match) return [];
                const direction = claim ? "claimed" : "issued";
                return [
                    {
                        groupId: `arkade-cash:${record.id}`,
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
