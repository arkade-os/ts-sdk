/**
 * The default chain source, over a scripted backend.
 *
 * The regtest suite exercises the real esplora one; what is proved here is the
 * adapter: the script-to-address encode `getScriptUtxos` needs and
 * `ChainSource`'s signature does not carry, the confirmations arithmetic
 * `Coin` cannot answer alone, the missing-spender fallback core already carries
 * for boarding outputs, and the one read that must never come from
 * `getChainTip().time`.
 */
import { hex } from "@scure/base";
import * as btc from "@scure/btc-signer";
import type { ExplorerTransaction, OnchainProvider } from "@arkade-os/sdk";
import { describe, expect, it, vi } from "vitest";
import {
    chainSourceOver,
    esploraTip,
    type ChainSourceBackend,
} from "../../../src/client/corridors/chainSource";
import { L1_NETWORKS } from "../../../src/onchainHtlc";

const NETWORK = L1_NETWORKS.regtest;
const PK_SCRIPT = btc.OutScript.encode({
    type: "wpkh",
    hash: hex.decode("751e76e8199196d454941c45d1b3a323f1433bd6"),
});
const ADDRESS = btc.Address(NETWORK).encode(btc.OutScript.decode(PK_SCRIPT));

/** A raw transaction paying `PK_SCRIPT`, so the fallback can derive its
 * address from the outpoint alone. */
const funding = (() => {
    const tx = new btc.Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true });
    tx.addInput({ txid: new Uint8Array(32), index: 0 });
    tx.addOutput({ script: PK_SCRIPT, amount: 10_000n });
    return tx;
})();
const FUNDING_TXID = funding.id;
const FUNDING_HEX = hex.encode(funding.toBytes(true, false));
const SPEND_HEX = "0200000000";

const backendOver = (provider: Partial<OnchainProvider>, height = 100, mtp = 1_700_000_000) =>
    ({
        provider: provider as OnchainProvider,
        tip: async () => ({ height, mtp }),
    }) as ChainSourceBackend;

