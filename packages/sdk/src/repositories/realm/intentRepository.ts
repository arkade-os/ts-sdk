import { Outpoint } from "../../wallet";
import {
    ArkIntent,
    ArkIntentState,
    assertIntentIdUnique,
    IntentPageFilter,
    IntentRepository,
    intentMatchesFilter,
    isTerminalIntentState,
} from "../intentRepository";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";
import { RealmLike } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toIntent(o: any): ArkIntent {
    return {
        intentTxId: o.intentTxId,
        intentId: o.intentId ?? undefined,
        state: o.state as ArkIntentState,
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
        intentVtxos: JSON.parse(o.intentVtxosJson),
    };
}

export class RealmIntentRepository implements IntentRepository {
    readonly version = 1 as const;
    constructor(private readonly realm: RealmLike) {}

    async clear(): Promise<void> {
        this.realm.write(() => {
            this.realm.delete(this.realm.objects("ArkIntent"));
        });
    }

    async saveIntent(intent: ArkIntent): Promise<void> {
        this.realm.write(() => {
            if (intent.intentId != null) {
                const clashes = [
                    ...this.realm.objects("ArkIntent").filtered("intentId == $0", intent.intentId),
                ].map(toIntent);
                assertIntentIdUnique(intent, clashes);
            }
            this.realm.create(
                "ArkIntent",
                {
                    intentTxId: intent.intentTxId,
                    intentId: intent.intentId ?? null,
                    state: intent.state,
                    validFrom: intent.validFrom ?? null,
                    validUntil: intent.validUntil ?? null,
                    createdAt: intent.createdAt,
                    updatedAt: Date.now(),
                    registerProof: intent.registerProof,
                    registerProofMessage: intent.registerProofMessage,
                    deleteProof: intent.deleteProof,
                    deleteProofMessage: intent.deleteProofMessage,
                    batchId: intent.batchId ?? null,
                    commitmentTransactionId: intent.commitmentTransactionId ?? null,
                    cancellationReason: intent.cancellationReason ?? null,
                    partialForfeitsJson: JSON.stringify(intent.partialForfeits),
                    signerDescriptor: intent.signerDescriptor ?? null,
                    intentVtxosJson: JSON.stringify(intent.intentVtxos),
                },
                "modified",
            );
        });
    }

    async getIntentsPage(
        filter: IntentPageFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<ArkIntent>> {
        assertPageRequest(page);
        let results = this.realm.objects("ArkIntent");
        if (page.after !== undefined) results = results.filtered("intentTxId > $0", page.after);
        const rows: ArkIntent[] = [];
        for (const row of results.sorted("intentTxId")) {
            const intent = toIntent(row);
            if (filter && !intentMatchesFilter(intent, filter)) continue;
            rows.push(intent);
            if (rows.length > page.limit) break;
        }
        return pageResult(rows, page.limit, (intent) => intent.intentTxId);
    }

    async getLockedVtxoOutpoints(): Promise<Outpoint[]> {
        const out: Outpoint[] = [];
        for (const o of [...this.realm.objects("ArkIntent")].map(toIntent))
            if (!isTerminalIntentState(o.state)) out.push(...o.intentVtxos);
        return out;
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}
