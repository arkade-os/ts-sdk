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
        await until(() => manager.getSyncState().syncing === false);
        return { manager, indexer };
    };

    it("is false once boot has settled, and always present", async () => {
        const { manager } = await setup();

        const state = manager.getSyncState();
        expect(state.syncing).toBe(false);
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

    it.each([false, true])(
        "lazyInitialization=%s controls whether construction waits",
        async (lazyInitialization) => {
            const contractRepository = new InMemoryContractRepository();
            const walletRepository = new InMemoryWalletRepository();
            await contractRepository.saveContract(seeded());
            const indexer: IndexerProvider = createMockIndexerProvider();

            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            (indexer.getVtxos as any).mockImplementation(async () => {
                await gate;
                return { vtxos: [] };
            });

            let resolved = false;
            const pending = ContractManager.create({
                indexerProvider: indexer,
                contractRepository,
                walletRepository,
                watcherConfig,
                lazyInitialization,
            }).then((manager) => {
                resolved = true;
                return track(manager);
            });
            await until(() => (indexer.getVtxos as any).mock.calls.length > 0);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(resolved).toBe(lazyInitialization);
            release();
            const manager = await pending;
            await manager.whenBooted();
            expect(manager.getSyncState().syncing).toBe(false);
        },
    );

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

        const snapshot = await manager.getStoredContractsWithVtxos();
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0].vtxos).toEqual([]);

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

        gates[0]();
        await first;
        expect(manager.getSyncState().syncing).toBe(true);

        gates[1]();
        await Promise.all([first, second]);
        expect(manager.getSyncState().syncing).toBe(false);
    });
});
