import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { asset, ArkAddress, Transaction } from "@arkade-os/sdk";
import { encodeOffer, offerVtxoScript, OFFER_CONTRACT_KIND, type Offer } from "../src/offer";
import { InMemoryAssetSwapRepository } from "../src/repository";
import { addAssetSwap, getAssetSwaps, type AssetSwap } from "../src/store";
import { retireSettledOfferContracts } from "../src/coverage";
import { spendUpdate, watchOfferSwaps } from "../src/watch";

const ASSET_ID = "f1".repeat(34);

const key = (seed: string) => schnorr.getPublicKey(hex.decode(seed.repeat(32)));
const SERVER_KEY = key("11");
const MAKER_KEY = key("22");
const EMULATOR_KEY = key("33");
const MAKER_PK_SCRIPT = new Uint8Array([0x51, 0x20, ...key("55")]);
const FUNDING_TXID = "ab".repeat(32);

const makeOffer = (side: "want-asset" | "want-btc" = "want-asset"): Offer => {
    const binding: Omit<Offer, "swapPkScript"> = {
        wantAmount: BigInt(992),
        ...(side === "want-asset"
            ? { wantAsset: asset.AssetId.fromString(ASSET_ID) }
            : { offerAsset: asset.AssetId.fromString(ASSET_ID) }),
        makerPkScript: MAKER_PK_SCRIPT,
        makerPublicKey: MAKER_KEY,
        emulatorPubkey: EMULATOR_KEY,
    };
    return { ...binding, swapPkScript: offerVtxoScript(binding, SERVER_KEY).pkScript };
};

const swapFor = (offer: Offer, overrides: Partial<AssetSwap> = {}): AssetSwap => ({
    id: FUNDING_TXID,
    fromAsset: "btc",
    toAsset: ASSET_ID,
    fromAmount: "10000",
    toAmount: "992",
    swapAddress: "",
    swapPkScript: hex.encode(offer.swapPkScript),
    offerHex: hex.encode(encodeOffer(offer)),
    fundingTxid: FUNDING_TXID,
    status: "pending",
    createdAt: 1_700_000_000_000,
    ...overrides,
});

const spendPsbt = (
    offer: Offer,
    via: "cancel" | "fulfill",
    vout = 0,
    fundingTxid = FUNDING_TXID,
) => {
    const leaf = offerVtxoScript(offer, SERVER_KEY).functionByName(via)!.tapLeafScript;
    const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
    tx.addInput({ txid: hex.decode(fundingTxid), index: vout, tapLeafScript: [leaf] });
    tx.addOutput({ script: MAKER_PK_SCRIPT, amount: BigInt(9_000) });
    return { psbt: base64.encode(tx.toPSBT()), txid: tx.id };
};

/**
 * A wallet stub exposing only what the watcher reads: the contract manager's
 * event seam, and an address to recover the server key from. `emit` plays the
 * manager's part.
 */
const makeWallet = (
    getVirtualTxs: (txids: string[]) => Promise<{ txs: string[] }>,
    contracts: any[] = [],
) => {
    const callbacks = new Set<(event: any) => void>();
    // a real ark address, so ArkAddress.decode recovers SERVER_KEY from it
    const address = new ArkAddress(SERVER_KEY, key("66"), "tark").encode();
    const setContractWatchState = vi.fn(async (_script: string, _watch: string) => {});
    const order: string[] = [];
    const getContractsWithVtxos = vi.fn(async (filter?: any) => {
        order.push("getContractsWithVtxos");
        const scripts = filter?.script;
        if (!scripts) return contracts;
        return contracts.filter((c) => scripts.includes(c.contract.script));
    });
    const wallet = {
        getAddress: async () => address,
        getContractManager: async () => ({
            onContractEvent: (cb: (event: any) => void) => {
                order.push("onContractEvent");
                callbacks.add(cb);
                return () => callbacks.delete(cb);
            },
            setContractWatchState,
            getContractsWithVtxos,
        }),
    } as any;
    return {
        wallet,
        getVirtualTxs,
        setContractWatchState,
        getContractsWithVtxos,
        order,
        emit: (event: any) => callbacks.forEach((cb) => cb(event)),
        listeners: () => callbacks.size,
    };
};

