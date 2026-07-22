import { describe, it, expect, vi, beforeEach } from "vitest";

import {
    ContractManager,
    DefaultContractHandler,
    DefaultVtxo,
    IndexerProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    SubscriptionResponse,
} from "../../src";
import { ContractRepository } from "../../src/repositories";
import { contractHandlers } from "../../src/contracts/handlers";
import { OVERLAP_MS } from "../../src/utils/syncCursors";
import { hex } from "@scure/base";
import {
    createDefaultContractParams,
    createMockContractVtxo,
    createMockExtendedVtxo,
    createMockIndexerProvider,
    createMockVtxo,
    TEST_DEFAULT_SCRIPT,
    TEST_DELEGATE_PUB_KEY,
    TEST_PUB_KEY,
    TEST_SERVER_PUB_KEY,
} from "./helpers";

// Second (script, params) pair distinct from `TEST_DEFAULT_SCRIPT` so a
// test can register two contracts via `manager.createContract` without
// the manager rejecting the duplicate script. Built with the delegate
// fixture pubkey to keep it deterministic.
const SECOND_DEFAULT_SCRIPT_TAPSCRIPT = new DefaultVtxo.Script({
    pubKey: TEST_DELEGATE_PUB_KEY,
    serverPubKey: TEST_SERVER_PUB_KEY,
    csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
});
const SECOND_DEFAULT_SCRIPT = hex.encode(SECOND_DEFAULT_SCRIPT_TAPSCRIPT.pkScript);
const SECOND_DEFAULT_PARAMS = DefaultContractHandler.serializeParams({
    pubKey: TEST_DELEGATE_PUB_KEY,
    serverPubKey: TEST_SERVER_PUB_KEY,
    csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
});

vi.useFakeTimers();

function collectRequestedScripts(mockIndexer: IndexerProvider): Set<string> {
    const calls = (mockIndexer.getVtxos as any).mock.calls;
    const out = new Set<string>();
    for (const args of calls) {
        for (const s of args[0]?.scripts ?? []) {
            out.add(s);
        }
    }
    return out;
}

