import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    ProviderUnavailableError,
    type IndexerProvider,
} from "../src";
import type { Contract } from "../src/contracts";
import {
    createMockIndexerProvider,
    createDefaultContractParams,
    TEST_DEFAULT_SCRIPT,
} from "./contracts/helpers";
import { getSyncCursor } from "../src/utils/syncCursors";

// Long timers so the watcher's failsafe poll / reconnect never fire mid-test;
// every manager is disposed in afterEach to stop them.
const watcherConfig = { failsafePollIntervalMs: 1_000_000, reconnectDelayMs: 1_000_000 };
// The background sweep is exercised deliberately below, never incidentally.
const noPeriodicSync = 0;

describe("ContractManager offline-first reads (Scope 3)", () => {
    const managers: ContractManager[] = [];
    const track = (m: ContractManager) => {
        managers.push(m);
        return m;
    };

    afterEach(async () => {
        while (managers.length) await managers.pop()!.dispose();
    });

    const create = (
        indexer: IndexerProvider,
        contractRepository: InMemoryContractRepository,
        walletRepository: InMemoryWalletRepository,
    ) =>
        ContractManager.create({
            indexerProvider: indexer,
            contractRepository,
            walletRepository,
            watcherConfig,
            periodicSyncIntervalMs: noPeriodicSync,
        }).then(track);

    const seededContract = (): Contract => ({
        type: "default",
        params: createDefaultContractParams(),
        script: TEST_DEFAULT_SCRIPT,
        address: "addr",
        state: "active",
        createdAt: 1,
    });

    const params = () => ({
        type: "default" as const,
        params: createDefaultContractParams(),
        script: TEST_DEFAULT_SCRIPT,
        address: "addr",
    });

    it("boot survives a retryable indexer failure and reports degraded", async () => {
        const contractRepo = new InMemoryContractRepository();
        const walletRepo = new InMemoryWalletRepository();
        await contractRepo.saveContract(seededContract());
        const indexer = createMockIndexerProvider();
        (indexer.getVtxos as any).mockRejectedValue(new ProviderUnavailableError("down"));

        const m = await create(indexer, contractRepo, walletRepo);

        expect(m.getSyncState().mode).toBe("degraded");
        // Repository rows are intact — a failed boot sync must not clear them.
        expect(await m.getContracts()).toHaveLength(1);
        // ...and it must not advance the sync cursor.
        expect(await getSyncCursor(walletRepo)).toBe(0);
    });

    it("boot rethrows a terminal (non-retryable) indexer failure", async () => {
        const contractRepo = new InMemoryContractRepository();
        await contractRepo.saveContract(seededContract());
        const indexer = createMockIndexerProvider();
        (indexer.getVtxos as any).mockRejectedValue(new Error("schema violation"));

        await expect(
            ContractManager.create({
                indexerProvider: indexer,
                contractRepository: contractRepo,
                walletRepository: new InMemoryWalletRepository(),
                watcherConfig,
                periodicSyncIntervalMs: noPeriodicSync,
            }),
        ).rejects.toThrow("schema violation");
    });

    it("getContractsWithVtxos reads the repository without touching the indexer", async () => {
        const contractRepo = new InMemoryContractRepository();
        const walletRepo = new InMemoryWalletRepository();
        const indexer = createMockIndexerProvider();
        const m = await create(indexer, contractRepo, walletRepo);
        await m.createContract(params());

        // A terminal failure would propagate if the read queried at all.
        (indexer.getVtxos as any).mockRejectedValue(new Error("schema violation"));
        (indexer.getVtxos as any).mockClear();

        await expect(m.getContractsWithVtxos()).resolves.toHaveLength(1);
        expect(indexer.getVtxos).not.toHaveBeenCalled();
    });

    it("getContractsWithVtxos with sync serves repository state on a retryable failure", async () => {
        const contractRepo = new InMemoryContractRepository();
        const walletRepo = new InMemoryWalletRepository();
        const indexer = createMockIndexerProvider(); // getVtxos resolves [] initially
        const m = await create(indexer, contractRepo, walletRepo);
        await m.createContract(params());
        expect(m.getSyncState().mode).toBe("online");

        (indexer.getVtxos as any).mockRejectedValue(new ProviderUnavailableError("down"));
        const result = await m.getContractsWithVtxos(undefined, { sync: true }); // must NOT throw

        expect(result).toHaveLength(1);
        expect(m.getSyncState().mode).toBe("degraded");
    });

    it("getContractsWithVtxos with sync rethrows a terminal failure", async () => {
        const contractRepo = new InMemoryContractRepository();
        const walletRepo = new InMemoryWalletRepository();
        const indexer = createMockIndexerProvider();
        const m = await create(indexer, contractRepo, walletRepo);
        await m.createContract(params());

        (indexer.getVtxos as any).mockRejectedValue(new Error("schema violation"));
        await expect(m.getContractsWithVtxos(undefined, { sync: true })).rejects.toThrow(
            "schema violation",
        );
    });

    it("createContract persists and watches even when hydration is retryable-unavailable", async () => {
        const contractRepo = new InMemoryContractRepository();
        const walletRepo = new InMemoryWalletRepository();
        const indexer = createMockIndexerProvider();
        const m = await create(indexer, contractRepo, walletRepo);

        (indexer.getVtxos as any).mockRejectedValue(new ProviderUnavailableError("down"));
        const c = await m.createContract(params());

        expect(c.script).toBe(TEST_DEFAULT_SCRIPT);
        expect(await m.getContracts()).toHaveLength(1);
        expect(m.getSyncState().mode).toBe("degraded");
    });

    it("a later successful sync clears a prior degraded state", async () => {
        const contractRepo = new InMemoryContractRepository();
        const walletRepo = new InMemoryWalletRepository();
        await contractRepo.saveContract(seededContract());
        const indexer = createMockIndexerProvider();
        (indexer.getVtxos as any).mockRejectedValueOnce(new ProviderUnavailableError("down"));

        const m = await create(indexer, contractRepo, walletRepo);
        expect(m.getSyncState().mode).toBe("degraded");

        // Operator recovers (base mock resolves { vtxos: [] }).
        await m.getContractsWithVtxos(undefined, { sync: true });
        expect(m.getSyncState().mode).toBe("online");
    });

    it("marks degraded when a connection_reset recovery hits a retryable failure", async () => {
        const contractRepo = new InMemoryContractRepository();
        const walletRepo = new InMemoryWalletRepository();
        await contractRepo.saveContract(seededContract());
        const indexer = createMockIndexerProvider(); // boot online (getVtxos → [])
        const m = await create(indexer, contractRepo, walletRepo);
        expect(m.getSyncState().mode).toBe("online");

        // Operator degrades post-boot; the watcher fires connection_reset and the
        // recovery sync fails retryably. This must flip sync state to degraded
        // even though the watcher callback swallows the rejection.
        (indexer.getVtxos as any).mockRejectedValue(new ProviderUnavailableError("down"));
        await (m as any).handleContractEvent({ type: "connection_reset", timestamp: 1 });

        expect(m.getSyncState().mode).toBe("degraded");
    });

    it("clears degraded when a later connection_reset recovery succeeds", async () => {
        const contractRepo = new InMemoryContractRepository();
        const walletRepo = new InMemoryWalletRepository();
        await contractRepo.saveContract(seededContract());
        const indexer = createMockIndexerProvider();
        (indexer.getVtxos as any).mockRejectedValueOnce(new ProviderUnavailableError("down"));
        const m = await create(indexer, contractRepo, walletRepo);
        expect(m.getSyncState().mode).toBe("degraded");

        // Operator recovers; the next connection_reset recovery succeeds.
        await (m as any).handleContractEvent({ type: "connection_reset", timestamp: 2 });
        expect(m.getSyncState().mode).toBe("online");
    });

    it("rethrows a terminal connection_reset recovery failure", async () => {
        const contractRepo = new InMemoryContractRepository();
        await contractRepo.saveContract(seededContract());
        const indexer = createMockIndexerProvider();
        const m = await create(indexer, contractRepo, new InMemoryWalletRepository());

        (indexer.getVtxos as any).mockRejectedValue(new Error("schema violation"));
        await expect(
            (m as any).handleContractEvent({ type: "connection_reset", timestamp: 3 }),
        ).rejects.toThrow("schema violation");
    });
});

