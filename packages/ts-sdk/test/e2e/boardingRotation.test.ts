import { expect, describe, it, beforeEach } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Wallet, EsploraProvider, MnemonicIdentity, RelativeTimelock } from "../../src";
import {
    beforeEachFaucet,
    createSharedRepos,
    execCommand,
    faucetOnchain,
    SharedRepos,
    waitFor,
} from "./utils";

/**
 * End-to-end coverage for per-derivation boarding rotation (plan §6) against
 * the regtest stack. The unit suite (`walletBoardingRotation.test.ts`) covers
 * allocation / boot / discovery filtering in isolation; these tests exercise
 * the parts only real chain + signer can: multi-address on-chain discovery,
 * per-index-key sweep signing, and on-chain boarding discovery during
 * `restore()`.
 */

interface HdWalletOpts {
    mnemonic: string;
    repos: SharedRepos;
    settlementConfig: false | { boardingUtxoSweep?: boolean; pollIntervalMs?: number };
    boardingTimelock?: RelativeTimelock;
}

function createHdWallet(opts: HdWalletOpts): Promise<Wallet> {
    return Wallet.create({
        identity: MnemonicIdentity.fromMnemonic(opts.mnemonic, { isMainnet: false }),
        walletMode: "hd",
        arkServerUrl: "http://localhost:7070",
        onchainProvider: new EsploraProvider("http://localhost:3000", {
            forcePolling: true,
            pollingInterval: 2000,
        }),
        storage: {
            walletRepository: opts.repos.walletRepository,
            contractRepository: opts.repos.contractRepository,
        },
        settlementConfig: opts.settlementConfig,
        ...(opts.boardingTimelock ? { boardingTimelock: opts.boardingTimelock } : {}),
    });
}

async function waitForChainTip(minHeight: number): Promise<void> {
    const esplora = new EsploraProvider("http://localhost:3000", {
        forcePolling: true,
        pollingInterval: 2000,
    });
    await waitFor(async () => (await esplora.getChainTip()).height >= minHeight, {
        timeout: 30_000,
        interval: 1_000,
    });
}

describe("Boarding HD rotation - multi-address discovery & sweep", () => {
    beforeEach(beforeEachFaucet, 60_000);

    it(
        "discovers and sweeps boarding UTXOs across current + rotated addresses",
        { timeout: 180_000 },
        async () => {
            const mnemonic = generateMnemonic(wordlist);
            const repos = createSharedRepos();
            // Short boarding-exit CSV so we can expire and sweep within the test.
            const boardingTimelock: RelativeTimelock = { type: "blocks", value: 20n };

            // ── Phase 1: rotate, fund two boarding addresses, expire them ──
            // Settlement disabled so no poll loop settles the UTXOs before we
            // can drive the sweep deterministically in phase 2.
            const setup = await createHdWallet({
                mnemonic,
                repos,
                settlementConfig: false,
                boardingTimelock,
            });

            const addr0 = await setup.getBoardingAddress(); // index-0 baseline
            const addr1 = await setup.getNewBoardingAddress(); // rotated index-1 (now current)
            expect(addr1).not.toBe(addr0);

            // Fund the current AND a rotated-away boarding address.
            faucetOnchain(addr0, 100_000);
            faucetOnchain(addr1, 100_000);

            // Multi-address fan-out: discovery must surface UTXOs at BOTH the
            // baseline (index-0) and the rotated (index-1) address, not just
            // the current one (plan §6-III.1).
            await waitFor(async () => (await setup.getBoardingUtxos()).length >= 2, {
                timeout: 60_000,
                interval: 2_000,
            });
            const funded = await setup.getBoardingUtxos();
            expect(funded).toHaveLength(2);
            const boardingAddresses = await setup.getBoardingAddresses();
            expect(boardingAddresses).toContain(addr0);
            expect(boardingAddresses).toContain(addr1);
            const initialTxids = new Set(funded.map((u) => u.txid));
            expect(initialTxids.size).toBe(2);

            // Confirm the faucet txs and read their funding height — the CSV
            // exit delay counts from confirmation, so we must mature both
            // inputs relative to the block they actually land in.
            execCommand("nigiri rpc --generate 1");
            await waitFor(
                async () => {
                    const u = await setup.getBoardingUtxos();
                    return u.length >= 2 && u.every((c) => (c.status.block_height ?? 0) > 0);
                },
                { timeout: 30_000, interval: 2_000 },
            );
            const confirmed = await setup.getBoardingUtxos();
            const fundingHeight = Math.max(...confirmed.map((c) => c.status.block_height ?? 0));

            // Expire both inputs (CSV = 20 blocks).
            execCommand("nigiri rpc --generate 20");
            await waitForChainTip(fundingHeight + 20);
            await setup.dispose();

            // ── Phase 2: sweep wallet on the SAME repos auto-sweeps both ──
            const wallet = await createHdWallet({
                mnemonic,
                repos,
                boardingTimelock,
                settlementConfig: { boardingUtxoSweep: true, pollIntervalMs: 5_000 },
            });

            // Boot restored the rotated index-1 as the current boarding address.
            // (Don't assert the pre-sweep UTXO count here: the poll loop runs
            // once immediately on init and may already be mid-sweep.)
            expect(await wallet.getBoardingAddress()).toBe(addr1);

            // The poll loop sweeps BOTH inputs in a single tx: the index-0 input
            // is signed with the identity key, the index-1 input with its
            // per-index descriptor key (plan §6-III.3), consolidating to the
            // current (addr1) boarding address. A mis-routed signing key would
            // produce an invalid tx that never confirms — so a successful sweep
            // is itself the per-index-signing assertion. Mine a block per poll
            // so the sweep tx confirms and the new UTXO enters esplora's set.
            await waitFor(
                async () => {
                    execCommand("nigiri rpc --generate 1");
                    const utxos = await wallet.getBoardingUtxos();
                    return utxos.length > 0 && utxos.every((u) => !initialTxids.has(u.txid));
                },
                { timeout: 90_000, interval: 5_000 },
            );

            const swept = await wallet.getBoardingUtxos();
            expect(swept.length).toBeGreaterThan(0);
            // Every UTXO now carries a fresh txid — both originals were consumed.
            expect(swept.every((u) => !initialTxids.has(u.txid))).toBe(true);

            await wallet.dispose();
        },
    );
});

