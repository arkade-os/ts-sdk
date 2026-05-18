import { Outpoint } from "../../wallet";
import {
    ChainedTxType,
    VirtualTx,
    VirtualTxRepository,
    VtxoBranch,
} from "../virtualTxRepository";
import { RealmLike } from "./types";

const vtxoKey = (o: Outpoint) => `${o.txid}:${o.vout}`;
const branchPk = (b: VtxoBranch) => `${b.vtxoTxid}:${b.vtxoVout}:${b.position}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTx(o: any): VirtualTx {
    return {
        txid: o.txid,
        hex: o.hex ?? null,
        expiresAt: o.expiresAt ?? null,
        type: (o.type ?? ChainedTxType.Unspecified) as ChainedTxType,
    };
}

export class RealmVirtualTxRepository implements VirtualTxRepository {
    readonly version = 1 as const;
    constructor(private readonly realm: RealmLike) {}

    async clear(): Promise<void> {
        this.realm.write(() => {
            this.realm.delete(this.realm.objects("ArkVirtualTx"));
            this.realm.delete(this.realm.objects("ArkVtxoBranch"));
        });
    }

    async upsertVirtualTxs(txs: VirtualTx[]): Promise<void> {
        this.realm.write(() => {
            for (const t of txs) {
                const prev = [
                    ...this.realm
                        .objects("ArkVirtualTx")
                        .filtered("txid == $0", t.txid),
                ][0] as VirtualTx | undefined;
                this.realm.create(
                    "ArkVirtualTx",
                    {
                        txid: t.txid,
                        hex: t.hex ?? prev?.hex ?? null,
                        expiresAt: t.expiresAt ?? prev?.expiresAt ?? null,
                        type: t.type ?? prev?.type ?? ChainedTxType.Unspecified,
                    },
                    "modified"
                );
            }
        });
    }

    async getVirtualTx(txid: string): Promise<VirtualTx | null> {
        const r = [
            ...this.realm.objects("ArkVirtualTx").filtered("txid == $0", txid),
        ];
        return r.length ? toTx(r[0]) : null;
    }

    async setBranch(vtxo: Outpoint, branch: VtxoBranch[]): Promise<void> {
        this.realm.write(() => {
            this.realm.delete(
                this.realm
                    .objects("ArkVtxoBranch")
                    .filtered("vtxoKey == $0", vtxoKey(vtxo))
            );
            for (const b of branch)
                this.realm.create(
                    "ArkVtxoBranch",
                    {
                        pk: branchPk(b),
                        vtxoKey: `${b.vtxoTxid}:${b.vtxoVout}`,
                        vtxoTxid: b.vtxoTxid,
                        vtxoVout: b.vtxoVout,
                        virtualTxid: b.virtualTxid,
                        position: b.position,
                    },
                    "modified"
                );
        });
    }

    async getBranch(vtxo: Outpoint): Promise<VirtualTx[]> {
        const rows = [
            ...this.realm
                .objects("ArkVtxoBranch")
                .filtered("vtxoKey == $0", vtxoKey(vtxo)),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any[];
        rows.sort((a, b) => a.position - b.position);
        const out: VirtualTx[] = [];
        for (const b of rows) {
            const t = [
                ...this.realm
                    .objects("ArkVirtualTx")
                    .filtered("txid == $0", b.virtualTxid),
            ];
            if (t.length) out.push(toTx(t[0]));
        }
        return out;
    }

    async hasBranch(vtxo: Outpoint): Promise<boolean> {
        return (
            [
                ...this.realm
                    .objects("ArkVtxoBranch")
                    .filtered("vtxoKey == $0", vtxoKey(vtxo)),
            ].length > 0
        );
    }

    async pruneForSpentVtxo(vtxo: Outpoint): Promise<void> {
        this.realm.write(() => {
            const removed = [
                ...this.realm
                    .objects("ArkVtxoBranch")
                    .filtered("vtxoKey == $0", vtxoKey(vtxo)),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ] as any[];
            this.realm.delete(
                this.realm
                    .objects("ArkVtxoBranch")
                    .filtered("vtxoKey == $0", vtxoKey(vtxo))
            );
            for (const e of removed) {
                const stillRef = [
                    ...this.realm
                        .objects("ArkVtxoBranch")
                        .filtered("virtualTxid == $0", e.virtualTxid),
                ];
                if (stillRef.length === 0)
                    this.realm.delete(
                        this.realm
                            .objects("ArkVirtualTx")
                            .filtered("txid == $0", e.virtualTxid)
                    );
            }
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}
