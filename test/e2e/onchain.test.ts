import { describe, expect, it } from "vitest";
import { createTestOnchainWallet } from "./utils";
import { execSync } from "child_process";

describe("Onchain integration tests", () => {
    it(
        "should perform a complete onchain roundtrip payment",
        { timeout: 30000 },
        async () => {
            // Create fresh wallet instances for this test
            const alice = createTestOnchainWallet();
            const bob = createTestOnchainWallet();

            // Initial balance check
            const aliceInitialBalance = await alice.wallet.getBalance();
            const bobInitialBalance = await bob.wallet.getBalance();
            expect(aliceInitialBalance).toBe(0);
            expect(bobInitialBalance).toBe(0);

            // Fund Alice's address using nigiri faucet
            const faucetAmountSats = 0.001 * 100_000_000; // Amount in sats
            execSync(`nigiri faucet ${alice.wallet.address} 0.001`);

            // Wait for the faucet transaction to be processed
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // Check Alice's balance after funding
            const aliceBalanceAfterFunding = await alice.wallet.getBalance();
            expect(aliceBalanceAfterFunding).toBe(faucetAmountSats);

            // Send from Alice to Bob
            const sendAmount = 50000; // 0.0005 BTC in sats
            await alice.wallet.send({
                address: bob.wallet.address,
                amount: sendAmount,
                feeRate: 2,
            });

            // Wait for the transaction to be processed
            await new Promise((resolve) => setTimeout(resolve, 5000));

            // Final balance check
            const aliceFinalBalance = await alice.wallet.getBalance();
            const bobFinalBalance = await bob.wallet.getBalance();

            // Verify the transaction was successful
            expect(bobFinalBalance).toBe(sendAmount);
            expect(aliceFinalBalance).toBeLessThan(aliceBalanceAfterFunding);
        }
    );
});
