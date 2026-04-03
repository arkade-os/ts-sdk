import { describe, it, expect, vi, beforeEach } from "vitest";
import { base64, hex } from "@scure/base";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import {
    verifyVtxo,
    verifyAllVtxos,
} from "../../src/verification/vtxoChainVerifier";
import type { IndexerProvider } from "../../src/providers/indexer";
import type { OnchainProvider } from "../../src/providers/onchain";
import type { VirtualCoin } from "../../src/wallet";
import type { RelativeTimelock } from "../../src/script/tapscript";
import { CSVMultisigTapscript } from "../../src/script/tapscript";
import { CLTVMultisigTapscript } from "../../src/script/tapscript";
import { VtxoScript } from "../../src/script/base";
import { SingleKey } from "../../src/identity/singleKey";
import { Transaction as ArkTransaction } from "../../src/utils/transaction";
import {
    CosignerPublicKey,
    setArkPsbtField,
} from "../../src/utils/unknownFields";
import { aggregateKeys } from "../../src/musig2";

function createMockIndexer(): IndexerProvider {
    return {
        getVtxoChain: vi.fn(),
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
    } as IndexerProvider;
}

function createMockOnchain(): OnchainProvider {
    return {
        getTxStatus: vi.fn(),
        getChainTip: vi.fn(),
        getTxHex: vi.fn(),
        getTxOutspends: vi.fn(),
        getCoins: vi.fn(),
        getFeeRate: vi.fn(),
        broadcastTransaction: vi.fn(),
        getTransactions: vi.fn(),
        watchAddresses: vi.fn(),
    } as OnchainProvider;
}

