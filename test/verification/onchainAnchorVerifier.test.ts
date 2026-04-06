import { describe, it, expect, vi, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { verifyOnchainAnchor } from "../../src/verification/onchainAnchorVerifier";
import type { OnchainProvider } from "../../src/providers/onchain";

// Build a real raw tx with a taproot output for mocking getTxHex
const expectedAmount = 100_000n;
const expectedScript = new Uint8Array(34);
expectedScript[0] = 0x51;
expectedScript[1] = 0x20;
expectedScript.set(new Uint8Array(32).fill(0xab), 2);

function buildMockCommitmentTxHex(): string {
    const tx = new Transaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        finalScriptSig: new Uint8Array(0),
    });
    tx.addOutput({ script: expectedScript, amount: expectedAmount });
    return hex.encode(tx.toBytes());
}

const mockTxHex = buildMockCommitmentTxHex();

describe("verifyOnchainAnchor", () => {
    const commitmentTxid =
        "aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd";
    const expectedOutputIndex = 0;

    let mockOnchain: OnchainProvider;

    beforeEach(() => {
        mockOnchain = {
            getTxStatus: vi.fn().mockResolvedValue({
                confirmed: true,
                blockHeight: 100,
                blockTime: 1700000000,
            }),
            getChainTip: vi.fn().mockResolvedValue({
                height: 110,
                time: 1700001000,
                hash: "00".repeat(32),
            }),
            getTxHex: vi.fn().mockResolvedValue(mockTxHex),
            getTxOutspends: vi
                .fn()
                .mockResolvedValue([{ spent: false, txid: "" }]),
            getCoins: vi.fn(),
            getFeeRate: vi.fn(),
            broadcastTransaction: vi.fn(),
            getTransactions: vi.fn(),
            watchAddresses: vi.fn(),
        } as OnchainProvider;
    });

    describe("confirmation depth", () => {
        it("should report confirmed with correct depth", async () => {
            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result.confirmed).toBe(true);
            expect(result.confirmationDepth).toBe(11);
            expect(result.errors).toHaveLength(0);
        });

        it("should warn when confirmation depth is below minimum", async () => {
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 108,
                blockTime: 1700000900,
            });

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result.confirmationDepth).toBe(3);
            expect(
                result.warnings.some((w) => /[Ll]ow confirmation/i.test(w))
            ).toBe(true);
        });

        it("should error when commitment tx is unconfirmed", async () => {
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({ confirmed: false });

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result.confirmed).toBe(false);
            expect(result.errors.some((e) => /not confirmed/i.test(e))).toBe(
                true
            );
        });

        it("should handle getTxStatus failure gracefully", async () => {
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockRejectedValue(new Error("connection refused"));

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(
                result.errors.some((e) => /connection refused/i.test(e))
            ).toBe(true);
        });
    });

    describe("output amount and script verification", () => {
        it("should pass when amount and script both match", async () => {
            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result.outputMatches).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it("should error when output amount does not match", async () => {
            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount + 1n,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result.outputMatches).toBe(false);
            expect(result.errors.some((e) => /amount/i.test(e))).toBe(true);
        });

        it("should error when output script does not match", async () => {
            const wrongScript = new Uint8Array(expectedScript);
            wrongScript[wrongScript.length - 1] ^= 0x01;

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                wrongScript,
                mockOnchain,
                6
            );

            expect(result.outputMatches).toBe(false);
            expect(result.errors.some((e) => /script/i.test(e))).toBe(true);
        });

        it("should error when both amount and script mismatch", async () => {
            const wrongScript = new Uint8Array(expectedScript);
            wrongScript[wrongScript.length - 1] ^= 0x01;

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount + 999n,
                wrongScript,
                mockOnchain,
                6
            );

            expect(result.outputMatches).toBe(false);
            expect(result.errors.some((e) => /amount/i.test(e))).toBe(true);
            expect(result.errors.some((e) => /script/i.test(e))).toBe(true);
        });

        it("should error when output index is out of bounds", async () => {
            const result = await verifyOnchainAnchor(
                commitmentTxid,
                99,
                expectedAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result.outputMatches).toBe(false);
            expect(
                result.errors.some((e) => /outputs.*expected/i.test(e))
            ).toBe(true);
        });

        it("should handle getTxHex failure gracefully", async () => {
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockRejectedValue(new Error("hex not available"));

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result.outputMatches).toBe(false);
            expect(
                result.errors.some((e) => /hex not available/i.test(e))
            ).toBe(true);
        });
    });

    describe("double-spend detection", () => {
        it("should warn when batch output has been spent", async () => {
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([{ spent: true, txid: "spender-txid" }]);

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result.doubleSpent).toBe(true);
            // Spending is reported as warning (not error) because in Ark
            // the batch output IS spent by tree txs during normal operation
            expect(result.warnings.some((w) => /spent/i.test(w))).toBe(true);
            expect(result.errors.some((e) => /spent/i.test(e))).toBe(false);
        });

        it("should pass when batch output is unspent", async () => {
            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result.doubleSpent).toBe(false);
        });

        it("should warn when outspend check fails", async () => {
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockRejectedValue(new Error("rate limited"));

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result.warnings.some((w) => /rate limited/i.test(w))).toBe(
                true
            );
        });

        it("should handle outspend index beyond array length", async () => {
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([]);

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result.doubleSpent).toBe(false);
        });
    });

    describe("edge cases", () => {
        it("should handle getChainTip failure after confirmed status", async () => {
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 100,
                blockTime: 1700000000,
            });
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockRejectedValue(new Error("chain tip unavailable"));

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result.confirmed).toBe(false);
            expect(
                result.errors.some((e) => /chain tip unavailable/i.test(e))
            ).toBe(true);
        });

        it("should return all fields on early error return", async () => {
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockRejectedValue(new Error("offline"));

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result).toHaveProperty("commitmentTxid", commitmentTxid);
            expect(result).toHaveProperty("confirmed", false);
            expect(result).toHaveProperty("confirmationDepth", 0);
            expect(result).toHaveProperty("outputMatches", false);
            expect(result).toHaveProperty("doubleSpent", false);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        it("should accumulate errors from multiple failing checks", async () => {
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({ confirmed: false });

            const wrongScript = new Uint8Array(expectedScript);
            wrongScript[wrongScript.length - 1] ^= 0x01;

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount + 1n,
                wrongScript,
                mockOnchain,
                6
            );

            expect(result.confirmed).toBe(false);
            expect(result.errors.length).toBeGreaterThanOrEqual(2);
            expect(result.errors.some((e) => /not confirmed/i.test(e))).toBe(
                true
            );
        });

        it("should accept minDepth of 1 with exact depth match", async () => {
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 110,
                blockTime: 1700001000,
            });

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                expectedScript,
                mockOnchain,
                1
            );

            expect(result.confirmationDepth).toBe(1);
            expect(result.warnings).toHaveLength(0);
        });
    });

    describe("output amount mismatch with real tx", () => {
        it("should error when amount differs from expected", async () => {
            const wrongAmount = 999_999n; // expected is 100_000n
            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                wrongAmount,
                expectedScript,
                mockOnchain,
                6
            );

            expect(result.outputMatches).toBe(false);
            expect(result.errors.some((e) => /amount mismatch/i.test(e))).toBe(
                true
            );
        });

        it("should error when script differs from expected", async () => {
            const wrongScript = new Uint8Array(34);
            wrongScript[0] = 0x51;
            wrongScript[1] = 0x20;
            wrongScript.set(new Uint8Array(32).fill(0xff), 2);

            const result = await verifyOnchainAnchor(
                commitmentTxid,
                expectedOutputIndex,
                expectedAmount,
                wrongScript,
                mockOnchain,
                6
            );

            expect(result.outputMatches).toBe(false);
            expect(result.errors.some((e) => /script mismatch/i.test(e))).toBe(
                true
            );
        });
    });
});
