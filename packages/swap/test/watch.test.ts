import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { asset, ArkAddress, Transaction } from "@arkade-os/sdk";
import { encodeOffer, offerContract, OFFER_CONTRACT_KIND, type Offer } from "../src/offer";
import { InMemoryAssetSwapRepository } from "../src/repository";
import { addAssetSwap, getAssetSwaps, type AssetSwap } from "../src/store";
import { retireSettledOfferContracts } from "../src/coverage";
import { spendUpdate, watchOfferSwaps } from "../src/watch";

const ASSET_ID = "f1".repeat(34);

const key = (seed: string) => schnorr.getPublicKey(hex.decode(seed.repeat(32)));
const OPERATOR_KEY = key("11");
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
    return { ...binding, swapPkScript: offerContract(binding, OPERATOR_KEY).pkScript };
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
    const leaf = offerContract(offer, OPERATOR_KEY).functionByName(via)!.tapLeafScript;
    const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
    tx.addInput({ txid: hex.decode(FUNDING_TXID), index: vout, tapLeafScript: [leaf] });
    tx.addOutput({ script: MAKER_PK_SCRIPT, amount: BigInt(9_000) });
    return { psbt: base64.encode(tx.toPSBT()), txid: tx.id };
};

/**
 * A wallet stub exposing only what the watcher reads: the contract manager's
 * event seam, an address to recover the server key from, and the arkade
 * reader that serves spending-tx lookups. `emit` plays the manager's part.
 */
