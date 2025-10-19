import { hex } from "@scure/base";
import { TapLeafScript } from "../script/base";
import { StorageAdapter } from "../storage";
import { ArkTransaction, ExtendedCoin, ExtendedVirtualCoin } from "../wallet";
import { TaprootControlBlock } from "@scure/btc-signer";

export interface WalletState {
    lastSyncTime?: number;
    settings?: Record<string, any>;
}

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
    private cache: {
        vtxos: Map<string, ExtendedVirtualCoin[]>;
        utxos: Map<string, ExtendedCoin[]>;
        transactions: Map<string, ArkTransaction[]>;
        walletState: WalletState | null;
        initialized: Set<string>;
    };

    constructor(storage: StorageAdapter) {
        this.storage = storage;
        this.cache = {
            vtxos: new Map(),
            utxos: new Map(),
            transactions: new Map(),
            walletState: null,
            initialized: new Set(),
        };
    }

    async getVtxos(address: string): Promise<ExtendedVirtualCoin[]> {
        const cacheKey = `vtxos:${address}`;

        if (this.cache.vtxos.has(address)) {
            return this.cache.vtxos.get(address)!;
        }

        const stored = await this.storage.getItem(cacheKey);
        if (!stored) {
            this.cache.vtxos.set(address, []);
            return [];
        }

        try {
            const parsed = JSON.parse(stored) as ExtendedVirtualCoin[];
            const vtxos = parsed.map(deserializeVtxo);
            this.cache.vtxos.set(address, vtxos.slice());
            return vtxos.slice();
        } catch (error) {
            console.error(
                `Failed to parse VTXOs for address ${address}:`,
                error
            );
            this.cache.vtxos.set(address, []);
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
        this.cache.vtxos.set(address, storedVtxos.slice());
        await this.storage.setItem(
            `vtxos:${address}`,
            JSON.stringify(storedVtxos.map(serializeVtxo))
        );
    }

    async removeVtxo(address: string, vtxoId: string): Promise<void> {
        const vtxos = await this.getVtxos(address);
        const [txid, vout] = vtxoId.split(":");
        const filtered = vtxos.filter(
            (v) => !(v.txid === txid && v.vout === parseInt(vout, 10))
        );

        this.cache.vtxos.set(address, filtered.slice());
        await this.storage.setItem(
            `vtxos:${address}`,
            JSON.stringify(filtered.map(serializeVtxo))
        );
    }

    async clearVtxos(address: string): Promise<void> {
        this.cache.vtxos.set(address, []);
        await this.storage.removeItem(`vtxos:${address}`);
    }

    async getUtxos(address: string): Promise<ExtendedCoin[]> {
        const cacheKey = `utxos:${address}`;

        if (this.cache.utxos.has(address)) {
            return this.cache.utxos.get(address)!;
        }

        const stored = await this.storage.getItem(cacheKey);
        if (!stored) {
            this.cache.utxos.set(address, []);
            return [];
        }

        try {
            const parsed = JSON.parse(stored) as ExtendedCoin[];
            const utxos = parsed.map(deserializeUtxo);
            this.cache.utxos.set(address, utxos.slice());
            return utxos.slice();
        } catch (error) {
            console.error(
                `Failed to parse UTXOs for address ${address}:`,
                error
            );
            this.cache.utxos.set(address, []);
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
        this.cache.utxos.set(address, storedUtxos.slice());
        await this.storage.setItem(
            `utxos:${address}`,
            JSON.stringify(storedUtxos.map(serializeUtxo))
        );
    }

    async removeUtxo(address: string, utxoId: string): Promise<void> {
        const utxos = await this.getUtxos(address);
        const [txid, vout] = utxoId.split(":");
        const filtered = utxos.filter(
            (v) => !(v.txid === txid && v.vout === parseInt(vout, 10))
        );
        this.cache.utxos.set(address, filtered.slice());
        await this.storage.setItem(
            `utxos:${address}`,
            JSON.stringify(filtered.map(serializeUtxo))
        );
    }

    async clearUtxos(address: string): Promise<void> {
        this.cache.utxos.set(address, []);
        await this.storage.removeItem(`utxos:${address}`);
    }

    async getTransactionHistory(address: string): Promise<ArkTransaction[]> {
        const cacheKey = `tx:${address}`;

        if (this.cache.transactions.has(address)) {
            return this.cache.transactions.get(address)!;
        }

        const stored = await this.storage.getItem(cacheKey);
        if (!stored) {
            this.cache.transactions.set(address, []);
            return [];
        }

        try {
            const transactions = JSON.parse(stored) as ArkTransaction[];
            this.cache.transactions.set(address, transactions);
            return transactions.slice();
        } catch (error) {
            console.error(
                `Failed to parse transactions for address ${address}:`,
                error
            );
            this.cache.transactions.set(address, []);
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
        this.cache.transactions.set(address, storedTransactions);
        await this.storage.setItem(
            `tx:${address}`,
            JSON.stringify(storedTransactions)
        );
    }

    async clearTransactions(address: string): Promise<void> {
        this.cache.transactions.set(address, []);
        await this.storage.removeItem(`tx:${address}`);
    }

    async getWalletState(): Promise<WalletState | null> {
        if (
            this.cache.walletState !== null ||
            this.cache.initialized.has("walletState")
        ) {
            return this.cache.walletState;
        }

        const stored = await this.storage.getItem("wallet:state");
        if (!stored) {
            this.cache.walletState = null;
            this.cache.initialized.add("walletState");
            return null;
        }

        try {
            const state = JSON.parse(stored) as WalletState;
            this.cache.walletState = state;
            this.cache.initialized.add("walletState");
            return state;
        } catch (error) {
            console.error("Failed to parse wallet state:", error);
            this.cache.walletState = null;
            this.cache.initialized.add("walletState");
            return null;
        }
    }

    async saveWalletState(state: WalletState): Promise<void> {
        this.cache.walletState = state;
        await this.storage.setItem("wallet:state", JSON.stringify(state));
    }
}
