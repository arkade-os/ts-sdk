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
} from "./contracts/helpers";

// Long timers so the watcher's failsafe poll / reconnect never fire mid-test.
const watcherConfig = { failsafePollIntervalMs: 1_000_000, reconnectDelayMs: 1_000_000 };

/** Spin until `predicate` holds, so a test never races the microtask queue. */
const until = async (predicate: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !predicate(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
};

describe("ContractManager getSyncState().syncing", () => {
    const managers: ContractManager[] = [];
    const track = (m: ContractManager) => {
        managers.push(m);
        return m;
    };

    afterEach(async () => {
        while (managers.length) await managers.pop()!.dispose();
    });

    const seeded = (): Contract => ({
        type: "default",
        params: createDefaultContractParams(),
        script: TEST_DEFAULT_SCRIPT,
        address: "addr",
        state: "active",
        createdAt: 1,
    });

    const setup = async () => {
        const contractRepository = new InMemoryContractRepository();
        const walletRepository = new InMemoryWalletRepository();
        await contractRepository.saveContract(seeded());
        const indexer: IndexerProvider = createMockIndexerProvider();
        const manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository,
            walletRepository,
            watcherConfig,
        }).then(track);
        // Boot runs off the construction path now, so wait for it to settle
        // before treating the state as quiet.
        await until(() => manager.getSyncState().syncing === false);
        return { manager, indexer };
    };

    it("is false once boot has settled, and always present", async () => {
        const { manager } = await setup();

        const state = manager.getSyncState();
        expect(state.syncing).toBe(false);
        // Set on both arms, so a reader never has to treat it as unknown.
        expect(state).toHaveProperty("syncing");
    });

    it("is true for exactly as long as a read's sync is in flight", async () => {
        const { manager, indexer } = await setup();

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        (indexer.getVtxos as any).mockImplementationOnce(async () => {
            await gate;
            return { vtxos: [] };
        });

        const read = manager.getContractsWithVtxos();
        await until(() => manager.getSyncState().syncing === true);
        expect(manager.getSyncState().syncing).toBe(true);

        release();
        await read;

        expect(manager.getSyncState().syncing).toBe(false);
    });

    it("constructs without waiting for the indexer", async () => {
        const contractRepository = new InMemoryContractRepository();
        const walletRepository = new InMemoryWalletRepository();
        await contractRepository.saveContract(seeded());
        const indexer: IndexerProvider = createMockIndexerProvider();

        // Park the very first provider call, which is the boot sync's.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        (indexer.getVtxos as any).mockImplementation(async () => {
            await gate;
            return { vtxos: [] };
        });

        const manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository,
            walletRepository,
            watcherConfig,
        }).then(track);

        // Construction returned with the boot still parked on the indexer.
        expect(manager.getSyncState().syncing).toBe(true);
        expect(await manager.getContracts()).toHaveLength(1);

        release();
        await manager.whenBooted();
        expect(manager.getSyncState().syncing).toBe(false);
    });

    it("serves a stored read with the indexer still parked, and syncs behind it", async () => {
        const { manager, indexer } = await setup();

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        (indexer.getVtxos as any).mockImplementation(async () => {
            await gate;
            return { vtxos: [] };
        });

        // The answer comes from storage, so this resolves without the indexer.
        const snapshot = await manager.getStoredContractsWithVtxos();
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0].vtxos).toEqual([]);

        // ...and the catch-up it asked for is running behind the answer.
        expect(manager.getSyncState().syncing).toBe(true);

        release();
        await until(() => manager.getSyncState().syncing === false);
    });

    it("starts one catch-up sync however many times a stored read is called", async () => {
        const { manager, indexer } = await setup();

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        (indexer.getVtxos as any).mockImplementation(async () => {
            await gate;
            return { vtxos: [] };
        });
        (indexer.getVtxos as any).mockClear();

        // A repainting UI reads several times per frame.
        await Promise.all([
            manager.getStoredContractsWithVtxos(),
            manager.getStoredContractsWithVtxos(),
            manager.getStoredContractsWithVtxos(),
        ]);

        expect((indexer.getVtxos as any).mock.calls.length).toBe(1);

        release();
        await until(() => manager.getSyncState().syncing === false);
    });

    it("stays syncing until the last overlapping sync settles", async () => {
        const { manager, indexer } = await setup();

        const gates: Array<() => void> = [];
        (indexer.getVtxos as any).mockImplementation(
            () =>
                new Promise((resolve) => {
                    gates.push(() => resolve({ vtxos: [] }));
                }),
        );

        const first = manager.refreshVtxos({ after: 0 });
        await until(() => gates.length === 1);
        const second = manager.refreshVtxos({ after: 0 });
        await until(() => gates.length === 2);

        // Settling the first leaves the second open, so the state stays true.
        gates[0]();
        await first;
        expect(manager.getSyncState().syncing).toBe(true);

        gates[1]();
        await Promise.all([first, second]);
        expect(manager.getSyncState().syncing).toBe(false);
    });
});
