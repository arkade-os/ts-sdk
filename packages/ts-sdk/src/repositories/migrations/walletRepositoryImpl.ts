import { WalletRepository, WalletState } from "../walletRepository";
import { StorageAdapter } from "../../storage";
import { ArkTransaction, ExtendedCoin, ExtendedVirtualCoin } from "../../wallet";
import {
    SerializedUtxo,
    SerializedVtxo,
    deserializeTransaction,
    deserializeUtxo,
    deserializeVtxo,
    serializeTransaction,
    serializeUtxo,
    serializeVtxo,
} from "../serialization";

const getVtxosStorageKey = (address: string) => `vtxos:${address}`;
const getUtxosStorageKey = (address: string) => `utxos:${address}`;
const getTransactionsStorageKey = (address: string) => `tx:${address}`;
const walletStateStorageKey = "wallet:state";

/**
 * @deprecated This is only to be used in migration from storage V1
 */
export class WalletRepositoryImpl implements WalletRepository {
    readonly version = 1 as const;
    private storage: StorageAdapter;

    constructor(storage: StorageAdapter) {
        this.storage = storage;
    }

    async getVtxos(address: string): Promise<ExtendedVirtualCoin[]> {
        const stored = await this.storage.getItem(getVtxosStorageKey(address));
        if (!stored) return [];

        try {
            const parsed = JSON.parse(stored) as SerializedVtxo[];
            return parsed.map(deserializeVtxo);
        } catch (error) {
            console.error(`Failed to parse VTXOs for address ${address}:`, error);
            return [];
        }
    }

    async saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void> {
        const storedVtxos = await this.getVtxos(address);
        for (const vtxo of vtxos) {
            const existing = storedVtxos.findIndex(
                (v) => v.txid === vtxo.txid && v.vout === vtxo.vout,
            );
            if (existing !== -1) {
                storedVtxos[existing] = vtxo;
            } else {
                storedVtxos.push(vtxo);
            }
        }
        await this.storage.setItem(
            getVtxosStorageKey(address),
            JSON.stringify(storedVtxos.map(serializeVtxo)),
        );
    }

    async clearVtxos(address: string): Promise<void> {
        return this.deleteVtxos(address);
    }

    async deleteVtxos(address: string): Promise<void> {
        await this.storage.removeItem(getVtxosStorageKey(address));
    }

    async getUtxos(address: string): Promise<ExtendedCoin[]> {
        const stored = await this.storage.getItem(getUtxosStorageKey(address));
        if (!stored) return [];

        try {
            const parsed = JSON.parse(stored) as SerializedUtxo[];
            return parsed.map(deserializeUtxo);
        } catch (error) {
            console.error(`Failed to parse UTXOs for address ${address}:`, error);
            return [];
        }
    }

    async saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void> {
        const storedUtxos = await this.getUtxos(address);
        utxos.forEach((utxo) => {
            const existing = storedUtxos.findIndex(
                (u) => u.txid === utxo.txid && u.vout === utxo.vout,
            );
            if (existing !== -1) {
                storedUtxos[existing] = utxo;
            } else {
                storedUtxos.push(utxo);
            }
        });
        await this.storage.setItem(
            getUtxosStorageKey(address),
            JSON.stringify(storedUtxos.map(serializeUtxo)),
        );
    }

    async clearUtxos(address: string): Promise<void> {
        return this.deleteVtxos(address);
    }

    async deleteUtxos(address: string): Promise<void> {
        await this.storage.removeItem(getUtxosStorageKey(address));
    }

    async getTransactionHistory(address: string): Promise<ArkTransaction[]> {
        const storageKey = getTransactionsStorageKey(address);

        const stored = await this.storage.getItem(storageKey);
        if (!stored) return [];

        try {
            const parsed = JSON.parse(stored) as Array<ReturnType<typeof serializeTransaction>>;
            return parsed.map(deserializeTransaction);
        } catch (error) {
            console.error(`Failed to parse transactions for address ${address}:`, error);
            return [];
        }
    }

    async saveTransactions(address: string, txs: ArkTransaction[]): Promise<void> {
        const storedTransactions = await this.getTransactionHistory(address);
        for (const tx of txs) {
            const existing = storedTransactions.findIndex(
                (t) =>
                    t.key.boardingTxid === tx.key.boardingTxid &&
                    t.key.commitmentTxid === tx.key.commitmentTxid &&
                    t.key.arkTxid === tx.key.arkTxid,
            );
            if (existing !== -1) {
                storedTransactions[existing] = tx;
            } else {
                storedTransactions.push(tx);
            }
        }
        await this.storage.setItem(
            getTransactionsStorageKey(address),
            JSON.stringify(storedTransactions.map(serializeTransaction)),
        );
    }

    async clearTransactions(address: string): Promise<void> {
        return this.deleteTransactions(address);
    }

    async deleteTransactions(address: string): Promise<void> {
        await this.storage.removeItem(getTransactionsStorageKey(address));
    }

    async getWalletState(): Promise<WalletState | null> {
        const stored = await this.storage.getItem(walletStateStorageKey);
        if (!stored) return null;

        try {
            const state = JSON.parse(stored) as WalletState;
            return state;
        } catch (error) {
            console.error("Failed to parse wallet state:", error);
            return null;
        }
    }

    async saveWalletState(state: WalletState): Promise<void> {
        await this.storage.setItem(walletStateStorageKey, JSON.stringify(state));
    }

    // New method added in V2, not implemented for legacy
    async clear(): Promise<void> {
        throw new Error("Method not implemented.");
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // deprecated StorageAdapter doesn't have a `close()` method
        return;
    }
}
