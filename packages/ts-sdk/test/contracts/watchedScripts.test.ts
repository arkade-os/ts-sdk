import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import {
    Contract,
    ContractEvent,
    ContractManager,
    ContractWatcher,
    DelegateProvider,
    type IndexerProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    SingleKey,
    Wallet,
} from "../../src";
import { ArkProvider } from "../../src/providers/ark";
import { OnchainProvider } from "../../src/providers/onchain";
import { VirtualCoin } from "../../src/wallet";
import {
    createDefaultContractParams,
    createMockIndexerProvider,
    createMockVtxo,
    TEST_DEFAULT_SCRIPT,
} from "./helpers";

/** A script this wallet does not own and never registers as a contract. */
const FOREIGN_SCRIPT = "5120" + "ab".repeat(32);
const OTHER_FOREIGN_SCRIPT = "5120" + "cd".repeat(32);

const activeContract = (script = TEST_DEFAULT_SCRIPT): Contract => ({
    type: "default",
    params: createDefaultContractParams(),
    script,
    address: "address",
    state: "active",
    createdAt: Date.now(),
});

/** A subscription that yields `updates` once, then hangs. */
function subscriptionYielding(updates: unknown[]) {
    return () => ({
        [Symbol.asyncIterator]: () => {
            let i = 0;
            return {
                next: () =>
                    i < updates.length
                        ? Promise.resolve({ value: updates[i++], done: false })
                        : new Promise(() => {}),
            };
        },
    });
}

