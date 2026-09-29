import { Outpoint } from "../../wallet";
import {
    ArkIntent,
    assertIntentIdUnique,
    IntentFilter,
    IntentPageFilter,
    IntentRepository,
    intentMatchesFilter,
    intentPageBounds,
    isTerminalIntentState,
} from "../intentRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";

export class InMemoryIntentRepository implements IntentRepository {
    readonly version = 1 as const;
    private byId = new Map<string, ArkIntent>();

    async clear(): Promise<void> {
        this.byId.clear();
    }

    async saveIntent(intent: ArkIntent): Promise<void> {
        assertIntentIdUnique(intent, this.byId.values());
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

    async getIntentsPage(
        filter: IntentPageFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<ArkIntent>> {
        assertPageRequest(page);
        const rows = [...this.byId.values()]
            .filter(
                (intent) =>
                    (page.after === undefined || intent.intentTxId > page.after) &&
                    (!filter || intentMatchesFilter(intent, filter)),
            )
            .sort((a, b) =>
                a.intentTxId < b.intentTxId ? -1 : a.intentTxId > b.intentTxId ? 1 : 0,
            )
            .slice(0, page.limit + 1)
            .map(clone);
        return pageResult(rows, page.limit, (intent) => intent.intentTxId);
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
