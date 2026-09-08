import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { asset, ArkAddress, CSVMultisigTapscript, Transaction } from "@arkade-os/sdk";
import {
    encodeOffer,
    offerVtxoScript,
    OFFER_CONTRACT_KIND,
    OFFER_CONTRACT_LABEL,
    type Offer,
} from "../src/offer";
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

const spendPsbt = (offer: Offer, via: "cancel" | "fulfill", vout = 0) => {
    const leaf = offerVtxoScript(offer, SERVER_KEY).functionByName(via)!.tapLeafScript;
    const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
    tx.addInput({ txid: hex.decode(FUNDING_TXID), index: vout, tapLeafScript: [leaf] });
    tx.addOutput({ script: MAKER_PK_SCRIPT, amount: BigInt(9_000) });
    return { psbt: base64.encode(tx.toPSBT()), txid: tx.id };
};

/**
 * A wallet stub exposing only what the watcher reads: the contract manager's
 * event seam, and an address to recover the server key from. `emit` plays the
 * manager's part.
 */
const makeWallet = (getVirtualTxs: (txids: string[]) => Promise<{ txs: string[] }>) => {
    const callbacks = new Set<(event: any) => void>();
    // a real ark address, so ArkAddress.decode recovers SERVER_KEY from it
    const address = new ArkAddress(SERVER_KEY, key("66"), "tark").encode();
    // the row's watch state, as the manager would report it back: the last
    // write wins, and a script never written is watched (the default)
    const watchOf = new Map<string, string>();
    const setContractWatchState = vi.fn(async (script: string, watch: string) => {
        watchOf.set(script, watch);
    });
    // what the start-up sweep registers: `ensureOfferContracts` goes through
    // the real ArkadeContract.register, which lands here
    const createContract = vi.fn(async (params: Record<string, unknown>) => ({
        ...params,
        state: "active",
        createdAt: 0,
    }));
    const wallet = {
        getAddress: async () => address,
        getContractManager: async () => ({
            onContractEvent: (cb: (event: any) => void) => {
                callbacks.add(cb);
                return () => callbacks.delete(cb);
            },
            setContractWatchState,
            createContract,
            getContracts: async ({ script }: { script: string }) => [
                { script, watch: watchOf.get(script) ?? "watched" },
            ],
        }),
    } as any;
    return {
        wallet,
        getVirtualTxs,
        setContractWatchState,
        createContract,
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

/** What the start-up sweep reads off the server: the signer key the offers
 * above were built against, and a network to derive the row's address on. */
const serverInfo = () => ({
    signerPubkey: "02" + hex.encode(SERVER_KEY),
    checkpointTapscript: hex.encode(
        CSVMultisigTapscript.encode({
            timelock: { type: "blocks", value: 10n },
            pubkeys: [SERVER_KEY],
        }).script,
    ),
    network: "regtest",
    unilateralExitDelay: 4096n,
});

// the watcher builds its own RestIndexerProvider from arkServerUrl, and the
// start-up sweep its own RestArkProvider; intercept the calls they make rather
// than reaching through the constructors
type Harness = ReturnType<typeof makeWallet>;

const withIndexer = async (
    fetcher: (txids: string[]) => Promise<{ txs: string[] }>,
    run: (harness: Harness) => Promise<void>,
    hooks: {
        /** The server the sweep reads; sees the harness so it can emit mid-sweep. */
        info?: (harness: Harness) => Promise<Record<string, unknown>>;
        /** What the reconcile finds at the script; nothing indexed by default. */
        vtxos?: () => Promise<{ vtxos: Record<string, unknown>[] }>;
    } = {},
) => {
    const sdk = await import("@arkade-os/sdk");
    const harness = makeWallet(fetcher);
    const spy = vi
        .spyOn(sdk.RestIndexerProvider.prototype, "getVirtualTxs")
        .mockImplementation(fetcher as any);
    const vtxosSpy = vi
        .spyOn(sdk.RestIndexerProvider.prototype, "getVtxos")
        .mockImplementation((hooks.vtxos ?? (async () => ({ vtxos: [] }))) as any);
    const infoSpy = vi
        .spyOn(sdk.RestArkProvider.prototype, "getInfo")
        .mockImplementation((() => (hooks.info ?? (async () => serverInfo()))(harness)) as any);
    try {
        await run(harness);
    } finally {
        spy.mockRestore();
        vtxosSpy.mockRestore();
        infoSpy.mockRestore();
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
                // the start-up sweep's own "watched" write is not what these assert on
                setContractWatchState.mockClear();
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
                // the start-up sweep's own "watched" write is not what these assert on
                setContractWatchState.mockClear();
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
                // the start-up sweep's own "watched" write is not what these assert on
                setContractWatchState.mockClear();
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
                // the start-up sweep's own "watched" write is not what these assert on
                setContractWatchState.mockClear();
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
                // the start-up sweep's own "watched" write is not what these assert on
                setContractWatchState.mockClear();
                emit(spentEvent(offer, fill.txid));
                await watcher.idle();
                watcher.stop();

                expect(await getAssetSwaps(repository)).toMatchObject([{ status: "fulfilled" }]);
                expect(warn).toHaveBeenCalled();
            },
        );
        vi.restoreAllMocks();
    });

    it("registers the covenant of every live record at start, and of no settled one", async () => {
        // The restored-wallet case: records are back, their deposits are on
        // chain, and nothing has told the wallet the scripts are its own. The
        // watcher hears only registered scripts, so it registers what it is
        // asked to watch — the same row createOffer writes, escrow marker and
        // all — and leaves the settled records alone.
        const pending = makeOffer("want-asset");
        const stuck: Offer = { ...pending, wantAmount: BigInt(993) };
        stuck.swapPkScript = offerVtxoScript(stuck, SERVER_KEY).pkScript;
        const done: Offer = { ...pending, wantAmount: BigInt(994) };
        done.swapPkScript = offerVtxoScript(done, SERVER_KEY).pkScript;
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(pending));
        await addAssetSwap(
            repository,
            swapFor(stuck, {
                id: "cd".repeat(32),
                fundingTxid: "cd".repeat(32),
                status: "cancelling",
            }),
        );
        await addAssetSwap(
            repository,
            swapFor(done, {
                id: "ef".repeat(32),
                fundingTxid: "ef".repeat(32),
                status: "fulfilled",
            }),
        );

        await withIndexer(
            async () => ({ txs: [] }),
            async ({ wallet, createContract, setContractWatchState }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                watcher.stop();

                const registered = createContract.mock.calls.map(([row]) => row);
                expect(registered.map((row) => row.script).sort()).toEqual(
                    [hex.encode(pending.swapPkScript), hex.encode(stuck.swapPkScript)].sort(),
                );
                for (const row of registered) {
                    expect(row.type).toBe("arkade");
                    expect(row.label).toBe(OFFER_CONTRACT_LABEL);
                    expect(row.metadata).toEqual({
                        genericallySpendable: false,
                        kind: OFFER_CONTRACT_KIND,
                    });
                }
                // watched, without the issuance mark: a fill can retire it
                expect(setContractWatchState.mock.calls.sort()).toEqual(
                    [
                        [hex.encode(pending.swapPkScript), "watched"],
                        [hex.encode(stuck.swapPkScript), "watched"],
                    ].sort(),
                );
            },
        );
    });

    it("still resolves a fill after the fill retires a script the sweep covered", async () => {
        // the mark `createOffer` sets would pin the script watched here; the
        // sweep sets none, so the spend event's retire goes through
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

                expect(await getAssetSwaps(repository)).toMatchObject([{ status: "fulfilled" }]);
                expect(setContractWatchState.mock.calls).toEqual([
                    [hex.encode(offer.swapPkScript), "watched"],
                    [hex.encode(offer.swapPkScript), "retained"],
                ]);
            },
        );
    });

    it("starts, and keeps classifying, when the sweep cannot reach the server", async () => {
        // best effort: an offline server at start costs coverage of restored
        // records until the next start, never the watcher itself
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        await withIndexer(
            async () => ({ txs: [fill.psbt] }),
            async ({ wallet, emit, createContract }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                expect(createContract).not.toHaveBeenCalled();
                expect(warn).toHaveBeenCalledWith(
                    expect.stringContaining("could not re-register"),
                    expect.anything(),
                );
                emit(spentEvent(offer, fill.txid));
                await watcher.idle();
                watcher.stop();

                expect(await getAssetSwaps(repository)).toMatchObject([{ status: "fulfilled" }]);
            },
            {
                info: async () => {
                    throw new Error("server down");
                },
            },
        );
        vi.restoreAllMocks();
    });

    it("resolves a deposit spent before the sweep covered it, off the indexer", async () => {
        // The event this record will never get: the fill landed while the
        // script was uncovered (the wallet was restored, then closed), so the
        // manager hydrates the deposit already spent and no vtxo_spent fires.
        // The sweep reads the deposit's fate once and classifies it as an
        // event would — the fill leaf — then retires the settled script.
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));
        const updates: AssetSwap[] = [];

        await withIndexer(
            async () => ({ txs: [fill.psbt] }),
            async ({ wallet, setContractWatchState }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                    onUpdate: (swap) => updates.push(swap),
                });
                await watcher.idle();
                watcher.stop();

                expect(await getAssetSwaps(repository)).toMatchObject([
                    { status: "fulfilled", spentTxid: fill.txid },
                ]);
                expect(updates.map((u) => u.status)).toEqual(["fulfilled"]);
                expect(setContractWatchState.mock.calls).toEqual([
                    [hex.encode(offer.swapPkScript), "watched"],
                    [hex.encode(offer.swapPkScript), "retained"],
                ]);
            },
            {
                vtxos: async () => ({
                    vtxos: [
                        {
                            txid: FUNDING_TXID,
                            vout: 0,
                            script: hex.encode(offer.swapPkScript),
                            virtualStatus: { state: "spent" },
                            arkTxId: fill.txid,
                        },
                    ],
                }),
            },
        );
    });

    it("marks a deposit swept before the sweep covered it recoverable, and keeps its script", async () => {
        const offer = makeOffer();
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));

        await withIndexer(
            async () => ({ txs: [] }),
            async ({ wallet, setContractWatchState }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                await watcher.idle();
                watcher.stop();

                expect(await getAssetSwaps(repository)).toMatchObject([{ status: "recoverable" }]);
                // swept money is still the user's money at that script
                expect(setContractWatchState.mock.calls).toEqual([
                    [hex.encode(offer.swapPkScript), "watched"],
                ]);
            },
            {
                vtxos: async () => ({
                    vtxos: [
                        {
                            txid: FUNDING_TXID,
                            vout: 0,
                            script: hex.encode(offer.swapPkScript),
                            virtualStatus: { state: "swept" },
                        },
                    ],
                }),
            },
        );
    });

    it("leaves a covered deposit that is still unspent pending", async () => {
        const offer = makeOffer();
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));

        await withIndexer(
            async () => ({ txs: [] }),
            async ({ wallet, setContractWatchState }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                await watcher.idle();
                watcher.stop();

                expect(await getAssetSwaps(repository)).toMatchObject([{ status: "pending" }]);
                expect(setContractWatchState.mock.calls).toEqual([
                    [hex.encode(offer.swapPkScript), "watched"],
                ]);
            },
            {
                vtxos: async () => ({
                    vtxos: [
                        {
                            txid: FUNDING_TXID,
                            vout: 0,
                            script: hex.encode(offer.swapPkScript),
                            virtualStatus: { state: "settled" },
                        },
                    ],
                }),
            },
        );
    });

    it("retires a script whose fill landed mid-sweep, after the sweep re-watched it", async () => {
        // The race: the sweep read its records (pending), a spend event lands
        // and retires the script while the sweep is still talking to the
        // server, then the sweep's own "watched" write comes last. Nothing
        // would ever retire it again, so the sweep re-derives liveness for
        // the scripts it touched once it is done.
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));

        await withIndexer(
            async () => ({ txs: [fill.psbt] }),
            async ({ wallet, setContractWatchState }) => {
                const watcher = await watchOfferSwaps({
                    wallet,
                    arkServerUrl: "http://ark",
                    repository,
                });
                await watcher.idle();
                watcher.stop();

                expect(await getAssetSwaps(repository)).toMatchObject([{ status: "fulfilled" }]);
                const script = hex.encode(offer.swapPkScript);
                // the sweep's cover is what re-watched the script, outracing
                // the mid-sweep fill's retire; the sweep's own liveness
                // re-derive has the last word: "retained" again
                const calls = setContractWatchState.mock.calls;
                const firstWatched = calls.findIndex((c) => c[1] === "watched");
                const firstRetained = calls.findIndex((c) => c[1] === "retained");
                expect(firstWatched).toBeGreaterThanOrEqual(0);
                expect(firstRetained).toBeGreaterThan(firstWatched);
                expect(calls[calls.length - 1]).toEqual([script, "retained"]);
            },
            {
                // the event arrives while the sweep is reading the server
                info: async ({ emit }) => {
                    emit(spentEvent(offer, fill.txid));
                    return serverInfo();
                },
            },
        );
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
