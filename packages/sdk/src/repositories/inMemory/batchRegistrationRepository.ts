import { Outpoint } from "../../wallet";
import {
    BatchRegistration,
    assertRegistrationIdUnique,
    BatchRegistrationPageFilter,
    IntentRepository,
    registrationMatchesFilter,
    isTerminalBatchRegistrationState,
} from "../batchRegistrationRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";

export class InMemoryBatchRegistrationRepository implements IntentRepository {
    readonly version = 2 as const;
    /** @deprecated Use {@link saveRegistration}. */
    saveIntent = this.saveRegistration;
    /** @deprecated Use {@link getRegistrationsPage}. */
    getIntentsPage = this.getRegistrationsPage;
    private byId = new Map<string, BatchRegistration>();

    async clear(): Promise<void> {
        this.byId.clear();
    }

    async saveRegistration(registration: BatchRegistration): Promise<void> {
        assertRegistrationIdUnique(registration, this.byId.values());
        this.byId.set(registration.proofTxId, {
            ...registration,
            inputs: [...registration.inputs],
            partialForfeits: [...registration.partialForfeits],
            updatedAt: Date.now(),
        });
    }

    async getRegistrationsPage(
        filter: BatchRegistrationPageFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<BatchRegistration>> {
        assertPageRequest(page);
        const rows = [...this.byId.values()]
            .filter(
                (registration) =>
                    (page.after === undefined || registration.proofTxId > page.after) &&
                    (!filter || registrationMatchesFilter(registration, filter)),
            )
            .sort((a, b) => (a.proofTxId < b.proofTxId ? -1 : a.proofTxId > b.proofTxId ? 1 : 0))
            .slice(0, page.limit + 1)
            .map(clone);
        return pageResult(rows, page.limit, (registration) => registration.proofTxId);
    }

    async getLockedVtxoOutpoints(): Promise<Outpoint[]> {
        const out: Outpoint[] = [];
        for (const i of this.byId.values())
            if (!isTerminalBatchRegistrationState(i.state))
                for (const o of i.inputs) out.push({ ...o });
        return out;
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}

const clone = (i: BatchRegistration): BatchRegistration => ({
    ...i,
    inputs: i.inputs.map((o) => ({ ...o })),
    partialForfeits: [...i.partialForfeits],
});

/** @deprecated Use {@link InMemoryBatchRegistrationRepository}. */
export const InMemoryIntentRepository = InMemoryBatchRegistrationRepository;
/** @deprecated Use {@link InMemoryBatchRegistrationRepository}. */
export type InMemoryIntentRepository = InMemoryBatchRegistrationRepository;
