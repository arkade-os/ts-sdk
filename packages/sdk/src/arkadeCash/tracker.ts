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
    readonly contributions = new Map<string, Map<string, number>>();
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

/** Inject a public record and recover its per-transaction voucher shares. */
export function addArkadeCashRecord(records: ArkadeCashTracker, record: ArkadeCashRecord): void {
    records.records.set(record.id, record);
    const contributions = records.contributions.get(record.id) ?? new Map<string, number>();
    for (const txid of [...record.issueTxIds, ...record.claimTxIds]) {
        contributions.set(txid, record.amount);
    }
    records.contributions.set(record.id, contributions);
}

export function fundArkadeCashRecord(
    records: ArkadeCashTracker,
    cashId: string,
    amount: number,
    issueTxIds: string[],
    createdAt: number,
): void {
    const previous = records.get(cashId);
    records.records.set(cashId, {
        id: cashId,
        action: previous?.action === "claimed" ? "claimed" : "issued",
        amount,
        createdAt: previous?.createdAt ?? createdAt,
        outcome: "available",
        issueTxIds: [...new Set([...(previous?.issueTxIds ?? []), ...issueTxIds])],
        claimTxIds: previous?.claimTxIds ?? [],
    });
    const contributions = records.contributions.get(cashId) ?? new Map<string, number>();
    for (const txid of issueTxIds) contributions.set(txid, amount);
    records.contributions.set(cashId, contributions);
}

export function markArkadeCashClaimed(
    records: ArkadeCashTracker,
    cashId: string,
    amount: number,
    outcome: string,
    claimTxIds: string[],
    createdAt: number,
    contribution?: { txid: string; amount: number },
): void {
    const previous = records.get(cashId);
    records.records.set(cashId, {
        id: cashId,
        action: "claimed",
        amount,
        createdAt,
        outcome,
        issueTxIds: previous?.issueTxIds ?? [],
        claimTxIds: [...new Set([...(previous?.claimTxIds ?? []), ...claimTxIds])],
    });
    if (contribution) {
        const contributions = records.contributions.get(cashId) ?? new Map<string, number>();
        contributions.set(contribution.txid, contribution.amount);
        records.contributions.set(cashId, contributions);
    }
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
                const issueTxId = record.issueTxIds.find((id) => txids.has(id));
                const claimTxId = record.claimTxIds.find((id) => txids.has(id));
                if (!issueTxId && !claimTxId) return [];
                const direction = claimTxId ? "claimed" : "issued";
                const amount = records.contributions.get(record.id)?.get(claimTxId ?? issueTxId!);
                return [
                    {
                        groupId: `arkade-cash:${record.id}`,
                        label: direction === "issued" ? "Cash issued" : "Cash claimed",
                        kind: "arkade-cash",
                        outcome: record.outcome,
                        metadata: { cashId: record.id, direction },
                        amount,
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
