import { afterEach, describe, expect, it } from "vitest";
import {
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    type IndexerProvider,
} from "../src";
import type { Contract } from "../src/contracts";
import {
    createMockIndexerProvider,
    createDefaultContractParams,
    TEST_DEFAULT_SCRIPT,
    TEST_DELEGATE_SCRIPT,
} from "./contracts/helpers";

const watcherConfig = { failsafePollIntervalMs: 1_000_000, reconnectDelayMs: 1_000_000 };

describe("ContractManager vtxoSyncMaxAgeMs", () => {
    const managers: ContractManager[] = [];
    const track = (m: ContractManager) => {
        managers.push(m);
        return m;
    };

    afterEach(async () => {
        while (managers.length) await managers.pop()!.dispose();
    });

    const seeded = (script: string, address: string): Contract => ({
        type: "default",
        params: createDefaultContractParams(),
        script,
        address,
        state: "active",
        createdAt: 1,
    });

    const setup = async (vtxoSyncMaxAgeMs?: number) => {
        const contractRepository = new InMemoryContractRepository();
        const walletRepository = new InMemoryWalletRepository();
        await contractRepository.saveContract(seeded(TEST_DEFAULT_SCRIPT, "addr"));
        const indexer: IndexerProvider = createMockIndexerProvider();
        const manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository,
            walletRepository,
            watcherConfig,
            vtxoSyncMaxAgeMs,
        }).then(track);
        return { manager, indexer, contractRepository, walletRepository };
    };

    const reads = (indexer: IndexerProvider) => (indexer.getVtxos as any).mock.calls.length;

    it("without a budget, every read syncs — unchanged behaviour", async () => {
        const { manager, indexer } = await setup();
        (indexer.getVtxos as any).mockClear();

        await manager.getContractsWithVtxos();
        const afterFirst = reads(indexer);
        await manager.getContractsWithVtxos();

        expect(afterFirst).toBeGreaterThan(0);
        expect(reads(indexer)).toBeGreaterThan(afterFirst);
    });

    it("an explicit 0 budget is the same as none", async () => {
        const { manager, indexer } = await setup(0);
        (indexer.getVtxos as any).mockClear();

        await manager.getContractsWithVtxos();
        const afterFirst = reads(indexer);
        await manager.getContractsWithVtxos();

        expect(reads(indexer)).toBeGreaterThan(afterFirst);
    });

    it("within the budget, a repeated read serves the repository without a round trip", async () => {
        const { manager, indexer } = await setup(60_000);
        await manager.getContractsWithVtxos();
        (indexer.getVtxos as any).mockClear();

        const result = await manager.getContractsWithVtxos();

        expect(reads(indexer)).toBe(0);
        expect(result).toHaveLength(1);
    });

    it("past the budget, the read syncs again", async () => {
        const { manager, indexer } = await setup(1);
        await manager.getContractsWithVtxos();
        (indexer.getVtxos as any).mockClear();
        await new Promise((r) => setTimeout(r, 5));

        await manager.getContractsWithVtxos();

        expect(reads(indexer)).toBeGreaterThan(0);
    });

    it("a contract the last sync did not cover is never fresh", async () => {
        const { manager, indexer, contractRepository } = await setup(60_000);
        await manager.getContractsWithVtxos();
        // Registered behind the manager's back, so no sync has ever covered it.
        await contractRepository.saveContract(seeded(TEST_DELEGATE_SCRIPT, "addr2"));
        (indexer.getVtxos as any).mockClear();

        const result = await manager.getContractsWithVtxos();

        expect(reads(indexer)).toBeGreaterThan(0);
        expect(result).toHaveLength(2);
    });

    it("a narrowed-window sync confers no freshness", async () => {
        const { manager, indexer } = await setup(50);
        await manager.getContractsWithVtxos();
        await new Promise((r) => setTimeout(r, 60));

        // Had this refreshed the budget, the read below would skip.
        await manager.refreshVtxos({ after: Date.now() - 1000 });
        (indexer.getVtxos as any).mockClear();

        await manager.getContractsWithVtxos();

        expect(reads(indexer)).toBeGreaterThan(0);
    });

    it("a full-window refresh does confer freshness — the contrast", async () => {
        const { manager, indexer } = await setup(50);
        await manager.getContractsWithVtxos();
        await new Promise((r) => setTimeout(r, 60));

        await manager.refreshVtxos();
        (indexer.getVtxos as any).mockClear();

        await manager.getContractsWithVtxos();

        expect(reads(indexer)).toBe(0);
    });

    it("setVtxoSyncMaxAge turns the budget on for a manager built without one", async () => {
        const { manager, indexer } = await setup();
        await manager.getContractsWithVtxos();

        manager.setVtxoSyncMaxAge(60_000);
        await manager.getContractsWithVtxos();
        (indexer.getVtxos as any).mockClear();
        await manager.getContractsWithVtxos();

        expect(reads(indexer)).toBe(0);
    });
});
