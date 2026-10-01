import { afterEach, describe, expect, it } from "vitest";
import {
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    ProviderUnavailableError,
    type IndexerProvider,
} from "../src";
import type { Contract } from "../src/contracts";
import type { LookAheadConfig } from "../src/contracts/contractManager";
import {
    createMockIndexerProvider,
    createDefaultContractParams,
    TEST_DEFAULT_SCRIPT,
} from "./contracts/helpers";
import { getSyncCursor } from "../src/utils/syncCursors";

/** Spin until `predicate` holds, so a test never races the boot sequence. */
const until = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !predicate(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
};

// Long timers so the watcher's failsafe poll / reconnect never fire mid-test;
// every manager is disposed in afterEach to stop them.
const watcherConfig = { failsafePollIntervalMs: 1_000_000, reconnectDelayMs: 1_000_000 };

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
        lookAhead?: LookAheadConfig,
        lazyInitialization = false,
    ) =>
        ContractManager.create({
            indexerProvider: indexer,
            contractRepository,
            walletRepository,
            watcherConfig,
            lazyInitialization,
            ...(lookAhead ? { lookAhead } : {}),
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

        await until(() => m.getSyncState().mode === "degraded");
        expect(m.getSyncState().mode).toBe("degraded");
        // Repository rows are intact — a failed boot sync must not clear them.
        expect(await m.getContracts()).toHaveLength(1);
        // ...and it must not advance the sync cursor.
        expect(await getSyncCursor(walletRepo)).toBe(0);
    });

    it("boot reports a terminal (non-retryable) failure on the state channel", async () => {
        const contractRepo = new InMemoryContractRepository();
        await contractRepo.saveContract(seededContract());
        const indexer = createMockIndexerProvider();
        (indexer.getVtxos as any).mockRejectedValue(new Error("schema violation"));

        await expect(create(indexer, contractRepo, new InMemoryWalletRepository())).rejects.toThrow(
            "schema violation",
        );
        const m = await create(
            indexer,
            contractRepo,
            new InMemoryWalletRepository(),
            undefined,
            true,
        );

        await until(() => m.getSyncState().mode === "degraded");
        const state = m.getSyncState();
        expect(state.mode).toBe("degraded");
        expect(state.mode === "degraded" ? state.reason : "").toContain("schema violation");
    });

    it.each([false, true])(
        "keeps a retryable look-ahead failure with lazyInitialization=%s",
        async (lazyInitialization) => {
            const contractRepo = new InMemoryContractRepository();
            await contractRepo.saveContract(seededContract());
            const indexer = createMockIndexerProvider(); // the boot reconcile succeeds

            const m = await create(
                indexer,
                contractRepo,
                new InMemoryWalletRepository(),
                {
                    size: 1,
                    currentWatermark: async () => {
                        throw new ProviderUnavailableError("look-ahead unavailable");
                    },
                    materialize: (index) => `descriptor-${index}`,
                    candidateDeps: () => ({
                        network: { hrp: "tark" },
                        serverPubKey: new Uint8Array(32),
                        csvTimelocks: [],
                    }),
                },
                lazyInitialization,
            );

            await m.whenBooted();
            const state = m.getSyncState();
            expect(state.mode).toBe("degraded");
            expect(state.mode === "degraded" ? state.reason : "").toContain("look-ahead band");
            expect(indexer.subscribeForScripts).toHaveBeenCalled();
        },
    );

    it("getContractsWithVtxos serves repository state on a retryable sync failure", async () => {
        const contractRepo = new InMemoryContractRepository();
        const walletRepo = new InMemoryWalletRepository();
        const indexer = createMockIndexerProvider(); // getVtxos resolves [] initially
        const m = await create(indexer, contractRepo, walletRepo);
        await m.createContract(params());
        expect(m.getSyncState().mode).toBe("online");

        (indexer.getVtxos as any).mockRejectedValue(new ProviderUnavailableError("down"));
        const result = await m.getContractsWithVtxos(); // must NOT throw

        expect(result).toHaveLength(1);
        expect(m.getSyncState().mode).toBe("degraded");
    });

    it("getContractsWithVtxos rethrows a terminal sync failure", async () => {
        const contractRepo = new InMemoryContractRepository();
        const walletRepo = new InMemoryWalletRepository();
        const indexer = createMockIndexerProvider();
        const m = await create(indexer, contractRepo, walletRepo);
        await m.createContract(params());

        (indexer.getVtxos as any).mockRejectedValue(new Error("schema violation"));
        await expect(m.getContractsWithVtxos()).rejects.toThrow("schema violation");
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
        await until(() => m.getSyncState().mode === "degraded");
        expect(m.getSyncState().mode).toBe("degraded");

        // Operator recovers (base mock resolves { vtxos: [] }).
        await m.getContractsWithVtxos();
        expect(m.getSyncState().mode).toBe("online");
    });

    it("marks degraded when a connection_reset recovery hits a retryable failure", async () => {
        const contractRepo = new InMemoryContractRepository();
        const walletRepo = new InMemoryWalletRepository();
        await contractRepo.saveContract(seededContract());
        const indexer = createMockIndexerProvider(); // boot online (getVtxos → [])
        const m = await create(indexer, contractRepo, walletRepo);
        await until(() => m.getSyncState().syncing === false);
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
        await until(() => m.getSyncState().mode === "degraded");
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
