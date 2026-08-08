import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { asset, ArkAddress, Transaction } from "@arkade-os/sdk";
import { encodeOffer, offerVtxoScript, OFFER_CONTRACT_KIND, type Offer } from "../src/offer";
import { InMemoryAssetSwapRepository } from "../src/repository";
import { addAssetSwap, getAssetSwaps, type AssetSwap } from "../src/store";
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
    const wallet = {
        getAddress: async () => address,
        getContractManager: async () => ({
            onContractEvent: (cb: (event: any) => void) => {
                callbacks.add(cb);
                return () => callbacks.delete(cb);
            },
        }),
    } as any;
    return {
        wallet,
        getVirtualTxs,
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

// the watcher builds its own RestIndexerProvider from arkServerUrl; intercept
// the one call it makes rather than reaching through the constructor
const withIndexer = async (
    fetcher: (txids: string[]) => Promise<{ txs: string[] }>,
    run: (harness: ReturnType<typeof makeWallet>) => Promise<void>,
) => {
    const sdk = await import("@arkade-os/sdk");
    const spy = vi
        .spyOn(sdk.RestIndexerProvider.prototype, "getVirtualTxs")
        .mockImplementation(fetcher as any);
    try {
        await run(makeWallet(fetcher));
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
