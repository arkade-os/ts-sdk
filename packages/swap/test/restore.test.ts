import { describe, expect, it } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { asset, Extension, Transaction, UnknownPacket } from "@arkade-os/sdk";
import { encodeOffer, offerVtxoScript, Offer, OFFER_PACKET_TYPE } from "../src/offer";
import {
    classifyDepositSpend,
    classifySpend,
    restoreAssetSwaps,
    spendTxidsOf,
    type RestoreIndexer,
    type Tx,
} from "../src/restore";

const ASSET_ID = "f1".repeat(34);
const OTHER_ASSET_ID = "a2".repeat(34);

// real points: the covenant is compiled for every fixture, so the offer's
// swapPkScript is the script the spends below are classified against
const key = (seed: string) => schnorr.getPublicKey(hex.decode(seed.repeat(32)));
const SERVER_KEY = key("11");
const MAKER_KEY = key("22");
const EMULATOR_KEY = key("33");
// a real taproot output key: the spend psbts below pay it, and @scure rejects
// a script whose key is not a point
const MAKER_PK_SCRIPT = new Uint8Array([0x51, 0x20, ...key("55")]);

const makeOffer = (side: "want-asset" | "want-btc", wantAmount: bigint): Offer => {
    const binding: Omit<Offer, "swapPkScript"> = {
        wantAmount,
        ...(side === "want-asset"
            ? { wantAsset: asset.AssetId.fromString(ASSET_ID) }
            : { offerAsset: asset.AssetId.fromString(ASSET_ID) }),
        makerPkScript: MAKER_PK_SCRIPT,
        makerPublicKey: MAKER_KEY,
        emulatorPubkey: EMULATOR_KEY,
    };
    return { ...binding, swapPkScript: offerVtxoScript(binding, SERVER_KEY).pkScript };
};

const scriptOf = (offer: Offer) => hex.encode(offer.swapPkScript);

/** A funding PSBT: covenant output + the offer packet in the extension. */
const fundingPsbt = (offer: Offer): { psbt: string; txid: string } => {
    const tx = new Transaction({ allowUnknownOutputs: true });
    tx.addInput({ txid: new Uint8Array(32), index: 0 });
    tx.addOutput({ script: offer.swapPkScript, amount: BigInt(10_000) });
    const payload = encodeOffer(offer);
    const ext = Extension.create([new UnknownPacket(OFFER_PACKET_TYPE, payload)]).txOut();
    tx.addOutput({ script: ext.script, amount: ext.amount });
    return { psbt: base64.encode(tx.toPSBT()), txid: tx.id };
};

/**
 * A spend of one or more deposits, each input carrying the covenant leaf it
 * took. This is what the classifier reads: `cancel` returns the deposit,
 * `fulfill` is the solver paying for it.
 */
