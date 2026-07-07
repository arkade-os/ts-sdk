import { Outpoint } from "../../wallet";
import {
    ArkIntent,
    ArkIntentState,
    assertIntentIdUnique,
    IntentFilter,
    IntentRepository,
    intentMatchesFilter,
    intentPageBounds,
    isTerminalIntentState,
} from "../intentRepository";
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

    async getIntents(filter?: IntentFilter): Promise<ArkIntent[]> {
        const all = [...this.realm.objects("ArkIntent")]
            .map(toIntent)
            .sort((a, b) => a.createdAt - b.createdAt || a.intentTxId.localeCompare(b.intentTxId));
        const out = filter ? all.filter((i) => intentMatchesFilter(i, filter)) : all;
        const { skip, end } = intentPageBounds(filter, out.length);
        return out.slice(skip, end);
    }

    async getLockedVtxoOutpoints(): Promise<Outpoint[]> {
        const out: Outpoint[] = [];
        for (const o of [...this.realm.objects("ArkIntent")].map(toIntent))
            if (!isTerminalIntentState(o.state)) out.push(...o.intentVtxos);
        return out;
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}