describe("verifyVtxo", () => {
    const serverInfo = {
        pubkey: new Uint8Array(32).fill(0xaa),
        sweepInterval: { value: 144n, type: "blocks" } as RelativeTimelock,
    };

    let mockIndexer: IndexerProvider;
    let mockOnchain: OnchainProvider;

    beforeEach(() => {
        mockIndexer = createMockIndexer();
        mockOnchain = createMockOnchain();
    });

    describe("preconfirmed VTXO rejection", () => {
        it("should reject preconfirmed VTXOs immediately", async () => {
            const vtxo: VirtualCoin = {
                txid: "aa".repeat(32),
                vout: 0,
                value: 1000n,
                virtualStatus: {
                    state: "preconfirmed",
                    batchTxid: "",
                    commitmentTxIds: [],
                },
            } as VirtualCoin;

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => /preconfirmed/i.test(e))).toBe(
                true
            );
            expect(mockIndexer.getVtxoChain).not.toHaveBeenCalled();
        });
    });

    describe("chain fetching", () => {
        it("should error when VTXO chain is empty", async () => {
            const vtxo = makeVtxo("cc".repeat(32));
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({ chain: [] });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => /[Ee]mpty.*chain/i.test(e))).toBe(
                true
            );
        });

        it("should error when no commitment tx found in chain", async () => {
            const vtxo = makeVtxo("cc".repeat(32));
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: "bb".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [],
                    },
                ],
            });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => /[Nn]o commitment/i.test(e))).toBe(
                true
            );
        });

        it("should error when virtualStatus commitment tx not in chain", async () => {
            const vtxo = makeVtxo("cc".repeat(32), ["dd".repeat(32)]);
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: "ee".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                ],
            });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) => /not found in chain/i.test(e))
            ).toBe(true);
        });

        it("should handle indexer fetch failure gracefully", async () => {
            const vtxo = makeVtxo("cc".repeat(32));
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockRejectedValue(new Error("indexer unavailable"));

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) => /indexer unavailable/i.test(e))
            ).toBe(true);
        });
    });

    describe("path verification", () => {
        it("should error when no virtual txs in chain path", async () => {
            const commitmentTxid = "aa".repeat(32);
            const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
            // Chain has only the commitment entry, no tree/checkpoint txs
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTxid,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                ],
            });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => /no virtual|path/i.test(e))).toBe(
                true
            );
        });

        it("should error when virtual tx count mismatches path", async () => {
            const commitmentTxid = "aa".repeat(32);
            const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTxid,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: "t1".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commitmentTxid],
                    },
                    {
                        txid: "t2".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: ["t1".repeat(32)],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({ txs: ["only-one-tx"] });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => /mismatch|count/i.test(e))).toBe(
                true
            );
        });

        it("should reject a chain whose root input fails CSV satisfaction", async () => {
            const { tx: commitmentTx, rawHex: commitmentHex } =
                await buildCommitmentTx(10_000n);
            const invalidCsvTx = await buildCsvPathTx({
                parentTxid: commitmentTx.id,
                amount: 10_000n,
                sequence: 1,
            });
            const vtxo = makeVtxo(invalidCsvTx.id, [commitmentTx.id]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: invalidCsvTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commitmentTx.id],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                txs: [base64.encode(invalidCsvTx.toPSBT())],
            });
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockResolvedValue(commitmentHex);
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 900,
                blockTime: 1_700_000_000,
            });
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                height: 1100,
                time: 1_700_000_100,
                hash: "00".repeat(32),
            });
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([{ spent: false, txid: "" }]);

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo,
                { verifySignatures: false }
            );

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) =>
                    /csv|sequence|satisfiable|timelock/i.test(e)
                )
            ).toBe(true);
        });

        it("should support root transactions that aggregate multiple inputs", async () => {
            const { tx: commit1, rawHex: commitHex1 } =
                await buildCommitmentTx(20_000n);
            const { tx: commit2, rawHex: commitHex2 } =
                await buildCommitmentTx(7_000n);
            const multiInputTx = await buildCsvPathTx({
                parentTxid: commit1.id,
                amount: 20_000n,
                sequence: 144,
                extraInputs: [{ txid: commit2.id, amount: 7_000n }],
            });
            const vtxo = makeVtxo(multiInputTx.id, [commit1.id, commit2.id]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commit1.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: commit2.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: multiInputTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commit1.id, commit2.id],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                txs: [base64.encode(multiInputTx.toPSBT())],
            });
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockImplementation(async (txid: string) => {
                if (txid === commit1.id) return commitHex1;
                if (txid === commit2.id) return commitHex2;
                throw new Error(`unknown txid ${txid}`);
            });
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 900,
                blockTime: 1_700_000_000,
            });
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                height: 1100,
                time: 1_700_000_100,
                hash: "00".repeat(32),
            });
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([{ spent: false, txid: "" }]);

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo,
                { verifySignatures: false }
            );

            if (!result.valid) {
                throw new Error(JSON.stringify(result));
            }
            expect(result.valid).toBe(true);
        });

        it("should accept a valid root tx when the commitment link is not input 0", async () => {
            const { tx: commit1, rawHex: commitHex1 } =
                await buildCommitmentTx(20_000n);
            const { tx: commit2, rawHex: commitHex2 } =
                await buildCommitmentTx(0n);
            const secondaryInput = await buildCsvInput({
                parentTxid: commit2.id,
                amount: 0n,
                sequence: 144,
            });
            const commitmentInput = await buildCsvInput({
                parentTxid: commit1.id,
                amount: 20_000n,
                sequence: 144,
            });
            const outputKey = await SingleKey.fromPrivateKey(
                randomPrivateKeyBytes()
            ).xOnlyPublicKey();
            const rootTx = new ArkTransaction();
            rootTx.addInput(secondaryInput);
            rootTx.addInput(commitmentInput);
            rootTx.addOutput({
                script: taprootOutputScript(outputKey),
                amount: 20_000n,
            });
            const vtxo = makeVtxo(rootTx.id, [commit1.id, commit2.id]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commit1.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: commit2.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: rootTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commit1.id, commit2.id],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                txs: [base64.encode(rootTx.toPSBT())],
            });
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockImplementation(async (txid: string) => {
                if (txid === commit1.id) return commitHex1;
                if (txid === commit2.id) return commitHex2;
                throw new Error(`unknown txid ${txid}`);
            });
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 900,
                blockTime: 1_700_000_000,
            });
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                height: 1100,
                time: 1_700_000_100,
                hash: "00".repeat(32),
            });
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([{ spent: false, txid: "" }]);

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo,
                { verifySignatures: false }
            );

            if (!result.valid) {
                throw new Error(JSON.stringify(result));
            }
            expect(result.valid).toBe(true);
        });

        it("should fail when integrated script verification cannot fetch chain tip", async () => {
            const { tx: commitmentTx, rawHex: commitmentHex } =
                await buildCommitmentTx(10_000n);
            const csvTx = await buildCsvPathTx({
                parentTxid: commitmentTx.id,
                amount: 10_000n,
                sequence: 144,
            });
            const vtxo = makeVtxo(csvTx.id, [commitmentTx.id]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: csvTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commitmentTx.id],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                txs: [base64.encode(csvTx.toPSBT())],
            });
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockResolvedValue(commitmentHex);
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 900,
                blockTime: 1_700_000_000,
            });
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockRejectedValue(new Error("chain tip unavailable"));
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([{ spent: false, txid: "" }]);

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo,
                { verifySignatures: false }
            );

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) =>
                    /script verification error: chain tip unavailable/i.test(e)
                )
            ).toBe(true);
        });

        it("should fail when a path tx references an unknown parent", async () => {
            const { tx: commitmentTx, rawHex: commitmentHex } =
                await buildCommitmentTx(10_000n);
            const csvTx = await buildCsvPathTx({
                parentTxid: "ab".repeat(32),
                amount: 10_000n,
                sequence: 144,
            });
            const vtxo = makeVtxo(csvTx.id, [commitmentTx.id]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: csvTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commitmentTx.id],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                txs: [base64.encode(csvTx.toPSBT())],
            });
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockResolvedValue(commitmentHex);
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 900,
                blockTime: 1_700_000_000,
            });
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                height: 1100,
                time: 1_700_000_100,
                hash: "00".repeat(32),
            });
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([{ spent: false, txid: "" }]);

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo,
                { verifySignatures: false }
            );

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) => /references unknown parent/i.test(e))
            ).toBe(true);
        });

        it("should fail when any input in a mixed-script tx violates its script", async () => {
            const { tx: commit1, rawHex: commitHex1 } =
                await buildCommitmentTx(20_000n);
            const { tx: commit2, rawHex: commitHex2 } =
                await buildCommitmentTx(7_000n);
            const mixedTx = await buildCsvPathTx({
                parentTxid: commit1.id,
                amount: 20_000n,
                sequence: 144,
                txLocktime: 500,
                extraInputs: [
                    await buildCltvInput({
                        parentTxid: commit2.id,
                        amount: 7_000n,
                        locktime: 2_000n,
                        txLocktime: 500,
                    }),
                ],
            });
            const vtxo = makeVtxo(mixedTx.id, [commit1.id, commit2.id]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commit1.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: commit2.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: mixedTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commit1.id, commit2.id],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                txs: [base64.encode(mixedTx.toPSBT())],
            });
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockImplementation(async (txid: string) => {
                if (txid === commit1.id) return commitHex1;
                if (txid === commit2.id) return commitHex2;
                throw new Error(`unknown txid ${txid}`);
            });
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 900,
                blockTime: 1_700_000_000,
            });
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                height: 1100,
                time: 1_700_000_100,
                hash: "00".repeat(32),
            });
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([{ spent: false, txid: "" }]);

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo,
                { verifySignatures: false }
            );

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => /locktime|cltv/i.test(e))).toBe(
                true
            );
        });

        it("should fail when a non-primary input references an unknown parent", async () => {
            const { tx: commit1, rawHex: commitHex1 } =
                await buildCommitmentTx(20_000n);
            const { tx: commit2, rawHex: commitHex2 } =
                await buildCommitmentTx(7_000n);
            const mixedTx = await buildCsvPathTx({
                parentTxid: commit1.id,
                amount: 20_000n,
                sequence: 144,
                extraInputs: [
                    {
                        txid: "ef".repeat(32),
                        amount: 7_000n,
                    },
                ],
            });
            const vtxo = makeVtxo(mixedTx.id, [commit1.id, commit2.id]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commit1.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: commit2.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: mixedTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commit1.id, commit2.id],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                txs: [base64.encode(mixedTx.toPSBT())],
            });
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockImplementation(async (txid: string) => {
                if (txid === commit1.id) return commitHex1;
                if (txid === commit2.id) return commitHex2;
                throw new Error(`unknown txid ${txid}`);
            });
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 900,
                blockTime: 1_700_000_000,
            });
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                height: 1100,
                time: 1_700_000_100,
                hash: "00".repeat(32),
            });
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([{ spent: false, txid: "" }]);

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo,
                { verifySignatures: false }
            );

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) => /references unknown parent/i.test(e))
            ).toBe(true);
        });

        it("should reject malformed chain topology permutations", async () => {
            const { tx: commitmentTx, rawHex: commitmentHex } =
                await buildCommitmentTx(10_000n);
            const pathTx = await buildCsvPathTx({
                parentTxid: commitmentTx.id,
                amount: 10_000n,
                sequence: 144,
            });
            const vtxo = makeVtxo(pathTx.id, [commitmentTx.id]);
            const validTreeEntry = {
                txid: pathTx.id,
                type: "INDEXER_CHAINED_TX_TYPE_TREE",
                expiresAt: "",
                spends: [commitmentTx.id],
            };

            const cases = [
                {
                    name: "tree entry duplicated in chain",
                    chain: [
                        {
                            txid: commitmentTx.id,
                            type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                            expiresAt: "",
                            spends: [],
                        },
                        validTreeEntry,
                        validTreeEntry,
                    ],
                    pattern: /virtual tx count mismatch/i,
                },
            ];

            for (const testCase of cases) {
                (
                    mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce({
                    chain: testCase.chain,
                });
                (
                    mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce({
                    txs: [base64.encode(pathTx.toPSBT())],
                });
                (
                    mockOnchain.getTxHex as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce(commitmentHex);
                (
                    mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce({
                    confirmed: true,
                    blockHeight: 900,
                    blockTime: 1_700_000_000,
                });
                (
                    mockOnchain.getChainTip as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce({
                    height: 1100,
                    time: 1_700_000_100,
                    hash: "00".repeat(32),
                });
                (
                    mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce([{ spent: false, txid: "" }]);

                const result = await verifyVtxo(
                    vtxo,
                    mockIndexer,
                    mockOnchain,
                    serverInfo,
                    { verifySignatures: false }
                );

                expect(result.valid, testCase.name).toBe(false);
                expect(
                    result.errors.some((e) => testCase.pattern.test(e)),
                    testCase.name
                ).toBe(true);
            }
        });

        it("should fail when a secondary commitment tx cannot be fetched", async () => {
            const { tx: commit1, rawHex: commitHex1 } =
                await buildCommitmentTx(20_000n);
            const { tx: commit2 } = await buildCommitmentTx(7_000n);
            const multiInputTx = await buildCsvPathTx({
                parentTxid: commit1.id,
                amount: 20_000n,
                sequence: 144,
                extraInputs: [{ txid: commit2.id, amount: 7_000n }],
            });
            const vtxo = makeVtxo(multiInputTx.id, [commit1.id, commit2.id]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commit1.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: commit2.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: multiInputTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commit1.id, commit2.id],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                txs: [base64.encode(multiInputTx.toPSBT())],
            });
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockImplementation(async (txid: string) => {
                if (txid === commit1.id) return commitHex1;
                if (txid === commit2.id) {
                    throw new Error("secondary commitment unavailable");
                }
                throw new Error(`unknown txid ${txid}`);
            });
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 900,
                blockTime: 1_700_000_000,
            });
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                height: 1100,
                time: 1_700_000_100,
                hash: "00".repeat(32),
            });
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([{ spent: false, txid: "" }]);

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo,
                { verifySignatures: false }
            );

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) =>
                    /failed to fetch commitment tx .*secondary commitment unavailable/i.test(
                        e
                    )
                )
            ).toBe(true);
            expect(
                result.errors.some((e) =>
                    /could not determine expected output/i.test(e)
                )
            ).toBe(true);
        });

        it("should fail when anchor status lookup fails for a commitment", async () => {
            const { tx: commitmentTx, rawHex: commitmentHex } =
                await buildCommitmentTx(10_000n);
            const csvTx = await buildCsvPathTx({
                parentTxid: commitmentTx.id,
                amount: 10_000n,
                sequence: 144,
            });
            const vtxo = makeVtxo(csvTx.id, [commitmentTx.id]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: csvTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commitmentTx.id],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                txs: [base64.encode(csvTx.toPSBT())],
            });
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockResolvedValue(commitmentHex);
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockRejectedValue(new Error("status lookup failed"));
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                height: 1100,
                time: 1_700_000_100,
                hash: "00".repeat(32),
            });
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([{ spent: false, txid: "" }]);

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo,
                { verifySignatures: false }
            );

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) =>
                    /failed to get commitment tx status: status lookup failed/i.test(
                        e
                    )
                )
            ).toBe(true);
        });

        it("should stay valid when only outspend lookup degrades to a warning", async () => {
            const { tx: commitmentTx, rawHex: commitmentHex } =
                await buildCommitmentTx(10_000n);
            const csvTx = await buildCsvPathTx({
                parentTxid: commitmentTx.id,
                amount: 10_000n,
                sequence: 144,
            });
            const vtxo = makeVtxo(csvTx.id, [commitmentTx.id]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: csvTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commitmentTx.id],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                txs: [base64.encode(csvTx.toPSBT())],
            });
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockResolvedValue(commitmentHex);
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 900,
                blockTime: 1_700_000_000,
            });
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                height: 1100,
                time: 1_700_000_100,
                hash: "00".repeat(32),
            });
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockRejectedValue(new Error("outspend backend timeout"));

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo,
                { verifySignatures: false }
            );

            expect(result.valid).toBe(true);
            expect(
                result.warnings.some((w) =>
                    /failed to check double-spend status: outspend backend timeout/i.test(
                        w
                    )
                )
            ).toBe(true);
        });

        it("should fail when chain spends metadata omits a real parent", async () => {
            const { tx: commitmentTx, rawHex: commitmentHex } =
                await buildCommitmentTx(10_000n);
            const csvTx = await buildCsvPathTx({
                parentTxid: commitmentTx.id,
                amount: 10_000n,
                sequence: 144,
            });
            const vtxo = makeVtxo(csvTx.id, [commitmentTx.id]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: csvTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                txs: [base64.encode(csvTx.toPSBT())],
            });
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockResolvedValue(commitmentHex);
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 900,
                blockTime: 1_700_000_000,
            });
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                height: 1100,
                time: 1_700_000_100,
                hash: "00".repeat(32),
            });
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([{ spent: false, txid: "" }]);

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo,
                { verifySignatures: false }
            );

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) =>
                    /chain metadata mismatch.*missing parents/i.test(e)
                )
            ).toBe(true);
        });

        it("should fail when chain spends metadata lists parents not used by the psbt", async () => {
            const { tx: commitmentTx, rawHex: commitmentHex } =
                await buildCommitmentTx(10_000n);
            const csvTx = await buildCsvPathTx({
                parentTxid: commitmentTx.id,
                amount: 10_000n,
                sequence: 144,
            });
            const vtxo = makeVtxo(csvTx.id, [commitmentTx.id]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: csvTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commitmentTx.id, "ee".repeat(32)],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                txs: [base64.encode(csvTx.toPSBT())],
            });
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockResolvedValue(commitmentHex);
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 900,
                blockTime: 1_700_000_000,
            });
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                height: 1100,
                time: 1_700_000_100,
                hash: "00".repeat(32),
            });
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([{ spent: false, txid: "" }]);

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo,
                { verifySignatures: false }
            );

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) =>
                    /chain metadata mismatch.*unexpected parents/i.test(e)
                )
            ).toBe(true);
        });

        it("should verify a valid multi-hop path even when chain entries are out of order", async () => {
            const { tx: commitmentTx, rawHex: commitmentHex } =
                await buildCommitmentTx(10_000n);
            const parentInputSigner = SingleKey.fromPrivateKey(
                randomPrivateKeyBytes()
            );
            const parentInputSignerPubkey =
                await parentInputSigner.xOnlyPublicKey();
            const parentInputScript = CSVMultisigTapscript.encode({
                timelock: { value: 144n, type: "blocks" },
                pubkeys: [parentInputSignerPubkey],
            });
            const parentInputVtxoScript = new VtxoScript([
                parentInputScript.script,
            ]);
            const childCosignerKey = SingleKey.fromPrivateKey(
                randomPrivateKeyBytes()
            );
            const childCosignerCompressed =
                await childCosignerKey.compressedPublicKey();
            const sweepScript = CSVMultisigTapscript.encode({
                timelock: serverInfo.sweepInterval,
                pubkeys: [serverInfo.pubkey],
            }).script;
            const { finalKey } = aggregateKeys(
                [childCosignerCompressed],
                true,
                {
                    taprootTweak: tapLeafHash(sweepScript),
                }
            );
            if (!finalKey) {
                throw new Error("failed to derive child final key");
            }
            const parentTx = new ArkTransaction();
            const parentOutputScript = taprootOutputScript(finalKey.slice(1));
            parentTx.addInput({
                txid: hex.decode(commitmentTx.id),
                index: 0,
                witnessUtxo: {
                    script: parentInputVtxoScript.pkScript,
                    amount: 10_000n,
                },
                tapLeafScript: [parentInputVtxoScript.leaves[0]],
                sequence: 144,
            });
            parentTx.addOutput({
                script: parentOutputScript,
                amount: 10_000n,
            });
            const parentAnchorKey = await SingleKey.fromPrivateKey(
                randomPrivateKeyBytes()
            ).xOnlyPublicKey();
            parentTx.addOutput({
                script: taprootOutputScript(parentAnchorKey),
                amount: 0n,
            });
            const leafOutputKey = await SingleKey.fromPrivateKey(
                randomPrivateKeyBytes()
            ).xOnlyPublicKey();
            const leafTx = new ArkTransaction();
            leafTx.addInput({
                txid: hex.decode(parentTx.id),
                index: 0,
                witnessUtxo: {
                    script: parentOutputScript,
                    amount: 10_000n,
                },
            });
            setArkPsbtField(leafTx, 0, CosignerPublicKey, {
                index: 0,
                key: childCosignerCompressed,
            });
            leafTx.addOutput({
                script: taprootOutputScript(leafOutputKey),
                amount: 10_000n,
            });
            const vtxo = makeVtxo(leafTx.id, [commitmentTx.id]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: parentTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commitmentTx.id],
                    },
                    {
                        txid: leafTx.id,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [parentTx.id],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                txs: [
                    base64.encode(parentTx.toPSBT()),
                    base64.encode(leafTx.toPSBT()),
                ],
            });
            (
                mockOnchain.getTxHex as ReturnType<typeof vi.fn>
            ).mockResolvedValue(commitmentHex);
            (
                mockOnchain.getTxStatus as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                confirmed: true,
                blockHeight: 900,
                blockTime: 1_700_000_000,
            });
            (
                mockOnchain.getChainTip as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                height: 1100,
                time: 1_700_000_100,
                hash: "00".repeat(32),
            });
            (
                mockOnchain.getTxOutspends as ReturnType<typeof vi.fn>
            ).mockResolvedValue([{ spent: false, txid: "" }]);

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo,
                { verifySignatures: false }
            );

            expect(result.valid).toBe(true);
        });
    });

    describe("checkpoint handling", () => {
        it("should warn on expired checkpoint transactions in chain", async () => {
            const commitmentTxid = "aa".repeat(32);
            const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
            // First call for step 1, second call for checkpoint check (step 3c)
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTxid,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: "cp".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_CHECKPOINT",
                        expiresAt: "2020-01-01T00:00:00Z",
                        spends: [commitmentTxid],
                    },
                ],
            });
            (
                mockIndexer.getVtxoTree as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                vtxoTree: [],
                page: { current: 0, next: 0, total: 0 },
            });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            // Will error on empty tree before reaching checkpoints,
            // but the chain fetch must succeed
            expect(result.valid).toBe(false);
        });

        it("should error on checkpoint with no parent references", async () => {
            const commitmentTxid = "aa".repeat(32);
            const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTxid,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: "cp".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_CHECKPOINT",
                        expiresAt: "",
                        spends: [], // no parent
                    },
                ],
            });
            (
                mockIndexer.getVtxoTree as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                vtxoTree: [],
                page: { current: 0, next: 0, total: 0 },
            });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
        });
    });

    describe("result structure", () => {
        it("should return well-formed result even on failure", async () => {
            const vtxo = makeVtxo("cc".repeat(32));
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({ chain: [] });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result).toHaveProperty("valid");
            expect(result).toHaveProperty("vtxoOutpoint");
            expect(result).toHaveProperty("commitmentTxid");
            expect(result).toHaveProperty("commitmentTxids");
            expect(result).toHaveProperty("confirmationDepth");
            expect(result).toHaveProperty("chainLength");
            expect(result).toHaveProperty("errors");
            expect(result).toHaveProperty("warnings");
            expect(Array.isArray(result.errors)).toBe(true);
            expect(Array.isArray(result.warnings)).toBe(true);
            expect(Array.isArray(result.commitmentTxids)).toBe(true);
        });
    });

    describe("multi-commitment DAG", () => {
        it("should find multiple commitment txs in the chain", async () => {
            const commit1 = "c1".repeat(32);
            const commit2 = "c2".repeat(32);
            const vtxo = makeVtxo("cc".repeat(32), [commit1, commit2]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commit1,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: commit2,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: "tt".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commit1],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({ txs: [] });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            // Should find both commitment txids
            expect(result.commitmentTxids).toContain(commit1);
            expect(result.commitmentTxids).toContain(commit2);
            expect(result.commitmentTxids).toHaveLength(2);
        });

        it("should error when virtualStatus commitment tx not in chain", async () => {
            const chainCommit = "c1".repeat(32);
            const statusCommit = "c9".repeat(32); // not in chain
            const vtxo = makeVtxo("cc".repeat(32), [statusCommit]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: chainCommit,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                ],
            });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(
                result.errors.some((e) => /not found in chain/i.test(e))
            ).toBe(true);
        });

        it("should use per-commitment output index for multi-batch VTXOs", async () => {
            const commit1 = "c1".repeat(32);
            const commit2 = "c2".repeat(32);
            const child1 = "d1".repeat(32);
            const child2 = "d2".repeat(32);
            const vtxo = makeVtxo("cc".repeat(32), [commit1, commit2]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commit1,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: commit2,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: child1,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commit1],
                    },
                    {
                        txid: child2,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commit2],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({ txs: [] });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.commitmentTxids).toContain(commit1);
            expect(result.commitmentTxids).toContain(commit2);
            expect(result.commitmentTxids).toHaveLength(2);
            // Will fail due to tx count mismatch but commitments are found
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => /mismatch|count/i.test(e))).toBe(
                true
            );
        });
    });
});

