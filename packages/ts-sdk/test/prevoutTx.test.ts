import { describe, it, expect, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
    Transaction,
    resolvePrevTxs,
    attachPrevArkTxs,
    attachPrevoutTxs,
    withPrevTxs,
    PrevTxUnavailableError,
    PrevArkTxField,
    PrevoutTxField,
    getArkPsbtFields,
    setArkPsbtField,
} from "../src";

function p2tr(seed = 1): Uint8Array {
    return new Uint8Array([
        0x51,
        0x20,
        ...schnorr.getPublicKey(new Uint8Array(32).fill(seed || 1)),
    ]);
}

/** A one-input/one-output tx standing in for a previous ark tx. */
function prevTx(seed: number): { txid: string; psbt: string; raw: Uint8Array } {
    const tx = new Transaction({ version: 3 });
    tx.addInput({
        txid: new Uint8Array(32).fill(seed),
        index: 0,
        witnessUtxo: { script: p2tr(seed), amount: 1_000n },
    });
    tx.addOutput({ script: p2tr(seed), amount: 900n });
    return { txid: tx.id, psbt: base64.encode(tx.toPSBT()), raw: tx.toBytes() };
}

/** An indexer serving only the txs it was seeded with, in reverse request order. */
function indexerOf(txs: { txid: string; psbt: string }[]) {
    const byTxid = new Map(txs.map((t) => [t.txid, t.psbt]));
    return {
        getVirtualTxs: vi.fn(async (txids: string[]) => ({
            // Order is not part of the contract; reverse it to prove the
            // resolver keys by the txid each PSBT computes to.
            txs: txids
                .map((t) => byTxid.get(t))
                .filter((p): p is string => p !== undefined)
                .reverse(),
        })),
    };
}

/** An ark tx shaped like `buildOffchainTx` output: n inputs spending n checkpoints. */
function arkTxWith(inputs: number): Transaction {
    const tx = new Transaction({ version: 3 });
    for (let i = 0; i < inputs; i++) {
        tx.addInput({
            txid: new Uint8Array(32).fill(0x80 + i),
            index: 0,
            witnessUtxo: { script: p2tr(i), amount: 1_000n },
        });
    }
    tx.addOutput({ script: p2tr(9), amount: 900n });
    return tx;
}

describe("resolvePrevTxs", () => {
    it("batches and de-duplicates into one call", async () => {
        const a = prevTx(1);
        const b = prevTx(2);
        const indexer = indexerOf([a, b]);

        const got = await resolvePrevTxs([a.txid, b.txid, a.txid], indexer);

        expect(indexer.getVirtualTxs).toHaveBeenCalledTimes(1);
        expect(indexer.getVirtualTxs.mock.calls[0][0]).toEqual([a.txid, b.txid]);
        expect(got.size).toBe(2);
    });

    it("returns the raw wire bytes that hash to the requested txid", async () => {
        const a = prevTx(3);
        const got = await resolvePrevTxs([a.txid], indexerOf([a]));

        const raw = got.get(a.txid)!;
        expect(hex.encode(raw)).toBe(hex.encode(a.raw));
        expect(Transaction.fromRaw(raw).id).toBe(a.txid);
    });

    it("is a no-op with no txids", async () => {
        const indexer = indexerOf([]);
        expect((await resolvePrevTxs([], indexer)).size).toBe(0);
        expect(indexer.getVirtualTxs).not.toHaveBeenCalled();
    });

    it("names the missing txids when the source comes up short", async () => {
        const a = prevTx(4);
        const b = prevTx(5);

        await expect(resolvePrevTxs([a.txid, b.txid], indexerOf([a]))).rejects.toThrow(
            new RegExp(b.txid),
        );
        await expect(resolvePrevTxs([b.txid], indexerOf([]))).rejects.toBeInstanceOf(
            PrevTxUnavailableError,
        );
    });

    it("falls through to the onchain source for txs the indexer does not serve", async () => {
        const a = prevTx(6);
        const boarding = prevTx(7);
        const onchain = {
            getRawTransaction: vi.fn(async (txid: string) => {
                if (txid !== boarding.txid) throw new Error("unknown tx");
                return boarding.raw;
            }),
        };

        const got = await resolvePrevTxs([a.txid, boarding.txid], indexerOf([a]), onchain);

        expect(onchain.getRawTransaction).toHaveBeenCalledTimes(1);
        expect(hex.encode(got.get(boarding.txid)!)).toBe(hex.encode(boarding.raw));
    });

    it("falls through when the indexer rejects the whole batch", async () => {
        const boarding = prevTx(9);
        const rejecting = {
            getVirtualTxs: vi.fn(async () => {
                throw new Error("Failed to fetch virtual txs: Not Found");
            }),
        };
        const onchain = { getRawTransaction: async () => boarding.raw };

        const got = await resolvePrevTxs([boarding.txid], rejecting, onchain);
        expect(hex.encode(got.get(boarding.txid)!)).toBe(hex.encode(boarding.raw));

        // With nothing behind it, the indexer's own error is what the caller sees.
        await expect(resolvePrevTxs([boarding.txid], rejecting)).rejects.toThrow(/Not Found/);
    });

    it("still reports what neither source could supply", async () => {
        const missing = prevTx(8);
        const onchain = {
            getRawTransaction: vi.fn(async () => {
                throw new Error("404");
            }),
        };

        await expect(resolvePrevTxs([missing.txid], indexerOf([]), onchain)).rejects.toThrow(
            new RegExp(missing.txid),
        );
    });
});

