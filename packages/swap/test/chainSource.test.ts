/**
 * `chainSourceFrom`. Every test is a mapping that is NOT one-to-one — the depth
 * arithmetic, the address a script decodes to, and MTP — each of which fails as
 * a claim window that quietly closed rather than as an error.
 */
import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import * as btc from "@scure/btc-signer";
import type { ExplorerTransaction, OnchainProvider } from "@arkade-os/sdk";
import { chainSourceFrom } from "../src/chainSource";
import {
    buildHtlcClaim,
    classifyOnchainHtlc,
    onchainHtlcScript,
    paymentHashOf,
} from "../src/onchainHtlc";
import { schnorr } from "@noble/curves/secp256k1.js";

const priv = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const key = (fill: number): Uint8Array => schnorr.getPublicKey(priv(fill));

const PREIMAGE = new Uint8Array(32).fill(7);

const HTLC = onchainHtlcScript(
    {
        paymentHash: paymentHashOf(PREIMAGE),
        claimKey: key(15),
        refundKey: key(11),
        refundLocktime: 1_800_000_000,
    },
    "regtest",
);

const historyTx = (txid: string, spends: { txid: string; vout: number }[]) =>
    ({
        txid,
        vin: spends,
        vout: [],
        status: { confirmed: true, block_time: 1 },
    }) as unknown as ExplorerTransaction;

/** A provider stub: only the methods the adapter reaches for are defined. */
const providerWith = (overrides: Partial<OnchainProvider>): OnchainProvider =>
    ({
        getCoins: vi.fn(async () => []),
        getChainTip: vi.fn(async () => ({ height: 100, time: 1_000, hash: "tip" })),
        getTxOutspends: vi.fn(async () => []),
        getTransactions: vi.fn(async () => []),
        getRawTransaction: vi.fn(async () => new Uint8Array()),
        broadcastTransaction: vi.fn(async () => "txid"),
        ...overrides,
    }) as unknown as OnchainProvider;

describe("chainSourceFrom.getScriptUtxos", () => {
    it("asks the provider for the address the pkScript decodes to", async () => {
        const getCoins = vi.fn(async () => []);
        const chain = chainSourceFrom(providerWith({ getCoins }), "regtest");

        await chain.getScriptUtxos(HTLC.pkScript);

        // Derived independently, so a wrong network cannot agree by accident.
        expect(getCoins).toHaveBeenCalledWith(HTLC.address);
    });

    it("encodes the address on the network it was given", async () => {
        const seen: string[] = [];
        const getCoins = vi.fn(async (address: string) => {
            seen.push(address);
            return [];
        });
        await chainSourceFrom(providerWith({ getCoins }), "bitcoin").getScriptUtxos(HTLC.pkScript);

        expect(seen[0].startsWith("bc1p")).toBe(true);
        expect(seen[0]).not.toBe(HTLC.address);
    });

    it("counts a tip-height confirmation as one, not zero", async () => {
        const chain = chainSourceFrom(
            providerWith({
                getChainTip: vi.fn(async () => ({ height: 100, time: 1_000, hash: "tip" })),
                getCoins: vi.fn(async () => [
                    {
                        txid: "aa",
                        vout: 0,
                        value: 50_000,
                        status: { confirmed: true, block_height: 100 },
                    },
                ]),
            }) as OnchainProvider,
            "regtest",
        );

        const [utxo] = await chain.getScriptUtxos(HTLC.pkScript);
        expect(utxo).toEqual({ txid: "aa", vout: 0, amount: 50_000n, confirmations: 1 });
    });

    it("counts depth from the tip, inclusive", async () => {
        const chain = chainSourceFrom(
            providerWith({
                getChainTip: vi.fn(async () => ({ height: 110, time: 1_000, hash: "tip" })),
                getCoins: vi.fn(async () => [
                    {
                        txid: "bb",
                        vout: 1,
                        value: 1,
                        status: { confirmed: true, block_height: 100 },
                    },
                ]),
            }) as OnchainProvider,
            "regtest",
        );

        expect((await chain.getScriptUtxos(HTLC.pkScript))[0].confirmations).toBe(11);
    });

    it("reports an unconfirmed output as zero-deep, never one", async () => {
        const chain = chainSourceFrom(
            providerWith({
                getCoins: vi.fn(async () => [
                    { txid: "cc", vout: 0, value: 10, status: { confirmed: false } },
                ]),
            }) as OnchainProvider,
            "regtest",
        );

        expect((await chain.getScriptUtxos(HTLC.pkScript))[0].confirmations).toBe(0);
    });

    it("reports a confirmed output with no known height as zero-deep", async () => {
        const chain = chainSourceFrom(
            providerWith({
                getCoins: vi.fn(async () => [
                    { txid: "dd", vout: 0, value: 10, status: { confirmed: true } },
                ]),
            }) as OnchainProvider,
            "regtest",
        );

        expect((await chain.getScriptUtxos(HTLC.pkScript))[0].confirmations).toBe(0);
    });

    it("never reports a negative depth when the tip lags the output", async () => {
        // Two endpoints, one race: a tip behind the utxo must not go negative.
        const chain = chainSourceFrom(
            providerWith({
                getChainTip: vi.fn(async () => ({ height: 90, time: 1_000, hash: "tip" })),
                getCoins: vi.fn(async () => [
                    {
                        txid: "ee",
                        vout: 0,
                        value: 10,
                        status: { confirmed: true, block_height: 100 },
                    },
                ]),
            }) as OnchainProvider,
            "regtest",
        );

        expect((await chain.getScriptUtxos(HTLC.pkScript))[0].confirmations).toBe(0);
    });
});

