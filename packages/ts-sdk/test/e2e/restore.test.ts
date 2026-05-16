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

describe("Wallet.restore()", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "recovers balance on a fresh repo from the same seed",
        { timeout: 120000 },
        async () => {
            const mnemonic = generateMnemonic(wordlist);

            // ── Wallet A: original instance, receives funds ───────────────────
            const a = await createTestArkWalletFromMnemonic(mnemonic);
            const address = await a.wallet.getAddress();
            expect(address).toBeDefined();

            // Fund via the arkd faucet (offchain send)
            faucetOffchain(address!, 100_000);

            // Wait until Wallet A sees the VTXO
            await waitFor(async () => (await a.wallet.getVtxos()).length > 0, {
                timeout: 60_000,
                interval: 1_000,
            });

            const balanceA = await a.wallet.getBalance();
            expect(balanceA.total).toBeGreaterThan(0);

            await a.wallet.dispose();

            // ── Wallet B: same seed, FRESH repos — balance must be zero pre-restore ──
            const freshRepos = createSharedRepos();
            const b = await createTestArkWalletFromMnemonic(
                mnemonic,
                freshRepos
            );

            const balanceBefore = await b.wallet.getBalance();
            expect(balanceBefore.total).toBe(0);

            // ── restore() must scan arkd and repopulate the fresh repo ─────────
            await b.wallet.restore();

            const balanceAfter = await b.wallet.getBalance();
            expect(balanceAfter.total).toBeGreaterThan(0);

            const vtxosAfter = await b.wallet.getVtxos();
            expect(vtxosAfter.length).toBeGreaterThan(0);

            await b.wallet.dispose();
        }
    );
});
