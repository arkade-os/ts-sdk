import { describe, it, expect, vi } from "vitest";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { Transaction } from "@scure/btc-signer";
import { hex } from "@scure/base";
import type { VirtualCoin } from "../../src/wallet";
import { SingleKey } from "../../src/identity/singleKey";
import { ReadonlyWallet } from "../../src/wallet/wallet";
import {
    InMemoryContractRepository,
    InMemoryWalletRepository,
} from "../../src/repositories";
import { InMemoryExitDataRepository } from "../../src/verification/exitDataStore";

/**
 * Lightweight contract tests for the standalone client-side verification API.
 * These avoid constructing full wallet instances and keep the verification
 * surface decoupled from wallet/runtime wrappers.
 */
describe("Verification API contract", () => {
    it("verifyVtxo should return VtxoVerificationResult shape", async () => {
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

describe("wallet exit-data sync", () => {
    it("persists exit data automatically during wallet VTXO sync", async () => {
        const identity = await SingleKey.fromPrivateKey(
            randomPrivateKeyBytes()
        ).toReadonly();
        const signerPubkey = await SingleKey.fromPrivateKey(
            randomPrivateKeyBytes()
        ).compressedPublicKey();
        const exitRepo = new InMemoryExitDataRepository();

        const mockArkProvider = {
            getInfo: vi.fn().mockResolvedValue({
                network: "mutinynet",
                signerPubkey: hex.encode(signerPubkey),
                unilateralExitDelay: 144n,
                boardingExitDelay: 144n,
                dust: 450n,
            }),
        } as any;

        const mockIndexer = {
            getVtxos: vi.fn().mockImplementation(async (opts?: any) => ({
                vtxos: [
                    {
                        txid: "aa".repeat(32),
                        vout: 0,
                        value: 10_000,
                        status: { confirmed: true },
                        createdAt: new Date(1700000000000),
                        isUnrolled: false,
                        isSpent: false,
                        script: opts?.scripts?.[0],
                        virtualStatus: {
                            state: "settled",
                            commitmentTxIds: ["cc".repeat(32)],
                        },
                    },
                ],
            })),
            getVtxoChain: vi.fn().mockResolvedValue({
                chain: [
                    {
                        txid: "cc".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: "aa".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: ["cc".repeat(32)],
                    },
                ],
            }),
            getVirtualTxs: vi.fn().mockResolvedValue({
                txs: [await validPsbtBase64("aa".repeat(32))],
            }),
            getVtxoTree: vi.fn(),
            getVtxoTreeLeaves: vi.fn(),
            getBatchSweepTransactions: vi.fn(),
            getCommitmentTx: vi.fn(),
            getCommitmentTxConnectors: vi.fn(),
            getCommitmentTxForfeitTxs: vi.fn(),
            getSubscription: vi.fn(),
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

        const wallet = await ReadonlyWallet.create({
            identity,
            arkServerUrl: "https://ark.example.test",
            arkProvider: mockArkProvider,
            indexerProvider: mockIndexer,
            onchainProvider: mockOnchain,
            storage: {
                walletRepository: new InMemoryWalletRepository(),
                contractRepository: new InMemoryContractRepository(),
                exitDataRepository: exitRepo,
            },
        });

        const vtxos = await wallet.getVtxos();
        const exitData = await exitRepo.getExitData({
            txid: vtxos[0].txid,
            vout: vtxos[0].vout,
        });

        expect(exitData).not.toBeNull();
        expect(exitData?.claimInput?.txid).toBe(vtxos[0].txid);
        expect(mockIndexer.getVtxoChain).toHaveBeenCalled();
    });
});

function taprootOutputScript(xOnlyKey: Uint8Array): Uint8Array {
    const script = new Uint8Array(34);
    script[0] = 0x51;
    script[1] = 0x20;
    script.set(xOnlyKey, 2);
    return script;
}

async function validPsbtBase64(seedHex: string): Promise<string> {
    const tx = new Transaction();
    const inputKey = await SingleKey.fromPrivateKey(
        randomPrivateKeyBytes()
    ).xOnlyPublicKey();
    const outputKey = await SingleKey.fromPrivateKey(
        randomPrivateKeyBytes()
    ).xOnlyPublicKey();
    tx.addOutput({
        script: taprootOutputScript(outputKey),
        amount: 10_000n,
    });
    tx.addInput({
        txid: hex.decode(seedHex),
        index: 0,
        witnessUtxo: {
            script: taprootOutputScript(inputKey),
            amount: 10_000n,
        },
        tapKeySig: new Uint8Array(64).fill(0x22),
    });

    return Buffer.from(tx.toPSBT()).toString("base64");
}