describe("chainSourceFrom.getSpendingTx", () => {
    it("resolves the spender of the requested vout and returns its hex", async () => {
        const getRawTransaction = vi.fn(async () => Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
        const chain = chainSourceFrom(
            providerWith({
                getTxOutspends: vi.fn(async () => [
                    { spent: false },
                    { spent: true, txid: "spender" },
                ]),
                getRawTransaction,
            }) as OnchainProvider,
            "regtest",
        );

        expect(await chain.getSpendingTx("funding", 1, HTLC.pkScript)).toEqual({
            txHex: "deadbeef",
        });
        expect(getRawTransaction).toHaveBeenCalledWith("spender");
    });

    it("reads the outspend at the requested index, not the first one", async () => {
        const chain = chainSourceFrom(
            providerWith({
                getTxOutspends: vi.fn(async () => [
                    { spent: true, txid: "wrong" },
                    { spent: false },
                ]),
            }) as OnchainProvider,
            "regtest",
        );

        expect(await chain.getSpendingTx("funding", 1, HTLC.pkScript)).toBeNull();
    });

    it("indexes the address history's vin when the deployment omits the spender txid", async () => {
        const getRawTransaction = vi.fn(async () => Uint8Array.from([0xde, 0xad, 0xbe, 0xef]));
        const getTransactions = vi.fn(async () => [
            historyTx("funding", [{ txid: "earlier", vout: 0 }]),
            historyTx("spender", [{ txid: "funding", vout: 1 }]),
        ]);
        const chain = chainSourceFrom(
            providerWith({
                getTxOutspends: vi.fn(async () => [{ spent: true }, { spent: true }]),
                getTransactions,
                getRawTransaction,
            }) as OnchainProvider,
            "regtest",
        );

        expect(await chain.getSpendingTx("funding", 1, HTLC.pkScript)).toEqual({
            txHex: "deadbeef",
        });
        expect(getTransactions).toHaveBeenCalledWith(HTLC.address);
        expect(getRawTransaction).toHaveBeenCalledWith("spender");
    });

    it("treats the electrum empty-string txid as absent, not as the spender", async () => {
        const getRawTransaction = vi.fn(async () => Uint8Array.from([0xbe, 0xef]));
        const chain = chainSourceFrom(
            providerWith({
                getTxOutspends: vi.fn(async () => [{ spent: true, txid: "" }]),
                getTransactions: vi.fn(async () => [
                    historyTx("spender", [{ txid: "funding", vout: 0 }]),
                ]),
                getRawTransaction,
            }) as OnchainProvider,
            "regtest",
        );

        expect(await chain.getSpendingTx("funding", 0, HTLC.pkScript)).toEqual({ txHex: "beef" });
        expect(getRawTransaction).toHaveBeenCalledWith("spender");
    });

    it("reports no spend when neither the outspend nor the history names one", async () => {
        const chain = chainSourceFrom(
            providerWith({
                getTxOutspends: vi.fn(async () => [{ spent: true }]),
                getTransactions: vi.fn(async () => [
                    historyTx("unrelated", [{ txid: "somethingelse", vout: 0 }]),
                ]),
            }) as OnchainProvider,
            "regtest",
        );

        expect(await chain.getSpendingTx("funding", 0, HTLC.pkScript)).toBeNull();
    });

    it("reports no spend for a vout the provider does not describe", async () => {
        const chain = chainSourceFrom(
            providerWith({ getTxOutspends: vi.fn(async () => []) }) as OnchainProvider,
            "regtest",
        );

        expect(await chain.getSpendingTx("funding", 3, HTLC.pkScript)).toBeNull();
    });
});

describe("a claimed HTLC on a deployment that omits the spender txid", () => {
    it("classifies as claimed with the preimage, not as unfunded", async () => {
        const claim = await buildHtlcClaim({
            htlc: HTLC,
            utxo: { txid: "aa".repeat(32), vout: 0, amount: 100_000n },
            preimage: PREIMAGE,
            payoutPkScript: Uint8Array.from([0x51, 0x20, ...key(5)]),
            feeRateSatVb: 1,
            sign: async (sighash) => schnorr.sign(sighash, priv(15)),
        });
        const chain = chainSourceFrom(
            providerWith({
                getCoins: vi.fn(async () => []),
                getTxOutspends: vi.fn(async () => [{ spent: true }]),
                getTransactions: vi.fn(async () => [
                    historyTx(claim.txid, [{ txid: "aa".repeat(32), vout: 0 }]),
                ]),
                getRawTransaction: vi.fn(async () => hex.decode(claim.txHex)),
            }) as OnchainProvider,
            "regtest",
        );

        expect(
            await classifyOnchainHtlc(chain, {
                htlc: HTLC,
                minConfirmations: 1,
                funding: { txid: "aa".repeat(32), vout: 0 },
            }),
        ).toEqual({ phase: "claimed", txid: claim.txid, preimage: PREIMAGE });
    });
});

describe("chainSourceFrom.broadcast", () => {
    it("passes the raw hex through as a single transaction", async () => {
        const broadcastTransaction = vi.fn(async () => "the-txid");
        const chain = chainSourceFrom(
            providerWith({ broadcastTransaction }) as OnchainProvider,
            "regtest",
        );

        expect(await chain.broadcast("0200dead")).toBe("the-txid");
        // One argument: two would be read as a 1P1C package.
        expect(broadcastTransaction).toHaveBeenCalledWith("0200dead");
        expect(broadcastTransaction.mock.calls[0]).toHaveLength(1);
    });
});

describe("chainSourceFrom.getMtp", () => {
    it("returns the tip's median-time-past", async () => {
        const chain = chainSourceFrom(
            providerWith({
                getChainTip: vi.fn(async () => ({
                    height: 100,
                    time: 1_699_996_400,
                    hash: "tip",
                })),
            }) as OnchainProvider,
            "regtest",
        );

        expect(await chain.getMtp()).toBe(1_699_996_400);
    });

    it("does not fall back to the host clock", async () => {
        // MTP is a chain observation: on a stalled chain it lags arbitrarily,
        // which is exactly when a refund must NOT fire.
        const chain = chainSourceFrom(
            providerWith({
                getChainTip: vi.fn(async () => ({ height: 1, time: 1, hash: "tip" })),
            }) as OnchainProvider,
            "regtest",
        );

        expect(await chain.getMtp()).toBe(1);
    });
});

describe("the adapter round-trips the real HTLC script", () => {
    it("decodes the pkScript back to the address the HTLC published", () => {
        // If decode/encode ever disagree on P2TR, every lookup returns [].
        const decoded = btc
            .Address({ ...btc.TEST_NETWORK, bech32: "bcrt" })
            .encode(btc.OutScript.decode(HTLC.pkScript));
        expect(decoded).toBe(HTLC.address);
        expect(hex.encode(HTLC.pkScript).startsWith("5120")).toBe(true);
    });
});
