import type { Outpoint } from "../wallet";
import type { StorageAdapter } from "../storage";
import { AsyncStorageAdapter } from "../storage/asyncStorage";
import { FileSystemStorageAdapter } from "../storage/fileSystem";
import { IndexedDBStorageAdapter } from "../storage/indexedDB";
import type { ExitData, ExitDataRepository } from "./exitDataStore";

type StoredIndex = string[];

export class StorageAdapterExitDataRepository implements ExitDataRepository {
    constructor(
        private readonly storage: StorageAdapter,
        private readonly namespace: string = "exit-data"
    ) {}

    async saveExitData(data: ExitData): Promise<void> {
        const key = this.entryKey(data.vtxoOutpoint);
        const index = await this.getIndex();
        if (!index.includes(key)) {
            index.push(key);
            await this.setIndex(index);
        }
        await this.storage.setItem(key, JSON.stringify(data));
    }

    async getExitData(outpoint: Outpoint): Promise<ExitData | null> {
        const raw = await this.storage.getItem(this.entryKey(outpoint));
        return raw ? (JSON.parse(raw) as ExitData) : null;
    }

    async getAllExitData(): Promise<ExitData[]> {
        const index = await this.getIndex();
        const all = await Promise.all(
            index.map(async (key) => {
                const raw = await this.storage.getItem(key);
                return raw ? (JSON.parse(raw) as ExitData) : null;
            })
        );
        return all.filter((entry): entry is ExitData => entry !== null);
    }

    async deleteExitData(outpoint: Outpoint): Promise<void> {
        const key = this.entryKey(outpoint);
        const index = await this.getIndex();
        await this.storage.removeItem(key);
        await this.setIndex(index.filter((entry) => entry !== key));
    }

    async clear(): Promise<void> {
        await this.storage.clear();
    }

    private entryKey(outpoint: Outpoint): string {
        return `${this.namespace}:${outpoint.txid}:${outpoint.vout}`;
    }

    private indexKey(): string {
        return `${this.namespace}:index`;
    }

    private async getIndex(): Promise<StoredIndex> {
        const raw = await this.storage.getItem(this.indexKey());
        return raw ? (JSON.parse(raw) as StoredIndex) : [];
    }

    private async setIndex(index: StoredIndex): Promise<void> {
        await this.storage.setItem(this.indexKey(), JSON.stringify(index));
    }
}

export class FileSystemExitDataRepository extends StorageAdapterExitDataRepository {
    constructor(dirPath: string, namespace?: string) {
        super(new FileSystemStorageAdapter(dirPath), namespace);
    }
}

export class IndexedDBExitDataRepository extends StorageAdapterExitDataRepository {
    constructor(dbName: string, namespace?: string) {
        super(new IndexedDBStorageAdapter(dbName), namespace);
    }
}

export class AsyncStorageExitDataRepository extends StorageAdapterExitDataRepository {
    constructor(namespace?: string) {
        super(new AsyncStorageAdapter(), namespace);
    }
}
