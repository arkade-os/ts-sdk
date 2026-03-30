import { describe, it, expect, vi } from "vitest";
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { verifyOnchainAnchor } from "../../src/verification/onchainAnchorVerifier";
import type { OnchainProvider } from "../../src/providers/onchain";

function createMockOnchainProvider(
    overrides: Partial<OnchainProvider> = {}
): OnchainProvider {
    return {
        getCoins: vi.fn(),
        getFeeRate: vi.fn(),
        broadcastTransaction: vi.fn(),
        getTxOutspends: vi.fn().mockResolvedValue([]),
        getTransactions: vi.fn(),
        getTxStatus: vi.fn().mockResolvedValue({
            confirmed: true,
            blockHeight: 100,
            blockTime: 1700000000,
        }),
        getTxHex: vi.fn(),
        getChainTip: vi.fn().mockResolvedValue({
            height: 110,
            time: 1700001000,
            hash: "0".repeat(64),
        }),
        watchAddresses: vi.fn(),
        ...overrides,
    };
}

// Build a simple transaction with known output for testing
function buildMockCommitmentTx(
    outputAmount: bigint,
    outputScript: Uint8Array
): { tx: Transaction; txHex: string } {
    const tx = new Transaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(1),
        index: 0,
    });
    tx.addOutput({
        amount: outputAmount,
        script: outputScript,
    });
    const raw = tx.toBytes(true, false);
    return { tx, txHex: hex.encode(raw) };
}