const spentEvent = (offer: Offer, spentTxid: string, overrides: Record<string, unknown> = {}) => ({
    type: "vtxo_spent",
    contractScript: hex.encode(offer.swapPkScript),
    contract: { metadata: { kind: OFFER_CONTRACT_KIND }, ...(overrides.contract as object) },
    vtxos: [{ txid: FUNDING_TXID, vout: 0, arkTxId: spentTxid }],
    timestamp: 1_700_000_100_000,
    ...overrides,
});

/** A contract row as the manager's own view returns it, deposit already spent —
 * what the start-up pass reads when no live event ever arrived. */
const spentDeposit = (offer: Offer, spentTxid: string, vtxo: Record<string, unknown> = {}) => ({
    contract: {
        script: hex.encode(offer.swapPkScript),
        metadata: { kind: OFFER_CONTRACT_KIND },
    },
    vtxos: [{ txid: FUNDING_TXID, vout: 0, isSpent: true, arkTxId: spentTxid, ...vtxo }],
});

const spentDeposits = (
    offer: Offer,
    deposits: { txid: string; vout: number; spentTxid: string }[],
) => ({
    contract: {
        script: hex.encode(offer.swapPkScript),
        metadata: { kind: OFFER_CONTRACT_KIND },
    },
    vtxos: deposits.map((d) => ({
        txid: d.txid,
        vout: d.vout,
        isSpent: true,
        arkTxId: d.spentTxid,
    })),
});

/** Answers only for spends the test built: a wrong txid reads as indeterminate
 * rather than reusing another deposit's transaction. */
const psbtsByTxid = (spends: { psbt: string; txid: string }[]) => {
    const byTxid = new Map(spends.map((s) => [s.txid, s.psbt]));
    return async (txids: string[]) => ({
        txs: txids.flatMap((t) => (byTxid.has(t) ? [byTxid.get(t)!] : [])),
    });
};

// the watcher builds its own RestIndexerProvider from arkServerUrl; intercept
// the one call it makes rather than reaching through the constructor
const withIndexer = async (
    fetcher: (txids: string[]) => Promise<{ txs: string[] }>,
    run: (harness: ReturnType<typeof makeWallet>) => Promise<void>,
    contracts: any[] = [],
) => {
    const sdk = await import("@arkade-os/sdk");
    const spy = vi
        .spyOn(sdk.RestIndexerProvider.prototype, "getVirtualTxs")
        .mockImplementation(fetcher as any);
    try {
        await run(makeWallet(fetcher, contracts));
    } finally {
        spy.mockRestore();
    }
};

describe("spendUpdate", () => {
    const offer = makeOffer();

    it("resolves a classified spend and ignores one nobody could classify", () => {
        const swap = swapFor(offer);
        expect(spendUpdate(swap, { txid: "f".repeat(64), kind: "cancelled" })).toMatchObject({
            status: "cancelled",
            spentTxid: "f".repeat(64),
        });
        expect(
            spendUpdate(swap, { txid: "f".repeat(64), kind: "fulfilled", at: 42 }),
        ).toMatchObject({ status: "fulfilled", completedAt: 42 });
        // no answer, no write: the restore scan decides it later
        expect(spendUpdate(swap, { txid: "f".repeat(64), kind: "indeterminate" })).toBeUndefined();
    });

    it("leaves an already-resolved swap alone, so a re-delivered event is a no-op", () => {
        for (const status of ["fulfilled", "cancelled", "recoverable"] as const) {
            const resolved = swapFor(offer, { status, spentTxid: "aa".repeat(32) });
            expect(
                spendUpdate(resolved, { txid: "bb".repeat(32), kind: "fulfilled" }),
            ).toBeUndefined();
        }
    });

    it("records a completion time for a fill but not for a cancel", () => {
        const swap = swapFor(offer);
        expect(spendUpdate(swap, { txid: "f".repeat(64), kind: "cancelled", at: 42 })).not.toEqual(
            expect.objectContaining({ completedAt: expect.anything() }),
        );
    });
});

