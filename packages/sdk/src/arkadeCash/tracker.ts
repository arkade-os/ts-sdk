import { hex } from "@scure/base";
import type { Activity, ActivityResolver } from "../wallet/activity";
import { buildActivities } from "../wallet/activity";
import type { ArkTransaction } from "../wallet";
import { ArkadeCash } from ".";

export type ArkadeCashAction = "issued" | "claimed";

export interface ArkadeCashRecord {
    id: string;
    action: ArkadeCashAction;
    amount: number;
    createdAt: number;
    outcome: string;
    issueTxIds: string[];
    claimTxIds: string[];
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

export async function fundArkadeCashRecord(
    records: ArkadeCashTracker,
    cashId: string,
    amount: number,
    issueTxIds: string[],
    createdAt: number,
): Promise<void> {
    records.records.set(cashId, {
        id: cashId,
        action: "issued",
        amount,
        createdAt,
        outcome: "available",
        issueTxIds,
        claimTxIds: [],
    });
}

export async function markArkadeCashClaimed(
    records: ArkadeCashTracker,
    cashId: string,
    amount: number,
    outcome: string,
    claimTxIds: string[],
    createdAt: number,
): Promise<void> {
    records.records.set(cashId, {
        id: cashId,
        action: "claimed",
        amount,
        createdAt,
        outcome,
        issueTxIds: [],
        claimTxIds,
    });
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
                if (
                    !record.issueTxIds.some((id) => txids.has(id)) &&
                    !record.claimTxIds.some((id) => txids.has(id))
                )
                    return [];
                return [
                    {
                        groupId: `arkade-cash:${record.id}`,
                        label: record.action === "issued" ? "Cash issued" : "Cash claimed",
                        kind: "arkade-cash",
                        outcome: record.outcome,
                        metadata: { cashId: record.id, direction: record.action },
                        amount: tx.amount,
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