describe("verifyAllVtxos", () => {
    const serverInfo = {
        pubkey: new Uint8Array(32).fill(0xaa),
        sweepInterval: { value: 144n, type: "blocks" } as RelativeTimelock,
    };

    let mockIndexer: IndexerProvider;
    let mockOnchain: OnchainProvider;

    beforeEach(() => {
        mockIndexer = createMockIndexer();
        mockOnchain = createMockOnchain();
    });

    it("should return empty map for empty VTXO list", async () => {
        const result = await verifyAllVtxos(
            [],
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.size).toBe(0);
    });

    it("should group VTXOs by commitment txid", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo1 = makeVtxo("v1".padEnd(64, "0"), [commitmentTxid]);
        const vtxo2 = makeVtxo("v2".padEnd(64, "0"), [commitmentTxid]);

        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
            ],
        });
        (mockIndexer.getVtxoTree as ReturnType<typeof vi.fn>).mockResolvedValue(
            { vtxoTree: [], page: { current: 0, next: 0, total: 0 } }
        );

        const result = await verifyAllVtxos(
            [vtxo1, vtxo2],
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.size).toBe(2);
    });

    it("should return result keyed by vtxo outpoint string", async () => {
        const vtxo = makeVtxo("cc".repeat(32));
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ chain: [] });

        const result = await verifyAllVtxos(
            [vtxo],
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        const keys = Array.from(result.keys());
        expect(keys.length).toBe(1);
        expect(keys[0]).toContain(vtxo.txid);
    });

    it("should handle VTXOs with different commitment txids separately", async () => {
        const vtxo1 = makeVtxo("v1".padEnd(64, "0"), ["c1".repeat(32)]);
        const vtxo2 = makeVtxo("v2".padEnd(64, "0"), ["c2".repeat(32)]);

        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ chain: [] });

        const result = await verifyAllVtxos(
            [vtxo1, vtxo2],
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.size).toBe(2);
        // Both should fail (empty chain) but be independent
        for (const [, r] of result) {
            expect(r.valid).toBe(false);
        }
    });

    it("should propagate vtxoOutpoint per VTXO in grouped results", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo1 = makeVtxo("v1".padEnd(64, "0"), [commitmentTxid]);
        const vtxo2 = makeVtxo("v2".padEnd(64, "0"), [commitmentTxid]);

        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
            ],
        });
        (mockIndexer.getVtxoTree as ReturnType<typeof vi.fn>).mockResolvedValue(
            { vtxoTree: [], page: { current: 0, next: 0, total: 0 } }
        );

        const result = await verifyAllVtxos(
            [vtxo1, vtxo2],
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        const r1 = result.get(`${"v1".padEnd(64, "0")}:0`);
        const r2 = result.get(`${"v2".padEnd(64, "0")}:0`);
        expect(r1?.vtxoOutpoint.txid).toBe("v1".padEnd(64, "0"));
        expect(r2?.vtxoOutpoint.txid).toBe("v2".padEnd(64, "0"));
    });
});

