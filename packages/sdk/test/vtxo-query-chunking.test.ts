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
import { MAX_INPUTS_PER_PROOF } from "../src/wallet/vtxo-manager";
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
            calls.push({ scripts: opts.scripts, pageIndex, pendingOnly: opts.pendingOnly });
            // As arkd: index 0 serves page 1, and a page holds at most 100 rows.
            const current = Math.max(pageIndex, 1);
            const page = {
                current,
                next: Math.min(current + 1, pagesPerChunk),
                total: pagesPerChunk,
            };
            const last = current === pagesPerChunk;
            const count = last ? opts.scripts.length : Math.min(opts.pageSize ?? 500, 100);
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

        await getAllNormalizedVtxos(indexer, scripts(CAP + 1));

        const byChunk = new Map<string, number[]>();
        for (const call of calls) {
            const key = call.scripts[0];
            byChunk.set(key, [...(byChunk.get(key) ?? []), call.pageIndex]);
        }
        expect([...byChunk.values()]).toEqual([
            [0, 2],
            [0, 2],
        ]);
        expect(widest(calls)).toBeLessThanOrEqual(CAP);
    });

    it("makes no request for an empty script list", async () => {
        const { indexer, calls } = recordingIndexer();
        expect(await getAllNormalizedVtxos(indexer, [])).toEqual([]);
        expect(calls).toHaveLength(0);
    });

    it("bounds concurrent chunks while returning results in script order", async () => {
        const indexer = createMockIndexerProvider();
        let active = 0;
        let peak = 0;
        (indexer.getVtxos as any).mockImplementation(
            async ({ scripts: chunk }: { scripts: string[] }) => {
                active++;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active--;
                return { vtxos: chunk.map((script) => vtxoFor(script, 0)) };
            },
        );

        const all = scripts(CAP * 9);
        const result = await getAllNormalizedVtxos(indexer, all);

        expect(peak).toBe(4);
        expect(result.map((v) => v.script)).toEqual(all);
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
        await manager.whenBooted();
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

    /** A fenced-off interrupted send, as a boot from cached operator info leaves it. */
    const deferredRecovery = async () => {
        const { wallet, walletRepository } = await walletWithContracts(1);
        await (await wallet.getContractManager()).whenBooted();
        await updateWalletState(walletRepository, (state) => ({
            ...state,
            settings: { ...state.settings, hasPendingTx: true },
        }));
        const liveInfo = await wallet.arkProvider.getInfo();
        const getInfo = vi.spyOn(wallet.arkProvider, "getInfo");
        const getPendingTxs = vi.spyOn(wallet.arkProvider, "getPendingTxs").mockResolvedValue([]);
        const submitTx = vi.spyOn(wallet.arkProvider, "submitTx").mockResolvedValue({
            arkTxid: "txid",
            finalArkTx: "ark-transaction",
            signedCheckpointTxs: [],
        });
        const finalizeTx = vi.spyOn(wallet.arkProvider, "finalizeTx").mockResolvedValue(undefined);
        const getVtxos = vi
            .spyOn(wallet.indexerProvider, "getVtxos")
            .mockResolvedValue({ vtxos: [] });
        const broadcaster = await wallet.getArkadeBroadcaster();

        expect(await wallet.deferPendingTxRecovery()).toBe(true);

        return {
            wallet,
            broadcaster,
            liveInfo,
            getInfo,
            getPendingTxs,
            submitTx,
            finalizeTx,
            getVtxos,
            own: (n: number, extra: Partial<VirtualCoin> = {}) => ({
                ...vtxoFor(wallet.defaultContractScript, n),
                ...extra,
            }),
            hasPendingTx: async () =>
                (await walletRepository.getWalletState())?.settings?.hasPendingTx,
        };
    };

    type DeferredRecovery = Awaited<ReturnType<typeof deferredRecovery>>;

    /** Both paths a new send can take to the operator. */
    const expectSendsRefused = async (h: DeferredRecovery) => {
        expect(h.wallet.hasDeferredPendingTxRecovery).toBe(true);
        await expect(h.broadcaster.submitTx("new-transaction", [])).rejects.toThrow(
            "recovery is required",
        );
        await expect(h.wallet.buildAndSubmitOffchainTx([], [])).rejects.toThrow(
            "recovery is required",
        );
        expect(h.submitTx).not.toHaveBeenCalled();
    };

    const expectSendsAllowed = async (h: DeferredRecovery) => {
        expect(h.wallet.hasDeferredPendingTxRecovery).toBe(false);
        await h.broadcaster.submitTx("new-transaction", []);
        expect(h.submitTx).toHaveBeenCalledWith("new-transaction", []);
    };

    it("unfences sends after a pass that found no proof input", async () => {
        const h = await deferredRecovery();

        await h.wallet.resumeDeferredPendingTxs(() => true);

        expect(h.getPendingTxs).not.toHaveBeenCalled();
        expect(await h.hasPendingTx()).toBe(true);
        await expectSendsAllowed(h);
    });

    it("unfences sends after a pass that could not finalize a discovered tx", async () => {
        const h = await deferredRecovery();
        h.getVtxos.mockResolvedValue({ vtxos: [h.own(1, { isSwept: true })] });
        h.getPendingTxs.mockResolvedValue([
            { arkTxid: "a".repeat(64), finalArkTx: "", signedCheckpointTxs: [] },
        ]);
        const logged = vi.spyOn(console, "error").mockImplementation(() => {});

        await h.wallet.resumeDeferredPendingTxs(() => true);

        expect(logged).toHaveBeenCalledWith(
            expect.stringContaining("Failed to finalize transaction"),
            expect.anything(),
        );
        expect(await h.hasPendingTx()).toBe(true);
        await expectSendsAllowed(h);
    });

    it("keeps sends fenced while the operator is unreachable, then unfences", async () => {
        const h = await deferredRecovery();
        h.getInfo.mockRejectedValueOnce(new ProviderUnavailableError("operator offline"));

        await expect(h.wallet.resumeDeferredPendingTxs(() => true)).rejects.toThrow(
            "operator offline",
        );

        expect(h.getVtxos).not.toHaveBeenCalled();
        await expectSendsRefused(h);
        // Recovery completes by finalizing, so that leg is never fenced.
        await h.broadcaster.finalizeTx("existing-transaction", []);
        expect(h.finalizeTx).toHaveBeenCalledWith("existing-transaction", []);

        await h.wallet.resumeDeferredPendingTxs(() => true);
        await expectSendsAllowed(h);
    });

    it("keeps sends fenced when the pass hits a retryable failure mid-flight", async () => {
        const h = await deferredRecovery();
        h.getVtxos.mockResolvedValue({ vtxos: [h.own(1, { isSwept: true })] });
        h.getPendingTxs.mockRejectedValueOnce(new ProviderUnavailableError("operator offline"));

        await expect(h.wallet.resumeDeferredPendingTxs(() => true)).rejects.toThrow(
            "operator offline",
        );

        expect(await h.hasPendingTx()).toBe(true);
        await expectSendsRefused(h);

        await h.wallet.resumeDeferredPendingTxs(() => true);
        await expectSendsAllowed(h);
    });

    it("unfences sends when the pass fails for a non-retryable reason", async () => {
        const h = await deferredRecovery();
        h.getVtxos.mockResolvedValue({ vtxos: [h.own(1, { isSwept: true })] });
        h.getPendingTxs.mockRejectedValue(new Error("pending lookup rejected"));

        await expect(h.wallet.resumeDeferredPendingTxs(() => true)).rejects.toThrow(
            "pending lookup rejected",
        );

        expect(await h.hasPendingTx()).toBe(true);
        await expectSendsAllowed(h);
    });

    it("keeps sends fenced when the operator reports another network", async () => {
        const h = await deferredRecovery();
        h.getInfo.mockResolvedValue({ ...h.liveInfo, network: "regtest" });

        await expect(h.wallet.resumeDeferredPendingTxs(() => true)).rejects.toThrow(
            "Operator network changed",
        );

        expect(h.getVtxos).not.toHaveBeenCalled();
        await expectSendsRefused(h);
    });

    it("keeps sends fenced when the operator's info is unusable, then unfences", async () => {
        const h = await deferredRecovery();
        h.getInfo.mockRejectedValueOnce(new Error("malformed operator info"));

        await expect(h.wallet.resumeDeferredPendingTxs(() => true)).rejects.toThrow(
            "malformed operator info",
        );

        expect(h.getVtxos).not.toHaveBeenCalled();
        await expectSendsRefused(h);

        await h.wallet.resumeDeferredPendingTxs(() => true);
        await expectSendsAllowed(h);
    });

    it("proves ownership with spent and swept outputs, never subdust or exited ones", async () => {
        const h = await deferredRecovery();
        const swept = h.own(1, { isSwept: true });
        const spent = h.own(2, { isSpent: true });
        const subdust = h.own(3, { value: Number(h.wallet.dustAmount) - 1 });
        const exited = h.own(4, { isUnrolled: true });
        h.getVtxos.mockResolvedValue({ vtxos: [swept, subdust, spent, exited] });
        const signOwnershipProof = vi.spyOn(h.wallet, "makeGetPendingTxIntentSignature");

        await h.wallet.resumeDeferredPendingTxs(() => true);

        expect(signOwnershipProof).toHaveBeenCalledWith([
            expect.objectContaining({ txid: swept.txid, isSwept: true }),
            expect.objectContaining({ txid: spent.txid, isSpent: true }),
        ]);
    });

    it("holds the recovery pass open until every proof batch has settled", async () => {
        const h = await deferredRecovery();
        h.getVtxos.mockResolvedValue({
            vtxos: Array.from({ length: MAX_INPUTS_PER_PROOF + 1 }, (_, i) =>
                h.own(i + 1, { isSwept: true }),
            ),
        });
        let release!: (txs: never[]) => void;
        const inFlight = new Promise<never[]>((resolve) => (release = resolve));
        let call = 0;
        h.getPendingTxs.mockImplementation(() => {
            call += 1;
            return call === 1
                ? Promise.reject(new ProviderUnavailableError("operator offline"))
                : inFlight;
        });

        let settled = false;
        const recovery = h.wallet
            .resumeDeferredPendingTxs(() => true)
            .catch(() => {
                settled = true;
            });

        // Failing fast would drop the tx lock with a sibling batch still signing, letting
        // the next tick finalize the same pending tx a second time.
        await vi.waitFor(() => expect(h.getPendingTxs.mock.calls.length).toBeGreaterThan(1));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(settled).toBe(false);

        release([]);
        await recovery;
        expect(settled).toBe(true);
        expect(h.wallet.hasDeferredPendingTxRecovery).toBe(true);
    });

    it("leaves the fence in place when its init generation went stale", async () => {
        const h = await deferredRecovery();
        h.getVtxos.mockResolvedValue({ vtxos: [h.own(1, { isSwept: true })] });
        let active = true;
        let finishLookup!: (pending: []) => void;
        h.getPendingTxs.mockImplementationOnce(
            () => new Promise((resolve) => (finishLookup = resolve)),
        );

        const staleRecovery = h.wallet.resumeDeferredPendingTxs(() => active);
        await vi.waitFor(() => expect(h.getPendingTxs).toHaveBeenCalledOnce());
        active = false;
        finishLookup([]);
        await staleRecovery;

        expect(await h.hasPendingTx()).toBe(true);
        expect(h.wallet.hasDeferredPendingTxRecovery).toBe(true);
    });

    it("unfences sends when a public recovery clears the flag", async () => {
        const h = await deferredRecovery();
        h.getVtxos.mockResolvedValue({ vtxos: [h.own(1, { isSpent: true })] });

        await h.wallet.finalizePendingTxs();

        expect(await h.hasPendingTx()).toBe(false);
        await expectSendsAllowed(h);
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

        await (await handle.wallet.getContractManager()).refreshVtxos({
            includeInactive: true,
        });

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
