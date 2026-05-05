import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { hex } from "@scure/base";
import {
    createDefaultContractParams,
    createMockContractVtxo,
    createMockIndexerProvider,
    createMockVtxo,
    TEST_DEFAULT_SCRIPT,
    TEST_PUB_KEY,
    TEST_SERVER_PUB_KEY,
} from "./helpers";

vi.useFakeTimers();

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
        const altScript = hex.encode(
            DefaultContractHandler.createScript(altParams).pkScript
        );

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
        const bootstrapCall = calls.find(
            (c: any) => c[0].scripts?.[0] === TEST_DEFAULT_SCRIPT
        );
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

    it("should not use spendable-only filter for getContractsWithVtxos", async () => {
        const contract = await manager.createContract({
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

        const result = await manager.getContractsWithVtxos();

        // getContractsWithVtxos forces a sync to retrieve all VTXOs in the time window
        const lastCall = (mockIndexer.getVtxos as any).mock.calls.at(-1);
        expect(lastCall[0].spendableOnly).toBeUndefined();
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
            }
        );

        const contract = await manager.createContract({
            type: "default",
            params: createDefaultContractParams(),
            script: TEST_DEFAULT_SCRIPT,
            address: "address",
        });

        vi.advanceTimersByTime(3000);
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
    });
});