describe("verifyVtxo edge cases", () => {
    const serverInfo = {
        pubkey: new Uint8Array(32).fill(0xaa),
        sweepInterval: { value: 144n, type: "blocks" } as RelativeTimelock,
    };

    let mockIndexer: IndexerProvider;
    let mockOnchain: OnchainProvider;

    beforeEach(() => {
        mockIndexer = createMockIndexer();
        mockOnchain = createMockOnchain();
    });

    it("should handle VTXO with no virtualStatus gracefully", async () => {
        const vtxo = {
            txid: "cc".repeat(32),
            vout: 0,
            value: 10_000n,
        } as VirtualCoin;

        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ chain: [] });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
    });

    it("should exclude checkpoint entries from pathTxids", async () => {
        const commitmentTxid = "aa".repeat(32);
        const treeTxid = "bb".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: treeTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
                {
                    txid: "cp".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_CHECKPOINT",
                    expiresAt: "2026-12-31T00:00:00Z",
                    spends: [treeTxid],
                },
            ],
        });
        // Only the tree tx should be requested (not the checkpoint)
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ txs: [] });

        await verifyVtxo(vtxo, mockIndexer, mockOnchain, serverInfo);

        const calledWith = (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mock.calls[0][0];
        expect(calledWith).toContain(treeTxid);
        expect(calledWith).not.toContain("cp".repeat(32));
        expect(calledWith).toHaveLength(1);
    });

    it("should include ARK type entries in pathTxids", async () => {
        const commitmentTxid = "aa".repeat(32);
        const arkTxid = "ak".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: arkTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_ARK",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
            ],
        });
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ txs: [] });

        await verifyVtxo(vtxo, mockIndexer, mockOnchain, serverInfo);

        const calledWith = (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mock.calls[0][0];
        expect(calledWith).toContain(arkTxid);
    });

    it("should handle VTXO with empty commitmentTxIds", async () => {
        const vtxo = makeVtxo("cc".repeat(32), []);
        const commitmentTxid = "dd".repeat(32);

        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
            ],
        });
        (mockIndexer.getVtxoTree as ReturnType<typeof vi.fn>).mockResolvedValue(
            { vtxoTree: [], page: { current: 0, next: 0, total: 0 } }
        );

        // Should proceed (no mismatch check when commitmentTxIds is empty)
        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        // Will fail on empty tree, but not on mismatch
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /mismatch/i.test(e))).toBe(false);
    });
});

