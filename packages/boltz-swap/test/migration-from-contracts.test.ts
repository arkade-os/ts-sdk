import { describe, it, expect, vi } from "vitest";
import { migrateToSwapRepository } from "../src/repositories/migrationFromContracts";

describe("migrateToSwapRepository", () => {
    it("copies at least one item per collection and sets the migration flag", async () => {
        const reverseSwaps = [{ id: "reverse-1", type: "reverse" }];
        const submarineSwaps = [{ id: "submarine-1", type: "submarine" }];

        const storage = {
            getItem: vi.fn(async (key: string) => {
                if (key === "collection:reverseSwaps") {
                    return JSON.stringify(reverseSwaps);
                }
                if (key === "collection:submarineSwaps") {
                    return JSON.stringify(submarineSwaps);
                }
                return null;
            }),
            setItem: vi.fn(async () => {}),
        };

        const repo = {
            saveSwap: vi.fn(async () => {}),
        };

        await migrateToSwapRepository(storage, repo as any);

        expect(repo.saveSwap).toHaveBeenCalledWith(reverseSwaps[0]);
        expect(repo.saveSwap).toHaveBeenCalledWith(submarineSwaps[0]);
        expect(repo.saveSwap).toHaveBeenCalledTimes(2);
        expect(storage.setItem).toHaveBeenCalledWith(
            "migration-from-storage-adapter-swaps",
            "done"
        );
    });

    it("does not run when migration flag is set", async () => {
        const storage = {
            getItem: vi.fn(async (key: string) =>
                key === "migration-from-storage-adapter-swaps" ? "done" : null
            ),
            setItem: vi.fn(async () => {}),
        };

        const repo = {
            saveSwap: vi.fn(async () => {}),
        };

        await migrateToSwapRepository(storage, repo as any);

        expect(repo.saveSwap).not.toHaveBeenCalled();
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(storage.getItem).toHaveBeenCalledTimes(1);
        expect(storage.getItem).toHaveBeenCalledWith(
            "migration-from-storage-adapter-swaps"
        );
    });
});
