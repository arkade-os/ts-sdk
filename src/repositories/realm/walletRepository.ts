import {
    ArkTransaction,
    ExtendedCoin,
    ExtendedVirtualCoin,
} from "../../wallet";
import { WalletRepository, WalletState } from "../walletRepository";
import {
    serializeVtxo,
    serializeUtxo,
    deserializeVtxo,
    deserializeUtxo,
    SerializedTapLeaf,
} from "../serialization";

/**
 * Realm-based implementation of WalletRepository.
 *
 * Since `realm` is a peer dependency and not installed in this package,
 * the Realm instance is typed as `any`. Consumers must open Realm with
 * the schemas from `./schemas.ts` and pass the instance to the constructor.
 *
 * Realm handles schema creation on open, so `ensureInit()` is a no-op.
 * The consumer owns the Realm lifecycle — `[Symbol.asyncDispose]` is a no-op.
 */
export class RealmWalletRepository implements WalletRepository {
    readonly version = 1 as const;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(private readonly realm: any) {}

    // ── Lifecycle ──────────────────────────────────────────────────────

    private async ensureInit(): Promise<void> {
        // Realm handles schema on open — nothing to initialise.
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // no-op — consumer owns the Realm lifecycle
    }

    // ── Clear ──────────────────────────────────────────────────────────

    async clear(): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            this.realm.delete(this.realm.objects("ArkVtxo"));
            this.realm.delete(this.realm.objects("ArkUtxo"));
            this.realm.delete(this.realm.objects("ArkTransaction"));
            this.realm.delete(this.realm.objects("ArkWalletState"));
        });
    }

    // ── VTXO management ────────────────────────────────────────────────

    async getVtxos(address: string): Promise<ExtendedVirtualCoin[]> {
        await this.ensureInit();
        const results = this.realm
            .objects("ArkVtxo")
            .filtered("address == $0", address);
        return [...results].map(vtxoObjectToDomain);
    }

    async saveVtxos(
        address: string,
        vtxos: ExtendedVirtualCoin[]
    ): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            for (const vtxo of vtxos) {
                const s = serializeVtxo(vtxo);
                this.realm.create(
                    "ArkVtxo",
                    {
                        pk: `${s.txid}:${s.vout}`,
                        address,
                        txid: s.txid,
                        vout: s.vout,
                        value: s.value,
                        tapTree: s.tapTree,
                        forfeitCb: s.forfeitTapLeafScript.cb,
                        forfeitS: s.forfeitTapLeafScript.s,
                        intentCb: s.intentTapLeafScript.cb,
                        intentS: s.intentTapLeafScript.s,
                        statusJson: JSON.stringify(s.status),
                        virtualStatusJson: JSON.stringify(s.virtualStatus),
                        createdAt:
                            typeof s.createdAt === "string"
                                ? s.createdAt
                                : s.createdAt instanceof Date
                                  ? s.createdAt.toISOString()
                                  : new Date(s.createdAt).toISOString(),
                        isUnrolled: s.isUnrolled ?? false,
                        isSpent: s.isSpent === undefined ? null : s.isSpent,
                        spentBy: s.spentBy ?? null,
                        settledBy: s.settledBy ?? null,
                        arkTxId: s.arkTxId ?? null,
                        extraWitnessJson: s.extraWitness
                            ? JSON.stringify(s.extraWitness)
                            : null,
                        assetsJson: s.assets ? JSON.stringify(s.assets) : null,
                    },
                    "modified"
                );
            }
        });
    }

    async deleteVtxos(address: string): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            const toDelete = this.realm
                .objects("ArkVtxo")
                .filtered("address == $0", address);
            this.realm.delete(toDelete);
        });
    }

    // ── UTXO management ────────────────────────────────────────────────

    async getUtxos(address: string): Promise<ExtendedCoin[]> {
        await this.ensureInit();
        const results = this.realm
            .objects("ArkUtxo")
            .filtered("address == $0", address);
        return [...results].map(utxoObjectToDomain);
    }

    async saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            for (const utxo of utxos) {
                const s = serializeUtxo(utxo);
                this.realm.create(
                    "ArkUtxo",
                    {
                        pk: `${s.txid}:${s.vout}`,
                        address,
                        txid: s.txid,
                        vout: s.vout,
                        value: s.value,
                        tapTree: s.tapTree,
                        forfeitCb: s.forfeitTapLeafScript.cb,
                        forfeitS: s.forfeitTapLeafScript.s,
                        intentCb: s.intentTapLeafScript.cb,
                        intentS: s.intentTapLeafScript.s,
                        statusJson: JSON.stringify(s.status),
                        extraWitnessJson: s.extraWitness
                            ? JSON.stringify(s.extraWitness)
                            : null,
                    },
                    "modified"
                );
            }
        });
    }

    async deleteUtxos(address: string): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            const toDelete = this.realm
                .objects("ArkUtxo")
                .filtered("address == $0", address);
            this.realm.delete(toDelete);
        });
    }

    // ── Transaction history ────────────────────────────────────────────

    async getTransactionHistory(address: string): Promise<ArkTransaction[]> {
        await this.ensureInit();
        const results = this.realm
            .objects("ArkTransaction")
            .filtered("address == $0", address);
        const txs = [...results].map(txObjectToDomain);
        txs.sort((a, b) => a.createdAt - b.createdAt);
        return txs;
    }

    async saveTransactions(
        address: string,
        txs: ArkTransaction[]
    ): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            for (const tx of txs) {
                this.realm.create(
                    "ArkTransaction",
                    {
                        pk: `${address}:${tx.key.boardingTxid}:${tx.key.commitmentTxid}:${tx.key.arkTxid}`,
                        address,
                        boardingTxid: tx.key.boardingTxid,
                        commitmentTxid: tx.key.commitmentTxid,
                        arkTxid: tx.key.arkTxid,
                        type: tx.type,
                        amount: tx.amount,
                        settled: tx.settled,
                        createdAt: tx.createdAt,
                        assetsJson: tx.assets
                            ? JSON.stringify(tx.assets)
                            : null,
                    },
                    "modified"
                );
            }
        });
    }

    async deleteTransactions(address: string): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            const toDelete = this.realm
                .objects("ArkTransaction")
                .filtered("address == $0", address);
            this.realm.delete(toDelete);
        });
    }

    // ── Wallet state ───────────────────────────────────────────────────

    async getWalletState(): Promise<WalletState | null> {
        await this.ensureInit();
        const results = this.realm
            .objects("ArkWalletState")
            .filtered("key == $0", "state");
        const items = [...results];
        if (items.length === 0) return null;

        const obj = items[0];
        const state: WalletState = {};
        if (obj.lastSyncTime !== null && obj.lastSyncTime !== undefined) {
            state.lastSyncTime = obj.lastSyncTime;
        }
        if (obj.settingsJson) {
            state.settings = JSON.parse(obj.settingsJson);
        }
        return state;
    }

    async saveWalletState(state: WalletState): Promise<void> {
        await this.ensureInit();
        this.realm.write(() => {
            this.realm.create(
                "ArkWalletState",
                {
                    key: "state",
                    lastSyncTime: state.lastSyncTime ?? null,
                    settingsJson: state.settings
                        ? JSON.stringify(state.settings)
                        : null,
                },
                "modified"
            );
        });
    }
}

