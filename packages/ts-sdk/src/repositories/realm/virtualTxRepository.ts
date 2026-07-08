import { Outpoint } from "../../wallet";
import {
    ChainedTxType,
    mergeChainedTxType,
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
        psbt: o.psbt ?? null,
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
                    ...this.realm.objects<VirtualTx>("ArkVirtualTx").filtered("txid == $0", t.txid),
                ].at(0);
                this.realm.create(
                    "ArkVirtualTx",
                    {
                        txid: t.txid,
                        psbt: t.psbt ?? prev?.psbt ?? null,
                        expiresAt: t.expiresAt ?? prev?.expiresAt ?? null,
                        type: mergeChainedTxType(t.type, prev?.type),
                    },
                    "modified",
                );
            }
        });
    }

    async getVirtualTx(txid: string): Promise<VirtualTx | null> {
        const r = [...this.realm.objects("ArkVirtualTx").filtered("txid == $0", txid)];
        return r.length ? toTx(r[0]) : null;
    }

    async setBranch(vtxo: Outpoint, branch: VtxoBranch[]): Promise<void> {
        this.realm.write(() => {
            this.realm.delete(
                this.realm.objects("ArkVtxoBranch").filtered("vtxoKey == $0", vtxoKey(vtxo)),
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
                    "modified",
                );
        });
    }

    async getBranch(vtxo: Outpoint): Promise<VirtualTx[]> {
        const rows = [
            ...this.realm.objects("ArkVtxoBranch").filtered("vtxoKey == $0", vtxoKey(vtxo)),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any[];
        rows.sort((a, b) => a.position - b.position);
        const out: VirtualTx[] = [];
        for (const b of rows) {
            const t = [...this.realm.objects("ArkVirtualTx").filtered("txid == $0", b.virtualTxid)];
            if (t.length) out.push(toTx(t[0]));
        }
        return out;
    }

    async hasBranch(vtxo: Outpoint): Promise<boolean> {
        return (
            [...this.realm.objects("ArkVtxoBranch").filtered("vtxoKey == $0", vtxoKey(vtxo))]
                .length > 0
        );
    }

    async pruneForSpentVtxo(vtxo: Outpoint): Promise<void> {
        this.realm.write(() => {
            const branchRows = this.realm
                .objects("ArkVtxoBranch")
                .filtered("vtxoKey == $0", vtxoKey(vtxo));
            // Snapshot the referenced txids into plain strings BEFORE deleting.
            // Real Realm invalidates deleted objects, so reading `virtualTxid`
            // off them after `delete` throws ("Accessing object which has been
            // invalidated") — which would roll back the whole write() and make
            // prune a permanent no-op on React Native.
            const virtualTxids = [
                ...new Set(
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    [...branchRows].map((e: any) => e.virtualTxid as string),
                ),
            ];
            this.realm.delete(branchRows);
            for (const virtualTxid of virtualTxids) {
                const stillRef = [
                    ...this.realm
                        .objects("ArkVtxoBranch")
                        .filtered("virtualTxid == $0", virtualTxid),
                ];
                if (stillRef.length === 0)
                    this.realm.delete(
                        this.realm.objects("ArkVirtualTx").filtered("txid == $0", virtualTxid),
                    );
            }
        });
    }

    async [Symbol.asyncDispose](): Promise<void> {}
}