describe("ContractWatcher watch-only scripts", () => {
    let watcher: ContractWatcher;
    let mockIndexer: IndexerProvider;

    beforeEach(() => {
        mockIndexer = createMockIndexerProvider();
        watcher = new ContractWatcher({
            indexerProvider: mockIndexer,
            walletRepository: new InMemoryWalletRepository(),
            failsafePollIntervalMs: 1000,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("emits script_vtxo_received for a watch-only script over the subscription", async () => {
        const vtxo = createMockVtxo({ script: FOREIGN_SCRIPT, value: 4200 });
        (mockIndexer.getSubscription as any).mockImplementation(
            subscriptionYielding([{ newVtxos: [vtxo] }]),
        );

        const events: ContractEvent[] = [];
        await watcher.addWatchedScript(FOREIGN_SCRIPT, { label: "lockup" });
        await watcher.startWatching((e) => events.push(e));
        await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));

        expect(events).toContainEqual({
            type: "script_vtxo_received",
            script: FOREIGN_SCRIPT,
            vtxos: [expect.objectContaining({ script: FOREIGN_SCRIPT, value: 4200 })],
            timestamp: expect.any(Number),
        });
        expect(watcher.getWatchedScripts()).toEqual([{ script: FOREIGN_SCRIPT, label: "lockup" }]);
        expect(watcher.getAllContracts()).toEqual([]);
        expect(watcher.getWatchedContracts()).toEqual([]);

        await watcher.stopWatching();
    });

    it("serves a watch-only script from the failsafe poll while the subscription is down", async () => {
        vi.useFakeTimers();

        const vtxo = createMockVtxo({ script: FOREIGN_SCRIPT, value: 777 });
        (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [vtxo] });

        const callback = vi.fn();
        await watcher.startWatching(callback);
        await watcher.addWatchedScript(FOREIGN_SCRIPT);
        callback.mockClear();

        (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [] });
        await vi.advanceTimersByTimeAsync(1000);

        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "script_vtxo_spent",
                script: FOREIGN_SCRIPT,
            }),
        );

        await watcher.stopWatching();
    });

    it("keeps the watch-only script subscribed across a reconnect", async () => {
        vi.useFakeTimers();

        (mockIndexer.getSubscription as any).mockImplementationOnce(() => ({
            [Symbol.asyncIterator]: () => ({
                next: () => Promise.reject(new Error("stream died")),
            }),
        }));

        await watcher.addContract(activeContract());
        await watcher.addWatchedScript(FOREIGN_SCRIPT);
        await watcher.startWatching(() => {});

        const subscribeMock = mockIndexer.subscribeForScripts as ReturnType<typeof vi.fn>;
        expect(subscribeMock.mock.calls[0][0]).toContain(FOREIGN_SCRIPT);

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(0);

        expect(subscribeMock.mock.calls.length).toBeGreaterThan(1);
        const lastCall = subscribeMock.mock.calls[subscribeMock.mock.calls.length - 1];
        expect(lastCall[0]).toContain(FOREIGN_SCRIPT);

        const vtxo = createMockVtxo({ script: FOREIGN_SCRIPT, value: 999 });
        (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [vtxo] });
        const after: ContractEvent[] = [];
        await watcher.stopWatching();
        await watcher.startWatching((e) => after.push(e));

        expect(after).toContainEqual(
            expect.objectContaining({
                type: "script_vtxo_received",
                script: FOREIGN_SCRIPT,
            }),
        );

        await watcher.stopWatching();
    });

    // Admitting one makes the next poll read its absence as a spend.
    it.each([
        { label: "spent", extra: { isSpent: true } },
        { label: "swept", extra: { isSwept: true } },
        { label: "batch-expired", extra: { expiresAt: new Date(Date.now() - 60_000) } },
    ])(
        "keeps an already-$label subscription output out of the watch-only baseline",
        async ({ extra }) => {
            vi.useFakeTimers();

            const dead = createMockVtxo({ script: FOREIGN_SCRIPT, value: 1500, ...extra });
            (mockIndexer.getSubscription as any).mockImplementation(
                subscriptionYielding([{ newVtxos: [dead] }]),
            );

            const callback = vi.fn();
            await watcher.addWatchedScript(FOREIGN_SCRIPT);
            await watcher.startWatching(callback);
            await vi.advanceTimersByTimeAsync(0);

            expect(callback).not.toHaveBeenCalledWith(
                expect.objectContaining({ type: "script_vtxo_received" }),
            );

            await vi.advanceTimersByTimeAsync(1000);
            expect(callback).not.toHaveBeenCalledWith(
                expect.objectContaining({ type: "script_vtxo_spent" }),
            );

            await watcher.stopWatching();
        },
    );

    it("does not let a retained contract out-rank a watch-only registration", async () => {
        const vtxo = createMockVtxo({ script: TEST_DEFAULT_SCRIPT, value: 2468 });
        (mockIndexer.getSubscription as any).mockImplementation(
            subscriptionYielding([{ newVtxos: [vtxo] }]),
        );

        const events: ContractEvent[] = [];
        await watcher.addContract({ ...activeContract(), watch: "retained" });
        await watcher.addWatchedScript(TEST_DEFAULT_SCRIPT);
        await watcher.startWatching((e) => events.push(e));
        await vi.waitFor(() =>
            expect(events.some((e) => e.type !== "connection_reset")).toBe(true),
        );

        const vtxoEvents = events.filter((e) => e.type !== "connection_reset");
        expect(vtxoEvents.map((e) => e.type)).toEqual(["script_vtxo_received"]);

        await watcher.stopWatching();
    });

    it("re-registering an already-watched script does not re-announce it", async () => {
        vi.useFakeTimers();

        const vtxo = createMockVtxo({ script: FOREIGN_SCRIPT, value: 640 });
        (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [vtxo] });

        const callback = vi.fn();
        await watcher.startWatching(callback);
        await watcher.addWatchedScript(FOREIGN_SCRIPT, { label: "first" });
        callback.mockClear();

        await watcher.addWatchedScript(FOREIGN_SCRIPT, { label: "second" });
        await vi.advanceTimersByTimeAsync(1000);

        expect(callback).not.toHaveBeenCalled();
        expect(watcher.getWatchedScripts()).toEqual([{ script: FOREIGN_SCRIPT, label: "second" }]);

        await watcher.stopWatching();
    });

    it("fails closed when the indexer rejects: no event, state preserved", async () => {
        vi.useFakeTimers();

        const vtxo = createMockVtxo({ script: FOREIGN_SCRIPT, value: 5000 });
        (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [vtxo] });

        const callback = vi.fn();
        await watcher.startWatching(callback);
        await watcher.addWatchedScript(FOREIGN_SCRIPT);
        callback.mockClear();

        // A rejected fetch must not read as "everything was spent".
        (mockIndexer.getVtxos as any).mockRejectedValue(new Error("indexer unavailable"));
        await vi.advanceTimersByTimeAsync(1000);

        expect(callback).not.toHaveBeenCalled();

        // The baseline survived, so the next good poll reports nothing new.
        (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [vtxo] });
        await vi.advanceTimersByTimeAsync(1000);

        expect(callback).not.toHaveBeenCalled();

        await watcher.stopWatching();
    });

    it("gives the contract path precedence when a script is both registered and watched", async () => {
        const contract = activeContract();
        const vtxo = createMockVtxo({ script: TEST_DEFAULT_SCRIPT, value: 1234 });
        (mockIndexer.getSubscription as any).mockImplementation(
            subscriptionYielding([{ newVtxos: [vtxo] }]),
        );

        const events: ContractEvent[] = [];
        await watcher.addContract(contract);
        await watcher.addWatchedScript(TEST_DEFAULT_SCRIPT);
        await watcher.startWatching((e) => events.push(e));
        await vi.waitFor(() =>
            expect(events.filter((e) => e.type !== "connection_reset").length).toBeGreaterThan(0),
        );

        const vtxoEvents = events.filter((e) => e.type !== "connection_reset");
        expect(vtxoEvents).toHaveLength(1);
        expect(vtxoEvents[0].type).toBe("vtxo_received");
        expect(vtxoEvents.some((e) => e.type.startsWith("script_"))).toBe(false);

        await watcher.stopWatching();
    });

    it("removeWatchedScript drops it from the next subscription and stops its events", async () => {
        vi.useFakeTimers();

        const vtxo = createMockVtxo({ script: FOREIGN_SCRIPT, value: 300 });
        (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [vtxo] });

        const callback = vi.fn();
        await watcher.startWatching(callback);
        await watcher.addWatchedScript(FOREIGN_SCRIPT);
        await watcher.addWatchedScript(OTHER_FOREIGN_SCRIPT);

        const subscribeMock = mockIndexer.subscribeForScripts as ReturnType<typeof vi.fn>;
        subscribeMock.mockClear();
        callback.mockClear();

        await watcher.removeWatchedScript(FOREIGN_SCRIPT);

        expect(subscribeMock).toHaveBeenCalled();
        const scripts = subscribeMock.mock.calls[subscribeMock.mock.calls.length - 1][0];
        expect(scripts).not.toContain(FOREIGN_SCRIPT);
        expect(scripts).toContain(OTHER_FOREIGN_SCRIPT);
        expect(watcher.getWatchedScripts().map((w) => w.script)).toEqual([OTHER_FOREIGN_SCRIPT]);

        (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [] });
        await vi.advanceTimersByTimeAsync(1000);

        for (const call of callback.mock.calls) {
            expect(call[0].script).not.toBe(FOREIGN_SCRIPT);
        }

        await watcher.stopWatching();
    });

    // `handleContractEvent` has no case for the script_ variants, so the event
    // is forwarded without reaching syncContracts/saveVtxosForContract.
    it("forwards a watch-only event through the manager without syncing it", async () => {
        const walletRepository = new InMemoryWalletRepository();
        const indexer = createMockIndexerProvider();
        (indexer.getSubscription as any).mockImplementation(
            subscriptionYielding([
                {
                    scripts: [FOREIGN_SCRIPT],
                    newVtxos: [createMockVtxo({ script: FOREIGN_SCRIPT, value: 8080 })],
                    spentVtxos: [],
                    sweptVtxos: [],
                },
            ]),
        );

        const manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository: new InMemoryContractRepository(),
            walletRepository,
        });

        const seen: ContractEvent[] = [];
        manager.onContractEvent((e) => seen.push(e));
        await manager.watchScript!(FOREIGN_SCRIPT);

        // Either name: `handleContractEvent` awaits its sync before forwarding.
        await vi.waitFor(() => expect(seen.some((e) => e.type !== "connection_reset")).toBe(true));
        expect(await walletRepository.getVtxosForScript!(FOREIGN_SCRIPT)).toEqual([]);
        expect(seen.map((e) => e.type)).toContain("script_vtxo_received");

        manager.dispose();
    });
});