describe("watchOfferSwaps", () => {
    it("marks a swap fulfilled when a spend takes the fulfill leaf", async () => {
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));

        await withIndexer(
            async () => ({ txs: [fill.psbt] }),
            async ({ wallet, emit }) => {
                const updates: AssetSwap[] = [];
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                    onUpdate: (swap) => updates.push(swap),
                });

                emit(spentEvent(offer, fill.txid));
                await watcher.idle();
                watcher.stop();

                expect(await getAssetSwaps(repository)).toMatchObject([
                    { status: "fulfilled", spentTxid: fill.txid, completedAt: 1_700_000_100_000 },
                ]);
                expect(updates).toMatchObject([{ status: "fulfilled" }]);
            },
        );
    });

    it("marks a cancel made elsewhere as cancelled, by its leaf", async () => {
        // the multi-device case: this store never recorded the cancel, so the
        // exact classifier has nothing to match and the leaf answers instead
        const offer = makeOffer("want-btc");
        const cancel = spendPsbt(offer, "cancel");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer, { fromAsset: ASSET_ID, toAsset: "btc" }));

        await withIndexer(
            async () => ({ txs: [cancel.psbt] }),
            async ({ wallet, emit }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                emit(spentEvent(offer, cancel.txid));
                await watcher.idle();
                watcher.stop();

                expect(await getAssetSwaps(repository)).toMatchObject([{ status: "cancelled" }]);
            },
        );
    });

    it("takes our own recorded cancel without reading the spending tx", async () => {
        const offer = makeOffer();
        const repository = new InMemoryAssetSwapRepository();
        const cancelTxid = "cc".repeat(32);
        await addAssetSwap(
            repository,
            swapFor(offer, { status: "cancelling", spentTxid: cancelTxid }),
        );

        const fetcher = vi.fn(async () => ({ txs: [] as string[] }));
        await withIndexer(fetcher, async ({ wallet, emit }) => {
            const watcher = await watchOfferSwaps({
                wallet,
                arkServerUrl: "http://ark",
                repository,
            });
            emit(spentEvent(offer, cancelTxid));
            await watcher.idle();
            watcher.stop();

            expect(await getAssetSwaps(repository)).toMatchObject([{ status: "cancelled" }]);
            // the whole point of the record: no indexer round trip
            expect(fetcher).not.toHaveBeenCalled();
        });
    });

    it("writes nothing when the spending tx cannot be read", async () => {
        // the indexer lags a freshly submitted ark tx. Persisting a guess here
        // is what made a wrong label permanent — later scans skip stored swaps
        const offer = makeOffer();
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));

        await withIndexer(
            async () => ({ txs: [] }),
            async ({ wallet, emit }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                emit(spentEvent(offer, "dd".repeat(32)));
                await watcher.idle();
                watcher.stop();

                expect(await getAssetSwaps(repository)).toMatchObject([{ status: "pending" }]);
            },
        );
    });

    it("ignores events for contracts that are not offer covenants", async () => {
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));

        await withIndexer(
            async () => ({ txs: [fill.psbt] }),
            async ({ wallet, emit }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                emit(spentEvent(offer, fill.txid, { contract: { metadata: { kind: "other" } } }));
                emit({ type: "vtxo_received", contractScript: "", vtxos: [], contract: {} });
                await watcher.idle();
                watcher.stop();

                expect(await getAssetSwaps(repository)).toMatchObject([{ status: "pending" }]);
            },
        );
    });

    it("does not notify a change the store refused", async () => {
        // `onUpdate` is documented as following a persisted change. Firing it
        // on a lost write puts a consumer that caches from it ahead of the
        // store, and marks a swap terminal that reads `pending` after reload.
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(repository, "saveSwap").mockRejectedValue(new Error("quota exceeded"));

        await withIndexer(
            async () => ({ txs: [fill.psbt] }),
            async ({ wallet, emit }) => {
                const updates: AssetSwap[] = [];
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                    onUpdate: (swap) => updates.push(swap),
                });

                emit(spentEvent(offer, fill.txid));
                await watcher.idle();
                watcher.stop();

                expect(updates).toEqual([]);
                expect(warn).toHaveBeenCalled();
            },
        );
        vi.restoreAllMocks();
    });

    it("retires the contract when the fill leaves no live record at the script", async () => {
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));

        await withIndexer(
            async () => ({ txs: [fill.psbt] }),
            async ({ wallet, emit, setContractWatchState }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                emit(spentEvent(offer, fill.txid));
                await watcher.idle();
                watcher.stop();

                expect(setContractWatchState).toHaveBeenCalledWith(
                    hex.encode(offer.swapPkScript),
                    "retained",
                );
            },
        );
    });

    it("keeps watching while another deposit at the same script is still live", async () => {
        // identical offers share one script and are told apart by their
        // funding txid: retiring on one fill would unwatch the other's deposit
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));
        await addAssetSwap(
            repository,
            swapFor(offer, { id: "ee".repeat(32), fundingTxid: "ee".repeat(32) }),
        );

        await withIndexer(
            async () => ({ txs: [fill.psbt] }),
            async ({ wallet, emit, setContractWatchState }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                emit(spentEvent(offer, fill.txid));
                await watcher.idle();
                watcher.stop();

                expect(setContractWatchState).not.toHaveBeenCalled();
            },
        );
    });

    it("keeps watching when the sibling deposit was swept", async () => {
        // `recoverable` is terminal for a spend but the funds are still the
        // maker's at that script: reading liveness off TERMINAL unwatches them
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));
        await addAssetSwap(
            repository,
            swapFor(offer, {
                id: "ee".repeat(32),
                fundingTxid: "ee".repeat(32),
                status: "recoverable",
            }),
        );

        await withIndexer(
            async () => ({ txs: [fill.psbt] }),
            async ({ wallet, emit, setContractWatchState }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                emit(spentEvent(offer, fill.txid));
                await watcher.idle();
                watcher.stop();

                expect(setContractWatchState).not.toHaveBeenCalled();
            },
        );
    });

    it("does not retire a change the store refused", async () => {
        // the record still reads `pending` to the next restore scan, so
        // unwatching it here would strand a deposit the scan still tracks
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(repository, "saveSwap").mockRejectedValue(new Error("quota exceeded"));

        await withIndexer(
            async () => ({ txs: [fill.psbt] }),
            async ({ wallet, emit, setContractWatchState }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                emit(spentEvent(offer, fill.txid));
                await watcher.idle();
                watcher.stop();

                expect(setContractWatchState).not.toHaveBeenCalled();
            },
        );
        vi.restoreAllMocks();
    });

    it("keeps the status write when the retire fails", async () => {
        // best-effort: a failed retire costs polling, never correctness
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await withIndexer(
            async () => ({ txs: [fill.psbt] }),
            async ({ wallet, emit, setContractWatchState }) => {
                setContractWatchState.mockRejectedValue(new Error("repository unavailable"));
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                emit(spentEvent(offer, fill.txid));
                await watcher.idle();
                watcher.stop();

                expect(await getAssetSwaps(repository)).toMatchObject([{ status: "fulfilled" }]);
                expect(warn).toHaveBeenCalled();
            },
        );
        vi.restoreAllMocks();
    });

    it("stops delivering after stop()", async () => {
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));

        await withIndexer(
            async () => ({ txs: [fill.psbt] }),
            async ({ wallet, emit, listeners }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                watcher.stop();
                expect(listeners()).toBe(0);

                emit(spentEvent(offer, fill.txid));
                await watcher.idle();
                expect(await getAssetSwaps(repository)).toMatchObject([{ status: "pending" }]);
            },
        );
    });

    describe("start-up pass", () => {
        it("resolves a spend that landed while nothing was subscribed", async () => {
            // the wallet was closed when the solver filled the offer: the boot
            // sync wrote the spend before any subscriber existed, and nothing
            // replays it. Without a pass the record is pending forever.
            const offer = makeOffer();
            const fill = spendPsbt(offer, "fulfill");
            const repository = new InMemoryAssetSwapRepository();
            await addAssetSwap(repository, swapFor(offer));

            await withIndexer(
                async () => ({ txs: [fill.psbt] }),
                async ({ wallet }) => {
                    const watcher = await watchOfferSwaps({
                        wallet,
                        arkServerUrl: "http://ark",
                        repository,
                    });
                    await watcher.idle();
                    watcher.stop();

                    expect(await getAssetSwaps(repository)).toMatchObject([
                        { status: "fulfilled", spentTxid: fill.txid },
                    ]);
                },
                [spentDeposit(offer, fill.txid)],
            );
        });

        it("subscribes before it reads, so a spend landing mid-pass is not lost", async () => {
            const offer = makeOffer();
            const repository = new InMemoryAssetSwapRepository();
            await addAssetSwap(repository, swapFor(offer));

            await withIndexer(
                async () => ({ txs: [] }),
                async ({ wallet, order }) => {
                    const watcher = await watchOfferSwaps({
                        wallet,
                        arkServerUrl: "http://ark",
                        repository,
                    });
                    await watcher.idle();
                    watcher.stop();

                    expect(order).toEqual(["onContractEvent", "getContractsWithVtxos"]);
                },
                [],
            );
        });

        it("asks only about scripts a live record still holds", async () => {
            const open = makeOffer();
            const settled = makeOffer("want-btc");
            const repository = new InMemoryAssetSwapRepository();
            await addAssetSwap(repository, swapFor(open));
            await addAssetSwap(
                repository,
                swapFor(settled, {
                    id: "ee".repeat(32),
                    fundingTxid: "ee".repeat(32),
                    status: "fulfilled",
                }),
            );

            await withIndexer(
                async () => ({ txs: [] }),
                async ({ wallet, getContractsWithVtxos }) => {
                    const watcher = await watchOfferSwaps({
                        wallet,
                        arkServerUrl: "http://ark",
                        repository,
                    });
                    await watcher.idle();
                    watcher.stop();

                    expect(getContractsWithVtxos).toHaveBeenCalledWith({
                        script: [hex.encode(open.swapPkScript)],
                    });
                },
                [],
            );
        });

        it("reads history once for the pass, not once per deposit", async () => {
            const offer = makeOffer();
            const funding = ["c1", "c2", "c3"].map((b) => b.repeat(32));
            const spends = funding.map((txid, i) => spendPsbt(offer, "fulfill", i, txid));
            const repository = new InMemoryAssetSwapRepository();
            for (const txid of funding) {
                await addAssetSwap(repository, swapFor(offer, { id: txid, fundingTxid: txid }));
            }
            const reads = vi.spyOn(repository, "getAllSwaps");

            await withIndexer(
                psbtsByTxid(spends),
                async ({ wallet }) => {
                    reads.mockClear();
                    const watcher = await watchOfferSwaps({
                        wallet,
                        arkServerUrl: "http://ark",
                        repository,
                    });
                    await watcher.idle();
                    watcher.stop();
                    const duringPass = reads.mock.calls.length;

                    const after = await getAssetSwaps(repository);
                    expect(after.filter((s) => s.status === "fulfilled")).toHaveLength(
                        funding.length,
                    );
                    // one read to open the pass, then one inside each write it
                    // makes; a per-deposit lookup adds a third for every deposit
                    expect(duringPass).toBe(1 + funding.length);
                },
                [
                    spentDeposits(
                        offer,
                        funding.map((txid, i) => ({ txid, vout: i, spentTxid: spends[i].txid })),
                    ),
                ],
            );
        });

        it("sees its own write, so two deposits of one funding tx resolve once", async () => {
            // the aliasing case a hoisted read breaks: both lookups hit one record
            const offer = makeOffer();
            const first = spendPsbt(offer, "fulfill", 0);
            const second = spendPsbt(offer, "fulfill", 1);
            const repository = new InMemoryAssetSwapRepository();
            await addAssetSwap(repository, swapFor(offer));

            await withIndexer(
                psbtsByTxid([first, second]),
                async ({ wallet }) => {
                    const updates: AssetSwap[] = [];
                    const watcher = await watchOfferSwaps({
                        wallet,
                        arkServerUrl: "http://ark",
                        repository,
                        onUpdate: (swap) => updates.push(swap),
                    });
                    await watcher.idle();
                    watcher.stop();

                    expect(updates).toHaveLength(1);
                    expect(await getAssetSwaps(repository)).toMatchObject([
                        { status: "fulfilled", spentTxid: first.txid },
                    ]);
                },
                [
                    spentDeposits(offer, [
                        { txid: FUNDING_TXID, vout: 0, spentTxid: first.txid },
                        { txid: FUNDING_TXID, vout: 1, spentTxid: second.txid },
                    ]),
                ],
            );
        });

        it("leaves a contract that is not an offer covenant alone", async () => {
            const offer = makeOffer();
            const fill = spendPsbt(offer, "fulfill");
            const repository = new InMemoryAssetSwapRepository();
            await addAssetSwap(repository, swapFor(offer));
            const row = spentDeposit(offer, fill.txid);
            row.contract.metadata = { kind: "other" };

            await withIndexer(
                async () => ({ txs: [fill.psbt] }),
                async ({ wallet }) => {
                    const watcher = await watchOfferSwaps({
                        wallet,
                        arkServerUrl: "http://ark",
                        repository,
                    });
                    await watcher.idle();
                    watcher.stop();

                    expect(await getAssetSwaps(repository)).toMatchObject([{ status: "pending" }]);
                },
                [row],
            );
        });
    });
});

