import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ContractManager,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    type IndexerProvider,
    TxType,
    type VirtualCoin,
} from "../src";
import type { Contract } from "../src/contracts";
import { OUTPOINT_QUERY_CHUNK_SIZE, SCRIPT_QUERY_CHUNK_SIZE } from "../src/contracts/constants";
import { ProviderUnavailableError } from "../src/providers/errors";
import { updateWalletState } from "../src/utils/syncCursors";
import { fetchVtxoCreatedAtByTxid, getAllNormalizedVtxos } from "../src/wallet/vtxo";
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

describe("fetchVtxoCreatedAtByTxid", () => {
    const OCAP = OUTPOINT_QUERY_CHUNK_SIZE;

    const txidAt = (i: number) => i.toString(16).padStart(64, "0");
    const txids = (n: number) => Array.from({ length: n }, (_, i) => txidAt(i));

    /**
     * Answers each `outpoints` query with one VTXO per outpoint, `createdAt`
     * derived from the txid. `failChunk` makes the Nth request throw `error`.
     */
    function outpointRecordingIndexer(opts?: { failChunk?: number; error?: Error }): {
        indexer: IndexerProvider;
        calls: { outpoints: { txid: string; vout: number }[]; pageSize?: number }[];
    } {
        const calls: { outpoints: { txid: string; vout: number }[]; pageSize?: number }[] = [];
        const indexer = createMockIndexerProvider();
        (indexer.getVtxos as any).mockImplementation(
            async (o?: { outpoints?: { txid: string; vout: number }[]; pageSize?: number }) => {
                if (!o?.outpoints) return { vtxos: [] };
                calls.push({ outpoints: o.outpoints, pageSize: o.pageSize });
                if (opts?.failChunk !== undefined && calls.length - 1 === opts.failChunk) {
                    throw opts.error ?? new ProviderUnavailableError("indexer down");
                }
                const vtxos = o.outpoints.map((op) => ({
                    ...vtxoFor(scriptAt(0), 0),
                    txid: op.txid,
                    createdAt: new Date(parseInt(op.txid.slice(-8), 16) * 1000),
                }));
                return { vtxos };
            },
        );
        return { indexer, calls };
    }

    it("chunks a txid list past the cap and unions every chunk's results", async () => {
        const { indexer, calls } = outpointRecordingIndexer();
        const all = txids(OCAP * 2 + 5);

        const times = await fetchVtxoCreatedAtByTxid(indexer, all);

        expect(calls.map((c) => c.outpoints.length)).toEqual([OCAP, OCAP, 5]);
        expect(times.size).toBe(all.length);
        for (const [i, txid] of all.entries()) {
            expect(times.get(txid)).toBe(i * 1000);
        }
    });

    it("dedupes txids and skips blanks", async () => {
        const { indexer, calls } = outpointRecordingIndexer();

        const times = await fetchVtxoCreatedAtByTxid(indexer, [
            txidAt(1),
            "",
            txidAt(2),
            txidAt(1),
        ]);

        expect(calls).toHaveLength(1);
        expect(calls[0].outpoints.map((o) => o.txid)).toEqual([txidAt(1), txidAt(2)]);
        expect(times.size).toBe(2);
    });

    it("makes no request for an empty txid list", async () => {
        const { indexer, calls } = outpointRecordingIndexer();
        expect((await fetchVtxoCreatedAtByTxid(indexer, [])).size).toBe(0);
        expect(calls).toHaveLength(0);
    });

    it("requests a page size that covers a full chunk", async () => {
        const { indexer, calls } = outpointRecordingIndexer();

        await fetchVtxoCreatedAtByTxid(indexer, txids(OCAP + 1));

        for (const call of calls) {
            expect(call.pageSize).toBeGreaterThanOrEqual(OCAP);
        }
    });

    it("keeps going past a retryable chunk failure and returns a partial map", async () => {
        const { indexer, calls } = outpointRecordingIndexer({ failChunk: 0 });
        const all = txids(OCAP + 5);

        const times = await fetchVtxoCreatedAtByTxid(indexer, all);

        expect(calls).toHaveLength(2);
        expect(times.size).toBe(5);
        for (const txid of all.slice(OCAP)) {
            expect(times.has(txid)).toBe(true);
        }
    });

    it("propagates a terminal error", async () => {
        const { indexer } = outpointRecordingIndexer({
            failChunk: 0,
            error: new Error("bad request"),
        });

        await expect(fetchVtxoCreatedAtByTxid(indexer, txids(3))).rejects.toThrow("bad request");
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

/**
 * The wiring, end to end: history used to issue one indexer request per spent
 * VTXO, sequentially, repeating for every VTXO sharing an `arkTxId`. The unit
 * tests above pin the resolver; these pin that `Wallet` actually reaches it.
 */
describe("Wallet.getTransactionHistory batches createdAt lookups", () => {
    beforeEach(installRestoreHarness);
    afterEach(() => {
        teardownRestoreHarness();
        vi.restoreAllMocks();
    });

    const arkTxIdAt = (i: number) => "f" + (i + 1).toString(16).padStart(63, "0");

    /**
     * A wallet holding one spent VTXO per contract, each spent by a distinct
     * `arkTxId` unless `sharedArkTxId` — the send-everything shape, whose
     * `createdAt` lives only at the indexer. Returns the outpoint-shaped queries
     * `getTransactionHistory` makes.
     */
    const walletWithSpentVtxos = async (count: number, sharedArkTxId?: string) => {
        const handle = await makeStaticWalletForTest();
        const spent = new Map(
            Array.from({ length: count }, (_, i) => {
                const script = scriptAt(i);
                return [
                    script,
                    {
                        ...vtxoFor(script, i),
                        isSpent: true,
                        arkTxId: sharedArkTxId ?? arkTxIdAt(i),
                    },
                ] as const;
            }),
        );
        for (const script of spent.keys()) {
            await handle.contractRepository.saveContract(
                contractAt(Number.parseInt(script.slice(4), 16)),
            );
        }

        const outpointCalls: { txid: string; vout: number }[][] = [];
        handle.indexer.getVtxos = (async (opts?: {
            scripts?: string[];
            outpoints?: { txid: string; vout: number }[];
        }) => {
            if (opts?.outpoints) {
                outpointCalls.push(opts.outpoints);
                return {
                    vtxos: opts.outpoints.map((o) => ({
                        ...vtxoFor(scriptAt(0), 0),
                        txid: o.txid,
                        createdAt: new Date(1_700_000_000_000),
                    })),
                };
            }
            return { vtxos: (opts?.scripts ?? []).map((s) => spent.get(s)).filter(Boolean) };
        }) as IndexerProvider["getVtxos"];

        return { wallet: handle.wallet, outpointCalls };
    };

    it("issues one request per chunk of txids, not one per spent vtxo", async () => {
        const count = OUTPOINT_QUERY_CHUNK_SIZE + 5;
        const { wallet, outpointCalls } = await walletWithSpentVtxos(count);

        const history = await wallet.getTransactionHistory();

        // Pre-batching: `count` sequential single-outpoint requests.
        expect(outpointCalls.map((c) => c.length)).toEqual([OUTPOINT_QUERY_CHUNK_SIZE, 5]);
        // Every fetched timestamp lands, so no send falls back to createdAt + 1.
        const sent = history.filter((tx) => tx.type === TxType.TxSent);
        expect(sent).toHaveLength(count);
        for (const tx of sent) {
            expect(tx.createdAt).toBe(1_700_000_000_000);
        }
    });

    it("does not re-request a txid shared by several vtxos", async () => {
        const shared = arkTxIdAt(0);
        const { wallet, outpointCalls } = await walletWithSpentVtxos(5, shared);

        await wallet.getTransactionHistory();

        expect(outpointCalls).toHaveLength(1);
        expect(outpointCalls[0]).toEqual([{ txid: shared, vout: 0 }]);
    });
});
