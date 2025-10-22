import { hex } from "@scure/base";
import { TapLeafScript } from "../script/base";
import { StorageAdapter } from "../storage";
import { ArkTransaction, ExtendedCoin, ExtendedVirtualCoin } from "../wallet";
import { TaprootControlBlock } from "@scure/btc-signer";

export interface WalletState {
    lastSyncTime?: number;
    settings?: Record<string, any>;
}

const getVtxosStorageKey = (address: string) => `vtxos:${address}`;
const getUtxosStorageKey = (address: string) => `utxos:${address}`;
const getTransactionsStorageKey = (address: string) => `tx:${address}`;
const walletStateStorageKey = "wallet:state";

// Utility functions for (de)serializing complex structures
const toHex = (b: Uint8Array | undefined) => (b ? hex.encode(b) : undefined);

const fromHex = (h: string | undefined) =>
    h ? hex.decode(h) : (undefined as any);

const serializeTapLeaf = ([cb, s]: TapLeafScript) => ({
    cb: hex.encode(TaprootControlBlock.encode(cb)),
    s: hex.encode(s),
});

const serializeVtxo = (v: ExtendedVirtualCoin) => ({
    ...v,
    tapTree: toHex(v.tapTree),
    forfeitTapLeafScript: serializeTapLeaf(v.forfeitTapLeafScript),
    intentTapLeafScript: serializeTapLeaf(v.intentTapLeafScript),
    extraWitness: v.extraWitness?.map(toHex),
});

const serializeUtxo = (u: ExtendedCoin) => ({
    ...u,
    tapTree: toHex(u.tapTree),
    forfeitTapLeafScript: serializeTapLeaf(u.forfeitTapLeafScript),
    intentTapLeafScript: serializeTapLeaf(u.intentTapLeafScript),
    extraWitness: u.extraWitness?.map(toHex),
});

const deserializeTapLeaf = (t: { cb: string; s: string }): TapLeafScript => {
    const cb = TaprootControlBlock.decode(fromHex(t.cb));
    const s = fromHex(t.s);
    return [cb, s];
};

const deserializeVtxo = (o: any): ExtendedVirtualCoin => ({
    ...o,
    createdAt: new Date(o.createdAt),
    tapTree: fromHex(o.tapTree),
    forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
    intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
    extraWitness: o.extraWitness?.map(fromHex),
});

const deserializeUtxo = (o: any): ExtendedCoin => ({
    ...o,
    tapTree: fromHex(o.tapTree),
    forfeitTapLeafScript: deserializeTapLeaf(o.forfeitTapLeafScript),
    intentTapLeafScript: deserializeTapLeaf(o.intentTapLeafScript),
    extraWitness: o.extraWitness?.map(fromHex),
});

export interface WalletRepository {
    // VTXO management
    getVtxos(address: string): Promise<ExtendedVirtualCoin[]>;
    saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    removeVtxo(address: string, vtxoId: string): Promise<void>;
    clearVtxos(address: string): Promise<void>;

    // UTXO management
    getUtxos(address: string): Promise<ExtendedCoin[]>;
    saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void>;
    removeUtxo(address: string, utxoId: string): Promise<void>;
    clearUtxos(address: string): Promise<void>;

    // Transaction history
    getTransactionHistory(address: string): Promise<ArkTransaction[]>;
    saveTransactions(address: string, txs: ArkTransaction[]): Promise<void>;
    clearTransactions(address: string): Promise<void>;

    // Wallet state
    getWalletState(): Promise<WalletState | null>;
    saveWalletState(state: WalletState): Promise<void>;
}

export class WalletRepositoryImpl implements WalletRepository {
    private storage: StorageAdapter;

    constructor(storage: StorageAdapter) {
        this.storage = storage;
    }

    async getVtxos(address: string): Promise<ExtendedVirtualCoin[]> {
        const stored = await this.storage.getItem(getVtxosStorageKey(address));
        if (!stored) return [];

        try {
            const parsed = JSON.parse(stored) as ExtendedVirtualCoin[];
            return parsed.map(deserializeVtxo);
        } catch (error) {
            console.error(
                `Failed to parse VTXOs for address ${address}:`,
                error
            );
            return [];
        }
    }