describe("ContractManager", () => {
    let manager: ContractManager;
    let mockIndexer: IndexerProvider;
    let repository: ContractRepository;

    beforeEach(async () => {
        mockIndexer = createMockIndexerProvider();
        repository = new InMemoryContractRepository();

        manager = await ContractManager.create({
            indexerProvider: mockIndexer,
            contractRepository: repository,
            walletRepository: new InMemoryWalletRepository(),
            watcherConfig: {
                failsafePollIntervalMs: 1000,
                reconnectDelayMs: 500,
            },
        });
    });

    it("should create and retrieve contracts", async () => {
        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });

        expect(contract.script).toBeDefined();
        expect(contract.createdAt).toBeDefined();
        expect(contract.state).toBe("active");

        const [retrieved] = await manager.getContracts({
            script: contract.script,
        });
        expect(retrieved).toEqual(contract);
    });

    it("should list all contracts", async () => {
        // Create two contracts with explicit different scripts
        await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address-1",
        });

        const altParams = DefaultContractHandler.serializeParams({
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: {
                type: "blocks",
                value: DefaultVtxo.Script.DEFAULT_TIMELOCK.value + 1n,
            },
        });
        const altScript = hex.encode(DefaultContractHandler.createScript(altParams).pkScript);

        await manager.createContract({
            type: "default",
            params: altParams,
            script: altScript,
            address: "address-2",
        });

        expect(await manager.getContracts()).toHaveLength(2);
    });

    it("should activate and deactivate contracts", async () => {
        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });
        expect(await manager.getContracts({ state: "active" })).toHaveLength(1);
        await manager.setContractState(contract.script, "inactive");
        expect(await manager.getContracts({ state: "active" })).toHaveLength(0);
        await manager.setContractState(contract.script, "active");
        expect(await manager.getContracts({ state: "active" })).toHaveLength(1);
    });

    it("should update contract metadata", async () => {
        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
            metadata: { customField: "initial" },
        });

        await manager.updateContract(contract.script, {
            metadata: { newField: "added" },
        });

        const [updated] = await manager.getContracts({
            script: contract.script,
        });
        expect(updated?.metadata).toEqual({
            newField: "added",
        });
    });

    it("should update contract params preserving the existing values", async () => {
        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });

        await manager.updateContractParams(contract.script, {
            preimage: "newSecret",
        });

        const [updated] = await manager.getContracts({
            script: contract.script,
        });
        expect(updated?.params).toEqual({
            ...contract.params,
            preimage: "newSecret",
        });
    });

    it("should persist contracts across initialization", async () => {
        await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });

        // Create new manager with same storage
        const newManager = await ContractManager.create({
            indexerProvider: mockIndexer,
            contractRepository: repository,
            walletRepository: new InMemoryWalletRepository(),
        });

        expect(await newManager.getContracts()).toHaveLength(1);
    });

    it("should fetch full VTXO history (not spendable-only) on bootstrap", async () => {
        // Pre-populate repo with a contract via createContract
        await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });

        // Clear mock calls from createContract so we only inspect
        // calls made during the subsequent ContractManager.create()
        (mockIndexer.getVtxos as any).mockClear();

        // Mock indexer to return a mix of settled and spent VTXOs
        const settledVtxo = createMockContractVtxo(TEST_DEFAULT_SCRIPT, {
            txid: "aa".repeat(32),
            virtualStatus: { state: "settled" },
        });
        const spentVtxo = createMockContractVtxo(TEST_DEFAULT_SCRIPT, {
            txid: "bb".repeat(32),
            isSpent: true,
            virtualStatus: { state: "settled" },
        });
        (mockIndexer.getVtxos as any).mockResolvedValue({
            vtxos: [settledVtxo, spentVtxo],
        });

        const walletRepo = new InMemoryWalletRepository();
        // Re-create manager with the pre-populated contract repo
        const newManager = await ContractManager.create({
            indexerProvider: mockIndexer,
            contractRepository: repository,
            walletRepository: walletRepo,
        });

        // The bootstrap call should NOT have used spendableOnly
        const calls = (mockIndexer.getVtxos as any).mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        const bootstrapCall = calls.find((c: any) => c[0].scripts?.[0] === TEST_DEFAULT_SCRIPT);
        expect(bootstrapCall).toBeDefined();
        expect(bootstrapCall[0].spendableOnly).toBeUndefined();

        // Both settled and spent VTXOs should be in the repo
        const repoVtxos = await walletRepo.getVtxos("address");
        expect(repoVtxos).toHaveLength(2);
    });

    it("should save all VTXOs to wallet repository on bootstrap", async () => {
        const walletRepo = new InMemoryWalletRepository();

        // Pre-populate contract repo
        await repository.saveContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "contract-address",
            createdAt: Date.now(),
            state: "active",
        });

        const vtxo1 = createMockContractVtxo(TEST_DEFAULT_SCRIPT, {
            txid: "cc".repeat(32),
            virtualStatus: { state: "settled" },
        });
        const vtxo2 = createMockContractVtxo(TEST_DEFAULT_SCRIPT, {
            txid: "dd".repeat(32),
            virtualStatus: { state: "swept" },
        });
        (mockIndexer.getVtxos as any).mockResolvedValue({
            vtxos: [vtxo1, vtxo2],
        });

        await ContractManager.create({
            indexerProvider: mockIndexer,
            contractRepository: repository,
            walletRepository: walletRepo,
        });

        const savedVtxos = await walletRepo.getVtxos("contract-address");
        expect(savedVtxos).toHaveLength(2);
        const states = savedVtxos.map((v) => v.virtualStatus.state);
        expect(states).toContain("settled");
        expect(states).toContain("swept");
    });

    it("should not use spendable-only filter when getContractsWithVtxos syncs", async () => {
        await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });

        // Mock indexer to return both spendable and spent VTXOs
        const spendable = createMockContractVtxo(TEST_DEFAULT_SCRIPT, {
            txid: "aa".repeat(32),
            isSpent: false,
        });
        const spent = createMockContractVtxo(TEST_DEFAULT_SCRIPT, {
            txid: "bb".repeat(32),
            isSpent: true,
        });
        (mockIndexer.getVtxos as any).mockResolvedValue({
            vtxos: [spendable, spent],
        });

        // Cleared so the assertion below can only be satisfied by this read's
        // own query — createContract hydrates from the indexer too.
        (mockIndexer.getVtxos as any).mockClear();
        const result = await manager.getContractsWithVtxos(undefined, { sync: true });

        expect(mockIndexer.getVtxos).toHaveBeenCalled();
        for (const [opts] of (mockIndexer.getVtxos as any).mock.calls) {
            expect(opts.spendableOnly).toBeUndefined();
        }
        // The point of not filtering: the spent row is persisted and returned,
        // so history and spend reconciliation can see it.
        expect(result[0].vtxos.map((v) => v.txid).sort()).toEqual(
            ["aa".repeat(32), "bb".repeat(32)].sort(),
        );
    });

    it("getContractsWithVtxos issues no query without the sync flag", async () => {
        await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });

        (mockIndexer.getVtxos as any).mockClear();
        await manager.getContractsWithVtxos();

        expect(mockIndexer.getVtxos).not.toHaveBeenCalled();
    });

    it("should force VTXOs refresh from indexer when received a `connection_reset` event", async () => {
        (mockIndexer.subscribeForScripts as any).mockImplementationOnce(() => {
            throw new Error("Connection refused");
        });

        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });
    });

    it("should force VTXOs refresh from indexer when received a `vtxo_received` event", async () => {
        (mockIndexer.getSubscription as any).mockImplementationOnce(
            (): AsyncIterableIterator<SubscriptionResponse> => {
                async function* gen(): AsyncIterableIterator<SubscriptionResponse> {
                    yield {
                        scripts: [TEST_DEFAULT_SCRIPT],
                        newVtxos: [createMockVtxo()],
                        spentVtxos: [],
                        sweptVtxos: [],
                    };
                }
                return gen();
            },
        );

        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });

        vi.advanceTimersByTime(3000);
    });

    describe("refreshVtxos includeInactive", () => {
        // Default `refreshVtxos()` syncs the watched set;
        // `includeInactive: true` widens it to every repository row,
        // which differs only for rows the watcher never registered.
        //
        // The manager validates that `script` is derived from `params`,
        // so these tests seed the repository directly with synthetic
        // scripts to exercise the refresh path independently of script
        // construction.

        const inactiveScript = "ee".repeat(34);
        const otherScript = "dd".repeat(34);

        async function seedActive(): Promise<void> {
            await manager.createContract({
                type: "default",
                params: createDefaultContractParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "active-address",
                state: "active",
            });
        }

        async function seedRaw(
            script: string,
            address: string,
            state: "active" | "inactive",
        ): Promise<void> {
            await repository.saveContract({
                type: "default",
                params: createDefaultContractParams(),
                script,
                address,
                state,
                createdAt: Date.now(),
            });
        }

        it("indexer query covers inactive contracts when the flag is set", async () => {
            await seedActive();
            await seedRaw(inactiveScript, "stale-address", "inactive");

            (mockIndexer.getVtxos as any).mockClear();
            (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [] });

            await manager.refreshVtxos({ includeInactive: true });

            // Both scripts appear in the indexer's `scripts` filter —
            // the active one (which the watched set would already
            // cover) AND the inactive one (which the default path
            // would skip).
            const requested = collectRequestedScripts(mockIndexer);
            expect(requested.has(TEST_DEFAULT_SCRIPT)).toBe(true);
            expect(requested.has(inactiveScript)).toBe(true);
        });

        it("default path (no flag) skips repository rows the watcher never registered", async () => {
            await seedActive();
            await seedRaw(inactiveScript, "stale-address", "inactive");

            (mockIndexer.getVtxos as any).mockClear();
            (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [] });

            await manager.refreshVtxos();

            // `seedRaw` bypasses `createContract`, so the watcher never
            // saw this script.
            const requested = collectRequestedScripts(mockIndexer);
            expect(requested.has(inactiveScript)).toBe(false);
        });

        it("default path still covers contracts the watcher transitioned to inactive", async () => {
            // The production shape the `seedRaw` variants can't reach: a
            // registered contract later retired via `setContractState`.
            await seedActive();
            await manager.createContract({
                type: "default",
                params: SECOND_DEFAULT_PARAMS,
                script: SECOND_DEFAULT_SCRIPT,
                address: "second-address",
                state: "active",
            });
            await manager.setContractState(SECOND_DEFAULT_SCRIPT, "inactive");

            (mockIndexer.getVtxos as any).mockClear();
            (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [] });

            await manager.refreshVtxos();

            const requested = collectRequestedScripts(mockIndexer);
            expect(requested.has(TEST_DEFAULT_SCRIPT)).toBe(true);
            expect(requested.has(SECOND_DEFAULT_SCRIPT)).toBe(true);
        });

        it("explicit scripts filter takes precedence over includeInactive", async () => {
            // `includeInactive` is documented as ignored when `scripts`
            // is set; verify the indexer query only covers the explicit
            // list, not "all contracts in the repo".
            await seedActive();
            await seedRaw(otherScript, "other-address", "inactive");

            (mockIndexer.getVtxos as any).mockClear();
            (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [] });

            await manager.refreshVtxos({
                scripts: [TEST_DEFAULT_SCRIPT],
                includeInactive: true,
            });

            const requested = collectRequestedScripts(mockIndexer);
            expect(requested.has(TEST_DEFAULT_SCRIPT)).toBe(true);
            expect(requested.has(otherScript)).toBe(false);
        });

        it("advances the cursor on a cursor-derived includeInactive sweep", async () => {
            // `includeInactive` widens the contract scope to a superset
            // of the watched set, so the cursor invariant ("we've caught
            // up on at least the watched set") still holds. The cursor
            // should advance, unlike a `scripts` subset query.
            const SEEDED_CURSOR = Date.now() - 60_000;
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const mgr = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: contractRepo,
                walletRepository: walletRepo,
                watcherConfig: {
                    failsafePollIntervalMs: 1000,
                    reconnectDelayMs: 500,
                },
            });
            // Dispose the per-test watcher in `finally` so a background
            // `getVtxos` loop can't bleed into a later test sharing the
            // same `mockIndexer` (fake-timer suite).
            try {
                await mgr.createContract({
                    type: "default",
                    params: createDefaultContractParams(),
                    script: TEST_DEFAULT_SCRIPT,
                    address: "address",
                });
                await contractRepo.saveContract({
                    type: "default",
                    params: createDefaultContractParams(),
                    script: inactiveScript,
                    address: "stale-address",
                    state: "inactive",
                    createdAt: Date.now(),
                });
                await walletRepo.saveWalletState({
                    lastSyncTime: SEEDED_CURSOR,
                    settings: { vtxoCursorMigrated: true },
                });

                (mockIndexer.getVtxos as any).mockClear();
                (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [] });

                await mgr.refreshVtxos({ includeInactive: true });

                // Sanity: the inactive contract was actually queried
                // (this is what makes the path a superset, not a subset).
                const requested = collectRequestedScripts(mockIndexer);
                expect(requested.has(inactiveScript)).toBe(true);

                // Cursor moved strictly forward — `>=` would pass even
                // on the no-op case (cursor unchanged), defeating the
                // test.
                const stateAfter = await walletRepo.getWalletState();
                expect(stateAfter?.lastSyncTime ?? 0).toBeGreaterThan(SEEDED_CURSOR);
            } finally {
                await mgr.dispose();
            }
        });

        it("does NOT advance the cursor on a windowed includeInactive sweep", async () => {
            // Even though `includeInactive` itself is cursor-safe, an
            // explicit `after` / `before` makes the query a bounded
            // subset of time and must not move the global cursor.
            const SEEDED_CURSOR = Date.now() - 60_000;
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const mgr = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: contractRepo,
                walletRepository: walletRepo,
                watcherConfig: {
                    failsafePollIntervalMs: 1000,
                    reconnectDelayMs: 500,
                },
            });
            try {
                await mgr.createContract({
                    type: "default",
                    params: createDefaultContractParams(),
                    script: TEST_DEFAULT_SCRIPT,
                    address: "address",
                });
                await walletRepo.saveWalletState({
                    lastSyncTime: SEEDED_CURSOR,
                    settings: { vtxoCursorMigrated: true },
                });

                (mockIndexer.getVtxos as any).mockClear();
                (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [] });

                await mgr.refreshVtxos({
                    includeInactive: true,
                    after: 1_000_000,
                });

                const stateAfter = await walletRepo.getWalletState();
                expect(stateAfter?.lastSyncTime).toBe(SEEDED_CURSOR);
            } finally {
                await mgr.dispose();
            }
        });
    });

    describe("retired contract coverage", () => {
        // Detection is asserted through *background* channels only, with
        // no read API involved, so these keep guarding once reads become
        // repository-only.

        it("a retired, fully-spent contract that receives is picked up by the reconnect sweep", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const contractRepo = new InMemoryContractRepository();
            const mgr = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: contractRepo,
                walletRepository: walletRepo,
                watcherConfig: {
                    failsafePollIntervalMs: 1000,
                    reconnectDelayMs: 500,
                },
            });

            try {
                await mgr.createContract({
                    type: "default",
                    params: createDefaultContractParams(),
                    script: TEST_DEFAULT_SCRIPT,
                    address: "retired-address",
                });
                // Retired with no VTXOs left: neither arm of the old
                // `active || lastKnownVtxos.size > 0` filter held it.
                await mgr.setContractState(TEST_DEFAULT_SCRIPT, "inactive");

                const incoming = createMockContractVtxo(TEST_DEFAULT_SCRIPT, {
                    txid: "ab".repeat(32),
                });
                (mockIndexer.getVtxos as any).mockClear();
                (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [incoming] });

                // Background channel: the reconnect reconcile.
                await (mgr as any).handleContractEvent({
                    type: "connection_reset",
                    timestamp: Date.now(),
                });

                expect(collectRequestedScripts(mockIndexer).has(TEST_DEFAULT_SCRIPT)).toBe(true);
                const stored = await walletRepo.getVtxos("retired-address");
                expect(stored.map((v) => v.txid)).toContain(incoming.txid);
            } finally {
                await mgr.dispose();
            }
        });

        it("keeps a retired contract in the subscription", async () => {
            const mgr = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: new InMemoryContractRepository(),
                walletRepository: new InMemoryWalletRepository(),
                watcherConfig: {
                    failsafePollIntervalMs: 1000,
                    reconnectDelayMs: 500,
                },
            });

            try {
                await mgr.createContract({
                    type: "default",
                    params: createDefaultContractParams(),
                    script: TEST_DEFAULT_SCRIPT,
                    address: "retired-address",
                });
                (mockIndexer.subscribeForScripts as any).mockClear();
                await mgr.setContractState(TEST_DEFAULT_SCRIPT, "inactive");

                const subscribed = (mockIndexer.subscribeForScripts as any).mock.calls.flatMap(
                    (c: any) => c[0],
                );
                expect(subscribed).toContain(TEST_DEFAULT_SCRIPT);
            } finally {
                await mgr.dispose();
            }
        });
    });

    describe("annotateVtxos", () => {
        it("returns empty array for empty input", async () => {
            const extended = await manager.annotateVtxos([]);
            expect(extended).toEqual([]);
        });

        it("stamps the owning contract's tapscripts via vtxo.script", async () => {
            await manager.createContract({
                type: "default",
                params: createDefaultContractParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address",
            });

            const vtxo = createMockVtxo({ script: TEST_DEFAULT_SCRIPT });
            const [extended] = await manager.annotateVtxos([vtxo]);

            expect(extended.forfeitTapLeafScript).toBeDefined();
            expect(extended.intentTapLeafScript).toBeDefined();
            expect(extended.tapTree).toBeDefined();
        });

        it("throws when a vtxo's script has no registered contract", async () => {
            const orphan = createMockVtxo({ script: "ab".repeat(34) });
            await expect(manager.annotateVtxos([orphan])).rejects.toThrow();
        });

        it("builds the taproot tree once per contract, not once per VTXO (#521)", async () => {
            await manager.createContract({
                type: "default",
                params: createDefaultContractParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address",
            });

            const handler = contractHandlers.get("default")!;
            const spy = vi.spyOn(handler, "createScript");

            const vtxos = Array.from({ length: 100 }, (_, i) =>
                createMockVtxo({ script: TEST_DEFAULT_SCRIPT, vout: i }),
            );
            const extended = await manager.annotateVtxos(vtxos);

            expect(extended).toHaveLength(100);
            // One taproot reconstruction for the whole batch, regardless of
            // how many VTXOs share the contract.
            expect(spy).toHaveBeenCalledTimes(1);
            spy.mockRestore();
        });
    });

    describe("refreshOutpoints", () => {
        it("queries the indexer by outpoint and upserts the authoritative state into the wallet repo", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const localManager = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: repository,
                walletRepository: walletRepo,
                watcherConfig: {
                    failsafePollIntervalMs: 1000,
                    reconnectDelayMs: 500,
                },
            });
            await localManager.createContract({
                type: "default",
                params: createDefaultContractParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address",
            });

            // Indexer is the source of truth: returns the same VTXO marked
            // spent. A cursor-derived delta sync would NOT surface this
            // because the VTXO was created before the cursor; the surgical
            // outpoint query bypasses that.
            const spent = createMockVtxo({
                txid: "aa".repeat(32),
                script: TEST_DEFAULT_SCRIPT,
                isSpent: true,
            });
            (mockIndexer.getVtxos as any).mockClear();
            (mockIndexer.getVtxos as any).mockResolvedValue({
                vtxos: [spent],
            });

            await localManager.refreshOutpoints([{ txid: spent.txid, vout: spent.vout }]);

            // Outpoint-scoped indexer call.
            expect(mockIndexer.getVtxos).toHaveBeenCalledWith({
                outpoints: [{ txid: spent.txid, vout: spent.vout }],
            });

            // The wallet repo now reflects the spent flag for this address.
            const stored = await walletRepo.getVtxos("address");
            const found = stored.find((v) => v.txid === spent.txid && v.vout === spent.vout);
            expect(found).toBeDefined();
            expect(found!.isSpent).toBe(true);
        });

        it("silently skips outpoints not owned by any tracked contract", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const localManager = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: repository,
                walletRepository: walletRepo,
                watcherConfig: {
                    failsafePollIntervalMs: 1000,
                    reconnectDelayMs: 500,
                },
            });
            // Indexer returns a VTXO at a script we don't track. The
            // method should not throw and should not write anything.
            (mockIndexer.getVtxos as any).mockClear();
            (mockIndexer.getVtxos as any).mockResolvedValue({
                vtxos: [
                    createMockVtxo({
                        txid: "aa".repeat(32),
                        script: "cd".repeat(34),
                        isSpent: true,
                    }),
                ],
            });

            await localManager.refreshOutpoints([{ txid: "aa".repeat(32), vout: 0 }]);

            expect(mockIndexer.getVtxos).toHaveBeenCalled();
            const stored = await walletRepo.getVtxos("address");
            expect(stored).toEqual([]);
        });

        it("is a no-op for an empty outpoint list", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const localManager = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: repository,
                walletRepository: walletRepo,
                watcherConfig: {
                    failsafePollIntervalMs: 1000,
                    reconnectDelayMs: 500,
                },
            });
            (mockIndexer.getVtxos as any).mockClear();

            await localManager.refreshOutpoints([]);

            expect(mockIndexer.getVtxos).not.toHaveBeenCalled();
        });
    });

    describe("refreshVtxos cursor handling", () => {
        // Regression: a previous version of refreshVtxos passed
        // `window: { after: undefined, before: undefined }` even when the
        // caller supplied no options. That truthy object short-circuited the
        // `??` fallback in syncContracts (so the indexer query went out
        // without `?after=`, forcing a full re-scan) AND blocked the cursor
        // advance gate (`options.window === undefined` was always false).
        // The fix is to forward `window` only when the caller actually
        // bounded it.
        const SEEDED_CURSOR = Date.now() - 60_000; // recent enough to clear OVERLAP_MS

        async function makeFreshManager(): Promise<{
            mgr: ContractManager;
            repo: InMemoryWalletRepository;
        }> {
            const repo = new InMemoryWalletRepository();
            const mgr = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: new InMemoryContractRepository(),
                walletRepository: repo,
                watcherConfig: {
                    failsafePollIntervalMs: 1000,
                    reconnectDelayMs: 500,
                },
            });
            // Need at least one watched contract so syncContracts has
            // something to query.
            await mgr.createContract({
                type: "default",
                params: createDefaultContractParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address",
            });
            return { mgr, repo };
        }

        it("uses the cursor-derived window and advances the cursor when no opts are given", async () => {
            const { mgr, repo } = await makeFreshManager();

            // Seed a recent cursor + the migration marker so a healthy
            // delta sync goes out with `?after=<cursor - OVERLAP>`. Without
            // the marker the cursor module treats stored state as
            // untrusted-bootstrap and the delta would fall back to 0.
            await repo.saveWalletState({
                lastSyncTime: SEEDED_CURSOR,
                settings: { vtxoCursorMigrated: true },
            });

            (mockIndexer.getVtxos as any).mockClear();
            (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [] });

            await mgr.refreshVtxos();

            const calls = (mockIndexer.getVtxos as any).mock.calls;
            // Every call must carry an `after` filter — the cursor-derived
            // window. The bug omitted `after`, producing an unbounded scan.
            for (const args of calls) {
                expect(args[0]?.after).toBeDefined();
                expect(typeof args[0]?.after).toBe("number");
            }
            expect(calls.length).toBeGreaterThan(0);

            // Cursor advanced past the seeded value (the bug left it pinned).
            const stateAfter = await repo.getWalletState();
            expect((stateAfter?.lastSyncTime ?? 0) >= SEEDED_CURSOR).toBe(true);
        });

        it("does not advance the cursor when an explicit `after` is provided", async () => {
            const { mgr, repo } = await makeFreshManager();

            await repo.saveWalletState({
                lastSyncTime: SEEDED_CURSOR,
                settings: { vtxoCursorMigrated: true },
            });

            (mockIndexer.getVtxos as any).mockClear();
            (mockIndexer.getVtxos as any).mockResolvedValue({ vtxos: [] });

            await mgr.refreshVtxos({ after: 1_000_000 });

            // Cursor untouched — caller-supplied windows are targeted and
            // must not move the global high-water mark.
            const stateAfter = await repo.getWalletState();
            expect(stateAfter?.lastSyncTime).toBe(SEEDED_CURSOR);
        });

        // Regression for restore's bulk hydration: contracts a scan just
        // discovered have no prior sync state, so their first fetch must be
        // unbounded. `after: 0` bypasses the cursor the boot-time reconcile
        // already advanced past their history.
        it("`after: 0` fetches history predating the cursor without advancing it", async () => {
            const { mgr, repo } = await makeFreshManager();

            await repo.saveWalletState({
                lastSyncTime: SEEDED_CURSOR,
                settings: { vtxoCursorMigrated: true },
            });

            const ancient = new Date(Date.now() - 30 * OVERLAP_MS);
            (mockIndexer.getVtxos as any).mockClear();
            // Honours the `after` bound, so a cursor-derived window would
            // come back empty — without this the assertions pass either way.
            (mockIndexer.getVtxos as any).mockImplementation(async (opts: any) => {
                const vtxo = createMockVtxo({
                    script: TEST_DEFAULT_SCRIPT,
                    createdAt: ancient,
                });
                const visible = !opts?.after || ancient.getTime() > opts.after;
                return { vtxos: visible ? [vtxo] : [] };
            });

            await mgr.refreshVtxos({ includeInactive: true, after: 0 });

            const calls = (mockIndexer.getVtxos as any).mock.calls;
            expect(calls.length).toBeGreaterThan(0);
            for (const args of calls) {
                expect(args[0]?.after).toBe(0);
            }

            const stored = await repo.getVtxos("address");
            expect(stored).toHaveLength(1);
            expect(stored[0].createdAt).toEqual(ancient);

            // Same invariant as the explicit-window case above: a targeted
            // superset fetch must not move the global watermark.
            const stateAfter = await repo.getWalletState();
            expect(stateAfter?.lastSyncTime).toBe(SEEDED_CURSOR);
        });
    });

    describe("refreshOutpoints", () => {
        it("queries the indexer by outpoint and upserts the authoritative state into the wallet repo", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const localManager = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: repository,
                walletRepository: walletRepo,
                watcherConfig: {
                    failsafePollIntervalMs: 1000,
                    reconnectDelayMs: 500,
                },
            });
            await localManager.createContract({
                type: "default",
                params: createDefaultContractParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "address",
            });

            // Indexer is the source of truth: returns the same VTXO marked
            // spent. A cursor-derived delta sync would NOT surface this
            // because the VTXO was created before the cursor; the surgical
            // outpoint query bypasses that.
            const spent = createMockVtxo({
                txid: "aa".repeat(32),
                script: TEST_DEFAULT_SCRIPT,
                isSpent: true,
            });
            (mockIndexer.getVtxos as any).mockClear();
            (mockIndexer.getVtxos as any).mockResolvedValue({
                vtxos: [spent],
            });

            await localManager.refreshOutpoints([{ txid: spent.txid, vout: spent.vout }]);

            // Outpoint-scoped indexer call.
            expect(mockIndexer.getVtxos).toHaveBeenCalledWith({
                outpoints: [{ txid: spent.txid, vout: spent.vout }],
            });

            // The wallet repo now reflects the spent flag for this address.
            const stored = await walletRepo.getVtxos("address");
            const found = stored.find((v) => v.txid === spent.txid && v.vout === spent.vout);
            expect(found).toBeDefined();
            expect(found!.isSpent).toBe(true);
        });

        it("silently skips outpoints not owned by any tracked contract", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const localManager = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: repository,
                walletRepository: walletRepo,
                watcherConfig: {
                    failsafePollIntervalMs: 1000,
                    reconnectDelayMs: 500,
                },
            });
            // Indexer returns a VTXO at a script we don't track. The
            // method should not throw and should not write anything.
            (mockIndexer.getVtxos as any).mockClear();
            (mockIndexer.getVtxos as any).mockResolvedValue({
                vtxos: [
                    createMockVtxo({
                        txid: "aa".repeat(32),
                        script: "cd".repeat(34),
                        isSpent: true,
                    }),
                ],
            });

            await localManager.refreshOutpoints([{ txid: "aa".repeat(32), vout: 0 }]);

            expect(mockIndexer.getVtxos).toHaveBeenCalled();
            const stored = await walletRepo.getVtxos("address");
            expect(stored).toEqual([]);
        });

        it("is a no-op for an empty outpoint list", async () => {
            const walletRepo = new InMemoryWalletRepository();
            const localManager = await ContractManager.create({
                indexerProvider: mockIndexer,
                contractRepository: repository,
                walletRepository: walletRepo,
                watcherConfig: {
                    failsafePollIntervalMs: 1000,
                    reconnectDelayMs: 500,
                },
            });
            (mockIndexer.getVtxos as any).mockClear();

            await localManager.refreshOutpoints([]);

            expect(mockIndexer.getVtxos).not.toHaveBeenCalled();
        });
    });

    // Regression: an address bucket can hold a row whose `script` belongs
    // to a different contract (legacy duplicate). `getContractsWithVtxos`
    // must filter each contract's bucket by its own `script` before mapping
    // to ContractVtxo, otherwise the wrong-script row leaks into the wrong
    // contract's view.
    it("getContractsWithVtxos drops wrong-script rows from a contract's address bucket", async () => {
        const altParams = DefaultContractHandler.serializeParams({
            pubKey: TEST_PUB_KEY,
            serverPubKey: TEST_SERVER_PUB_KEY,
            csvTimelock: {
                type: "blocks",
                value: DefaultVtxo.Script.DEFAULT_TIMELOCK.value + 1n,
            },
        });
        const altScript = hex.encode(DefaultContractHandler.createScript(altParams).pkScript);

        const walletRepo = new InMemoryWalletRepository();
        const localManager = await ContractManager.create({
            indexerProvider: createMockIndexerProvider(),
            contractRepository: new InMemoryContractRepository(),
            walletRepository: walletRepo,
            watcherConfig: {
                failsafePollIntervalMs: 1000,
                reconnectDelayMs: 500,
            },
        });

        const contractA = await localManager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "contract-A-addr",
        });
        const contractB = await localManager.createContract({
            type: "default",
            params: altParams,
            script: altScript,
            address: "contract-B-addr",
        });

        // Seed contract A's bucket with a row whose script actually
        // belongs to contract B — the live bug we're guarding against.
        const wrongScriptRow = createMockExtendedVtxo({
            txid: "ee".repeat(32),
            vout: 0,
            virtualStatus: { state: "settled" },
            isSpent: false,
            script: contractB.script,
        });
        // Seed contract B's bucket with the script-matching row at the
        // same outpoint, marked spent so we can prove the spent row wins
        // over the unspent wrong-script duplicate.
        const correctRow = createMockExtendedVtxo({
            txid: "ee".repeat(32),
            vout: 0,
            virtualStatus: { state: "settled" },
            isSpent: true,
            script: contractB.script,
        });
        await walletRepo.saveVtxos(contractA.address, [wrongScriptRow]);
        await walletRepo.saveVtxos(contractB.address, [correctRow]);

        const result = await localManager.getContractsWithVtxos();
        const a = result.find((c) => c.contract.script === contractA.script);
        const b = result.find((c) => c.contract.script === contractB.script);

        // Contract A must not return a row whose script is contract B's.
        expect(a?.vtxos.find((v) => v.txid === "ee".repeat(32))).toBeUndefined();
        // Contract B returns its own script-matching row.
        const bRow = b?.vtxos.find((v) => v.txid === "ee".repeat(32));
        expect(bRow).toBeDefined();
        expect(bRow?.isSpent).toBe(true);

        localManager.dispose();
    });

    it("fetchContractVxosFromIndexer skips wrong-script rows without crashing the sync", async () => {
        const walletRepo = new InMemoryWalletRepository();
        const indexer = createMockIndexerProvider();
        const goodVtxo = createMockContractVtxo(TEST_DEFAULT_SCRIPT, {
            txid: "aa".repeat(32),
            virtualStatus: { state: "settled" },
        });
        // A row coming back tagged with the wrong script (e.g. indexer
        // mis-routing) must be dropped, not persisted under the contract's
        // address bucket.
        const badVtxo = createMockContractVtxo(TEST_DEFAULT_SCRIPT, {
            txid: "bb".repeat(32),
            virtualStatus: { state: "settled" },
            script: "ff".repeat(34),
        });
        (indexer.getVtxos as any).mockResolvedValue({
            vtxos: [goodVtxo, badVtxo],
        });

        const localManager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository: new InMemoryContractRepository(),
            walletRepository: walletRepo,
            watcherConfig: {
                failsafePollIntervalMs: 1000,
                reconnectDelayMs: 500,
            },
        });

        await expect(
            localManager.createContract({
                type: "default",
                params: createDefaultContractParams(),
                script: TEST_DEFAULT_SCRIPT,
                address: "contract-addr",
            }),
        ).resolves.toBeDefined();

        const saved = await walletRepo.getVtxos("contract-addr");
        // The badVtxo must have been filtered out; the good one persists.
        expect(saved.find((v) => v.txid === "aa".repeat(32))).toBeDefined();
        expect(saved.find((v) => v.txid === "bb".repeat(32))).toBeUndefined();

        localManager.dispose();
    });
});
