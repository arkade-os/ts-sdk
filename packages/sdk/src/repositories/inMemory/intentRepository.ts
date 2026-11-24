import { Outpoint } from "../../wallet";
import {
    BatchRegistration,
    assertIntentIdUnique,
    BatchRegistrationPageFilter,
    BatchRegistrationRepository,
    intentMatchesFilter,
    isTerminalBatchRegistrationState,
} from "../intentRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";

export class InMemoryBatchRegistrationRepository implements BatchRegistrationRepository {
    readonly version = 1 as const;
    private byId = new Map<string, BatchRegistration>();

    async clear(): Promise<void> {
        this.byId.clear();
    }

    async saveBatchRegistration(intent: BatchRegistration): Promise<void> {
        assertIntentIdUnique(intent, this.byId.values());
        this.byId.set(intent.proofTxId, {
            ...intent,
            proofInputs: [...intent.proofInputs],
            partialForfeits: [...intent.partialForfeits],
            updatedAt: Date.now(),
        });
    }

    async getBatchRegistrationsPage(
        filter: BatchRegistrationPageFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<BatchRegistration>> {
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
            if (!isTerminalBatchRegistrationState(i.state))
                for (const o of i.proofInputs) out.push({ ...o });
        return out;
    }

    /** @deprecated Use {@link saveBatchRegistration}. */
    saveIntent(intent: BatchRegistration) {
        return this.saveBatchRegistration(intent);
    }

    /** @deprecated Use {@link getBatchRegistrationsPage}. */
    getIntentsPage(filter: BatchRegistrationPageFilter | undefined, page: PageRequest) {
        return this.getBatchRegistrationsPage(filter, page);
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}

const clone = (i: BatchRegistration): BatchRegistration => ({
    ...i,
    proofInputs: i.proofInputs.map((o) => ({ ...o })),
    partialForfeits: [...i.partialForfeits],
});

/** @deprecated Use {@link InMemoryBatchRegistrationRepository}. */
export const InMemoryIntentRepository = InMemoryBatchRegistrationRepository;
/** @deprecated Use {@link InMemoryBatchRegistrationRepository}. */
export type InMemoryIntentRepository = InMemoryBatchRegistrationRepository;