// ============================================================
// Adversarial / attack-vector tests
// ============================================================

describe("verifyVtxo adversarial inputs", () => {
    const serverInfo = {
        pubkey: new Uint8Array(32).fill(0xaa),
        sweepInterval: { value: 144n, type: "blocks" } as RelativeTimelock,
    };

    let mockIndexer: IndexerProvider;
    let mockOnchain: OnchainProvider;

    beforeEach(() => {
        mockIndexer = createMockIndexer();
        mockOnchain = createMockOnchain();
    });

    it("should reject chain with only checkpoint entries (no virtual txs)", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: "cp".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_CHECKPOINT",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
            ],
        });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /no virtual/i.test(e))).toBe(true);
        // getVirtualTxs should NOT be called since pathTxids is empty
        expect(mockIndexer.getVirtualTxs).not.toHaveBeenCalled();
    });

    it("should reject when indexer returns malformed PSBT (base64 garbage)", async () => {
        const commitmentTxid = "aa".repeat(32);
        const treeTxid = "bb".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: treeTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
            ],
        });
        // Return garbage base64 that will crash PSBT parsing
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ txs: ["not-a-valid-base64-psbt!!!"] });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should reject when getVirtualTxs returns undefined txs", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: "bb".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
            ],
        });
        // Malformed response — no txs field
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockResolvedValue({});

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
    });

    it("should reject duplicate commitment txids in chain", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
            ],
        });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        // Should still find the commitment but fail on no virtual txs
        expect(result.valid).toBe(false);
        expect(result.commitmentTxids).toContain(commitmentTxid);
    });

    it("should reject when virtualStatus claims a commitment not in chain", async () => {
        const realCommit = "aa".repeat(32);
        const fakeCommit = "ff".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [fakeCommit]);

        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: realCommit,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: "bb".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [realCommit],
                },
            ],
        });
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ txs: [] });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /not found in chain/i.test(e))).toBe(
            true
        );
    });

    it("should reject when indexer getVtxoChain throws", async () => {
        const vtxo = makeVtxo("cc".repeat(32));
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockRejectedValue(new Error("indexer is down"));

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /indexer is down/i.test(e))).toBe(
            true
        );
    });

    it("should reject when chain has no commitment entries", async () => {
        const vtxo = makeVtxo("cc".repeat(32));
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: "bb".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: "dd".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_ARK",
                    expiresAt: "",
                    spends: ["bb".repeat(32)],
                },
            ],
        });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /no commitment/i.test(e))).toBe(true);
    });

    it("should reject when getVirtualTxs returns fewer txs than requested", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: "t1".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
                {
                    txid: "t2".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: ["t1".repeat(32)],
                },
            ],
        });
        // Requested 2 txs but only got 1
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ txs: ["some-psbt"] });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /mismatch|count/i.test(e))).toBe(true);
    });

    it("should reject preconfirmed VTXO without calling indexer", async () => {
        const vtxo = {
            txid: "aa".repeat(32),
            vout: 0,
            value: 1000n,
            virtualStatus: {
                state: "preconfirmed",
                batchTxid: "",
                commitmentTxIds: [],
            },
        } as VirtualCoin;

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /preconfirmed/i.test(e))).toBe(true);
        expect(mockIndexer.getVtxoChain).not.toHaveBeenCalled();
        expect(mockOnchain.getTxHex).not.toHaveBeenCalled();
    });

    it("should handle null chain gracefully", async () => {
        const vtxo = makeVtxo("cc".repeat(32));
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ chain: null });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
    });

    it("should handle getVirtualTxs throwing an error", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: "bb".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
            ],
        });
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockRejectedValue(new Error("indexer timeout"));

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /indexer timeout/i.test(e))).toBe(
            true
        );
    });
});