describe("the default chain source's adapter", () => {
    describe("getScriptUtxos", () => {
        it("encodes the script to an address and converts sats to bigint", async () => {
            const getCoins = vi.fn(async () => [
                { txid: "a".repeat(64), vout: 0, value: 10_000, status: { confirmed: false } },
            ]);
            const chain = chainSourceOver(backendOver({ getCoins }), NETWORK);
            expect(await chain.getScriptUtxos(PK_SCRIPT)).toEqual([
                { txid: "a".repeat(64), vout: 0, amount: 10_000n, confirmations: 0 },
            ]);
            expect(getCoins).toHaveBeenCalledWith(ADDRESS);
        });

        it("derives confirmations against the tip, counting the block it landed in", async () => {
            // `Coin` carries a height, never a depth, so the tip is the second
            // half of the answer — which is why the utxo read and the tip read
            // happen together.
            const chain = chainSourceOver(
                backendOver({
                    getCoins: async () => [
                        {
                            txid: "a".repeat(64),
                            vout: 0,
                            value: 1,
                            status: { confirmed: true, block_height: 100 },
                        },
                        {
                            txid: "b".repeat(64),
                            vout: 1,
                            value: 2,
                            status: { confirmed: true, block_height: 95 },
                        },
                    ],
                }),
                NETWORK,
            );
            expect((await chain.getScriptUtxos(PK_SCRIPT)).map((u) => u.confirmations)).toEqual([
                1, 6,
            ]);
        });
    });

    describe("getSpendingTx", () => {
        it("follows the spender `/outspends` names", async () => {
            const getRawTransaction = vi.fn(async () => hex.decode(SPEND_HEX));
            const chain = chainSourceOver(
                backendOver({
                    getTxOutspends: async () => [{ spent: true, txid: "c".repeat(64) }],
                    getRawTransaction,
                }),
                NETWORK,
            );
            expect(await chain.getSpendingTx(FUNDING_TXID, 0)).toEqual({ txHex: SPEND_HEX });
            expect(getRawTransaction).toHaveBeenCalledWith("c".repeat(64));
        });

        it("scans the spent output's address history when `/outspends` omits the txid", async () => {
            // Some deployments answer `{spent: true}` with no `txid` —
            // `mempool.arkade.sh`, which is `ESPLORA_URL.bitcoin`. The address
            // is derived from the funding transaction, because `getSpendingTx`
            // is handed an outpoint and nothing else.
            const history: ExplorerTransaction[] = [
                {
                    txid: "d".repeat(64),
                    vin: [{ txid: "e".repeat(64), vout: 3 }],
                    vout: [],
                    status: { confirmed: true, block_time: 1 },
                },
                {
                    txid: "f".repeat(64),
                    vin: [{ txid: FUNDING_TXID, vout: 0 }],
                    vout: [],
                    status: { confirmed: true, block_time: 2 },
                },
            ];
            const getTransactions = vi.fn(async () => history);
            const chain = chainSourceOver(
                backendOver({
                    getTxOutspends: async () => [{ spent: true }],
                    getTransactions,
                    getRawTransaction: async (txid: string) =>
                        hex.decode(txid === FUNDING_TXID ? FUNDING_HEX : SPEND_HEX),
                }),
                NETWORK,
            );
            expect(await chain.getSpendingTx(FUNDING_TXID, 0)).toEqual({ txHex: SPEND_HEX });
            expect(getTransactions).toHaveBeenCalledWith(ADDRESS);
        });

        it("treats the electrum provider's empty-string txid as no spender", async () => {
            // `""` is its unspent sentinel, and `??` would have taken it.
            const chain = chainSourceOver(
                backendOver({
                    getTxOutspends: async () => [{ spent: true, txid: "" }],
                    getTransactions: async () => [],
                    getRawTransaction: async () => hex.decode(FUNDING_HEX),
                }),
                NETWORK,
            );
            expect(await chain.getSpendingTx(FUNDING_TXID, 0)).toBe(null);
        });

        it("answers null for an unspent outpoint", async () => {
            const chain = chainSourceOver(
                backendOver({ getTxOutspends: async () => [{ spent: false }] }),
                NETWORK,
            );
            expect(await chain.getSpendingTx(FUNDING_TXID, 0)).toBe(null);
        });
    });

    it("broadcasts through the provider", async () => {
        const broadcastTransaction = vi.fn(async () => "txid");
        const chain = chainSourceOver(backendOver({ broadcastTransaction }), NETWORK);
        expect(await chain.broadcast(SPEND_HEX)).toBe("txid");
        expect(broadcastTransaction).toHaveBeenCalledWith(SPEND_HEX);
    });

    it("answers median-time-past, not a block time", async () => {
        const chain = chainSourceOver(backendOver({}, 100, 1_699_999_000), NETWORK);
        expect(await chain.getMtp()).toBe(1_699_999_000);
    });
});

describe("esploraTip", () => {
    const respondWith = (body: unknown, ok = true) =>
        vi.fn(async () =>
            ok
                ? Response.json(body)
                : new Response("nope", { status: 502, statusText: "Bad Gateway" }),
        ) as unknown as typeof fetch;

    it("reads `mediantime` off `/blocks`", async () => {
        // `/blocks` rather than `/blocks/tip`: the latter is not part of the
        // Esplora spec and a strict backend answers an empty array.
        const fetchImpl = respondWith([
            { id: "h", height: 812, mediantime: 1_700_000_000 },
            { id: "g", height: 811, mediantime: 1_699_999_000 },
        ]);
        expect(await esploraTip("http://esplora/api", fetchImpl)).toEqual({
            height: 812,
            mtp: 1_700_000_000,
        });
        expect(fetchImpl).toHaveBeenCalledWith("http://esplora/api/blocks");
    });

    it("fails rather than substituting a tip time for MTP", async () => {
        // The one substitution this read exists to prevent: an MTP that runs
        // high abandons a still-live L1 claim.
        await expect(
            esploraTip("http://esplora/api", respondWith([{ id: "h", height: 812, time: 1 }])),
        ).rejects.toThrow(/no usable chain tip/);
        await expect(esploraTip("http://esplora/api", respondWith([]))).rejects.toThrow(
            /no usable chain tip/,
        );
        await expect(
            esploraTip("http://esplora/api", respondWith(undefined, false)),
        ).rejects.toThrow(/failed to read the chain tip/);
    });
});
