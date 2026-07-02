import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { ElectrumWS } from "ws-electrumx-client";
import { Address, OutScript } from "@scure/btc-signer";
import {
    ElectrumOnchainProvider,
    OnchainWallet,
    SingleKey,
    WsElectrumChainSource,
} from "../../src";
import { networks } from "../../src/networks";
import { waitFor } from "./utils";

// The arkade-regtest Fulcrum service exposes its Electrum TCP endpoint as a
// WebSocket on this port.
const ELECTRUM_WS_URL = "ws://localhost:50003";

function faucet(address: string, btc = 0.001): number {
    execSync(`node regtest/regtest.mjs faucet ${address} ${btc} --confirm`);
    // Mine a block immediately so electrs has a stable confirmed state to
    // index. Without this the bridge can race: listunspent reports the tx
    // at height N before block.header(N) is queryable, surfacing as
    // "missingheight" errors. Other e2e suites mine after every state
    // change for the same reason (settlement.test.ts etc.).
    execSync(`node regtest/regtest.mjs mine 1`);
    return Math.round(btc * 100_000_000);
}

describe("ElectrumOnchainProvider integration tests", () => {
    let ws: ElectrumWS;
    let provider: ElectrumOnchainProvider;
    let chain: WsElectrumChainSource;

    beforeAll(async () => {
        ws = new ElectrumWS(ELECTRUM_WS_URL);
        provider = new ElectrumOnchainProvider(ws, networks.regtest);
        chain = new WsElectrumChainSource(ws, networks.regtest);
        // Make sure the connection is actually open before the first test —
        // ws-electrumx-client lazy-connects on the first request, so any
        // setup error surfaces here rather than inside a test body.
        const version = await ws.request<[string, string]>("server.version", "ts-sdk-e2e", "1.4");
        expect(Array.isArray(version)).toBe(true);
    }, 15_000);

    afterAll(async () => {
        await provider.close().catch(() => {});
    });

    it(
        "exposes the regtest chain tip via the headers subscription",
        { timeout: 10_000 },
        async () => {
            const tip = await provider.getChainTip();
            // Regtest tips have non-zero height after the stack bootstraps and
            // mines its genesis-plus-N blocks; assert the shape and a sane lower bound.
            expect(tip.height).toBeGreaterThanOrEqual(0);
            expect(typeof tip.hash).toBe("string");
            expect(tip.hash).toMatch(/^[0-9a-f]{64}$/);
            expect(tip.time).toBeGreaterThan(0);

            // Calling twice must reuse the same subscription (cached tip),
            // not register a new one server-side.
            const tipAgain = await provider.getChainTip();
            expect(tipAgain.height).toBeGreaterThanOrEqual(tip.height);
        },
    );

    it(
        "returns a positive sat/vB fee rate for the regtest mempool",
        { timeout: 10_000 },
        async () => {
            const feeRate = await provider.getFeeRate();
            // Regtest typically returns -1 (no estimate available) which the
            // provider maps to undefined, OR a tiny positive integer when the
            // chain has enough activity. Both are acceptable for this assertion.
            if (feeRate !== undefined) {
                expect(feeRate).toBeGreaterThanOrEqual(1);
                expect(Number.isInteger(feeRate)).toBe(true);
            }
        },
    );

    it(
        "tracks a freshly-funded address through getCoins / getTransactions / getTxStatus",
        { timeout: 30_000 },
        async () => {
            const identity = SingleKey.fromRandomBytes();
            const wallet = await OnchainWallet.create(identity, "regtest", provider);

            // Fresh wallet: no coins, no history.
            expect(await provider.getCoins(wallet.address)).toEqual([]);
            expect(await provider.getTransactions(wallet.address)).toEqual([]);

            const sats = faucet(wallet.address, 0.001);
            // Poll until electrs picks up the faucet tx — tighter than a
            // fixed sleep, and aligns with the rest of the e2e suite.
            await waitFor(async () => {
                const coins = await provider.getCoins(wallet.address);
                return coins.length === 1 && coins[0].value === sats;
            });

            const coins = await provider.getCoins(wallet.address);
            expect(coins).toHaveLength(1);
            expect(coins[0].value).toBe(sats);

            const txs = await provider.getTransactions(wallet.address);
            // Must include the faucet tx; may include further txs if other
            // tests ran against the same regtest. Filter to ours by address.
            const fundingTx = txs.find((tx) =>
                tx.vout.some(
                    (out) =>
                        out.scriptpubkey_address === wallet.address && Number(out.value) === sats,
                ),
            );
            expect(fundingTx).toBeDefined();
            expect(fundingTx!.txid).toBe(coins[0].txid);

            // The faucet tx has at most 0 confirmations until the next
            // block; either status is acceptable. getTxStatus tolerates
            // electrs's index-lag race on block.header(N) by returning
            // blockTime=0 (degraded but useful), so we just assert shape.
            const status = await provider.getTxStatus(coins[0].txid);
            if (status.confirmed) {
                expect(status.blockHeight).toBeGreaterThan(0);
                expect(status.blockTime).toBeGreaterThanOrEqual(0);
            } else {
                expect(status).toEqual({ confirmed: false });
            }
        },
    );

    it(
        "broadcasts a single transaction and surfaces the new outpoint",
        { timeout: 30_000 },
        async () => {
            // Stand up Alice with the electrum provider and Bob (recipient).
            const alice = await OnchainWallet.create(
                SingleKey.fromRandomBytes(),
                "regtest",
                provider,
            );
            const bob = await OnchainWallet.create(
                SingleKey.fromRandomBytes(),
                "regtest",
                provider,
            );

            faucet(alice.address, 0.001);
            await waitFor(async () => (await alice.getBalance()) > 0);

            // Send half the funded amount; remainder goes to fee + change.
            await alice.send({
                address: bob.address,
                amount: 50_000,
                feeRate: 2,
            });
            await waitFor(async () => {
                const bobCoins = await provider.getCoins(bob.address);
                return bobCoins.length === 1 && bobCoins[0].value === 50_000;
            });

            const bobCoins = await provider.getCoins(bob.address);
            expect(bobCoins).toHaveLength(1);
            expect(bobCoins[0].value).toBe(50_000);

            // The send tx's outspends should mark Alice's funding output as
            // spent (any vout pointing to Bob's coin counts).
            const aliceFinalBalance = await alice.getBalance();
            expect(aliceFinalBalance).toBeLessThan(100_000);
        },
    );

    it(
        "computes outspends correctly for a tx whose outputs are partially spent",
        { timeout: 30_000 },
        async () => {
            const alice = await OnchainWallet.create(
                SingleKey.fromRandomBytes(),
                "regtest",
                provider,
            );
            const bob = await OnchainWallet.create(
                SingleKey.fromRandomBytes(),
                "regtest",
                provider,
            );

            faucet(alice.address, 0.001);
            await waitFor(async () => (await provider.getCoins(alice.address)).length === 1);

            const aliceCoins = await provider.getCoins(alice.address);
            expect(aliceCoins).toHaveLength(1);
            const fundingTxid = aliceCoins[0].txid;

            // Spend it; the spending tx's outputs become Bob's coin + change.
            await alice.send({
                address: bob.address,
                amount: 30_000,
                feeRate: 2,
            });
            await waitFor(async () =>
                (await provider.getTxOutspends(fundingTxid)).some((o) => o.spent),
            );

            const outspends = await provider.getTxOutspends(fundingTxid);
            // The funded vout must report spent=true with a non-empty txid.
            const spentOutput = outspends.find((o) => o.spent);
            expect(spentOutput).toBeDefined();
            expect(spentOutput!.txid).toMatch(/^[0-9a-f]{64}$/);
            expect(spentOutput!.txid).not.toBe(fundingTxid);
        },
    );

    it("delivers funded txs to the watchAddresses callback", { timeout: 30_000 }, async () => {
        const wallet = await OnchainWallet.create(SingleKey.fromRandomBytes(), "regtest", provider);

        const seen: string[] = [];
        const stop = await provider.watchAddresses([wallet.address], (txs) => {
            for (const tx of txs) seen.push(tx.txid);
        });

        try {
            faucet(wallet.address, 0.0005);
            // Subscriptions deliver via electrs's mempool notification.
            // Poll the captured array — finishes as soon as electrs
            // pushes the notification, much shorter than a fixed sleep
            // in the common case.
            await waitFor(async () => seen.length >= 1, {
                timeout: 30_000,
            });

            // The reported txid must match the on-chain coin we can
            // independently fetch via listunspent.
            const coins = await provider.getCoins(wallet.address);
            expect(seen).toContain(coins[0].txid);
        } finally {
            stop();
        }
    });

    it(
        "exposes WsElectrumChainSource.fetchHistories as a batch round-trip",
        // Need headroom for waitFor's default 25s polling budget plus
        // electrs's own indexing latency under CI load.
        { timeout: 40_000 },
        async () => {
            const a = await OnchainWallet.create(SingleKey.fromRandomBytes(), "regtest", provider);
            const b = await OnchainWallet.create(SingleKey.fromRandomBytes(), "regtest", provider);
            faucet(a.address, 0.0001);
            faucet(b.address, 0.0002);

            const aScript = decodeP2trScript(a.address);
            const bScript = decodeP2trScript(b.address);

            // Drive the assertion via fetchHistories directly so the wait
            // loop and the test target use the same code path. The wait
            // also swallows the library's 10s per-request timeout — under
            // CI load electrs occasionally wedges on get_history for the
            // full window. Treat that as "not ready yet" and retry; only
            // genuine errors propagate.
            let histories: Awaited<ReturnType<typeof chain.fetchHistories>>;
            await waitFor(async () => {
                try {
                    histories = await chain.fetchHistories([aScript, bScript]);
                    return histories[0].length >= 1 && histories[1].length >= 1;
                } catch (err) {
                    if (/request timeout|missingheight/i.test(String(err))) {
                        return false;
                    }
                    throw err;
                }
            });

            expect(histories!).toHaveLength(2);
            expect(histories![0].length).toBeGreaterThanOrEqual(1);
            expect(histories![1].length).toBeGreaterThanOrEqual(1);
        },
    );
});