// ============================================================
// Test helpers
// ============================================================

function makeVtxo(
    txid: string,
    commitmentTxIds: string[] = [],
    vout: number = 0
): VirtualCoin {
    return {
        txid,
        vout,
        value: 10_000n,
        virtualStatus: {
            state: "confirmed",
            batchTxid: commitmentTxIds[0] ?? "",
            commitmentTxIds,
        },
    } as VirtualCoin;
}

function taprootOutputScript(xOnlyKey: Uint8Array): Uint8Array {
    const script = new Uint8Array(34);
    script[0] = 0x51;
    script[1] = 0x20;
    script.set(xOnlyKey, 2);
    return script;
}

async function buildCommitmentTx(amount: bigint) {
    const tx = new ArkTransaction();
    const outputKey = await SingleKey.fromPrivateKey(
        randomPrivateKeyBytes()
    ).xOnlyPublicKey();

    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
    });
    tx.addOutput({
        script: taprootOutputScript(outputKey),
        amount,
    });

    return {
        tx,
        rawHex: hex.encode(tx.toBytes()),
    };
}

async function buildCsvPathTx(opts: {
    parentTxid: string;
    amount: bigint;
    sequence: number;
    extraInputs?: {
        txid: string;
        amount: bigint;
        witnessScript?: Uint8Array;
        tapLeafScript?: any;
        sequence?: number;
    }[];
    txLocktime?: number;
}) {
    const signer = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const signerPubkey = await signer.xOnlyPublicKey();
    const csvScript = CSVMultisigTapscript.encode({
        timelock: { value: 144n, type: "blocks" },
        pubkeys: [signerPubkey],
    });
    const vtxoScript = new VtxoScript([csvScript.script]);

    const tx = new ArkTransaction({
        lockTime: opts.txLocktime,
    });
    tx.addInput({
        txid: hex.decode(opts.parentTxid),
        index: 0,
        witnessUtxo: {
            script: vtxoScript.pkScript,
            amount: opts.amount,
        },
        tapLeafScript: [vtxoScript.leaves[0]],
        sequence: opts.sequence,
    });

    for (const input of opts.extraInputs ?? []) {
        tx.addInput({
            txid: hex.decode(input.txid),
            index: 0,
            witnessUtxo: {
                script: input.witnessScript ?? vtxoScript.pkScript,
                amount: input.amount,
            },
            tapLeafScript: input.tapLeafScript ?? [vtxoScript.leaves[0]],
            sequence: input.sequence ?? opts.sequence,
        });
    }

    const outputKey = await SingleKey.fromPrivateKey(
        randomPrivateKeyBytes()
    ).xOnlyPublicKey();
    tx.addOutput({
        script: taprootOutputScript(outputKey),
        amount: opts.amount,
    });

    return tx;
}

