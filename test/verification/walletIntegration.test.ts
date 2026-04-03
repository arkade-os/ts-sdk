import { describe, it, expect, vi } from "vitest";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { Transaction } from "@scure/btc-signer";
import { hex } from "@scure/base";
import type { VirtualCoin } from "../../src/wallet";
import { SingleKey } from "../../src/identity/singleKey";

/**
 * Tests for Wallet.verifyVtxo() and Wallet.verifyAllVtxos() wrappers.
 * These methods delegate to the standalone verifyVtxo/verifyAllVtxos
 * functions, wiring up indexer, onchain, and serverInfo from Wallet internals.
 *
 * Since Wallet construction requires a real arkProvider.getInfo() call,
 * these are kept as lightweight checks on the standalone functions
 * via the same interface the Wallet methods use.
 */
describe("Wallet verification method contract", () => {
    it("verifyVtxo should return VtxoVerificationResult shape", async () => {
        // Import the standalone function (same as Wallet calls internally)
        const { verifyVtxo } = await import(
            "../../src/verification/vtxoChainVerifier"
        );

        const mockIndexer = {
            getVtxoChain: vi.fn().mockResolvedValue({ chain: [] }),
            getVtxoTree: vi.fn(),
            getVirtualTxs: vi.fn(),
            getVtxoTreeLeaves: vi.fn(),
            getBatchSweepTransactions: vi.fn(),
            getCommitmentTx: vi.fn(),
            getCommitmentTxConnectors: vi.fn(),
            getCommitmentTxForfeitTxs: vi.fn(),
            getSubscription: vi.fn(),
            getVtxos: vi.fn(),
            getAssetDetails: vi.fn(),
            subscribeForScripts: vi.fn(),
            unsubscribeForScripts: vi.fn(),
        } as any;

        const mockOnchain = {
            getTxStatus: vi.fn(),
            getChainTip: vi.fn(),
            getTxHex: vi.fn(),
            getTxOutspends: vi.fn(),
            getCoins: vi.fn(),
            getFeeRate: vi.fn(),
            broadcastTransaction: vi.fn(),
            getTransactions: vi.fn(),
            watchAddresses: vi.fn(),
        } as any;

        const vtxo = {
            txid: "aa".repeat(32),
            vout: 0,
            value: 10_000n,
            virtualStatus: {
                state: "confirmed",
                batchTxid: "",
                commitmentTxIds: [],
            },
        } as VirtualCoin;

        const result = await verifyVtxo(vtxo, mockIndexer, mockOnchain, {
            pubkey: new Uint8Array(32),
            sweepInterval: { value: 144n, type: "blocks" as const },
        });

        // Verify the result shape matches what Wallet.verifyVtxo() returns
        expect(result).toHaveProperty("valid");
        expect(result).toHaveProperty("vtxoOutpoint");
        expect(result).toHaveProperty("commitmentTxid");
        expect(result).toHaveProperty("confirmationDepth");
        expect(result).toHaveProperty("chainLength");
        expect(result).toHaveProperty("errors");
        expect(result).toHaveProperty("warnings");
        expect(result.vtxoOutpoint.txid).toBe(vtxo.txid);
        expect(result.vtxoOutpoint.vout).toBe(vtxo.vout);
    });

    it("verifyAllVtxos should return Map keyed by outpoint", async () => {
        const { verifyAllVtxos } = await import(
            "../../src/verification/vtxoChainVerifier"
        );

        const mockIndexer = {
            getVtxoChain: vi.fn().mockResolvedValue({ chain: [] }),
            getVtxoTree: vi.fn(),
            getVirtualTxs: vi.fn(),
            getVtxoTreeLeaves: vi.fn(),
            getBatchSweepTransactions: vi.fn(),
            getCommitmentTx: vi.fn(),
            getCommitmentTxConnectors: vi.fn(),
            getCommitmentTxForfeitTxs: vi.fn(),
            getSubscription: vi.fn(),
            getVtxos: vi.fn(),
            getAssetDetails: vi.fn(),
            subscribeForScripts: vi.fn(),
            unsubscribeForScripts: vi.fn(),
        } as any;

        const mockOnchain = {
            getTxStatus: vi.fn(),
            getChainTip: vi.fn(),
            getTxHex: vi.fn(),
            getTxOutspends: vi.fn(),
            getCoins: vi.fn(),
            getFeeRate: vi.fn(),
            broadcastTransaction: vi.fn(),
            getTransactions: vi.fn(),
            watchAddresses: vi.fn(),
        } as any;

        const vtxo1 = {
            txid: "aa".repeat(32),
            vout: 0,
            value: 10_000n,
            virtualStatus: {
                state: "confirmed",
                batchTxid: "",
                commitmentTxIds: [],
            },
        } as VirtualCoin;

        const vtxo2 = {
            txid: "bb".repeat(32),
            vout: 1,
            value: 20_000n,
            virtualStatus: {
                state: "confirmed",
                batchTxid: "",
                commitmentTxIds: [],
            },
        } as VirtualCoin;

        const results = await verifyAllVtxos(
            [vtxo1, vtxo2],
            mockIndexer,
            mockOnchain,
            {
                pubkey: new Uint8Array(32),
                sweepInterval: { value: 144n, type: "blocks" as const },
            }
        );

        expect(results).toBeInstanceOf(Map);
        expect(results.size).toBe(2);
        expect(results.has(`${"aa".repeat(32)}:0`)).toBe(true);
        expect(results.has(`${"bb".repeat(32)}:1`)).toBe(true);
    });
});

