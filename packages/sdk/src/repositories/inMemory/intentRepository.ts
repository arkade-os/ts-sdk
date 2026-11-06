import { Outpoint } from "../../wallet";
import {
    ArkIntent,
    assertIntentIdUnique,
    IntentPageFilter,
    IntentRepository,
    intentMatchesFilter,
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
        this.byId.set(intent.proofTxId, {
            ...intent,
            proofInputs: [...intent.proofInputs],
            partialForfeits: [...intent.partialForfeits],
            updatedAt: Date.now(),
        });
    }

    async getIntentsPage(
        filter: IntentPageFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<ArkIntent>> {
        assertPageRequest(page);
        const rows = [...this.byId.values()]
            .filter(
                (intent) =>
                    (page.after === undefined || intent.proofTxId > page.after) &&
                    (!filter || intentMatchesFilter(intent, filter)),
            )
            .sort((a, b) => (a.proofTxId < b.proofTxId ? -1 : a.proofTxId > b.proofTxId ? 1 : 0))
            .slice(0, page.limit + 1)
            .map(clone);
        return pageResult(rows, page.limit, (intent) => intent.proofTxId);
    }

    async getLockedVtxoOutpoints(): Promise<Outpoint[]> {
        const out: Outpoint[] = [];
        for (const i of this.byId.values())
            if (!isTerminalIntentState(i.state)) for (const o of i.proofInputs) out.push({ ...o });
        return out;
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}

const clone = (i: ArkIntent): ArkIntent => ({
    ...i,
    proofInputs: i.proofInputs.map((o) => ({ ...o })),
    partialForfeits: [...i.partialForfeits],
});