const mockPrivKeyHex = "ce66c68f8875c0c98a502c666303dc183a21600130013c06f9d1edf60207abf2";
const serverPubKeyHex = "e35799157be4b37565bb5afe4d04e6a0fa0a4b6a4f4e48b0d904685d253cdbdb";

function createMockArkProvider(): ArkProvider {
    return {
        getInfo: vi.fn().mockResolvedValue({
            signerPubkey: "02" + serverPubKeyHex,
            forfeitPubkey: "02" + serverPubKeyHex,
            boardingExitDelay: 144n,
            unilateralExitDelay: 144n,
            sessionDuration: 10n,
            network: "regtest",
            forfeitAddress: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
            checkpointTapscript: "5ab27520" + serverPubKeyHex + "ac",
            dust: 450n,
            fees: { intentFee: {}, txFeeRate: "" },
            deprecatedSigners: [],
            digest: "",
            scheduledSession: undefined,
            serviceStatus: { isReady: true },
            utxoMaxAmount: -1n,
            utxoMinAmount: 0n,
            version: "0.1.0",
            vtxoMaxAmount: -1n,
            vtxoMinAmount: 0n,
        }),
        submitTx: vi.fn(),
        finalizeTx: vi.fn(),
        registerIntent: vi.fn(),
        deleteIntent: vi.fn(),
        confirmRegistration: vi.fn(),
        submitTreeNonces: vi.fn(),
        submitTreeSignatures: vi.fn(),
        submitSignedForfeitTxs: vi.fn(),
        getEventStream: vi.fn(),
        getTransactionsStream: vi.fn(),
        getPendingTxs: vi.fn(),
    } as unknown as ArkProvider;
}

