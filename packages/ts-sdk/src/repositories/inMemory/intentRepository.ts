import { Outpoint } from "../../wallet";
import {
    ArkIntent,
    IntentFilter,
    IntentRepository,
    intentMatchesFilter,
    intentPageBounds,
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
        if (filter) out = out.filter((i) => intentMatchesFilter(i, filter));
        // Stable order shared with all persistent backends: (createdAt, intentTxId).
        out.sort((a, b) => a.createdAt - b.createdAt || a.intentTxId.localeCompare(b.intentTxId));
        const { skip, end } = intentPageBounds(filter, out.length);
        return out.slice(skip, end).map(clone);
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
