import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type Contract,
    type ContractEvent,
    ContractWatcher,
    type ExtendedVirtualCoin,
    type IndexerProvider,
    InMemoryWalletRepository,
    isContractVtxoEvent,
} from "../../src";
import { saveVtxosForContract } from "../../src/contracts/vtxoOwnership";
import {
    createDefaultContractParams,
    createMockIndexerProvider,
    createMockVtxo,
    TEST_DEFAULT_SCRIPT,
} from "./helpers";

const CHECKPOINT = "cc".repeat(32);
const ARK_TX = "dd".repeat(32);

const contract = (): Contract => ({
    type: "default",
    params: createDefaultContractParams(),
    script: TEST_DEFAULT_SCRIPT,
    address: "address",
    state: "active",
    createdAt: Date.now(),
});

/**
 * That payload used to be the cached, pre-spend row, stating `spentBy: ""` on
 * an event that says the output was spent. Nothing pinned that shape, which is
 * how it survived; this pins the one that replaced it.
 */
describe("failsafe poll: what a vtxo_spent event carries", () => {
    let watcher: ContractWatcher;
    let indexer: IndexerProvider;
    let repository: InMemoryWalletRepository;

    beforeEach(() => {
        indexer = createMockIndexerProvider();
        repository = new InMemoryWalletRepository();
        watcher = new ContractWatcher({
            indexerProvider: indexer,
            walletRepository: repository,
            failsafePollIntervalMs: 1000,
        });
    });

    afterEach(() => vi.useRealTimers());

    it("reports the spend with the row that records it", async () => {
        const unspent = createMockVtxo({
            script: TEST_DEFAULT_SCRIPT,
            value: 4200,
        }) as ExtendedVirtualCoin;
        const target = contract();
        await saveVtxosForContract(repository, target, [unspent]);

        vi.useFakeTimers();
        const events: ContractEvent[] = [];
        await watcher.addContract(target);
        await watcher.startWatching((e) => events.push(e));
        events.length = 0;

        // the sync has since written the spend against the same outpoint
        await saveVtxosForContract(repository, target, [
            {
                ...unspent,
                isSpent: true,
                virtualStatus: { state: "spent" },
                spentBy: CHECKPOINT,
                arkTxId: ARK_TX,
            },
        ]);
        await vi.advanceTimersByTimeAsync(1200);

        const spent = events.filter(
            (e) => e.type === "vtxo_spent" && isContractVtxoEvent(e) && e.vtxos.length > 0,
        );
        expect(spent).toHaveLength(1);
        expect((spent[0] as { vtxos: unknown[] }).vtxos[0]).toMatchObject({
            txid: unspent.txid,
            vout: unspent.vout,
            isSpent: true,
            spentBy: CHECKPOINT,
            arkTxId: ARK_TX,
        });

        await watcher.stopWatching();
    });

    it("still reports a spend whose row storage never gained", async () => {
        // an outpoint that simply left the unspent set, with nothing fresher to
        // report it by: the cached row, exactly as before
        const unspent = createMockVtxo({
            script: TEST_DEFAULT_SCRIPT,
            value: 4200,
        }) as ExtendedVirtualCoin;
        const target = contract();
        await saveVtxosForContract(repository, target, [unspent]);

        vi.useFakeTimers();
        const events: ContractEvent[] = [];
        await watcher.addContract(target);
        await watcher.startWatching((e) => events.push(e));
        events.length = 0;

        await repository.deleteVtxosForScript!(TEST_DEFAULT_SCRIPT);
        await vi.advanceTimersByTimeAsync(1200);

        const spent = events.filter(
            (e) => e.type === "vtxo_spent" && isContractVtxoEvent(e) && e.vtxos.length > 0,
        );
        expect(spent).toHaveLength(1);
        expect((spent[0] as { vtxos: { txid: string }[] }).vtxos[0].txid).toBe(unspent.txid);

        await watcher.stopWatching();
    });

    it("does not read a spent row as a new receipt", async () => {
        // `includeSpent: true` widens the read, so the unspent set the diff runs
        // against has to be narrowed back or every spend reads as a receipt too
        const target = contract();

        vi.useFakeTimers();
        const events: ContractEvent[] = [];
        await watcher.addContract(target);
        await watcher.startWatching((e) => events.push(e));
        events.length = 0;

        // arrives already spent, and only after the boot poll — seeding it up
        // front would let that poll claim it before this assertion looks
        await saveVtxosForContract(repository, target, [
            {
                ...(createMockVtxo({ script: TEST_DEFAULT_SCRIPT }) as ExtendedVirtualCoin),
                txid: "ee".repeat(32),
                isSpent: true,
                virtualStatus: { state: "spent" },
                spentBy: CHECKPOINT,
            },
        ]);
        await vi.advanceTimersByTimeAsync(1200);

        expect(events.filter((e) => e.type === "vtxo_received")).toEqual([]);

        await watcher.stopWatching();
    });
});
