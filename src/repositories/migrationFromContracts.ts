import { SwapRepository } from "./swap-repository";
import { PendingReverseSwap, PendingSubmarineSwap } from "../types";

const MIGRATION_KEY = "migration-from-storage-adapter-swaps";

/**
 * Reader and Writer functions for a key-value storage.
 * It mimics the deprecated StorageAdapter interface from @arkade-os/sdk.
 */
export type LegacyStorageAccessor = {
    getItem: (key: string) => Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
};

/**
 * Migrates the swaps stored in the old ContractRepository to the new SwapRepository.
 * It accepts a generic reader/writer interface, once it's done it will set a flag
 * in the storage to avoid running it again.
 *
 * @param storageAdapter - The storage adapter to read the swaps from.
 * @param fresh - The new swap repository to save the swaps to.
 *
 * @return true if data was migrated
 */
export async function migrateToSwapRepository(
    storageAdapter: LegacyStorageAccessor,
    fresh: SwapRepository
): Promise<boolean> {
    try {
        const migration = await storageAdapter.getItem(MIGRATION_KEY);
        if (migration === "done") {
            return false;
        }

        // reverse swaps
        const reverseSwaps: readonly PendingReverseSwap[] =
            await getContractCollection(storageAdapter, "reverseSwaps");
        const submarineSwaps: readonly PendingSubmarineSwap[] =
            await getContractCollection(storageAdapter, "submarineSwaps");

        for (const swap of reverseSwaps) {
            await fresh.saveSwap(swap);
        }

        for (const swap of submarineSwaps) {
            await fresh.saveSwap(swap);
        }

        await storageAdapter.setItem(MIGRATION_KEY, "done");
        return true;
    } catch (error) {
        if (
            error instanceof Error &&
            error.message.includes(
                "One of the specified object stores was not found."
            )
        ) {
            // This error occurs if app tries to migrate without having an existing storage
            return false;
        }
        throw error;
    }
}

async function getContractCollection<T>(
    storage: LegacyStorageAccessor,
    contractType: string
): Promise<ReadonlyArray<T>> {
    const stored = await storage.getItem(`collection:${contractType}`);
    if (!stored) return [];

    try {
        return JSON.parse(stored) as T[];
    } catch (error) {
        const errMessage: string =
            "message" in (error as any) ? (error as any).message : "";
        throw new Error(
            `Failed to parse contract collection ${contractType} from storage: ${errMessage}`
        );
    }
}
