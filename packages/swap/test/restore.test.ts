import { describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import { asset, Extension, Transaction, UnknownPacket } from "@arkade-os/sdk";
import { encodeOffer, Offer, OFFER_PACKET_TYPE } from "../src/offer";
import { restoreAssetSwaps, type RestoreIndexer, type Tx } from "../src/restore";

const ASSET_ID = "f1".repeat(34);
const OTHER_ASSET_ID = "a2".repeat(34);
const SWAP_PK_SCRIPT = "5120" + "ab".repeat(32);

const makeOffer = (side: "want-asset" | "want-btc", wantAmount: bigint): Offer => ({
    swapPkScript: hex.decode(SWAP_PK_SCRIPT),
    wantAmount,
    ...(side === "want-asset"
        ? { wantAsset: asset.AssetId.fromString(ASSET_ID) }
        : { offerAsset: asset.AssetId.fromString(ASSET_ID) }),
    makerPkScript: hex.decode("5120" + "cd".repeat(32)),
    makerPublicKey: hex.decode("ef".repeat(32)),
    emulatorPubkey: hex.decode("12".repeat(32)),
});

/** A funding PSBT: covenant output + the offer packet in the extension. */
const fundingPsbt = (payload: Uint8Array): { psbt: string; txid: string } => {
    const tx = new Transaction({ allowUnknownOutputs: true });
    tx.addInput({ txid: new Uint8Array(32), index: 0 });
    tx.addOutput({ script: hex.decode(SWAP_PK_SCRIPT), amount: BigInt(10_000) });
    const ext = Extension.create([new UnknownPacket(OFFER_PACKET_TYPE, payload)]).txOut();
    tx.addOutput({ script: ext.script, amount: ext.amount });
    return { psbt: base64.encode(tx.toPSBT()), txid: tx.id };
};

const walletTx = (redeemTxid: string, type: string, overrides: Partial<Tx> = {}): Tx => ({
    boardingTxid: "",
    createdAt: 1_700_000_000,
    redeemTxid,
    roundTxid: "",
    type,
    ...overrides,
});

type FakeIndexer = RestoreIndexer & { calls: string[][] };

// typed against the production contract so a change to RestoreIndexer breaks
// these fakes at compile time instead of leaving them on a stale shape
const makeIndexer = (psbts: string[], vtxos: any[]): FakeIndexer => {
    const calls: string[][] = [];
    return {
        calls,
        getVirtualTxs: async (txids: string[]) => {
            calls.push(txids);
            return { txs: psbts };
        },
        getVtxos: async () => ({ vtxos }),
    } as unknown as FakeIndexer;
};

const spentVtxo = (txid: string, spentBy: string) => ({
    txid,
    script: SWAP_PK_SCRIPT,
    value: 10_000,
    createdAt: new Date(1_700_000_000_000),
    virtualStatus: { state: "spent" },
    arkTxId: spentBy,
});

describe("restoreAssetSwaps", () => {
    it("rebuilds a fulfilled BTC->asset swap from the funding tx offer packet and its spend", async () => {
        const offer = makeOffer("want-asset", BigInt(992));
        const payload = encodeOffer(offer);
        const { psbt, txid } = fundingPsbt(payload);
        const txs = [
            walletTx(txid, "sent"),
            walletTx("fill-txid", "received", {
                createdAt: 1_700_000_100,
                assets: [{ assetId: ASSET_ID, amount: BigInt(992) }] as any,
            }),
        ];
        const indexer = makeIndexer([psbt], [spentVtxo(txid, "fill-txid")]);

        const { restored } = await restoreAssetSwaps(indexer, txs, new Set());

        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({
            id: txid,
            fundingTxid: txid,
            fromAsset: "btc",
            toAsset: ASSET_ID,
            fromAmount: "10000",
            toAmount: "992",
            swapPkScript: SWAP_PK_SCRIPT,
            offerHex: hex.encode(payload),
            status: "fulfilled",
            spentTxid: "fill-txid",
            createdAt: 1_700_000_000_000,
            completedAt: 1_700_000_100_000,
        });
    });

    it("marks a spend that returned no want-asset as cancelled", async () => {
        const offer = makeOffer("want-asset", BigInt(992));
        const { psbt, txid } = fundingPsbt(encodeOffer(offer));
        // the spend credited sats back, no asset delivered: our cancel
        const txs = [walletTx(txid, "sent"), walletTx("cancel-txid", "received")];
        const indexer = makeIndexer([psbt], [spentVtxo(txid, "cancel-txid")]);

        const {
            restored: [restored],
        } = await restoreAssetSwaps(indexer, txs, new Set());

        expect(restored).toMatchObject({ status: "cancelled", spentTxid: "cancel-txid" });
        expect(restored.completedAt).toBeUndefined();
    });

    it("rebuilds an asset->BTC swap with the deposit amount from the covenant vtxo assets", async () => {
        const offer = makeOffer("want-btc", BigInt(21_000));
        const { psbt, txid } = fundingPsbt(encodeOffer(offer));
        const txs = [walletTx(txid, "sent"), walletTx("fill-txid", "received")];
        const vtxo = {
            ...spentVtxo(txid, "fill-txid"),
            assets: [{ assetId: ASSET_ID, amount: BigInt(500) }],
        };
        const indexer = makeIndexer([psbt], [vtxo]);

        const {
            restored: [restored],
        } = await restoreAssetSwaps(indexer, txs, new Set());

        expect(restored).toMatchObject({
            fromAsset: ASSET_ID,
            toAsset: "btc",
            fromAmount: "500",
            toAmount: "21000",
            status: "fulfilled",
        });
    });

    it("rebuilds an asset<->asset swap, deposit identified by the funding rider", async () => {
        // a want-asset offer whose funding vtxo carries a different asset: the
        // TLV names no deposit, so its identity comes from the vtxo's own rider
        const offer = makeOffer("want-asset", BigInt(992)); // wants ASSET_ID
        const { psbt, txid } = fundingPsbt(encodeOffer(offer));
        const txs = [
            walletTx(txid, "sent"),
            walletTx("fill-txid", "received", {
                assets: [{ assetId: ASSET_ID, amount: BigInt(992) }] as any,
            }),
        ];
        const vtxo = {
            ...spentVtxo(txid, "fill-txid"),
            assets: [{ assetId: OTHER_ASSET_ID, amount: BigInt(500) }],
        };
        const indexer = makeIndexer([psbt], [vtxo]);

        const {
            restored: [restored],
        } = await restoreAssetSwaps(indexer, txs, new Set());

        expect(restored).toMatchObject({
            fromAsset: OTHER_ASSET_ID,
            toAsset: ASSET_ID,
            fromAmount: "500",
            toAmount: "992",
            status: "fulfilled",
        });
    });

    it("marks an asset->BTC spend that returned the deposit asset as cancelled", async () => {
        const offer = makeOffer("want-btc", BigInt(21_000));
        const { psbt, txid } = fundingPsbt(encodeOffer(offer));
        const txs = [
            walletTx(txid, "sent"),
            walletTx("cancel-txid", "received", {
                assets: [{ assetId: ASSET_ID, amount: BigInt(500) }] as any,
            }),
        ];
        const vtxo = {
            ...spentVtxo(txid, "cancel-txid"),
            assets: [{ assetId: ASSET_ID, amount: BigInt(500) }],
        };
        const indexer = makeIndexer([psbt], [vtxo]);

        const {
            restored: [restored],
        } = await restoreAssetSwaps(indexer, txs, new Set());

        expect(restored).toMatchObject({ status: "cancelled" });
    });

    it("keeps an unspent deposit pending and a swept one recoverable", async () => {
        const offer = makeOffer("want-asset", BigInt(992));
        const { psbt, txid } = fundingPsbt(encodeOffer(offer));
        for (const [state, status] of [
            ["settled", "pending"],
            ["swept", "recoverable"],
        ]) {
            const vtxo = { ...spentVtxo(txid, ""), arkTxId: undefined, virtualStatus: { state } };
            const indexer = makeIndexer([psbt], [vtxo]);
            const {
                restored: [restored],
            } = await restoreAssetSwaps(indexer, [walletTx(txid, "sent")], new Set());
            expect(restored.status).toBe(status);
            expect(restored.spentTxid).toBeUndefined();
        }
    });

    it("skips sent txs without an offer packet and already-known swaps", async () => {
        const offer = makeOffer("want-asset", BigInt(992));
        const { psbt, txid } = fundingPsbt(encodeOffer(offer));
        const plainTx = new Transaction({ allowUnknownOutputs: true });
        plainTx.addInput({ txid: new Uint8Array(32), index: 1 });
        plainTx.addOutput({ script: hex.decode(SWAP_PK_SCRIPT), amount: BigInt(500) });
        const plain = base64.encode(plainTx.toPSBT());

        // known id: never fetched, never restored
        const known = await restoreAssetSwaps(
            makeIndexer([psbt], []),
            [walletTx(txid, "sent")],
            new Set([txid]),
        );
        expect(known).toEqual({ restored: [], scannedTxids: [] });

        // plain sends and received txs produce nothing
        const indexer = makeIndexer([plain], []);
        const result = await restoreAssetSwaps(
            indexer,
            [walletTx(plainTx.id, "sent"), walletTx("other", "received")],
            new Set(),
        );
        expect(result.restored).toEqual([]);
        expect(result.scannedTxids).toEqual([plainTx.id]);
        expect(indexer.calls).toEqual([[plainTx.id]]);
    });

    it("never re-fetches txids that already got an authoritative answer", async () => {
        const { psbt, txid } = fundingPsbt(encodeOffer(makeOffer("want-asset", BigInt(992))));
        const indexer = makeIndexer([psbt], []);

        const result = await restoreAssetSwaps(
            indexer,
            [walletTx(txid, "sent")],
            new Set(),
            new Set([txid]),
        );

        expect(result).toEqual({ restored: [], scannedTxids: [] });
        expect(indexer.calls).toEqual([]);
    });

    it("leaves a txid unscanned while the declared deposit asset is missing from the vtxo", async () => {
        // a want-btc offer's TLV names the deposit asset; if the indexer hasn't
        // attached the rider yet, persisting now would burn a zero-amount record
        const offer = makeOffer("want-btc", BigInt(21_000));
        const { psbt, txid } = fundingPsbt(encodeOffer(offer));
        const indexer = makeIndexer([psbt], [spentVtxo(txid, "fill-txid")]); // vtxo without assets

        const result = await restoreAssetSwaps(indexer, [walletTx(txid, "sent")], new Set());

        expect(result).toEqual({ restored: [], scannedTxids: [] });
    });

    it("leaves a txid unscanned when its psbt is missing from the response", async () => {
        // two candidates requested, the indexer answers for only one: the missing
        // txid must stay unscanned or its swap could never be restored
        const offer = makeOffer("want-asset", BigInt(992));
        const { psbt, txid } = fundingPsbt(encodeOffer(offer));
        const indexer = makeIndexer([psbt], [spentVtxo(txid, "fill-txid")]);

        const result = await restoreAssetSwaps(
            indexer,
            [walletTx(txid, "sent"), walletTx("unanswered", "sent")],
            new Set(),
        );

        expect(result.restored).toHaveLength(1);
        expect(result.scannedTxids).toEqual([txid]);
    });

    it("leaves a txid unscanned while its funding vtxo is not yet indexed", async () => {
        // the offer packet is there but getVtxos lags behind the tx feed: marking
        // the txid scanned now would permanently orphan a still-pending swap
        const offer = makeOffer("want-asset", BigInt(992));
        const { psbt, txid } = fundingPsbt(encodeOffer(offer));
        const indexer = makeIndexer([psbt], []);

        const result = await restoreAssetSwaps(indexer, [walletTx(txid, "sent")], new Set());

        expect(result).toEqual({ restored: [], scannedTxids: [] });

        // once the indexer catches up, the same candidate restores normally
        const caughtUp = makeIndexer([psbt], [spentVtxo(txid, "fill-txid")]);
        const retry = await restoreAssetSwaps(caughtUp, [walletTx(txid, "sent")], new Set());
        expect(retry.restored).toHaveLength(1);
        expect(retry.scannedTxids).toEqual([txid]);
    });

    it("leaves a failed fetch unscanned so it retries on a later scan", async () => {
        const { txid } = fundingPsbt(encodeOffer(makeOffer("want-asset", BigInt(992))));
        const indexer = {
            getVirtualTxs: async () => {
                throw new Error("indexer down");
            },
            getVtxos: async () => ({ vtxos: [] }),
        } as any;

        const result = await restoreAssetSwaps(indexer, [walletTx(txid, "sent")], new Set());

        expect(result).toEqual({ restored: [], scannedTxids: [] });
    });

    it("keeps one chunk's failure from marking another chunk's txids scanned", async () => {
        // TXS_PER_REQUEST is 50, so 51 candidates split into two requests. If a
        // failed chunk let its txids be marked scanned, those swaps could never
        // be rebuilt — later scans skip answered txids.
        const funded = Array.from({ length: 51 }, (_, i) =>
            fundingPsbt(encodeOffer(makeOffer("want-asset", BigInt(1_000 + i)))),
        );
        const firstChunk = funded.slice(0, 50);
        const lastTxid = funded[50].txid;

        const indexer = {
            getVirtualTxs: async (txids: string[]) => {
                if (txids.includes(lastTxid)) throw new Error("indexer down for this chunk");
                return { txs: firstChunk.map((f) => f.psbt) };
            },
            getVtxos: async () => ({
                vtxos: funded.map((f) => spentVtxo(f.txid, "fill-txid")),
            }),
        } as unknown as FakeIndexer;

        const result = await restoreAssetSwaps(
            indexer,
            funded.map((f) => walletTx(f.txid, "sent")),
            new Set(),
        );

        expect(result.restored).toHaveLength(50);
        expect(result.scannedTxids).toHaveLength(50);
        expect(result.scannedTxids).not.toContain(lastTxid);
        expect(new Set(result.scannedTxids)).toEqual(new Set(firstChunk.map((f) => f.txid)));
    });
});
