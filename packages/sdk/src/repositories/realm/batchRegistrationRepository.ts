import { Outpoint } from "../../wallet";
import {
    BatchRegistration,
    BatchRegistrationState,
    assertRegistrationIdUnique,
    BatchRegistrationPageFilter,
    IntentRepository,
    registrationMatchesFilter,
    isTerminalBatchRegistrationState,
} from "../batchRegistrationRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";
import { RealmLike } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRegistration(o: any): BatchRegistration {
    return {
        proofTxId: o.intentTxId,
        registrationId: o.intentId ?? undefined,
        state: o.state as BatchRegistrationState,
        validFrom: o.validFrom ?? undefined,
        validUntil: o.validUntil ?? undefined,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        registerProof: o.registerProof,
        registerProofMessage: o.registerProofMessage,
        deleteProof: o.deleteProof,
        deleteProofMessage: o.deleteProofMessage,
        batchId: o.batchId ?? undefined,
        commitmentTransactionId: o.commitmentTransactionId ?? undefined,
        cancellationReason: o.cancellationReason ?? undefined,
        partialForfeits: JSON.parse(o.partialForfeitsJson),
        signerDescriptor: o.signerDescriptor ?? undefined,
        inputs: JSON.parse(o.intentVtxosJson),
    };
}

export class RealmBatchRegistrationRepository implements IntentRepository {
    readonly version = 2 as const;
    /** @deprecated Use {@link saveRegistration}. */
    saveIntent = this.saveRegistration;
    /** @deprecated Use {@link getRegistrationsPage}. */
    getIntentsPage = this.getRegistrationsPage;
    constructor(private readonly realm: RealmLike) {}

    async clear(): Promise<void> {
        this.realm.write(() => {
            this.realm.delete(this.realm.objects("ArkIntent"));
        });
    }

    async saveRegistration(registration: BatchRegistration): Promise<void> {
        this.realm.write(() => {
            if (registration.registrationId != null) {
                const clashes = [
                    ...this.realm
                        .objects("ArkIntent")
                        .filtered("intentId == $0", registration.registrationId),
                ].map(toRegistration);
                assertRegistrationIdUnique(registration, clashes);
            }
            this.realm.create(
                "ArkIntent",
                {
                    intentTxId: registration.proofTxId,
                    intentId: registration.registrationId ?? null,
                    state: registration.state,
                    validFrom: registration.validFrom ?? null,
                    validUntil: registration.validUntil ?? null,
                    createdAt: registration.createdAt,
                    updatedAt: Date.now(),
                    registerProof: registration.registerProof,
                    registerProofMessage: registration.registerProofMessage,
                    deleteProof: registration.deleteProof,
                    deleteProofMessage: registration.deleteProofMessage,
                    batchId: registration.batchId ?? null,
                    commitmentTransactionId: registration.commitmentTransactionId ?? null,
                    cancellationReason: registration.cancellationReason ?? null,
                    partialForfeitsJson: JSON.stringify(registration.partialForfeits),
                    signerDescriptor: registration.signerDescriptor ?? null,
                    intentVtxosJson: JSON.stringify(registration.inputs),
                },
                "modified",
            );
        });
    }

    async getRegistrationsPage(
        filter: BatchRegistrationPageFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<BatchRegistration>> {
        assertPageRequest(page);
        let results = this.realm.objects("ArkIntent");
        if (page.after !== undefined) results = results.filtered("intentTxId > $0", page.after);
        const rows: BatchRegistration[] = [];
        for (const row of results.sorted("intentTxId")) {
            const registration = toRegistration(row);
            if (filter && !registrationMatchesFilter(registration, filter)) continue;
            rows.push(registration);
            if (rows.length > page.limit) break;
        }
        return pageResult(rows, page.limit, (registration) => registration.proofTxId);
    }

    async getLockedVtxoOutpoints(): Promise<Outpoint[]> {
        const out: Outpoint[] = [];
        for (const o of [...this.realm.objects("ArkIntent")].map(toRegistration))
            if (!isTerminalBatchRegistrationState(o.state)) out.push(...o.inputs);
        return out;
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}

/** @deprecated Use {@link RealmBatchRegistrationRepository}. */
export const RealmIntentRepository = RealmBatchRegistrationRepository;
/** @deprecated Use {@link RealmBatchRegistrationRepository}. */
export type RealmIntentRepository = RealmBatchRegistrationRepository;
