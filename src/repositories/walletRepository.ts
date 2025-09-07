import { StorageAdapter } from "../storage";
import { ExtendedVirtualCoin } from "../wallet";

export interface WalletState {
    lastSyncTime?: number;
    settings?: Record<string, any>;
}

export interface Transaction {
    id: string;
    timestamp: number;
    amount: number;
    type: "send" | "receive";
    status: "pending" | "confirmed" | "failed";
}

export interface WalletRepository {
    // VTXO management
    getVtxos(address: string): Promise<ExtendedVirtualCoin[]>;
    saveVtxo(address: string, vtxo: ExtendedVirtualCoin): Promise<void>;
    saveVtxos(address: string, vtxos: ExtendedVirtualCoin[]): Promise<void>;
    removeVtxo(address: string, vtxoId: string): Promise<void>;
    clearVtxos(address: string): Promise<void>;

    // Transaction history
    getTransactionHistory(address: string): Promise<Transaction[]>;
    saveTransaction(address: string, tx: Transaction): Promise<void>;

    // Wallet state
    getWalletState(): Promise<WalletState | null>;
    saveWalletState(state: WalletState): Promise<void>;
}

export class WalletRepositoryImpl implements WalletRepository {
    private storage: StorageAdapter;
    private cache: {
        vtxos: Map<string, ExtendedVirtualCoin[]>;
        transactions: Map<string, Transaction[]>;
        walletState: WalletState | null;
        initialized: Set<string>;
    };

    constructor(storage: StorageAdapter) {
        this.storage = storage;
        this.cache = {
            vtxos: new Map(),
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
            const vtxos = JSON.parse(stored) as ExtendedVirtualCoin[];
            this.cache.vtxos.set(address, vtxos);
            return vtxos;
        } catch (error) {
            console.error(
                `Failed to parse VTXOs for address ${address}:`,
                error
            );
            this.cache.vtxos.set(address, []);
            return [];
        }
    }

    async saveVtxo(address: string, vtxo: ExtendedVirtualCoin): Promise<void> {
        const vtxos = await this.getVtxos(address);
        const existing = vtxos.findIndex(
            (v) => v.txid === vtxo.txid && v.vout === vtxo.vout
        );

        if (existing !== -1) {
            vtxos[existing] = vtxo;
        } else {
            vtxos.push(vtxo);
        }

        this.cache.vtxos.set(address, vtxos);
        await this.storage.setItem(`vtxos:${address}`, JSON.stringify(vtxos));
    }

    async saveVtxos(
        address: string,
        vtxos: ExtendedVirtualCoin[]
    ): Promise<void> {
        this.cache.vtxos.set(address, vtxos);
        await this.storage.setItem(`vtxos:${address}`, JSON.stringify(vtxos));
    }

    async removeVtxo(address: string, vtxoId: string): Promise<void> {
        const vtxos = await this.getVtxos(address);
        const [txid, vout] = vtxoId.split(":");
        const filtered = vtxos.filter(
            (v) => !(v.txid === txid && v.vout === parseInt(vout))
        );

        this.cache.vtxos.set(address, filtered);
        await this.storage.setItem(
            `vtxos:${address}`,
            JSON.stringify(filtered)
        );
    }

    async clearVtxos(address: string): Promise<void> {
        this.cache.vtxos.set(address, []);
        await this.storage.removeItem(`vtxos:${address}`);
    }

    async getTransactionHistory(address: string): Promise<Transaction[]> {
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
            const transactions = JSON.parse(stored) as Transaction[];
            this.cache.transactions.set(address, transactions);
            return transactions;
        } catch (error) {
            console.error(
                `Failed to parse transactions for address ${address}:`,
                error
            );
            this.cache.transactions.set(address, []);
            return [];
        }
    }

    async saveTransaction(address: string, tx: Transaction): Promise<void> {
        const transactions = await this.getTransactionHistory(address);
        const existing = transactions.findIndex((t) => t.id === tx.id);

        if (existing !== -1) {
            transactions[existing] = tx;
        } else {
            transactions.push(tx);
            // Sort by timestamp descending
            transactions.sort((a, b) => b.timestamp - a.timestamp);
        }

        this.cache.transactions.set(address, transactions);
        await this.storage.setItem(
            `tx:${address}`,
            JSON.stringify(transactions)
        );
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
