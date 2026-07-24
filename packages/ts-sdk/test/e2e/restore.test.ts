import { expect, describe, it, beforeEach } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDDescriptorProvider } from "../../src";
import type { HDCapableIdentity } from "../../src/identity";
import { buildReceiveContract } from "../../src/wallet/walletReceiveRotator";
import {
    beforeEachFaucet,
    createSharedRepos,
    createTestArkWalletFromMnemonic,
    faucetOffchain,
    waitFor,
} from "./utils";

/**
 * `restore()` is only load-bearing when funds sit at an HD index that
 * neither the wallet's baseline auto-registration NOR its look-ahead band
 * cover — i.e. across a gap wider than the look-ahead window.
 *
 * `Wallet.create` → `initializeContractManager` registers a baseline
 * `default` contract at `identity.xOnlyPublicKey()`, the BIP-86 index-0
 * child. On top of that, an HD wallet watches a look-ahead band of unfunded
 * receive scripts spanning `[max(0, w - size), w + size]` around its
 * allocation watermark `w`, and that band SLIDES: every funded index it
 * discovers advances the watermark and refills the band forward. So a
 * *contiguous* run of funded indices (0, 1, 2, …) is fully discovered with
 * no `restore()` — the band walks the whole run. `restore()` only does work
 * when a funded index is separated from the watched set by a gap larger than
 * the window, exactly the "externally-issued address" case the look-ahead
 * cannot reach.
 *
 * We reproduce that with `lookAheadWindow: 1` (band reach `[0, 1]` from a
 * fresh watermark of 0) and park funds at:
 *   - index-0 (the baseline) — a fresh same-seed wallet credits these
 *     directly, and
 *   - index-5 — well outside the band and unreachable by its slide (the
 *     intervening indices are unfunded), yet inside `restore()`'s default
 *     gapLimit of 20.
 *
 * The index-5 address is derived directly (not via the receive rotator,
 * which only advances one index per received vtxo) to simulate a third party
 * issuing a deep address from the shared seed. A fresh wallet B on the same
 * seed can therefore see the index-0 funds but NOT the index-5 funds until
 * `restore()`'s gap scan discovers and registers the index-5 contract. That
 * is the load-bearing property this test asserts.
 */
describe("Wallet.restore()", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "recovers HD-rotated funds a fresh same-seed repo cannot see without restore()",
        { timeout: 120000 },
        async () => {
            const mnemonic = generateMnemonic(wordlist);
            const GAP_INDEX = 5; // > lookAheadWindow (1), < restore gapLimit (20)
            const AMOUNT = 50_000; // small: two sends must fit the per-test faucet budget
            const totalFunded = 2 * AMOUNT;

            // ── Wallet A: HD mode, the "issuer" ───────────────────────────
            // lookAheadWindow: 1 keeps the band tight; A is only used to fund
            // the index-0 baseline and to derive the deep index-5 address.
            const a = await createTestArkWalletFromMnemonic(mnemonic, undefined, "hd", 1);

            // Wrap A in try/finally so a failed assertion can't leak A's
            // watcher/state into later e2e files.
            try {
                // Derive the index-5 receive address up front, off the baseline
                // (index-0) tapscript. `buildReceiveContract` rebuilds it under
                // the index-5 leaf key and encodes the ark address — the same
                // primitive the look-ahead and restore gap-scan use.
                const provider = await HDDescriptorProvider.create(
                    a.identity as unknown as HDCapableIdentity,
                    createSharedRepos().walletRepository,
                );
                const { params } = buildReceiveContract(
                    a.wallet.offchainTapscript,
                    provider.materializeDescriptorAt(GAP_INDEX),
                    a.wallet.network.hrp,
                    false,
                );
                const gapAddress = params.address;

                // Fund the index-0 baseline (a fresh same-seed wallet covers
                // this) and wait for A to see it, confirming the send landed.
                const baselineAddress = await a.wallet.getAddress();
                expect(baselineAddress).toBeDefined();
                faucetOffchain(baselineAddress!, AMOUNT);
                await waitFor(async () => (await a.wallet.getVtxos()).length > 0, {
                    timeout: 60_000,
                    interval: 1_000,
                });

                // Fund the deep index-5 address. These funds live at a script
                // that a fresh same-seed wallet's baseline + [0, 1] look-ahead
                // band cannot reach.
                faucetOffchain(gapAddress, AMOUNT);

                // ── Wallet B: same seed, HD mode, FRESH separate repos ────────
                const freshRepos = createSharedRepos();
                const b = await createTestArkWalletFromMnemonic(mnemonic, freshRepos, "hd", 1);

                // Wrap B in try/finally too — guarantee b.dispose() runs even
                // if a B-side assertion throws.
                try {
                    // B's baseline + [0, 1] band covers index-0 only (index-1 is
                    // unfunded, so the band never slides toward index-5). It can
                    // credit the index-0 funds but never the index-5 funds — so
                    // `before` is strictly LESS than the full funded total.
                    const before = (await b.wallet.getBalance()).total;
                    expect(before).toBeLessThan(totalFunded);

                    // ── restore() must scan the HD index range and register the
                    //    index-5 contract the baseline + band missed ──────────────
                    await b.wallet.restore();

                    const after = (await b.wallet.getBalance()).total;
                    // restore() is load-bearing: it raised B's balance by
                    // discovering the gapped (index-5) contract. Offchain receive
                    // loses no value, so B recovers the full funded total.
                    expect(after).toBeGreaterThan(before);
                    expect(after).toBeGreaterThanOrEqual(totalFunded);

                    const vtxosAfter = await b.wallet.getVtxos();
                    expect(vtxosAfter.length).toBeGreaterThan(0);
                } finally {
                    await b.wallet.dispose();
                }
            } finally {
                await a.wallet.dispose();
            }
        },
    );
});
