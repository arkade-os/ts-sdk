import { afterEach, describe, expect, it } from "vitest";
import {
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    type IndexerProvider,
} from "../src";
import {
    createDefaultContractParams,
    createMockIndexerProvider,
    createMockVtxo,
    TEST_DEFAULT_SCRIPT,
} from "./contracts/helpers";

const watcherConfig = { failsafePollIntervalMs: 1_000_000, reconnectDelayMs: 1_000_000 };

const until = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !predicate(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
};

describe("ContractManager sync with a contract deleted mid-fetch", () => {
    let manager: ContractManager | undefined;
    afterEach(async () => {
        await manager?.dispose();
    });

    it("annotates against the contracts it fetched for, not a second repository read", async () => {
        const contractRepository = new InMemoryContractRepository();
        await contractRepository.saveContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "addr",
            state: "active",
            createdAt: 1,
        });
        const indexer: IndexerProvider = createMockIndexerProvider();
        manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository,
            walletRepository: new InMemoryWalletRepository(),
            watcherConfig,
        });
        await until(() => manager!.getSyncState().syncing === false);

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        (indexer.getVtxos as any).mockImplementation(async () => {
            await gate;
            return { vtxos: [createMockVtxo({ script: TEST_DEFAULT_SCRIPT })] };
        });
        (indexer.getVtxos as any).mockClear();

        const read = manager.getContractsWithVtxos();
        await until(() => (indexer.getVtxos as any).mock.calls.length > 0);
        await manager.deleteContract(TEST_DEFAULT_SCRIPT);
        release();

        await expect(read).resolves.toBeDefined();
    });
});