// ── Realm object → Domain converters ─────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function vtxoObjectToDomain(obj: any): ExtendedVirtualCoin {
    const serialized = {
        txid: obj.txid,
        vout: obj.vout,
        value: obj.value,
        tapTree: obj.tapTree,
        forfeitTapLeafScript: {
            cb: obj.forfeitCb,
            s: obj.forfeitS,
        } as SerializedTapLeaf,
        intentTapLeafScript: {
            cb: obj.intentCb,
            s: obj.intentS,
        } as SerializedTapLeaf,
        status: JSON.parse(obj.statusJson),
        virtualStatus: JSON.parse(obj.virtualStatusJson),
        createdAt: new Date(obj.createdAt),
        isUnrolled: obj.isUnrolled,
        isSpent: obj.isSpent === null ? undefined : obj.isSpent,
        spentBy: obj.spentBy ?? undefined,
        settledBy: obj.settledBy ?? undefined,
        arkTxId: obj.arkTxId ?? undefined,
        extraWitness: obj.extraWitnessJson
            ? JSON.parse(obj.extraWitnessJson)
            : undefined,
        assets: obj.assetsJson ? JSON.parse(obj.assetsJson) : undefined,
    };

    return deserializeVtxo(serialized);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function utxoObjectToDomain(obj: any): ExtendedCoin {
    const serialized = {
        txid: obj.txid,
        vout: obj.vout,
        value: obj.value,
        tapTree: obj.tapTree,
        forfeitTapLeafScript: {
            cb: obj.forfeitCb,
            s: obj.forfeitS,
        } as SerializedTapLeaf,
        intentTapLeafScript: {
            cb: obj.intentCb,
            s: obj.intentS,
        } as SerializedTapLeaf,
        status: JSON.parse(obj.statusJson),
        extraWitness: obj.extraWitnessJson
            ? JSON.parse(obj.extraWitnessJson)
            : undefined,
    };

    return deserializeUtxo(serialized);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function txObjectToDomain(obj: any): ArkTransaction {
    const tx: ArkTransaction = {
        key: {
            boardingTxid: obj.boardingTxid,
            commitmentTxid: obj.commitmentTxid,
            arkTxid: obj.arkTxid,
        },
        type: obj.type as ArkTransaction["type"],
        amount: obj.amount,
        settled: obj.settled,
        createdAt: obj.createdAt,
    };
    if (obj.assetsJson) {
        tx.assets = JSON.parse(obj.assetsJson);
    }
    return tx;
}
