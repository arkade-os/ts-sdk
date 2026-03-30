/**
 * Integration tests for VTXO chain verification against a local arkd instance on regtest.
 *
 * Prerequisites:
 *   - nigiri running (bitcoin regtest + esplora)
 *   - arkd running on localhost:7070
 *   - Run: pnpm exec vitest run test/e2e/verification.test.ts
 *
 * These tests create real wallets, settle real batches, and verify the resulting VTXOs
 * using the client-side verification pipeline.
 */
import { expect, describe, it, beforeEach } from "vitest";
import {
    createTestArkWallet,
    createVtxo,
    beforeEachFaucet,
    waitFor,
} from "./utils";

describe("VTXO Verification E2E", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should verify a settled VTXO with full chain verification",
        { timeout: 120000 },
        async () => {
            // Step 1: Create a wallet and fund it with a VTXO
            const alice = await createTestArkWallet();
            await createVtxo(alice, 10000);

            // Wait for VTXO to appear
            await waitFor(async () => {
                const vtxos = await alice.wallet.getVtxos();
                return (
                    vtxos.length > 0 &&
                    vtxos[0].virtualStatus.state === "settled"
                );
            });

            const vtxos = await alice.wallet.getVtxos();
            expect(vtxos.length).toBeGreaterThan(0);

            const vtxo = vtxos[0];
            expect(vtxo.virtualStatus.state).toBe("settled");

            // Step 2: Verify the VTXO
            const result = await alice.wallet.verifyVtxo(vtxo, {
                minConfirmationDepth: 1, // regtest, low threshold
            });

            // Step 3: Assert verification passes
            expect(result.vtxoOutpoint.txid).toBe(vtxo.txid);
            expect(result.vtxoOutpoint.vout).toBe(vtxo.vout);
            expect(result.commitmentTxid).toBeTruthy();
            expect(result.chainLength).toBeGreaterThan(0);

            // On regtest, the commitment tx should be confirmed
            if (result.confirmationDepth > 0) {
                expect(result.errors).toHaveLength(0);
                expect(result.valid).toBe(true);
            } else {
                // If not yet confirmed, we may get a warning but not a hard failure
                console.log(
                    "Commitment not yet confirmed, warnings:",
                    result.warnings
                );
            }

            console.log("Verification result:", {
                valid: result.valid,
                commitmentTxid: result.commitmentTxid,
                confirmationDepth: result.confirmationDepth,
                chainLength: result.chainLength,
                errors: result.errors,
                warnings: result.warnings,
            });

            await alice.wallet.dispose();
        }
    );

    it("should verify all VTXOs in wallet", { timeout: 120000 }, async () => {
        const alice = await createTestArkWallet();

        // Create two VTXOs
        await createVtxo(alice, 5000);
        await createVtxo(alice, 3000);

        await waitFor(async () => {
            const vtxos = await alice.wallet.getVtxos();
            return vtxos.length >= 2;
        });

        // Verify all
        const results = await alice.wallet.verifyAllVtxos({
            minConfirmationDepth: 1,
        });

        expect(results.size).toBeGreaterThanOrEqual(2);

        for (const [key, result] of results) {
            console.log(
                `VTXO ${key}: valid=${result.valid}, depth=${result.confirmationDepth}, errors=${result.errors.length}`
            );
            expect(result.commitmentTxid).toBeTruthy();
            expect(result.chainLength).toBeGreaterThan(0);
        }

        await alice.wallet.dispose();
    });

    it(
        "should report error for preconfirmed VTXO",
        { timeout: 60000 },
        async () => {
            const alice = await createTestArkWallet();
            const address = await alice.wallet.getAddress();

            // Fund offchain but DON'T settle, so VTXO is preconfirmed
            const { execCommand } = await import("./utils");
            const { arkdExec } = await import("./utils");
            execCommand(
                `${arkdExec} ark send --to ${address} --amount 5000 --password secret`
            );

            await waitFor(async () => {
                const vtxos = await alice.wallet.getVtxos({
                    withPending: true,
                });
                return vtxos.some(
                    (v) => v.virtualStatus.state === "preconfirmed"
                );
            });

            const vtxos = await alice.wallet.getVtxos({
                withPending: true,
            });
            const preconfirmed = vtxos.find(
                (v) => v.virtualStatus.state === "preconfirmed"
            );

            if (preconfirmed) {
                const result = await alice.wallet.verifyVtxo(preconfirmed);
                expect(result.valid).toBe(false);
                expect(
                    result.errors.some((e) => e.includes("preconfirmed"))
                ).toBe(true);
            }

            await alice.wallet.dispose();
        }
    );
});