    async saveVtxos(
        address: string,
        vtxos: ExtendedVirtualCoin[]
    ): Promise<void> {
        const storedVtxos = await this.getVtxos(address);
        for (const vtxo of vtxos) {
            const existing = storedVtxos.findIndex(
                (v) => v.txid === vtxo.txid && v.vout === vtxo.vout
            );
            if (existing !== -1) {
                storedVtxos[existing] = vtxo;
            } else {
                storedVtxos.push(vtxo);
            }
        }
        await this.storage.setItem(
            getVtxosStorageKey(address),
            JSON.stringify(storedVtxos.map(serializeVtxo))
        );
    }

    async removeVtxo(address: string, vtxoId: string): Promise<void> {
        const vtxos = await this.getVtxos(address);
        const [txid, vout] = vtxoId.split(":");
        const filtered = vtxos.filter(
            (v) => !(v.txid === txid && v.vout === parseInt(vout, 10))
        );
        await this.storage.setItem(
            getVtxosStorageKey(address),
            JSON.stringify(filtered.map(serializeVtxo))
        );
    }

    async clearVtxos(address: string): Promise<void> {
        await this.storage.removeItem(getVtxosStorageKey(address));
    }

    async getUtxos(address: string): Promise<ExtendedCoin[]> {
        const stored = await this.storage.getItem(getUtxosStorageKey(address));
        if (!stored) return [];

        try {
            const parsed = JSON.parse(stored) as ExtendedCoin[];
            return parsed.map(deserializeUtxo);
        } catch (error) {
            console.error(
                `Failed to parse UTXOs for address ${address}:`,
                error
            );
            return [];
        }
    }

    async saveUtxos(address: string, utxos: ExtendedCoin[]): Promise<void> {
        const storedUtxos = await this.getUtxos(address);
        utxos.forEach((utxo) => {
            const existing = storedUtxos.findIndex(
                (u) => u.txid === utxo.txid && u.vout === utxo.vout
            );
            if (existing !== -1) {
                storedUtxos[existing] = utxo;
            } else {
                storedUtxos.push(utxo);
            }
        });
        await this.storage.setItem(
            getUtxosStorageKey(address),
            JSON.stringify(storedUtxos.map(serializeUtxo))
        );
    }

    async removeUtxo(address: string, utxoId: string): Promise<void> {
        const utxos = await this.getUtxos(address);
        const [txid, vout] = utxoId.split(":");
        const filtered = utxos.filter(
            (v) => !(v.txid === txid && v.vout === parseInt(vout, 10))
        );
        await this.storage.setItem(
            getUtxosStorageKey(address),
            JSON.stringify(filtered.map(serializeUtxo))
        );
    }

    async clearUtxos(address: string): Promise<void> {
        await this.storage.removeItem(getUtxosStorageKey(address));
    }

    async getTransactionHistory(address: string): Promise<ArkTransaction[]> {
        const storageKey = getTransactionsStorageKey(address);

        const stored = await this.storage.getItem(storageKey);
        if (!stored) return [];

        try {
            return JSON.parse(stored) as ArkTransaction[];
        } catch (error) {
            console.error(
                `Failed to parse transactions for address ${address}:`,
                error
            );
            return [];
        }
    }

    async saveTransactions(
        address: string,
        txs: ArkTransaction[]
    ): Promise<void> {
        const storedTransactions = await this.getTransactionHistory(address);
        for (const tx of txs) {
            const existing = storedTransactions.findIndex(
                (t) => t.key === tx.key
            );
            if (existing !== -1) {
                storedTransactions[existing] = tx;
            } else {
                storedTransactions.push(tx);
            }
        }
        await this.storage.setItem(
            getTransactionsStorageKey(address),
            JSON.stringify(storedTransactions)
        );
    }

    async clearTransactions(address: string): Promise<void> {
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
        await this.storage.setItem(
            walletStateStorageKey,
            JSON.stringify(state)
        );
    }
}
