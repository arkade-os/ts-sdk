import { Outpoint } from "../../wallet";
import {
    ArkIntent,
    IntentFilter,
    IntentRepository,
    isTerminalIntentState,
} from "../intentRepository";

export class InMemoryIntentRepository implements IntentRepository {
    readonly version = 1 as const;
    private byId = new Map<string, ArkIntent>();

    async clear(): Promise<void> {
        this.byId.clear();
    }

    async saveIntent(intent: ArkIntent): Promise<void> {
        this.byId.set(intent.intentTxId, {
            ...intent,
            intentVtxos: [...intent.intentVtxos],
            partialForfeits: [...intent.partialForfeits],
            updatedAt: Date.now(),
        });
    }

    async getIntents(filter?: IntentFilter): Promise<ArkIntent[]> {
        let out = [...this.byId.values()];
        if (filter) out = out.filter((i) => matches(i, filter));
        // Stable order shared with all persistent backends: (createdAt, intentTxId).
        out.sort((a, b) => a.createdAt - b.createdAt || a.intentTxId.localeCompare(b.intentTxId));
        const skip = filter?.skip ?? 0;
        const take = filter?.take ?? out.length;
        return out.slice(skip, skip + take).map(clone);
    }

    async getLockedVtxoOutpoints(): Promise<Outpoint[]> {
        const out: Outpoint[] = [];
        for (const i of this.byId.values())
            if (!isTerminalIntentState(i.state)) for (const o of i.intentVtxos) out.push({ ...o });
        return out;
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}

const clone = (i: ArkIntent): ArkIntent => ({
    ...i,
    intentVtxos: i.intentVtxos.map((o) => ({ ...o })),
    partialForfeits: [...i.partialForfeits],
});

export function matches(i: ArkIntent, f: IntentFilter): boolean {
    if (f.intentTxIds && !f.intentTxIds.includes(i.intentTxId)) return false;
    if (f.intentIds && (!i.intentId || !f.intentIds.includes(i.intentId))) return false;
    if (f.states && !f.states.includes(i.state)) return false;
    if (f.containingInputs) {
        const keys = new Set(i.intentVtxos.map((o) => `${o.txid}:${o.vout}`));
        if (!f.containingInputs.some((o) => keys.has(`${o.txid}:${o.vout}`))) return false;
    }
    if (f.validAt !== undefined) {
        if (i.validFrom !== undefined && f.validAt < i.validFrom) return false;
        if (i.validUntil !== undefined && f.validAt > i.validUntil) return false;
    }
    if (f.searchText) {
        const hay = [i.intentId, i.batchId, i.commitmentTransactionId].filter(Boolean).join(" ");
        if (!hay.includes(f.searchText)) return false;
    }
    return true;
}