describe("ContractManager background sweep", () => {
    const managers: ContractManager[] = [];

    afterEach(async () => {
        while (managers.length) await managers.pop()!.dispose();
        vi.useRealTimers();
    });

    const seeded = async (indexer: IndexerProvider, periodicSyncIntervalMs?: number) => {
        const contractRepository = new InMemoryContractRepository();
        await contractRepository.saveContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "addr",
            state: "active",
            createdAt: 1,
        });
        const m = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository,
            walletRepository: new InMemoryWalletRepository(),
            watcherConfig,
            periodicSyncIntervalMs,
        });
        managers.push(m);
        return m;
    };

    it("sweeps the watched set on each tick", async () => {
        const indexer = createMockIndexerProvider();
        const m = await seeded(indexer, 1_000);
        (indexer.getVtxos as any).mockClear();

        await (m as any).runPeriodicSync();

        expect(indexer.getVtxos).toHaveBeenCalled();
        expect(m.getSyncState().mode).toBe("online");
    });

    it("records a failed sweep as degraded instead of rejecting", async () => {
        const indexer = createMockIndexerProvider();
        const m = await seeded(indexer, 1_000);

        // Terminal, not retryable: a timer has no caller to propagate to, so it
        // must still be swallowed into degraded state.
        (indexer.getVtxos as any).mockRejectedValue(new Error("schema violation"));
        await expect((m as any).runPeriodicSync()).resolves.toBeUndefined();

        expect(m.getSyncState().mode).toBe("degraded");
    });

    it("does not stack overlapping sweeps", async () => {
        const indexer = createMockIndexerProvider();
        let release!: () => void;
        const blocked = new Promise<void>((r) => (release = r));
        const m = await seeded(indexer, 1_000);
        (indexer.getVtxos as any).mockClear();
        (indexer.getVtxos as any).mockImplementation(async () => {
            await blocked;
            return { vtxos: [] };
        });

        const first = (m as any).runPeriodicSync();
        const second = (m as any).runPeriodicSync();
        expect(second).toBe(first);

        release();
        await first;
        expect((indexer.getVtxos as any).mock.calls.length).toBe(1);
    });

    it("is disabled by a zero interval and stopped by dispose", async () => {
        vi.useFakeTimers();
        const indexer = createMockIndexerProvider();

        const off = await seeded(indexer, 0);
        (indexer.getVtxos as any).mockClear();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(indexer.getVtxos).not.toHaveBeenCalled();
        await off.dispose();

        const on = await seeded(indexer, 1_000);
        await on.dispose();
        (indexer.getVtxos as any).mockClear();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(indexer.getVtxos).not.toHaveBeenCalled();
    });
});
