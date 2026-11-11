import { Outpoint } from "../../wallet";
import {
    ArkIntent,
    assertIntentIdUnique,
    IntentPageFilter,
    BatchRegistrationRepository,
    intentMatchesFilter,
    isTerminalIntentState,
} from "../intentRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";

export class InMemoryBatchRegistrationRepository implements BatchRegistrationRepository {
    readonly version = 1 as const;
    private byId = new Map<string, ArkIntent>();

    async clear(): Promise<void> {
        this.byId.clear();
    }

    async saveBatchRegistration(intent: ArkIntent): Promise<void> {
        assertIntentIdUnique(intent, this.byId.values());
        this.byId.set(intent.proofTxId, {
            ...intent,
            proofInputs: [...intent.proofInputs],
            partialForfeits: [...intent.partialForfeits],
            updatedAt: Date.now(),
        });
    }

    async getBatchRegistrationsPage(
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

    /** @deprecated Use {@link saveBatchRegistration}. */
    saveIntent(intent: ArkIntent) {
        return this.saveBatchRegistration(intent);
    }

    /** @deprecated Use {@link getBatchRegistrationsPage}. */
    getIntentsPage(filter: IntentPageFilter | undefined, page: PageRequest) {
        return this.getBatchRegistrationsPage(filter, page);
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}

const clone = (i: ArkIntent): ArkIntent => ({
    ...i,
    proofInputs: i.proofInputs.map((o) => ({ ...o })),
    partialForfeits: [...i.partialForfeits],
});

/** @deprecated Use {@link InMemoryBatchRegistrationRepository}. */
export const InMemoryIntentRepository = InMemoryBatchRegistrationRepository;
/** @deprecated Use {@link InMemoryBatchRegistrationRepository}. */
export type InMemoryIntentRepository = InMemoryBatchRegistrationRepository;
