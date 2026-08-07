import { ArkTransaction, ExtendedCoin, ExtendedVirtualCoin, Outpoint } from "../../wallet";
import { WalletRepository, WalletState, VtxoRepositoryKey } from "../walletRepository";
import { isVtxoForScript } from "../../contracts/vtxoOwnership";

/**
 * In-memory implementation of WalletRepository.
 * Data is ephemeral and scoped to the instance.
 */
export class InMemoryWalletRepository implements WalletRepository {
    readonly version = 1 as const;
    private readonly vtxosByAddress = new Map<string, ExtendedVirtualCoin[]>();
    private readonly utxosByAddress = new Map<string, ExtendedCoin[]>();
    private readonly txsByAddress = new Map<string, ArkTransaction[]>();

    private walletState: WalletState | null = null;

    async getVtxos(address: string): Promise<ExtendedVirtualCoin[]> {
        return this.vtxosByAddress.get(address) ?? [];
    }

    async saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void> {
        const existing = this.vtxosByAddress.get(address) ?? [];
        const next = mergeByKey(existing, vtxos, (item) => `${item.txid}:${item.vout}`);
        this.vtxosByAddress.set(address, next);
    }

    async deleteVtxos(address: string): Promise<void> {
        this.vtxosByAddress.delete(address);
    }

    async getVtxosForScript(script: string): Promise<ExtendedVirtualCoin[]> {
        const allMatches: ExtendedVirtualCoin[] = [];
        for (const bucket of this.vtxosByAddress.values()) {
            for (const vtxo of bucket) {
                if (isVtxoForScript(vtxo, script)) {
                    allMatches.push(vtxo);
                }
            }
        }
        // Dedup by outpoint (last-write-wins across address buckets)
        return mergeByKey([], allMatches, (item) => `${item.txid}:${item.vout}`);
    }

    async saveVtxosForScript(key: VtxoRepositoryKey, vtxos: ExtendedVirtualCoin[]): Promise<void> {
        if (!key.address) {
            throw new Error("InMemoryWalletRepository requires an address");
        }
        for (const vtxo of vtxos) {
            if (!isVtxoForScript(vtxo, key.script)) {
                throw new Error(
                    `VTXO ${vtxo.txid}:${vtxo.vout} script mismatch: expected ${key.script}, got ${vtxo.script}`,
                );
            }
        }
        return this.saveVtxos(key.address, vtxos);
    }

    async deleteVtxosForScript(script: string): Promise<void> {
        for (const [address, bucket] of this.vtxosByAddress.entries()) {
            const next = bucket.filter((v) => !isVtxoForScript(v, script));
            if (next.length === 0) {
                this.vtxosByAddress.delete(address);
            } else {
                this.vtxosByAddress.set(address, next);
            }
        }
    }

    async deleteVtxosByOutpoint(outpoints: Outpoint[]): Promise<void> {
        if (outpoints.length === 0) return;
        const gone = new Set(outpoints.map((o) => `${o.txid}:${o.vout}`));
        for (const [address, bucket] of this.vtxosByAddress.entries()) {
            const next = bucket.filter((v) => !gone.has(`${v.txid}:${v.vout}`));
            if (next.length === 0) {
                this.vtxosByAddress.delete(address);
            } else {
                this.vtxosByAddress.set(address, next);
            }
        }
    }

    async getUtxos(address: string): Promise<ExtendedCoin[]> {
        return this.utxosByAddress.get(address) ?? [];
    }

    async saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void> {
        const existing = this.utxosByAddress.get(address) ?? [];
        const next = mergeByKey(existing, utxos, (item) => `${item.txid}:${item.vout}`);
        this.utxosByAddress.set(address, next);
    }

    async deleteUtxos(address: string): Promise<void> {
        this.utxosByAddress.delete(address);
    }

    async getTransactionHistory(address: string): Promise<ArkTransaction[]> {
        return this.txsByAddress.get(address) ?? [];
    }

    async saveTransactions(address: string, txs: ArkTransaction[]): Promise<void> {
        const existing = this.txsByAddress.get(address) ?? [];
        const next = mergeByKey(existing, txs, serializeTxKey);
        this.txsByAddress.set(address, next);
    }

    async deleteTransactions(address: string): Promise<void> {
        this.txsByAddress.delete(address);
    }

    async getWalletState(): Promise<WalletState | null> {
        return this.walletState;
    }

    async saveWalletState(state: WalletState): Promise<void> {
        this.walletState = state;
    }

    async clear(): Promise<void> {
        this.vtxosByAddress.clear();
        this.utxosByAddress.clear();
        this.txsByAddress.clear();
        this.walletState = null;
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // nothing to dispose, data is ephemeral and scoped to the instance
        return;
    }
}

function serializeTxKey(tx: ArkTransaction): string {
    const key = tx.key;
    return `${key.boardingTxid}:${key.commitmentTxid}:${key.arkTxid}`;
}

function mergeByKey<T>(existing: T[], incoming: T[], toKey: (item: T) => string): T[] {
    const next = new Map<string, T>();
    existing.forEach((item) => {
        next.set(toKey(item), item);
    });
    incoming.forEach((item) => {
        next.set(toKey(item), item);
    });
    return Array.from(next.values());
}