describe("errorMessage shared utility", () => {
    it("should extract message from Error objects", async () => {
        const { errorMessage } = await import("../../src/verification/utils");
        expect(errorMessage(new Error("test error"))).toBe("test error");
    });

    it("should stringify non-Error values", async () => {
        const { errorMessage } = await import("../../src/verification/utils");
        expect(errorMessage("string error")).toBe("string error");
        expect(errorMessage(42)).toBe("42");
        expect(errorMessage(null)).toBe("null");
    });
});

describe("double-spend check is warning, not error", () => {
    it("verifyOnchainAnchor reports spent outputs as warnings, not errors", async () => {
        const { verifyOnchainAnchor } = await import(
            "../../src/verification/onchainAnchorVerifier"
        );

        const outputKey = await SingleKey.fromPrivateKey(
            randomPrivateKeyBytes()
        ).xOnlyPublicKey();
        const tx = new Transaction();
        tx.addInput({
            txid: new Uint8Array(32).fill(1),
            index: 0,
        });
        tx.addOutput({
            script: taprootOutputScript(outputKey),
            amount: 10_000n,
        });

        const mockOnchain = {
            getTxStatus: vi.fn().mockResolvedValue({
                confirmed: true,
                blockHeight: 1000,
                blockTime: 1700000000,
            }),
            getChainTip: vi.fn().mockResolvedValue({
                height: 1100,
                time: 1700001000,
                hash: "00".repeat(32),
            }),
            getTxHex: vi.fn().mockResolvedValue(hex.encode(tx.toBytes())),
            getTxOutspends: vi
                .fn()
                .mockResolvedValue([{ spent: true, txid: "ff".repeat(32) }]),
            getCoins: vi.fn(),
            getFeeRate: vi.fn(),
            broadcastTransaction: vi.fn(),
            getTransactions: vi.fn(),
            watchAddresses: vi.fn(),
        } as any;

        const result = await verifyOnchainAnchor(
            "aa".repeat(32),
            0,
            10_000n,
            taprootOutputScript(outputKey),
            mockOnchain
        );

        expect(result.doubleSpent).toBe(true);
        expect(
            result.warnings.some((warning) => /has been spent/i.test(warning))
        ).toBe(true);
        expect(
            result.errors.some((error) => /has been spent/i.test(error))
        ).toBe(false);
    });
});

function taprootOutputScript(xOnlyKey: Uint8Array): Uint8Array {
    const script = new Uint8Array(34);
    script[0] = 0x51;
    script[1] = 0x20;
    script.set(xOnlyKey, 2);
    return script;
}
