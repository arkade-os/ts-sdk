/**
 * `chainSourceFrom` — the package's L1 view, taken from the SDK's own
 * `OnchainProvider` instead of a hand-written esplora client per consumer.
 *
 * Every test here is about a mapping that is NOT one-to-one. A provider read
 * that returns the wrong shape is caught by types; the ones that are not are
 * the depth arithmetic, the address the script decodes to, and above all MTP —
 * each of which fails as a claim window that quietly closed rather than as an
 * error.
 */
import { describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import * as btc from "@scure/btc-signer";
import type { OnchainProvider } from "@arkade-os/sdk";
import { chainSourceFrom } from "../src/chainSource";
import { onchainHtlcScript, paymentHashOf } from "../src/onchainHtlc";
import { schnorr } from "@noble/curves/secp256k1.js";

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill));

const HTLC = onchainHtlcScript(
    {
        paymentHash: paymentHashOf(new Uint8Array(32).fill(7)),
        claimKey: key(15),
        refundKey: key(11),
        refundLocktime: 1_800_000_000,
    },
    "regtest",
);

/** A provider stub: only the methods the adapter reaches for are defined. */
const providerWith = (overrides: Partial<OnchainProvider>): OnchainProvider =>
    ({
        getCoins: vi.fn(async () => []),
        getChainTip: vi.fn(async () => ({ height: 100, time: 1_000, hash: "tip" })),
        getTxOutspends: vi.fn(async () => []),
        getRawTransaction: vi.fn(async () => new Uint8Array()),
        broadcastTransaction: vi.fn(async () => "txid"),
        ...overrides,
    }) as unknown as OnchainProvider;

describe("chainSourceFrom.getScriptUtxos", () => {
    it("asks the provider for the address the pkScript decodes to", async () => {
        const getCoins = vi.fn(async () => []);
        const chain = chainSourceFrom(providerWith({ getCoins }), "regtest");

        await chain.getScriptUtxos(HTLC.pkScript);

        // The HTLC's own address, derived independently by onchainHtlcScript —
        // not a string this test made up, so a wrong network or a byte-reversed
        // lookup cannot agree with it by accident.
        expect(getCoins).toHaveBeenCalledWith(HTLC.address);
    });

    it("encodes the address on the network it was given", async () => {
        const seen: string[] = [];
        const getCoins = vi.fn(async (address: string) => {
            seen.push(address);
            return [];
        });
        // Same script, read as mainnet: a bc1p address, not the bcrt1p one.
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
        // A `minConfirmations: 1` policy must not claim against a mempool
        // output, which can still be replaced.
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
        // A provider whose tip read is behind its utxo read (two endpoints, one
        // race) must not produce a negative number the comparison would read as
        // "not deep enough" in one direction and as garbage in the other.
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

        expect(await chain.getSpendingTx("funding", 1)).toEqual({ txHex: "deadbeef" });
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

        expect(await chain.getSpendingTx("funding", 1)).toBeNull();
    });

    it("reports no spend when the deployment omits the spender txid", async () => {
        // `txid` is optional on the interface; some esplora deployments drop it.
        // The only caller reads P out of the spend and retries, so "not yet" is
        // the honest answer — an invented txid would not be.
        const chain = chainSourceFrom(
            providerWith({
                getTxOutspends: vi.fn(async () => [{ spent: true }]),
            }) as OnchainProvider,
            "regtest",
        );

        expect(await chain.getSpendingTx("funding", 0)).toBeNull();
    });

    it("reports no spend for a vout the provider does not describe", async () => {
        const chain = chainSourceFrom(
            providerWith({ getTxOutspends: vi.fn(async () => []) }) as OnchainProvider,
            "regtest",
        );

        expect(await chain.getSpendingTx("funding", 3)).toBeNull();
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
                    // MTP lags the tip's own header time by roughly an hour;
                    // `OnchainProvider.getChainTip().time` is specified as the
                    // former, and a refund gated on the latter would broadcast
                    // before the leaf actually opens.
                    time: 1_699_996_400,
                    hash: "tip",
                })),
            }) as OnchainProvider,
            "regtest",
        );

        expect(await chain.getMtp()).toBe(1_699_996_400);
    });

    it("does not fall back to the host clock", async () => {
        // A `Date.now()` here reads as MTP being roughly wall-clock, which it is
        // not: it is a chain observation and can lag arbitrarily on a stalled
        // chain, which is exactly when a refund must NOT fire.
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
        // Guards the decode itself: if `OutScript.decode` and `Address.encode`
        // ever disagree for a P2TR output, every lookup silently returns [].
        const decoded = btc
            .Address({ ...btc.TEST_NETWORK, bech32: "bcrt" })
            .encode(btc.OutScript.decode(HTLC.pkScript));
        expect(decoded).toBe(HTLC.address);
        expect(hex.encode(HTLC.pkScript).startsWith("5120")).toBe(true);
    });
});