describe("retireSettledOfferContracts", () => {
    // the batch path: a consumer that applies restore results without running
    // the watcher retires with one call rather than a re-implementation
    const btcOffer = makeOffer();
    const assetOffer = makeOffer("want-btc");
    const btcScript = hex.encode(btcOffer.swapPkScript);
    const assetScript = hex.encode(assetOffer.swapPkScript);
    const manager = () => ({
        setContractWatchState: vi.fn(async (_script: string, _watch: string) => {}),
    });

    it("retires each settled script once and leaves the others watched", async () => {
        const { setContractWatchState } = manager();
        await retireSettledOfferContracts({ setContractWatchState }, [
            swapFor(btcOffer, { status: "fulfilled" }),
            swapFor(btcOffer, { id: "ee".repeat(32), status: "cancelled" }),
            swapFor(assetOffer, { id: "ff".repeat(32), status: "pending" }),
        ]);

        expect(setContractWatchState.mock.calls).toEqual([[btcScript, "retained"]]);
        expect(setContractWatchState).not.toHaveBeenCalledWith(assetScript, "retained");
    });

    it("never retires a script with a swept deposit at it", async () => {
        const { setContractWatchState } = manager();
        await retireSettledOfferContracts({ setContractWatchState }, [
            swapFor(btcOffer, { status: "recoverable" }),
            swapFor(assetOffer, { id: "ee".repeat(32), status: "recoverable" }),
            swapFor(assetOffer, { id: "ff".repeat(32), status: "fulfilled" }),
        ]);

        // neither on its own account, nor as a sibling of a fill
        expect(setContractWatchState).not.toHaveBeenCalled();
    });
});
