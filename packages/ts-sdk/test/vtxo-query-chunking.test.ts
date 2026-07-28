import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    type IndexerProvider,
    type VirtualCoin,
} from "../src";
import type { Contract } from "../src/contracts";
import { SCRIPT_QUERY_CHUNK_SIZE } from "../src/contracts/constants";
import { updateWalletState } from "../src/utils/syncCursors";
import { getAllNormalizedVtxos } from "../src/wallet/vtxo";
import { createDefaultContractParams, createMockIndexerProvider } from "./contracts/helpers";
import {
    installRestoreHarness,
    makeStaticWalletForTest,
    teardownRestoreHarness,
} from "./helpers/restoreWallet";

const CAP = SCRIPT_QUERY_CHUNK_SIZE;

/** Distinct, P2TR-shaped pkScripts. */
const scriptAt = (i: number) => "5120" + i.toString(16).padStart(64, "0");
const scripts = (n: number) => Array.from({ length: n }, (_, i) => scriptAt(i));

const contractAt = (i: number): Contract => ({
    type: "default",
    params: createDefaultContractParams(),
    script: scriptAt(i),
    address: `addr-${i}`,
    state: "active",
    createdAt: 1,
});

const vtxoFor = (script: string, n: number): VirtualCoin => ({
    txid: script.slice(4, 68).replace(/^.{2}/, n.toString(16).padStart(2, "0")),
    vout: 0,
    value: 1000,
    status: { confirmed: true },
    virtualStatus: { state: "settled" },
    createdAt: new Date(),
    isUnrolled: false,
    isSpent: false,
    script,
});

/**
 * Records every `scripts`-shaped query and answers each with one VTXO per
 * requested script, spread over `pagesPerChunk` pages so the chunk/page nesting
 * is exercised rather than assumed.
 */
function recordingIndexer(pagesPerChunk = 1): {
    indexer: IndexerProvider;
    calls: { scripts: string[]; pageIndex: number; pendingOnly?: boolean }[];
} {
    const calls: { scripts: string[]; pageIndex: number; pendingOnly?: boolean }[] = [];
    const indexer = createMockIndexerProvider();
    (indexer.getVtxos as any).mockImplementation(
        async (opts?: {
            scripts?: string[];
            pageIndex?: number;
            pageSize?: number;
            pendingOnly?: boolean;
        }) => {
            if (!opts?.scripts) return { vtxos: [] };
            const pageIndex = opts.pageIndex ?? 0;
            const pageSize = opts.pageSize ?? 500;
            calls.push({ scripts: opts.scripts, pageIndex, pendingOnly: opts.pendingOnly });
            const page = { current: pageIndex, next: pageIndex + 1, total: pagesPerChunk };
            // A full page keeps the reader going; the last one is short.
            const last = pageIndex === pagesPerChunk - 1;
            const count = last ? opts.scripts.length : pageSize;
            const vtxos = Array.from({ length: count }, (_, k) =>
                vtxoFor(opts.scripts![k % opts.scripts!.length], pageIndex * 1000 + k),
            );
            return { vtxos, page };
        },
    );
    return { indexer, calls };
}

const widest = (calls: { scripts: string[] }[]) => Math.max(...calls.map((c) => c.scripts.length));

describe("getAllNormalizedVtxos", () => {
    it("chunks a script list past the cap and unions every chunk's results", async () => {
        const { indexer, calls } = recordingIndexer();
        const all = scripts(CAP * 3 + 7);

        const vtxos = await getAllNormalizedVtxos(indexer, all);

        expect(calls).toHaveLength(4);
        expect(widest(calls)).toBeLessThanOrEqual(CAP);
        // The union is the part that can silently drop scripts.
        expect(new Set(vtxos.map((v) => v.script))).toEqual(new Set(all));
    });

    it("pages each chunk to exhaustion, restarting the cursor per chunk", async () => {
        const { indexer, calls } = recordingIndexer(2);

        await getAllNormalizedVtxos(indexer, scripts(CAP + 1), { pageSize: 2 });

        expect(calls.map((c) => c.pageIndex)).toEqual([0, 1, 0, 1]);
        expect(widest(calls)).toBeLessThanOrEqual(CAP);
    });

    it("makes no request for an empty script list", async () => {
        const { indexer, calls } = recordingIndexer();
        expect(await getAllNormalizedVtxos(indexer, [])).toEqual([]);
        expect(calls).toHaveLength(0);
    });
});

describe("ContractManager script queries stay under the URL cap", () => {
    const managers: ContractManager[] = [];
    afterEach(async () => {
        while (managers.length) await managers.pop()!.dispose();
    });

    const boot = async (indexer: IndexerProvider, contractCount: number) => {
        const contractRepository = new InMemoryContractRepository();
        for (let i = 0; i < contractCount; i++) {
            await contractRepository.saveContract(contractAt(i));
        }
        const manager = await ContractManager.create({
            indexerProvider: indexer,
            contractRepository,
            walletRepository: new InMemoryWalletRepository(),
            watcherConfig: { failsafePollIntervalMs: 1_000_000, reconnectDelayMs: 1_000_000 },
        });
        managers.push(manager);
        return manager;
    };

    // The boot guard: an oversized URL is a terminal 414, so before chunking a
    // large wallet failed to construct outright.
    it("boots a large wallet without an oversized request", async () => {
        const { indexer, calls } = recordingIndexer();

        await boot(indexer, CAP * 4);

        // Both boot queries must be chunked: the sync, and the pending-frontier
        // reconcile that runs over the full watched set right after it.
        expect(calls.some((c) => c.pendingOnly)).toBe(true);
        expect(widest(calls)).toBeLessThanOrEqual(CAP);
    });

    it("returns vtxos for every contract across chunks", async () => {
        const { indexer, calls } = recordingIndexer();
        const count = CAP * 2 + 5;
        const manager = await boot(indexer, count);
        calls.length = 0;

        const withVtxos = await manager.getContractsWithVtxos();

        expect(widest(calls)).toBeLessThanOrEqual(CAP);
        for (let i = 0; i < count; i++) {
            const entry = withVtxos.find((c) => c.contract.script === scriptAt(i));
            expect(entry?.vtxos.length).toBeGreaterThan(0);
        }
    });
});

describe("Wallet script queries stay under the URL cap", () => {
    beforeEach(installRestoreHarness);
    afterEach(() => {
        teardownRestoreHarness();
        vi.restoreAllMocks();
    });

    /** A wallet whose contract repository already holds `count` contracts. */
    const walletWithContracts = async (count: number) => {
        const handle = await makeStaticWalletForTest();
        for (let i = 0; i < count; i++) {
            await handle.contractRepository.saveContract(contractAt(i));
        }
        handle.indexer.getVtxosCalls.length = 0;
        return handle;
    };

    it("chunks fetchPendingTxs", async () => {
        const handle = await walletWithContracts(CAP * 3);

        await handle.wallet.fetchPendingTxs();

        expect(widest(handle.indexer.getVtxosCalls)).toBeLessThanOrEqual(CAP);
    });

    it("chunks finalizePendingTxs", async () => {
        const handle = await walletWithContracts(CAP * 3);
        await updateWalletState(handle.walletRepository, (state) => ({
            ...state,
            settings: { ...state.settings, hasPendingTx: true },
        }));

        await handle.wallet.finalizePendingTxs();

        expect(handle.indexer.getVtxosCalls.length).toBeGreaterThan(0);
        expect(widest(handle.indexer.getVtxosCalls)).toBeLessThanOrEqual(CAP);
    });
});
