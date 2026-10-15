import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ContractManager,
    ContractWatcher,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    ReadonlyWallet,
    type ContractEvent,
    type IndexerProvider,
} from "../src";
import type { Contract } from "../src/contracts";
import {
    createDefaultContractParams,
    createMockIndexerProvider,
    TEST_DEFAULT_SCRIPT,
} from "./contracts/helpers";

const watcherConfig = { failsafePollIntervalMs: 1_000_000, reconnectDelayMs: 1_000_000 };

const contract: Contract = {
    type: "default",
    params: createDefaultContractParams(),
    script: TEST_DEFAULT_SCRIPT,
    address: "addr",
    state: "active",
    createdAt: 1,
};

const received = (): ContractEvent => ({
    type: "vtxo_received",
    contractScript: contract.script,
    contract,
    vtxos: [],
    timestamp: Date.now(),
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("dispose waits for contract events still being handled", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const setup = async () => {
        let deliver!: (event: ContractEvent) => void;
        vi.spyOn(ContractWatcher.prototype, "startWatching").mockImplementation(
            async (callback) => {
                deliver = callback;
                return () => {};
            },
        );
        const contractRepository = new InMemoryContractRepository();
        await contractRepository.saveContract(contract);
        const indexer: IndexerProvider = createMockIndexerProvider();
        const manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository,
            walletRepository: new InMemoryWalletRepository(),
            watcherConfig,
        });
        return { manager, indexer, deliver };
    };

    it("ContractManager.dispose settles only after an in-flight event finishes", async () => {
        const { manager, indexer, deliver } = await setup();
        let release: (() => void) | undefined;
        vi.mocked(indexer.getVtxos).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = () => resolve({ vtxos: [] } as any);
                }),
        );

        deliver(received());
        await vi.waitFor(() => expect(release).toBeDefined());

        let disposed = false;
        const disposing = manager.dispose().then(() => {
            disposed = true;
        });
        await tick();
        expect(disposed).toBe(false);

        release!();
        await disposing;
        expect(disposed).toBe(true);
    });

    it("ContractManager ignores an event delivered after dispose", async () => {
        const { manager, indexer, deliver } = await setup();
        await manager.dispose();
        vi.mocked(indexer.getVtxos).mockClear();

        deliver(received());
        await tick();

        expect(indexer.getVtxos).not.toHaveBeenCalled();
    });

    it("ReadonlyWallet.dispose waits for its contract manager", async () => {
        let release!: () => void;
        const managerDisposed = new Promise<void>((r) => {
            release = r;
        });
        const wallet = Object.create(ReadonlyWallet.prototype) as ReadonlyWallet;
        (wallet as any)._contractManager = { dispose: () => managerDisposed };

        let disposed = false;
        const disposing = wallet.dispose().then(() => {
            disposed = true;
        });
        await tick();
        expect(disposed).toBe(false);

        release();
        await disposing;
        expect(disposed).toBe(true);
    });
});