function createMockOnchainProvider(): OnchainProvider {
    return {
        getCoins: vi.fn().mockResolvedValue([]),
        getFeeRate: vi.fn().mockResolvedValue(1),
        broadcastTransaction: vi.fn(),
        getTxOutspends: vi.fn().mockResolvedValue([]),
        getTransactions: vi.fn().mockResolvedValue([]),
        getChainTip: vi.fn().mockResolvedValue({ height: 100, time: 0 }),
        getTxStatus: vi.fn(),
        getTxHex: vi.fn(),
    } as unknown as OnchainProvider;
}

describe("watch-only scripts stay out of the wallet", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    // Load-bearing: the owned assertions stop the "absent" ones passing vacuously.
    it("never enter balance, spendable, recoverable or contract reads", async () => {
        const walletRepository = new InMemoryWalletRepository();
        const contractRepository = new InMemoryContractRepository();
        const mockIndexer = createMockIndexerProvider();

        const wallet = await Wallet.create({
            identity: SingleKey.fromHex(mockPrivKeyHex),
            arkServerUrl: "http://localhost:7070",
            arkProvider: createMockArkProvider(),
            indexerProvider: mockIndexer,
            onchainProvider: createMockOnchainProvider(),
            storage: { walletRepository, contractRepository },
        });

        const manager = await wallet.getContractManager();
        const [owned] = await manager.getContracts({ type: ["default"] });
        expect(owned).toBeDefined();

        const OWNED_VALUE = 31337;
        const FOREIGN_VALUE = 99999;

        // The indexer knows both scripts. Only one is ours.
        (mockIndexer.getVtxos as any).mockImplementation((opts: { scripts?: string[] }) => {
            const scripts = opts?.scripts ?? [];
            const vtxos: VirtualCoin[] = [];
            for (const s of scripts) {
                if (s === owned.script) {
                    vtxos.push(
                        createMockVtxo({
                            script: s,
                            value: OWNED_VALUE,
                            txid: hex.encode(new Uint8Array(32).fill(0xaa)),
                        }),
                    );
                }
                if (s === FOREIGN_SCRIPT) {
                    vtxos.push(
                        createMockVtxo({
                            script: s,
                            value: FOREIGN_VALUE,
                            txid: hex.encode(new Uint8Array(32).fill(0xbb)),
                        }),
                    );
                }
            }
            return Promise.resolve({ vtxos });
        });

        await manager.watchScript!(FOREIGN_SCRIPT);
        await manager.refreshVtxos();

        expect((await manager.getWatchedScripts!()).map((w) => w.script)).toEqual([FOREIGN_SCRIPT]);

        const hasForeign = (vtxos: { script: string }[]) =>
            vtxos.some((v) => v.script === FOREIGN_SCRIPT);
        const hasOwned = (vtxos: { script: string }[]) =>
            vtxos.some((v) => v.script === owned.script);

        const all = await wallet.getVtxos({ withRecoverable: true });
        expect(hasForeign(all)).toBe(false);
        expect(hasOwned(all)).toBe(true);
        expect(all.find((v) => v.script === owned.script)!.value).toBe(OWNED_VALUE);

        const spendable = await wallet.getSpendableVtxos();
        expect(hasForeign(spendable)).toBe(false);
        expect(hasOwned(spendable)).toBe(true);

        const contracts = await manager.getContracts();
        expect(contracts.some((c) => c.script === FOREIGN_SCRIPT)).toBe(false);
        expect(contracts.some((c) => c.script === owned.script)).toBe(true);

        const withVtxos = await manager.getContractsWithVtxos();
        expect(withVtxos.some((c) => c.contract.script === FOREIGN_SCRIPT)).toBe(false);
        expect(withVtxos.flatMap((c) => c.vtxos).some((v) => v.script === FOREIGN_SCRIPT)).toBe(
            false,
        );
        expect(withVtxos.flatMap((c) => c.vtxos).some((v) => v.script === owned.script)).toBe(true);

        // No balance bucket may contain the foreign value; the owned one must
        // be counted — the pair is what makes this test bite.
        const balance = await wallet.getBalance();
        const buckets = [
            balance.settled,
            balance.preconfirmed,
            balance.available,
            balance.recoverable,
            balance.total,
            balance.boarding.total,
        ];
        for (const bucket of buckets) {
            expect(bucket).not.toBe(FOREIGN_VALUE);
            expect(bucket).toBeLessThan(FOREIGN_VALUE);
        }
        expect(balance.total).toBe(OWNED_VALUE);

        // The root cause of every "absent" above: nothing was persisted.
        expect(await walletRepository.getVtxosForScript!(FOREIGN_SCRIPT)).toEqual([]);
        expect(await walletRepository.getVtxosForScript!(owned.script)).not.toEqual([]);

        manager.dispose();
    });
});