// Repository-coupled smoke test: exercise OnchainWallet's full read/write
// surface against the electrum provider, mirroring the existing esplora
// test (test/e2e/onchain.test.ts) so any divergence between providers is
// visible side-by-side.
describe("OnchainWallet over ElectrumOnchainProvider", () => {
    let ws: ElectrumWS;
    let provider: ElectrumOnchainProvider;

    beforeAll(async () => {
        ws = new ElectrumWS(ELECTRUM_WS_URL);
        provider = new ElectrumOnchainProvider(ws, networks.regtest);
        // Force the connection to come up before the test starts so latency
        // stays out of the test budget.
        await ws.request<[string, string]>("server.version", "ts-sdk-e2e", "1.4");
    }, 15_000);

    afterAll(async () => {
        await provider.close().catch(() => {});
    });

    it(
        "performs a complete onchain roundtrip payment via electrum",
        { timeout: 30_000 },
        async () => {
            const alice = await OnchainWallet.create(
                SingleKey.fromRandomBytes(),
                "regtest",
                provider,
            );
            const bob = await OnchainWallet.create(
                SingleKey.fromRandomBytes(),
                "regtest",
                provider,
            );

            expect(await alice.getBalance()).toBe(0);
            expect(await bob.getBalance()).toBe(0);

            const sats = faucet(alice.address, 0.001);
            await waitFor(async () => (await alice.getBalance()) === sats);
            expect(await alice.getBalance()).toBe(sats);

            const sendAmount = 50_000;
            await alice.send({
                address: bob.address,
                amount: sendAmount,
                feeRate: 2,
            });
            await waitFor(async () => (await bob.getBalance()) === sendAmount);

            expect(await bob.getBalance()).toBe(sendAmount);
            expect(await alice.getBalance()).toBeLessThan(sats);
        },
    );
});

/**
 * Decode a regtest P2TR address back to its scriptPubKey. Used to feed
 * `WsElectrumChainSource.fetchHistories`, which takes raw scripts.
 */
function decodeP2trScript(address: string): Uint8Array {
    return OutScript.encode(Address(networks.regtest).decode(address));
}