const spendPsbt = (
    spends: { offer: Offer; deposit: { txid: string; vout: number }; via: "cancel" | "fulfill" }[],
): { psbt: string; txid: string } => {
    const tx = new Transaction({ allowUnknownOutputs: true, allowUnknownInputs: true });
    for (const { offer, deposit, via } of spends) {
        const leaf = offerVtxoScript(offer, SERVER_KEY).functionByName(via)!.tapLeafScript;
        tx.addInput({
            txid: hex.decode(deposit.txid),
            index: deposit.vout,
            tapLeafScript: [leaf],
        });
    }
    tx.addOutput({ script: MAKER_PK_SCRIPT, amount: BigInt(9_000) });
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
const makeIndexer = (psbts: { psbt: string; txid: string }[], vtxos: any[]): FakeIndexer => {
    const calls: string[][] = [];
    const byTxid = new Map(psbts.map((p) => [p.txid, p.psbt]));
    return {
        calls,
        getVirtualTxs: async (txids: string[]) => {
            calls.push(txids);
            return { txs: txids.map((id) => byTxid.get(id)).filter(Boolean) as string[] };
        },
        getVtxos: async () => ({ vtxos }),
    } as unknown as FakeIndexer;
};

const depositVtxo = (offer: Offer, txid: string, extra: Record<string, unknown> = {}) => ({
    txid,
    vout: 0,
    script: scriptOf(offer),
    value: 10_000,
    createdAt: new Date(1_700_000_000_000),
    virtualStatus: { state: "settled" },
    ...extra,
});

const spentVtxo = (offer: Offer, txid: string, spentBy: string, extra = {}) =>
    depositVtxo(offer, txid, { virtualStatus: { state: "spent" }, arkTxId: spentBy, ...extra });

const scan = (
    indexer: RestoreIndexer,
    txs: Tx[],
    existingIds = new Set<string>(),
    scanned?: Set<string>,
) => restoreAssetSwaps(indexer, txs, existingIds, { serverPubkey: SERVER_KEY, scanned });

describe("classifySpend", () => {
    it("reads the leaf, not what the transaction moved", async () => {
        // the case a net-delta reading gets wrong: an asset offer's cancel takes
        // the asset out of the covenant and puts the same asset back, so every
        // wallet-level asset figure nets to zero and looks exactly like a fill
        const offer = makeOffer("want-btc", BigInt(21_000));
        const deposit = { txid: "ab".repeat(32), vout: 0 };
        const cancel = spendPsbt([{ offer, deposit, via: "cancel" }]);
        const fill = spendPsbt([{ offer, deposit, via: "fulfill" }]);

        const parse = (psbt: string) => Transaction.fromPSBT(base64.decode(psbt));
        expect(classifySpend(offer, SERVER_KEY, parse(cancel.psbt), deposit)).toBe("cancelled");
        expect(classifySpend(offer, SERVER_KEY, parse(fill.psbt), deposit)).toBe("fulfilled");
    });

    it("classifies each deposit by its own input when one tx spends several", async () => {
        // a solver batching fills, or any tx touching two of a maker's offers:
        // per-input leaves answer per deposit, where a transaction-level rollup
        // would give both deposits the same answer
        const cancelled = makeOffer("want-btc", BigInt(21_000));
        const filled = makeOffer("want-btc", BigInt(22_000));
        const a = { txid: "ab".repeat(32), vout: 0 };
        const b = { txid: "cd".repeat(32), vout: 1 };
        const { psbt } = spendPsbt([
            { offer: cancelled, deposit: a, via: "cancel" },
            { offer: filled, deposit: b, via: "fulfill" },
        ]);
        const parsed = Transaction.fromPSBT(base64.decode(psbt));

        expect(classifySpend(cancelled, SERVER_KEY, parsed, a)).toBe("cancelled");
        expect(classifySpend(filled, SERVER_KEY, parsed, b)).toBe("fulfilled");
    });

    it("classifies across both halves of a real spend, where only the checkpoint holds the outpoint", async () => {
        // the shape regtest produces: `spentBy` is the checkpoint, which takes
        // the deposit outpoint and carries the covenant leaf, and `arkTxId`
        // spends the checkpoint's output — same leaf, different outpoint. A
        // classifier handed only the ark tx answers `indeterminate` for every
        // real spend, which is precisely the bug the e2e caught.
        const offer = makeOffer("want-btc", BigInt(21_000));
        const deposit = { txid: "ab".repeat(32), vout: 0 };
        const checkpoint = spendPsbt([{ offer, deposit, via: "cancel" }]);
        // the ark tx spends the checkpoint, not the deposit
        const arkTx = spendPsbt([
            { offer, deposit: { txid: checkpoint.txid, vout: 0 }, via: "cancel" },
        ]);
        const parse = (psbt: string) => Transaction.fromPSBT(base64.decode(psbt));

        expect(classifySpend(offer, SERVER_KEY, parse(arkTx.psbt), deposit)).toBe("indeterminate");
        expect(classifyDepositSpend(offer, SERVER_KEY, [parse(arkTx.psbt)], deposit)).toBe(
            "indeterminate",
        );
        // given both, the checkpoint answers
        expect(
            classifyDepositSpend(
                offer,
                SERVER_KEY,
                [parse(checkpoint.psbt), parse(arkTx.psbt)],
                deposit,
            ),
        ).toBe("cancelled");
    });

    it("orders the candidate txids checkpoint-first", () => {
        expect(spendTxidsOf({ spentBy: "ck", arkTxId: "ark" })).toEqual(["ck", "ark"]);
        expect(spendTxidsOf({ arkTxId: "ark" })).toEqual(["ark"]);
        expect(spendTxidsOf({})).toEqual([]);
    });

    it("is indeterminate for a wrong server key or a spend by neither leaf", async () => {
        const offer = makeOffer("want-asset", BigInt(992));
        const deposit = { txid: "ab".repeat(32), vout: 0 };
        const { psbt } = spendPsbt([{ offer, deposit, via: "cancel" }]);
        const parsed = Transaction.fromPSBT(base64.decode(psbt));

        // a rotated server key rebuilds a different covenant: say so rather than
        // classify against a script the deposit was never funded to
        expect(classifySpend(offer, key("44"), parsed, deposit)).toBe("indeterminate");
        // right tx, wrong outpoint — the deposit is not among its inputs
        expect(classifySpend(offer, SERVER_KEY, parsed, { txid: "ef".repeat(32), vout: 0 })).toBe(
            "indeterminate",
        );
    });
});

describe("restoreAssetSwaps", () => {
    it("rebuilds a fulfilled BTC->asset swap from the funding tx offer packet and its spend", async () => {
        const offer = makeOffer("want-asset", BigInt(992));
        const payload = encodeOffer(offer);
        const funding = fundingPsbt(offer);
        const fill = spendPsbt([
            { offer, deposit: { txid: funding.txid, vout: 0 }, via: "fulfill" },
        ]);
        const txs = [
            walletTx(funding.txid, "sent"),
            walletTx(fill.txid, "received", { createdAt: 1_700_000_100 }),
        ];
        const indexer = makeIndexer([funding, fill], [spentVtxo(offer, funding.txid, fill.txid)]);

        const { restored } = await scan(indexer, txs);

        expect(restored).toHaveLength(1);
        expect(restored[0]).toMatchObject({
            id: funding.txid,
            fundingTxid: funding.txid,
            fromAsset: "btc",
            toAsset: ASSET_ID,
            fromAmount: "10000",
            toAmount: "992",
            swapPkScript: scriptOf(offer),
            offerHex: hex.encode(payload),
            status: "fulfilled",
            spentTxid: fill.txid,
            createdAt: 1_700_000_000_000,
            completedAt: 1_700_000_100_000,
        });
    });

    it("marks a spend that took the cancel leaf as cancelled", async () => {
        const offer = makeOffer("want-asset", BigInt(992));
        const funding = fundingPsbt(offer);
        const cancel = spendPsbt([
            { offer, deposit: { txid: funding.txid, vout: 0 }, via: "cancel" },
        ]);
        const txs = [walletTx(funding.txid, "sent"), walletTx(cancel.txid, "received")];
        const indexer = makeIndexer(
            [funding, cancel],
            [spentVtxo(offer, funding.txid, cancel.txid)],
        );

        const {
            restored: [restored],
        } = await scan(indexer, txs);

        expect(restored).toMatchObject({ status: "cancelled", spentTxid: cancel.txid });
        expect(restored.completedAt).toBeUndefined();
    });

    it("marks an asset->BTC cancel as cancelled, though it returns the deposit asset", async () => {
        // the regression this classifier exists for: with the deposit registered
        // as a contract, the asset leaves and returns within the wallet's own
        // coins, so every net asset figure for this tx is zero — identical to a
        // fill. The leaf is not.
        const offer = makeOffer("want-btc", BigInt(21_000));
        const funding = fundingPsbt(offer);
        const cancel = spendPsbt([
            { offer, deposit: { txid: funding.txid, vout: 0 }, via: "cancel" },
        ]);
        const vtxo = spentVtxo(offer, funding.txid, cancel.txid, {
            assets: [{ assetId: ASSET_ID, amount: BigInt(500) }],
        });
        const indexer = makeIndexer([funding, cancel], [vtxo]);

        const {
            restored: [restored],
        } = await scan(indexer, [walletTx(funding.txid, "sent")]);

        expect(restored).toMatchObject({ status: "cancelled", fromAsset: ASSET_ID });
    });

    it("rebuilds an asset->BTC swap with the deposit amount from the covenant vtxo assets", async () => {
        const offer = makeOffer("want-btc", BigInt(21_000));
        const funding = fundingPsbt(offer);
        const fill = spendPsbt([
            { offer, deposit: { txid: funding.txid, vout: 0 }, via: "fulfill" },
        ]);
        const vtxo = spentVtxo(offer, funding.txid, fill.txid, {
            assets: [{ assetId: ASSET_ID, amount: BigInt(500) }],
        });
        const indexer = makeIndexer([funding, fill], [vtxo]);

        const {
            restored: [restored],
        } = await scan(indexer, [walletTx(funding.txid, "sent"), walletTx(fill.txid, "received")]);

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
        const funding = fundingPsbt(offer);
        const fill = spendPsbt([
            { offer, deposit: { txid: funding.txid, vout: 0 }, via: "fulfill" },
        ]);
        const vtxo = spentVtxo(offer, funding.txid, fill.txid, {
            assets: [{ assetId: OTHER_ASSET_ID, amount: BigInt(500) }],
        });
        const indexer = makeIndexer([funding, fill], [vtxo]);

        const {
            restored: [restored],
        } = await scan(indexer, [walletTx(funding.txid, "sent"), walletTx(fill.txid, "received")]);

        expect(restored).toMatchObject({
            fromAsset: OTHER_ASSET_ID,
            toAsset: ASSET_ID,
            fromAmount: "500",
            toAmount: "992",
            status: "fulfilled",
        });
    });

    it("keeps an unspent deposit pending and a swept one recoverable", async () => {
        const offer = makeOffer("want-asset", BigInt(992));
        const funding = fundingPsbt(offer);
        for (const [state, status] of [
            ["settled", "pending"],
            ["swept", "recoverable"],
        ]) {
            const vtxo = depositVtxo(offer, funding.txid, { virtualStatus: { state } });
            const indexer = makeIndexer([funding], [vtxo]);
            const {
                restored: [restored],
            } = await scan(indexer, [walletTx(funding.txid, "sent")]);
            expect(restored.status).toBe(status);
            expect(restored.spentTxid).toBeUndefined();
        }
    });

    it("leaves a spend it cannot classify unscanned, rather than guessing", async () => {
        // the spender is not fetchable yet. Persisting a guess here is what made
        // a mislabel permanent: a stored swap is skipped by every later scan.
        const offer = makeOffer("want-asset", BigInt(992));
        const funding = fundingPsbt(offer);
        const indexer = makeIndexer([funding], [spentVtxo(offer, funding.txid, "not-fetchable")]);

        const result = await scan(indexer, [walletTx(funding.txid, "sent")]);

        expect(result).toEqual({ restored: [], scannedTxids: [] });

        // once the spender is fetchable the same candidate resolves
        const cancel = spendPsbt([
            { offer, deposit: { txid: funding.txid, vout: 0 }, via: "cancel" },
        ]);
        const later = makeIndexer([funding, cancel], [spentVtxo(offer, funding.txid, cancel.txid)]);
        const retry = await scan(later, [walletTx(funding.txid, "sent")]);
        expect(retry.restored).toMatchObject([{ status: "cancelled" }]);
        expect(retry.scannedTxids).toEqual([funding.txid]);
    });

    it("skips sent txs without an offer packet and already-known swaps", async () => {
        const offer = makeOffer("want-asset", BigInt(992));
        const funding = fundingPsbt(offer);
        const plainTx = new Transaction({ allowUnknownOutputs: true });
        plainTx.addInput({ txid: new Uint8Array(32), index: 1 });
        plainTx.addOutput({ script: offer.swapPkScript, amount: BigInt(500) });
        const plain = { psbt: base64.encode(plainTx.toPSBT()), txid: plainTx.id };

        // known id: never fetched, never restored
        const known = await scan(
            makeIndexer([funding], []),
            [walletTx(funding.txid, "sent")],
            new Set([funding.txid]),
        );
        expect(known).toEqual({ restored: [], scannedTxids: [] });

        // plain sends and received txs produce nothing
        const indexer = makeIndexer([plain], []);
        const result = await scan(indexer, [
            walletTx(plainTx.id, "sent"),
            walletTx("other", "received"),
        ]);
        expect(result.restored).toEqual([]);
        expect(result.scannedTxids).toEqual([plainTx.id]);
        expect(indexer.calls).toEqual([[plainTx.id]]);
    });

    it("never re-fetches txids that already got an authoritative answer", async () => {
        const offer = makeOffer("want-asset", BigInt(992));
        const funding = fundingPsbt(offer);
        const indexer = makeIndexer([funding], []);

        const result = await scan(
            indexer,
            [walletTx(funding.txid, "sent")],
            new Set(),
            new Set([funding.txid]),
        );

        expect(result).toEqual({ restored: [], scannedTxids: [] });
        expect(indexer.calls).toEqual([]);
    });

    it("leaves a txid unscanned while the declared deposit asset is missing from the vtxo", async () => {
        // a want-btc offer's TLV names the deposit asset; if the indexer hasn't
        // attached the rider yet, persisting now would burn a zero-amount record
        const offer = makeOffer("want-btc", BigInt(21_000));
        const funding = fundingPsbt(offer);
        const indexer = makeIndexer([funding], [spentVtxo(offer, funding.txid, "fill-txid")]);

        const result = await scan(indexer, [walletTx(funding.txid, "sent")]);

        expect(result).toEqual({ restored: [], scannedTxids: [] });
    });

    it("leaves a txid unscanned when its psbt is missing from the response", async () => {
        // two candidates requested, the indexer answers for only one: the missing
        // txid must stay unscanned or its swap could never be restored
        const offer = makeOffer("want-asset", BigInt(992));
        const funding = fundingPsbt(offer);
        const fill = spendPsbt([
            { offer, deposit: { txid: funding.txid, vout: 0 }, via: "fulfill" },
        ]);
        const indexer = makeIndexer([funding, fill], [spentVtxo(offer, funding.txid, fill.txid)]);

        const result = await scan(indexer, [
            walletTx(funding.txid, "sent"),
            walletTx("unanswered", "sent"),
        ]);

        expect(result.restored).toHaveLength(1);
        expect(result.scannedTxids).toEqual([funding.txid]);
    });

    it("leaves a txid unscanned while its funding vtxo is not yet indexed", async () => {
        // the offer packet is there but getVtxos lags behind the tx feed: marking
        // the txid scanned now would permanently orphan a still-pending swap
        const offer = makeOffer("want-asset", BigInt(992));
        const funding = fundingPsbt(offer);
        const indexer = makeIndexer([funding], []);

        const result = await scan(indexer, [walletTx(funding.txid, "sent")]);

        expect(result).toEqual({ restored: [], scannedTxids: [] });

        // once the indexer catches up, the same candidate restores normally
        const caughtUp = makeIndexer([funding], [depositVtxo(offer, funding.txid)]);
        const retry = await scan(caughtUp, [walletTx(funding.txid, "sent")]);
        expect(retry.restored).toHaveLength(1);
        expect(retry.scannedTxids).toEqual([funding.txid]);
    });

    it("leaves a failed fetch unscanned so it retries on a later scan", async () => {
        const funding = fundingPsbt(makeOffer("want-asset", BigInt(992)));
        const indexer = {
            getVirtualTxs: async () => {
                throw new Error("indexer down");
            },
            getVtxos: async () => ({ vtxos: [] }),
        } as any;

        const result = await scan(indexer, [walletTx(funding.txid, "sent")]);

        expect(result).toEqual({ restored: [], scannedTxids: [] });
    });

    it("keeps one chunk's failure from marking another chunk's txids scanned", async () => {
        // TXS_PER_REQUEST is 50, so 51 candidates split into two requests. If a
        // failed chunk let its txids be marked scanned, those swaps could never
        // be rebuilt — later scans skip answered txids.
        const offers = Array.from({ length: 51 }, (_, i) =>
            makeOffer("want-asset", BigInt(1_000 + i)),
        );
        const funded = offers.map((offer) => ({ offer, ...fundingPsbt(offer) }));
        const firstChunk = funded.slice(0, 50);
        const lastTxid = funded[50].txid;
        const byTxid = new Map(funded.map((f) => [f.txid, f.psbt]));

        const indexer = {
            getVirtualTxs: async (txids: string[]) => {
                if (txids.includes(lastTxid)) throw new Error("indexer down for this chunk");
                return { txs: txids.map((id) => byTxid.get(id)).filter(Boolean) as string[] };
            },
            getVtxos: async () => ({
                vtxos: funded.map((f) => depositVtxo(f.offer, f.txid)),
            }),
        } as unknown as FakeIndexer;

        const result = await scan(
            indexer,
            funded.map((f) => walletTx(f.txid, "sent")),
        );

        expect(result.restored).toHaveLength(50);
        expect(result.scannedTxids).toHaveLength(50);
        expect(result.scannedTxids).not.toContain(lastTxid);
        expect(new Set(result.scannedTxids)).toEqual(new Set(firstChunk.map((f) => f.txid)));
    });
});