describe("verifyOnchainAnchor", () => {
    const outputAmount = 10000n;
    const outputScript = new Uint8Array(34).fill(0xab);
    // set valid p2tr-like script prefix
    outputScript[0] = 0x51; // OP_1
    outputScript[1] = 0x20; // push 32 bytes

    const { txHex } = buildMockCommitmentTx(outputAmount, outputScript);
    const commitmentTxid = "a".repeat(64);

    it("should return valid result for confirmed tx with matching output", async () => {
        const provider = createMockOnchainProvider({
            getTxHex: vi.fn().mockResolvedValue(txHex),
            getTxOutspends: vi
                .fn()
                .mockResolvedValue([{ spent: false, txid: "" }]),
        });

        const result = await verifyOnchainAnchor(
            commitmentTxid,
            0,
            outputAmount,
            outputScript,
            provider,
            6
        );

        expect(result.confirmed).toBe(true);
        expect(result.confirmationDepth).toBe(11); // 110 - 100 + 1
        expect(result.outputMatches).toBe(true);
        expect(result.doubleSpent).toBe(false);
        expect(result.errors).toHaveLength(0);
        expect(result.warnings).toHaveLength(0);
    });

    it("should report error for unconfirmed tx", async () => {
        const provider = createMockOnchainProvider({
            getTxStatus: vi.fn().mockResolvedValue({ confirmed: false }),
            getTxHex: vi.fn().mockResolvedValue(txHex),
            getTxOutspends: vi
                .fn()
                .mockResolvedValue([{ spent: false, txid: "" }]),
        });

        const result = await verifyOnchainAnchor(
            commitmentTxid,
            0,
            outputAmount,
            outputScript,
            provider
        );

        expect(result.confirmed).toBe(false);
        expect(result.confirmationDepth).toBe(0);
        expect(result.errors).toContain(
            "Commitment transaction is not confirmed"
        );
    });

    it("should warn on low confirmation depth", async () => {
        const provider = createMockOnchainProvider({
            getTxStatus: vi.fn().mockResolvedValue({
                confirmed: true,
                blockHeight: 108,
                blockTime: 1700000000,
            }),
            getTxHex: vi.fn().mockResolvedValue(txHex),
            getTxOutspends: vi
                .fn()
                .mockResolvedValue([{ spent: false, txid: "" }]),
        });

        const result = await verifyOnchainAnchor(
            commitmentTxid,
            0,
            outputAmount,
            outputScript,
            provider,
            6
        );

        expect(result.confirmed).toBe(true);
        expect(result.confirmationDepth).toBe(3); // 110 - 108 + 1
        expect(
            result.warnings.some((w) => w.includes("Low confirmation depth"))
        ).toBe(true);
    });

    it("should report error for amount mismatch", async () => {
        const provider = createMockOnchainProvider({
            getTxHex: vi.fn().mockResolvedValue(txHex),
            getTxOutspends: vi
                .fn()
                .mockResolvedValue([{ spent: false, txid: "" }]),
        });

        const result = await verifyOnchainAnchor(
            commitmentTxid,
            0,
            99999n, // wrong amount
            outputScript,
            provider
        );

        expect(result.outputMatches).toBe(false);
        expect(
            result.errors.some((e) => e.includes("Output amount mismatch"))
        ).toBe(true);
    });

    it("should report error for script mismatch", async () => {
        const wrongScript = new Uint8Array(34).fill(0xcd);
        wrongScript[0] = 0x51;
        wrongScript[1] = 0x20;

        const provider = createMockOnchainProvider({
            getTxHex: vi.fn().mockResolvedValue(txHex),
            getTxOutspends: vi
                .fn()
                .mockResolvedValue([{ spent: false, txid: "" }]),
        });

        const result = await verifyOnchainAnchor(
            commitmentTxid,
            0,
            outputAmount,
            wrongScript,
            provider
        );

        expect(result.outputMatches).toBe(false);
        expect(
            result.errors.some((e) => e.includes("Output script mismatch"))
        ).toBe(true);
    });

    it("should report error for double-spent output", async () => {
        const spendingTxid = "b".repeat(64);
        const provider = createMockOnchainProvider({
            getTxHex: vi.fn().mockResolvedValue(txHex),
            getTxOutspends: vi
                .fn()
                .mockResolvedValue([{ spent: true, txid: spendingTxid }]),
        });

        const result = await verifyOnchainAnchor(
            commitmentTxid,
            0,
            outputAmount,
            outputScript,
            provider
        );

        expect(result.doubleSpent).toBe(true);
        expect(result.errors.some((e) => e.includes("has been spent"))).toBe(
            true
        );
    });

    it("should report error when tx not found (getTxStatus throws)", async () => {
        const provider = createMockOnchainProvider({
            getTxStatus: vi.fn().mockRejectedValue(new Error("Not Found")),
            getTxHex: vi.fn().mockResolvedValue(txHex),
        });

        const result = await verifyOnchainAnchor(
            commitmentTxid,
            0,
            outputAmount,
            outputScript,
            provider
        );

        expect(result.confirmed).toBe(false);
        expect(
            result.errors.some((e) =>
                e.includes("Failed to get commitment tx status")
            )
        ).toBe(true);
    });

    it("should report error when output index is out of bounds", async () => {
        const provider = createMockOnchainProvider({
            getTxHex: vi.fn().mockResolvedValue(txHex),
            getTxOutspends: vi
                .fn()
                .mockResolvedValue([{ spent: false, txid: "" }]),
        });

        const result = await verifyOnchainAnchor(
            commitmentTxid,
            5, // out of bounds
            outputAmount,
            outputScript,
            provider
        );

        expect(result.outputMatches).toBe(false);
        expect(
            result.errors.some((e) => e.includes("outputs, expected at least"))
        ).toBe(true);
    });

    it("should handle getTxHex failure gracefully", async () => {
        const provider = createMockOnchainProvider({
            getTxHex: vi.fn().mockRejectedValue(new Error("Network error")),
            getTxOutspends: vi
                .fn()
                .mockResolvedValue([{ spent: false, txid: "" }]),
        });

        const result = await verifyOnchainAnchor(
            commitmentTxid,
            0,
            outputAmount,
            outputScript,
            provider
        );

        expect(result.outputMatches).toBe(false);
        expect(
            result.errors.some((e) =>
                e.includes("Failed to fetch commitment tx hex")
            )
        ).toBe(true);
    });

    it("should warn when outspend check fails", async () => {
        const provider = createMockOnchainProvider({
            getTxHex: vi.fn().mockResolvedValue(txHex),
            getTxOutspends: vi
                .fn()
                .mockRejectedValue(new Error("Service unavailable")),
        });

        const result = await verifyOnchainAnchor(
            commitmentTxid,
            0,
            outputAmount,
            outputScript,
            provider
        );

        // Should still succeed on other checks, just warn about outspend
        expect(result.doubleSpent).toBe(false);
        expect(
            result.warnings.some((w) =>
                w.includes("Failed to check double-spend")
            )
        ).toBe(true);
    });
});
