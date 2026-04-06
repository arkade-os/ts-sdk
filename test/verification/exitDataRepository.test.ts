import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "../../src/storage";
import { StorageAdapterExitDataRepository } from "../../src/verification/exitDataRepository";
import type { ExitData } from "../../src/verification/exitDataStore";

class MemoryStorageAdapter implements StorageAdapter {
    private store = new Map<string, string>();

    async getItem(key: string): Promise<string | null> {
        return this.store.get(key) ?? null;
    }

    async setItem(key: string, value: string): Promise<void> {
        this.store.set(key, value);
    }

    async removeItem(key: string): Promise<void> {
        this.store.delete(key);
    }

    async clear(): Promise<void> {
        this.store.clear();
    }
}

describe("StorageAdapterExitDataRepository", () => {
    it("saves and retrieves exit data through the adapter", async () => {
        const repo = new StorageAdapterExitDataRepository(
            new MemoryStorageAdapter()
        );
        const data = makeExitData();

        await repo.saveExitData(data);
        const retrieved = await repo.getExitData(data.vtxoOutpoint);

        expect(retrieved).not.toBeNull();
        expect(retrieved!.commitmentTxid).toBe(data.commitmentTxid);
    });

    it("lists all saved exit data entries", async () => {
        const repo = new StorageAdapterExitDataRepository(
            new MemoryStorageAdapter()
        );

        await repo.saveExitData(makeExitData("aa".repeat(32)));
        await repo.saveExitData(makeExitData("bb".repeat(32)));

        const all = await repo.getAllExitData();
        expect(all).toHaveLength(2);
    });

    it("deletes a single exit data entry", async () => {
        const repo = new StorageAdapterExitDataRepository(
            new MemoryStorageAdapter()
        );
        const data = makeExitData();
        await repo.saveExitData(data);

        await repo.deleteExitData(data.vtxoOutpoint);

        expect(await repo.getExitData(data.vtxoOutpoint)).toBeNull();
    });
});

function makeExitData(txid: string = "aa".repeat(32)): ExitData {
    return {
        vtxoOutpoint: { txid, vout: 0 },
        commitmentTxid: "cc".repeat(32),
        chain: [
            {
                txid: "cc".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT" as any,
                expiresAt: "",
                spends: [],
            },
            {
                txid,
                type: "INDEXER_CHAINED_TX_TYPE_TREE" as any,
                expiresAt: "",
                spends: ["cc".repeat(32)],
            },
        ],
        virtualTxs: { [txid]: "base64psbt" },
        treeNodes: [{ txid, tx: "base64psbt", children: {} }],
        storedAt: Date.now(),
    };
}