describe("Boarding HD rotation - restore()", () => {
    beforeEach(beforeEachFaucet, 60_000);

    it(
        "rediscovers boarding funds at a rotated index a fresh same-seed repo cannot see",
        { timeout: 180_000 },
        async () => {
            const mnemonic = generateMnemonic(wordlist);

            // ── Wallet A: rotate boarding and fund the rotated address ──
            const a = await createHdWallet({
                mnemonic,
                repos: createSharedRepos(),
                settlementConfig: false,
            });
            try {
                const addr0 = await a.getBoardingAddress();
                const addr1 = await a.getNewBoardingAddress(); // rotated index-1
                expect(addr1).not.toBe(addr0);

                // Fund ONLY the rotated address — its script is one a fresh
                // same-seed wallet's index-0 baseline coverage cannot derive.
                faucetOnchain(addr1, 100_000);
                await waitFor(async () => (await a.getBoardingUtxos()).length >= 1, {
                    timeout: 60_000,
                    interval: 2_000,
                });
                // Confirm so the on-chain discovery probe (getCoins) sees it.
                execCommand("nigiri rpc --generate 1");
                const fundedA = await a.getBoardingUtxos();
                await waitForChainTip((fundedA[0].status.block_height ?? 0) + 1);

                // ── Wallet B: same seed, HD mode, FRESH separate repos ──
                const freshRepos = createSharedRepos();
                const b = await createHdWallet({
                    mnemonic,
                    repos: freshRepos,
                    settlementConfig: false,
                });
                try {
                    // B's baseline auto-registration covers only index-0, so it
                    // cannot see the rotated index-1 boarding UTXO yet.
                    const before = await b.getBoardingUtxos();
                    expect(before).toHaveLength(0);

                    // restore() scans the HD index range; the boarding probe
                    // (plan §6-I) discovers and registers the index-1 boarding
                    // contract the baseline missed.
                    await b.restore();

                    const after = await b.getBoardingUtxos();
                    expect(after.length).toBeGreaterThan(before.length);
                    expect(after.length).toBeGreaterThanOrEqual(1);
                    // The recovered UTXO sits at the rotated address.
                    expect(await b.getBoardingAddresses()).toContain(addr1);
                } finally {
                    await b.dispose();
                }
            } finally {
                await a.dispose();
            }
        },
    );
});