const makeWallet = (getVirtualTxs: (txids: string[]) => Promise<{ txs: string[] }>) => {
    const callbacks = new Set<(event: any) => void>();
    // a real ark address, so ArkAddress.decode recovers OPERATOR_KEY from it
    const address = new ArkAddress(OPERATOR_KEY, key("66"), "tark").encode();
    const setContractWatchState = vi.fn(async (_script: string, _watch: string) => {});
    const wallet = {
        getAddress: async () => address,
        getContractManager: async () => ({
            onContractEvent: (cb: (event: any) => void) => {
                callbacks.add(cb);
                return () => callbacks.delete(cb);
            },
            setContractWatchState,
        }),
        // the watcher reads spending txs through this seam, so the fetcher
        // rides the stub wallet — no prototype spy on `RestIndexerProvider`,
        // which is exactly the indirection the seam removes
        getArkadeReader: async () => ({ getVirtualTxs }),
    } as any;
    return {
        wallet,
        setContractWatchState,
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

        const { wallet, emit } = makeWallet(async () => ({ txs: [fill.psbt] }));
        const updates: AssetSwap[] = [];
        const watcher = await watchOfferSwaps({
            wallet,
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
    });

    it("marks a cancel made elsewhere as cancelled, by its leaf", async () => {
        // the multi-device case: this store never recorded the cancel, so the
        // exact classifier has nothing to match and the leaf answers instead
        const offer = makeOffer("want-btc");
        const cancel = spendPsbt(offer, "cancel");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer, { fromAsset: ASSET_ID, toAsset: "btc" }));

        const { wallet, emit } = makeWallet(async () => ({ txs: [cancel.psbt] }));
        const watcher = await watchOfferSwaps({
            wallet,
            repository,
        });
        emit(spentEvent(offer, cancel.txid));
        await watcher.idle();
        watcher.stop();

        expect(await getAssetSwaps(repository)).toMatchObject([{ status: "cancelled" }]);
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
        const { wallet, emit } = makeWallet(fetcher);
        const watcher = await watchOfferSwaps({ wallet, repository });
        emit(spentEvent(offer, cancelTxid));
        await watcher.idle();
        watcher.stop();

        expect(await getAssetSwaps(repository)).toMatchObject([{ status: "cancelled" }]);
        // the whole point of the record: no indexer round trip
        expect(fetcher).not.toHaveBeenCalled();
    });

    it("writes nothing when the spending tx cannot be read", async () => {
        // the indexer lags a freshly submitted ark tx. Persisting a guess here
        // is what made a wrong label permanent — later scans skip stored swaps
        const offer = makeOffer();
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));

        const { wallet, emit } = makeWallet(async () => ({ txs: [] }));
        const watcher = await watchOfferSwaps({
            wallet,
            repository,
        });
        emit(spentEvent(offer, "dd".repeat(32)));
        await watcher.idle();
        watcher.stop();

        expect(await getAssetSwaps(repository)).toMatchObject([{ status: "pending" }]);
    });

    it("ignores events for contracts that are not offer covenants", async () => {
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));

        const { wallet, emit } = makeWallet(async () => ({ txs: [fill.psbt] }));
        const watcher = await watchOfferSwaps({
            wallet,
            repository,
        });
        emit(spentEvent(offer, fill.txid, { contract: { metadata: { kind: "other" } } }));
        emit({ type: "vtxo_received", contractScript: "", vtxos: [], contract: {} });
        await watcher.idle();
        watcher.stop();

        expect(await getAssetSwaps(repository)).toMatchObject([{ status: "pending" }]);
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

        const { wallet, emit } = makeWallet(async () => ({ txs: [fill.psbt] }));
        const updates: AssetSwap[] = [];
        const watcher = await watchOfferSwaps({
            wallet,
            repository,
            onUpdate: (swap) => updates.push(swap),
        });

        emit(spentEvent(offer, fill.txid));
        await watcher.idle();
        watcher.stop();

        expect(updates).toEqual([]);
        expect(warn).toHaveBeenCalled();
        vi.restoreAllMocks();
    });

    it("retires the contract when the fill leaves no live record at the script", async () => {
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));

        const { wallet, emit, setContractWatchState } = makeWallet(async () => ({
            txs: [fill.psbt],
        }));
        const watcher = await watchOfferSwaps({
            wallet,
            repository,
        });
        emit(spentEvent(offer, fill.txid));
        await watcher.idle();
        watcher.stop();

        expect(setContractWatchState).toHaveBeenCalledWith(
            hex.encode(offer.swapPkScript),
            "retained",
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

        const { wallet, emit, setContractWatchState } = makeWallet(async () => ({
            txs: [fill.psbt],
        }));
        const watcher = await watchOfferSwaps({
            wallet,
            repository,
        });
        emit(spentEvent(offer, fill.txid));
        await watcher.idle();
        watcher.stop();

        expect(setContractWatchState).not.toHaveBeenCalled();
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

        const { wallet, emit, setContractWatchState } = makeWallet(async () => ({
            txs: [fill.psbt],
        }));
        const watcher = await watchOfferSwaps({
            wallet,
            repository,
        });
        emit(spentEvent(offer, fill.txid));
        await watcher.idle();
        watcher.stop();

        expect(setContractWatchState).not.toHaveBeenCalled();
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

        const { wallet, emit, setContractWatchState } = makeWallet(async () => ({
            txs: [fill.psbt],
        }));
        const watcher = await watchOfferSwaps({
            wallet,
            repository,
        });
        emit(spentEvent(offer, fill.txid));
        await watcher.idle();
        watcher.stop();

        expect(setContractWatchState).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });

    it("keeps the status write when the retire fails", async () => {
        // best-effort: a failed retire costs polling, never correctness
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const { wallet, emit, setContractWatchState } = makeWallet(async () => ({
            txs: [fill.psbt],
        }));
        setContractWatchState.mockRejectedValue(new Error("repository unavailable"));
        const watcher = await watchOfferSwaps({
            wallet,
            repository,
        });
        emit(spentEvent(offer, fill.txid));
        await watcher.idle();
        watcher.stop();

        expect(await getAssetSwaps(repository)).toMatchObject([{ status: "fulfilled" }]);
        expect(warn).toHaveBeenCalled();
        vi.restoreAllMocks();
    });

    it("stops delivering after stop()", async () => {
        const offer = makeOffer();
        const fill = spendPsbt(offer, "fulfill");
        const repository = new InMemoryAssetSwapRepository();
        await addAssetSwap(repository, swapFor(offer));

        const { wallet, emit, listeners } = makeWallet(async () => ({ txs: [fill.psbt] }));
        const watcher = await watchOfferSwaps({
            wallet,
            repository,
        });
        watcher.stop();
        expect(listeners()).toBe(0);

        emit(spentEvent(offer, fill.txid));
        await watcher.idle();
        expect(await getAssetSwaps(repository)).toMatchObject([{ status: "pending" }]);
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