describe("attachPrevArkTxs", () => {
    it("sets exactly one field on every input, keyed by the coin txid", async () => {
        const coins = [prevTx(11), prevTx(12), prevTx(13)];
        const arkTx = arkTxWith(3);

        await attachPrevArkTxs(
            arkTx,
            coins.map((c) => c.txid),
            indexerOf(coins),
        );

        for (const [i, coin] of coins.entries()) {
            const fields = getArkPsbtFields(arkTx, i, PrevArkTxField);
            expect(fields).toHaveLength(1);
            expect(Transaction.fromRaw(fields[0]).id).toBe(coin.txid);
        }
    });

    it("leaves an input that already carries the field alone", async () => {
        const coins = [prevTx(14), prevTx(15)];
        const supplied = prevTx(16);
        const arkTx = arkTxWith(2);
        setArkPsbtField(arkTx, 0, PrevArkTxField, supplied.raw);
        const indexer = indexerOf(coins);

        await attachPrevArkTxs(
            arkTx,
            coins.map((c) => c.txid),
            indexer,
        );

        // Only the uncovered input is fetched — and input 0 keeps one field, the
        // caller's, since the emulator refuses an input bearing two.
        expect(indexer.getVirtualTxs.mock.calls[0][0]).toEqual([coins[1].txid]);
        const first = getArkPsbtFields(arkTx, 0, PrevArkTxField);
        expect(first).toHaveLength(1);
        expect(hex.encode(first[0])).toBe(hex.encode(supplied.raw));
        expect(getArkPsbtFields(arkTx, 1, PrevArkTxField)).toHaveLength(1);
    });

    it("fetches nothing when every input is already covered", async () => {
        const arkTx = arkTxWith(1);
        setArkPsbtField(arkTx, 0, PrevArkTxField, prevTx(17).raw);
        const indexer = indexerOf([]);

        await attachPrevArkTxs(arkTx, ["deadbeef"], indexer);

        expect(indexer.getVirtualTxs).not.toHaveBeenCalled();
    });

    it("refuses an input with no source txid rather than submitting a tx the emulator rejects", async () => {
        const arkTx = arkTxWith(2);
        await expect(
            attachPrevArkTxs(arkTx, [prevTx(18).txid], indexerOf([])),
        ).rejects.toBeInstanceOf(PrevTxUnavailableError);
    });
});

describe("attachPrevoutTxs", () => {
    it("reads each input's own outpoint", async () => {
        const funding = prevTx(21);
        const tx = new Transaction();
        tx.addInput({
            txid: hex.decode(funding.txid),
            index: 0,
            witnessUtxo: { script: p2tr(21), amount: 900n },
        });
        tx.addOutput({ script: p2tr(22), amount: 800n });

        await attachPrevoutTxs(tx, { getRawTransaction: async () => funding.raw });

        const fields = getArkPsbtFields(tx, 0, PrevoutTxField);
        expect(fields).toHaveLength(1);
        expect(Transaction.fromRaw(fields[0]).id).toBe(funding.txid);
    });
});

describe("withPrevTxs", () => {
    it("fills prevTx on every coin and keeps one already supplied", async () => {
        const a = prevTx(31);
        const b = prevTx(32);
        const preset = new Uint8Array([1, 2, 3]);
        const indexer = indexerOf([a, b]);

        const coins = await withPrevTxs(
            [
                { txid: a.txid, value: 1 },
                { txid: b.txid, value: 2, prevTx: preset },
            ],
            indexer,
        );

        expect(indexer.getVirtualTxs.mock.calls[0][0]).toEqual([a.txid]);
        expect(hex.encode(coins[0].prevTx!)).toBe(hex.encode(a.raw));
        expect(coins[1].prevTx).toBe(preset);
    });
});
