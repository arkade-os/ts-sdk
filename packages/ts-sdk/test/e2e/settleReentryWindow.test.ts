/**
 * DIAGNOSTIC e2e — measures / reproduces the coinflip settle-UI-hang window.
 *
 * Question it answers: after `settle(undefined)` sweeps a boarding UTXO, does that
 * coin still come back from `getBoardingUtxos()` before the commitment tx confirms?
 * If so, a SECOND `settle(undefined)` — coinflip fires one from the auto-settle in
 * refreshBalance AND one from the manual button — re-selects an already-committed
 * input and the round hangs. That hang is what coinflip worked around client-side
 * with a `singleFlight` (PR #45).
 *
 * `getBoardingUtxos()` -> `onchainProvider.getCoins()` -> esplora `/address/{a}/utxo`.
 * Whether the window exists hinges on that endpoint's mempool-awareness — operational
 * timing that cannot be settled by reading the SDK source, only by running this.
 *
 * The SDK already serializes settles (`_withTxLock`); the gap is that a second
 * settle-all is not *idempotent* — it re-derives inputs from a now-stale view. The
 * fix is to coalesce a concurrent `settle(undefined)` (what `singleFlight` does, one
 * layer too low). This test FAILS while the hang reproduces and PASSES once the SDK
 * coalesces — i.e. it doubles as the regression gate for that fix.
 *
 * Run (regtest stack must be up: arkd @ :7070, esplora @ :3000, `regtest.mjs` wired):
 *   cd packages/ts-sdk && npx vitest run test/e2e/settleReentryWindow.test.ts
 */
import { describe, it, expect } from "vitest";
import {
    Wallet,
    SingleKey,
    EsploraProvider,
    InMemoryWalletRepository,
    InMemoryContractRepository,
} from "../../src";
import { execFileSync } from "child_process";

const ARK_URL = "http://localhost:7070";
const ESPLORA_URL = "http://localhost:3000/api";

async function waitFor(
    fn: () => Promise<boolean>,
    { timeout = 30_000, interval = 500 } = {},
): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error("waitFor: timed out");
}

describe("Settle-all re-entry window (coinflip settle-UI-hang)", () => {
    it(
        "a second settle() right after the first must not hang on a re-selected boarding input",
        { timeout: 180_000 },
        async () => {
            const wallet = await Wallet.create({
                identity: SingleKey.fromRandomBytes(),
                arkServerUrl: ARK_URL,
                onchainProvider: new EsploraProvider(ESPLORA_URL, {
                    forcePolling: true,
                    pollingInterval: 2000,
                }),
                storage: {
                    walletRepository: new InMemoryWalletRepository(),
                    contractRepository: new InMemoryContractRepository(),
                },
                // No background VtxoManager: we drive BOTH settles by hand, exactly
                // like coinflip's auto-settle + manual-button pair.
                settlementConfig: false,
            });

            try {
                // 1. Board a coin and confirm it (--confirm mines one block).
                const boardingAddress = await wallet.getBoardingAddress();
                // execFileSync passes args directly (no shell) — injection-safe even
                // though boardingAddress is wallet-derived. --confirm mines one block.
                execFileSync(
                    "node",
                    ["regtest/regtest.mjs", "faucet", boardingAddress, "0.001", "--confirm"],
                    { encoding: "utf8" },
                );
                // Wait for the boarding UTXO to be CONFIRMED — settle(undefined)
                // filters unconfirmed boarding (wallet.ts:2666), so settling the
                // moment it merely appears throws "No inputs found".
                await waitFor(async () => {
                    const b = await wallet.getBoardingUtxos();
                    return b.length > 0 && b[0].status.confirmed === true;
                });

                const before = await wallet.getBoardingUtxos();
                expect(before.length).toBe(1);

                // 2. Fire TWO settle-alls concurrently — coinflip's auto-settle (in
                //    refreshBalance) and the manual button. `_withTxLock` serializes
                //    them, so B acquires the lock exactly when A releases it: round
                //    finalized, commitment broadcast. A direct measurement (an earlier
                //    revision of this test) showed the swept boarding coin then lingers
                //    in getBoardingUtxos for ~2s — esplora keeps it until the commitment
                //    confirms. If B reads boarding inside that window it re-selects an
                //    already-committed input and its round can't sign it → the hang.
                const HANG = "HANG (no resolve/throw within 90s)";
                const a = wallet.settle();
                const b = wallet.settle().then(
                    (txid) => `resolved ${txid}`,
                    (err) => `threw "${(err as Error).message}"`,
                );
                b.catch(() => {}); // a late rejection after the race must not go unhandled

                const aTxid = await a;
                expect(aTxid).toHaveLength(64);

                const outcome = await Promise.race([
                    b,
                    new Promise<string>((r) => setTimeout(() => r(HANG), 90_000)),
                ]);
                // eslint-disable-next-line no-console
                console.log(`[settle-window] concurrent 2nd settle-all outcome: ${outcome}`);

                expect(
                    outcome,
                    "2nd concurrent settle(undefined) hung — reproduces the coinflip settle-UI-hang. " +
                        "The SDK should coalesce / idempotently handle a concurrent settle-all " +
                        "instead of re-selecting an already-committed boarding input.",
                ).not.toBe(HANG);
            } finally {
                await wallet.dispose().catch(() => {});
            }
        },
    );
});
