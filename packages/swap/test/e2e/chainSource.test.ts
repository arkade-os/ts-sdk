/**
 * The default chain source against the regtest stack's real esplora.
 *
 * The unit suite proves the adapter over a scripted backend; what needs a
 * server is the half that is a claim about esplora itself — that `/blocks`
 * answers `mediantime`, that `/address/:a/utxo` carries the height the
 * confirmations arithmetic needs, and that `/tx/:t/outspends` plus
 * `/tx/:t/hex` recover a spend. `getMtp` most of all: it is the read
 * `classifyOnchainHtlc` gates an L1 claim window on, and a tip time standing in
 * for median-time-past abandons a still-live claim.
 *
 * Only the `base` profile is needed — bitcoind plus mempool's esplora API on
 * port 3000, which is `ESPLORA_URL.regtest`.
 */
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import * as btc from "@scure/btc-signer";
import { ESPLORA_URL } from "@arkade-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { esploraChainSource } from "../../src/client/corridors/chainSource";
import { L1_NETWORKS } from "../../src/onchainHtlc";
import type { ChainSource, ChainUtxo } from "../../src/onchainHtlc";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const NETWORK = L1_NETWORKS.regtest;
const FUND_SATS = 100_000n;
const FEE_SATS = 1_000n;

const regtest = (args: string): string =>
    execSync(`node regtest/regtest.mjs ${args}`, {
        encoding: "utf8",
        cwd: REPO_ROOT,
        timeout: 120_000,
    }).trim();

/** `bitcoin-cli getblockchaininfo`, for the node's own median-time-past. */
const chainInfo = (): { blocks: number; mediantime: number } =>
    JSON.parse(regtest("rpc getblockchaininfo"));

const waitFor = async (
    fn: () => Promise<boolean>,
    { timeout = 60_000, interval = 500 } = {},
): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error("timeout in waitFor");
};

const keyPair = () => {
    const priv = secp256k1.utils.randomSecretKey();
    const payment = btc.p2wpkh(secp256k1.getPublicKey(priv, true), NETWORK);
    return { priv, ...payment };
};

describe("the default chain source (regtest)", () => {
    let chain: ChainSource;
    let funded: ReturnType<typeof keyPair>;
    let idle: ReturnType<typeof keyPair>;
    let payout: ReturnType<typeof keyPair>;
    let fill: ChainUtxo;
    let unspent: ChainUtxo;

    beforeAll(async () => {
        // Built exactly the way `resolveCorridorDeps` builds it with no
        // override: `ESPLORA_URL[network]` off the wallet's network.
        chain = esploraChainSource({ esploraUrl: ESPLORA_URL.regtest, network: NETWORK });
        funded = keyPair();
        idle = keyPair();
        payout = keyPair();
        regtest(`faucet ${funded.address} ${(Number(FUND_SATS) / 1e8).toFixed(8)} --confirm`);
        regtest(`faucet ${idle.address} ${(Number(FUND_SATS) / 1e8).toFixed(8)} --confirm`);
        // The indexer trails Core by up to a block, so every read below waits
        // for it rather than assuming the faucet's own confirmation is visible.
        await waitFor(async () => {
            const utxo = (await chain.getScriptUtxos(funded.script)).find(
                (candidate) => candidate.amount === FUND_SATS && candidate.confirmations > 0,
            );
            if (utxo) fill = utxo;
            return utxo !== undefined;
        });
        await waitFor(async () => {
            const utxo = (await chain.getScriptUtxos(idle.script)).find(
                (candidate) => candidate.amount === FUND_SATS && candidate.confirmations > 0,
            );
            if (utxo) unspent = utxo;
            return utxo !== undefined;
        });
    }, 180_000);

    it("finds the funded output, in bigint sats and with a real depth", () => {
        expect(fill.amount).toBe(FUND_SATS);
        // `--confirm` mined it, so the block it landed in counts as one.
        expect(fill.confirmations).toBeGreaterThanOrEqual(1);
    });

    it("answers the node's own median-time-past", async () => {
        // A poll, not a single comparison: the indexer's tip trails Core's, and
        // MTP moves with it. What matters is that the value converges on the
        // node's `mediantime` and never on a block time — the substitution
        // `OnchainProvider.getChainTip` would invite, since it promises no more
        // than "block time" and its two implementations disagree about which.
        await waitFor(async () => (await chain.getMtp()) === chainInfo().mediantime);
    });

    it("broadcasts a spend and then finds it from the outpoint", async () => {
        const tx = new btc.Transaction();
        tx.addInput({
            txid: fill.txid,
            index: fill.vout,
            witnessUtxo: { script: funded.script, amount: FUND_SATS },
        });
        tx.addOutputAddress(payout.address!, FUND_SATS - FEE_SATS, NETWORK);
        tx.sign(funded.priv);
        tx.finalize();

        const txid = await chain.broadcast(hex.encode(tx.extract()));
        expect(txid).toBe(tx.id);

        await waitFor(async () => (await chain.getSpendingTx(fill.txid, fill.vout)) !== null);
        const spend = await chain.getSpendingTx(fill.txid, fill.vout);
        expect(spend).not.toBe(null);
        expect(btc.Transaction.fromRaw(hex.decode(spend!.txHex)).id).toBe(txid);
    }, 120_000);

    it("answers null for an outpoint nothing has spent", async () => {
        const spend = await chain.getSpendingTx(unspent.txid, unspent.vout);
        expect(spend).toBe(null);
    });
});
