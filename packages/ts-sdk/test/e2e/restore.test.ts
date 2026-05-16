import { expect, describe, it, beforeEach } from "vitest";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
    beforeEachFaucet,
    createSharedRepos,
    createTestArkWalletFromMnemonic,
    faucetOffchain,
    waitFor,
} from "./utils";

/**
 * `restore()` is only load-bearing when funds sit at a script the
 * wallet's baseline auto-registration does NOT cover.
 *
 * `Wallet.create` → `initializeContractManager` registers a baseline
 * `default` contract at `identity.xOnlyPublicKey()`. For a
 * `MnemonicIdentity`, that key is the BIP-86 index-0 child
 * (`m/86'/.../0/0`). `HDDescriptorProvider.materializeDescriptorAt(0)`
 * derives the SAME index-0 key, so a fresh HD wallet's *first* receive
 * address is exactly the baseline. A same-seed fresh wallet would
 * therefore already see index-0 funds via baseline auto-registration —
 * making a single-receive restore test VACUOUS.
 *
 * To make `restore()` actually do work, funds must land at a ROTATED
 * HD index (≥ 1). The receive rotator advances the displayed address on
 * every `vtxo_received` for the current display contract. So we:
 *   1. Fund A's index-0 (baseline) address → watcher fires
 *      `vtxo_received` → rotation moves the display to index-1.
 *   2. Fund A's NEW (index-1) address.
 *
 * A fresh wallet B on the same seed only auto-registers the index-0
 * baseline. It can see the index-0 funds but NOT the index-1 funds
 * until `restore()`'s gap scan discovers and registers the index-1
 * contract. That is the load-bearing property this test asserts.
 */
describe("Wallet.restore()", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "recovers HD-rotated funds a fresh same-seed repo cannot see without restore()",
        { timeout: 120000 },
        async () => {
            const mnemonic = generateMnemonic(wordlist);

            // ── Wallet A: HD mode, original instance ──────────────────────
            const a = await createTestArkWalletFromMnemonic(
                mnemonic,
                undefined,
                "hd"
            );

            // A's first receive address is the index-0 baseline (==
            // identity.xOnlyPublicKey()). Funding it triggers a
            // `vtxo_received`, which rotates the display to index-1.
            const baselineAddress = await a.wallet.getAddress();
            expect(baselineAddress).toBeDefined();

            faucetOffchain(baselineAddress!, 100_000);

            // Wait for A to see the index-0 VTXO.
            await waitFor(async () => (await a.wallet.getVtxos()).length > 0, {
                timeout: 60_000,
                interval: 1_000,
            });

            // Wait for the receive rotation to advance the displayed
            // address off the index-0 baseline. After this, getAddress()
            // returns the index-1 (HD-derived, non-baseline) address.
            let rotatedAddress = baselineAddress!;
            await waitFor(
                async () => {
                    rotatedAddress = await a.wallet.getAddress();
                    return rotatedAddress !== baselineAddress;
                },
                { timeout: 60_000, interval: 1_000 }
            );
            expect(rotatedAddress).not.toBe(baselineAddress);

            // Fund the ROTATED (index-1) address. These funds live at a
            // script the index-0 baseline auto-registration does NOT
            // cover.
            faucetOffchain(rotatedAddress, 100_000);

            // Wait until A sees both VTXOs (index-0 + index-1).
            await waitFor(async () => (await a.wallet.getVtxos()).length >= 2, {
                timeout: 60_000,
                interval: 1_000,
            });

            const totalA = (await a.wallet.getBalance()).total;
            // Sanity: A received two 100_000 faucets offchain (no fee on
            // an arkd `ark send`), so it holds the full sum.
            expect(totalA).toBe(200_000);

            await a.wallet.dispose();

            // ── Wallet B: same seed, HD mode, FRESH separate repos ────────
            const freshRepos = createSharedRepos();
            const b = await createTestArkWalletFromMnemonic(
                mnemonic,
                freshRepos,
                "hd"
            );

            // B's baseline auto-registration covers ONLY the index-0
            // script. It will (after its watcher syncs) credit the
            // index-0 funds but can never see the index-1 funds — so
            // `before` is strictly LESS than the full A total. This is
            // the robust replacement for the old, false `=== 0`
            // assertion.
            const before = (await b.wallet.getBalance()).total;
            expect(before).toBeLessThan(totalA);

            // ── restore() must scan the HD index range and register the
            //    index-1 contract the baseline missed ──────────────────────
            await b.wallet.restore();

            const after = (await b.wallet.getBalance()).total;
            // restore() is load-bearing: it raised B's balance by
            // discovering the rotated (index-1) contract. Offchain
            // receive loses no value, so B recovers the full A total.
            expect(after).toBeGreaterThan(before);
            expect(after).toBeGreaterThanOrEqual(totalA);

            const vtxosAfter = await b.wallet.getVtxos();
            expect(vtxosAfter.length).toBeGreaterThan(0);

            await b.wallet.dispose();
        }
    );
});