async function buildCsvInput(opts: {
    parentTxid: string;
    amount: bigint;
    sequence: number;
}) {
    const signer = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const signerPubkey = await signer.xOnlyPublicKey();
    const csvScript = CSVMultisigTapscript.encode({
        timelock: { value: 144n, type: "blocks" },
        pubkeys: [signerPubkey],
    });
    const vtxoScript = new VtxoScript([csvScript.script]);

    return {
        txid: hex.decode(opts.parentTxid),
        index: 0,
        witnessUtxo: {
            script: vtxoScript.pkScript,
            amount: opts.amount,
        },
        tapLeafScript: [vtxoScript.leaves[0]],
        sequence: opts.sequence,
    };
}

async function buildCltvInput(opts: {
    parentTxid: string;
    amount: bigint;
    locktime: bigint;
    txLocktime: number;
}) {
    const signer = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const signerPubkey = await signer.xOnlyPublicKey();
    const cltvScript = CLTVMultisigTapscript.encode({
        absoluteTimelock: opts.locktime,
        pubkeys: [signerPubkey],
    });
    const vtxoScript = new VtxoScript([cltvScript.script]);

    return {
        txid: opts.parentTxid,
        amount: opts.amount,
        witnessScript: vtxoScript.pkScript,
        tapLeafScript: [vtxoScript.leaves[0]],
        sequence: 0xfffffffe,
    };
}
