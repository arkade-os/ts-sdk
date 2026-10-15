import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    type Contract,
    type ContractEvent,
    ContractWatcher,
    type ExtendedVirtualCoin,
    type IndexerProvider,
    InMemoryWalletRepository,
    type SubscriptionResponse,
} from "../../src";
import { saveVtxosForContract } from "../../src/contracts/vtxoOwnership";
import {
    createDefaultContractParams,
    createMockIndexerProvider,
    createMockVtxo,
    TEST_DEFAULT_SCRIPT,
} from "./helpers";

const contract = (): Contract => ({
    type: "default",
    params: createDefaultContractParams(),
    script: TEST_DEFAULT_SCRIPT,
    address: "address",
    state: "active",
    createdAt: Date.now(),
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

/** A subscription the test pushes updates into. */
function streamInto(indexer: IndexerProvider) {
    const queue: SubscriptionResponse[] = [];
    let waiter: ((r: IteratorResult<SubscriptionResponse>) => void) | undefined;
    vi.mocked(indexer.getSubscription).mockImplementation(
        () =>
            ({
                [Symbol.asyncIterator]: () => ({
                    next: () =>
                        queue.length
                            ? Promise.resolve({ value: queue.shift()!, done: false })
                            : new Promise((r) => (waiter = r)),
                }),
            }) as never,
    );
    return (update: SubscriptionResponse) => {
        if (!waiter) return void queue.push(update);
        const w = waiter;
        waiter = undefined;
        w({ value: update, done: false });
    };
}

const label = (e: ContractEvent) =>
    "vtxos" in e ? `${e.type}:${e.vtxos.map((v) => v.txid.slice(0, 2)).join(",")}` : e.type;

// #1083: the stream updates the watcher at once, the repository only once the event's sync lands.
describe("failsafe poll vs. the sync behind a stream event", () => {
    let indexer: IndexerProvider;
    let repository: InMemoryWalletRepository;
    let watcher: ContractWatcher;
    let push: (update: SubscriptionResponse) => void;
    const A = createMockVtxo({
        script: TEST_DEFAULT_SCRIPT,
        txid: "aa".repeat(32),
    }) as ExtendedVirtualCoin;
    const B = createMockVtxo({
        script: TEST_DEFAULT_SCRIPT,
        txid: "bb".repeat(32),
    }) as ExtendedVirtualCoin;
    const target = contract();
    const syncLands = () =>
        saveVtxosForContract(repository, target, [
            { ...A, isSpent: true, spentBy: "cc".repeat(32), arkTxId: "dd".repeat(32) },
            B,
        ]);

    beforeEach(async () => {
        indexer = createMockIndexerProvider();
        push = streamInto(indexer);
        repository = new InMemoryWalletRepository();
        watcher = new ContractWatcher({
            indexerProvider: indexer,
            walletRepository: repository,
            failsafePollIntervalMs: 1000,
        });
        await saveVtxosForContract(repository, target, [A]);
        vi.useFakeTimers();
    });

    afterEach(async () => {
        await watcher.stopWatching();
        vi.useRealTimers();
    });

    it("emits nothing while the sync is in flight, nor after it lands", async () => {
        const sync = deferred();
        const events: string[] = [];
        await watcher.addContract(target);
        await watcher.startWatching((e) => {
            events.push(label(e));
            return sync.promise;
        });

        push({
            scripts: [TEST_DEFAULT_SCRIPT],
            newVtxos: [B],
            spentVtxos: [{ ...A, isSpent: true }],
            sweptVtxos: [],
        });
        await vi.advanceTimersByTimeAsync(1100);
        expect(events).toEqual(["vtxo_received:bb", "vtxo_spent:aa"]);

        await syncLands();
        sync.resolve();
        await vi.advanceTimersByTimeAsync(1000);
        expect(events).toEqual(["vtxo_received:bb", "vtxo_spent:aa"]);
    });

    it("discards a repository read the sync overtook", async () => {
        const sync = deferred();
        const events: string[] = [];
        await watcher.addContract(target);
        await watcher.startWatching((e) => {
            events.push(label(e));
            return sync.promise;
        });

        push({
            scripts: [TEST_DEFAULT_SCRIPT],
            newVtxos: [B],
            spentVtxos: [{ ...A, isSpent: true }],
            sweptVtxos: [],
        });
        await vi.advanceTimersByTimeAsync(10);

        // the poll reads the stale repository, then the sync lands before it diffs
        const read = repository.getVtxosForScriptPage!.bind(repository);
        vi.spyOn(repository, "getVtxosForScriptPage").mockImplementationOnce(async (...args) => {
            const page = await read(...args);
            await syncLands();
            sync.resolve();
            await sync.promise;
            return page;
        });
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(1000);
        expect(events).toEqual(["vtxo_received:bb", "vtxo_spent:aa"]);
    });
});
