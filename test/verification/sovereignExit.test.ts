import { Address } from "@scure/btc-signer";
import { describe, expect, it, vi } from "vitest";
import { base64, hex } from "@scure/base";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import {
    sovereignExit,
    canSovereignExit,
} from "../../src/verification/sovereignExit";
import { InMemoryExitDataRepository } from "../../src/verification/exitDataStore";
import type { ExitData } from "../../src/verification/exitDataStore";
import type { OnchainProvider } from "../../src/providers/onchain";
import { Transaction as ArkTransaction } from "../../src/utils/transaction";
import { SingleKey } from "../../src/identity/singleKey";
import { DefaultVtxo } from "../../src/script/default";
import { getNetwork } from "../../src/networks";

describe("canSovereignExit", () => {
    it("returns true when exit data exists and the commitment is confirmed", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        await repo.saveExitData(data);

        const result = await canSovereignExit(
            data.vtxoOutpoint,
            repo,
            createMockOnchain({ confirmed: true })
        );

        expect(result.canExit).toBe(true);
    });

    it("returns false when no exit data is stored", async () => {
        const repo = new InMemoryExitDataRepository();

        const result = await canSovereignExit(
            { txid: "ff".repeat(32), vout: 0 },
            repo,
            createMockOnchain({ confirmed: true })
        );

        expect(result.canExit).toBe(false);
        expect(result.reason).toMatch(/no.*exit.*data/i);
    });

    it("returns false when the commitment is not confirmed", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        await repo.saveExitData(data);

        const result = await canSovereignExit(
            data.vtxoOutpoint,
            repo,
            createMockOnchain({ confirmed: false })
        );

        expect(result.canExit).toBe(false);
        expect(result.reason).toMatch(/commitment.*not.*confirmed/i);
    });
});

describe("sovereignExit", () => {
    it("fails when no exit data is stored", async () => {
        const repo = new InMemoryExitDataRepository();
        const result = await sovereignExit(
            { txid: "ff".repeat(32), vout: 0 },
            repo,
            createMockOnchain({ confirmed: true })
        );

        expect(result.success).toBe(false);
        expect(
            result.errors.some((error) => /no.*exit.*data/i.test(error))
        ).toBe(true);
    });

    it("fails fast when stored exit data is invalid", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        data.commitmentTxid = "";
        await repo.saveExitData(data);

        const onchain = createMockOnchain({ confirmed: true });
        const result = await sovereignExit(data.vtxoOutpoint, repo, onchain);

        expect(result.success).toBe(false);
        expect(
            result.errors.some((error) =>
                /missing commitment txid/i.test(error)
            )
        ).toBe(true);
        expect(onchain.broadcastTransaction).not.toHaveBeenCalled();
    });

    it("broadcasts an unconfirmed virtual transaction and succeeds", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        data.virtualTxs = {
            ["bb".repeat(32)]: await validPsbtBase64("bb".repeat(32)),
        };
        await repo.saveExitData(data);

        const onchain = createMockOnchain({ confirmed: true });
        (onchain.getTxStatus as ReturnType<typeof vi.fn>).mockImplementation(
            async (txid: string) => {
                if (txid === data.commitmentTxid) {
                    return {
                        confirmed: true,
                        blockHeight: 1000,
                        blockTime: 1700000000,
                    };
                }
                throw new Error("not found");
            }
        );

        const result = await sovereignExit(data.vtxoOutpoint, repo, onchain);

        expect(result.success).toBe(true);
        expect(onchain.broadcastTransaction).toHaveBeenCalledTimes(1);
        expect(result.steps.some((step) => step.type === "broadcast")).toBe(
            true
        );
        expect(result.finalTxid).toBe("bb".repeat(32));
    });

    it("treats duplicate broadcast errors as non-fatal", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        data.virtualTxs = {
            ["bb".repeat(32)]: await validPsbtBase64("bb".repeat(32)),
        };
        await repo.saveExitData(data);

        const onchain = createMockOnchain({ confirmed: true });
        (onchain.getTxStatus as ReturnType<typeof vi.fn>).mockImplementation(
            async () => {
                throw new Error("not found");
            }
        );
        (
            onchain.broadcastTransaction as ReturnType<typeof vi.fn>
        ).mockRejectedValue(new Error("already in mempool"));

        const result = await sovereignExit(data.vtxoOutpoint, repo, onchain);

        expect(result.success).toBe(true);
        expect(
            result.steps.some((step) =>
                /already in mempool/i.test(step.description)
            )
        ).toBe(true);
        expect(
            result.errors.some((error) => /already in mempool/i.test(error))
        ).toBe(false);
    });

    it("surfaces non-duplicate broadcast failures", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        data.virtualTxs = {
            ["bb".repeat(32)]: await validPsbtBase64("bb".repeat(32)),
        };
        await repo.saveExitData(data);

        const onchain = createMockOnchain({ confirmed: true });
        (onchain.getTxStatus as ReturnType<typeof vi.fn>).mockImplementation(
            async () => {
                throw new Error("not found");
            }
        );
        (
            onchain.broadcastTransaction as ReturnType<typeof vi.fn>
        ).mockRejectedValue(new Error("broadcast rejected"));

        const result = await sovereignExit(data.vtxoOutpoint, repo, onchain);

        expect(result.success).toBe(false);
        expect(
            result.errors.some((error) =>
                /failed to broadcast tx .*broadcast rejected/i.test(error)
            )
        ).toBe(true);
    });

    it("skips already-confirmed virtual transactions", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        await repo.saveExitData(data);

        const result = await sovereignExit(
            data.vtxoOutpoint,
            repo,
            createMockOnchain({ confirmed: true })
        );

        expect(result.success).toBe(true);
        expect(result.steps.some((step) => step.type === "wait")).toBe(true);
        expect(result.steps.some((step) => step.type === "done")).toBe(true);
    });

    it("fails when a PSBT is missing for an unconfirmed transaction", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        data.virtualTxs = {};
        await repo.saveExitData(data);

        const onchain = createMockOnchain({ confirmed: true });
        (onchain.getTxStatus as ReturnType<typeof vi.fn>).mockImplementation(
            async (txid: string) => {
                if (txid === data.commitmentTxid) {
                    return {
                        confirmed: true,
                        blockHeight: 1000,
                        blockTime: 1700000000,
                    };
                }
                throw new Error("not found");
            }
        );

        const result = await sovereignExit(data.vtxoOutpoint, repo, onchain);

        expect(result.success).toBe(false);
        expect(
            result.errors.some((error) => /missing.*psbt/i.test(error))
        ).toBe(true);
    });

    it("finalizes tapKeySig inputs even when they are not input 0", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        data.virtualTxs = {
            ["bb".repeat(32)]: await validMultiInputPsbtBase64("bb".repeat(32)),
        };
        await repo.saveExitData(data);

        const onchain = createMockOnchain({ confirmed: true });
        (onchain.getTxStatus as ReturnType<typeof vi.fn>).mockImplementation(
            async () => {
                throw new Error("not found");
            }
        );

        const result = await sovereignExit(data.vtxoOutpoint, repo, onchain);

        expect(result.success).toBe(true);
        expect(onchain.broadcastTransaction).toHaveBeenCalledTimes(1);
    });

    it("does not require ASP services during exit", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        await repo.saveExitData(data);

        const result = await sovereignExit(
            data.vtxoOutpoint,
            repo,
            createMockOnchain({ confirmed: true })
        );

        expect(result).toBeDefined();
    });

    it("builds and broadcasts the final claim transaction when claim data is stored", async () => {
        const repo = new InMemoryExitDataRepository();
        const identity = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
        const pubKey = await identity.xOnlyPublicKey();
        const serverPubKey = await SingleKey.fromPrivateKey(
            randomPrivateKeyBytes()
        ).xOnlyPublicKey();
        const script = new DefaultVtxo.Script({
            pubKey,
            serverPubKey,
            csvTimelock: { value: 1n, type: "blocks" },
        });
        const data = makeExitData("bb".repeat(32));
        data.claimInput = {
            txid: "bb".repeat(32),
            vout: 0,
            value: 10_000,
            tapTree: hex.encode(script.encode()),
        };
        await repo.saveExitData(data);

        const network = getNetwork("mutinynet");
        const destinationKey = await SingleKey.fromPrivateKey(
            randomPrivateKeyBytes()
        ).xOnlyPublicKey();
        const outputAddress = Address(network).encode({
            type: "tr",
            pubkey: destinationKey,
        });

        const onchain = createMockOnchain({
            confirmed: true,
            blockHeight: 100,
        });
        (onchain.getTxStatus as ReturnType<typeof vi.fn>).mockImplementation(
            async (txid: string) => {
                if (
                    txid === data.commitmentTxid ||
                    txid === data.claimInput!.txid
                ) {
                    return {
                        confirmed: true,
                        blockHeight: 100,
                        blockTime: 1700000000,
                    };
                }
                throw new Error("not found");
            }
        );
        (onchain.getChainTip as ReturnType<typeof vi.fn>).mockResolvedValue({
            height: 1100,
            time: 1700001000,
            hash: "00".repeat(32),
        });

        const result = await sovereignExit(data.vtxoOutpoint, repo, onchain, {
            identity,
            outputAddress,
            network,
        });

        expect(result.success).toBe(true);
        expect(onchain.broadcastTransaction).toHaveBeenCalledTimes(1);
        expect(
            result.steps.some((step) =>
                /final claim tx/i.test(step.description)
            )
        ).toBe(true);
        expect(result.finalTxid).toHaveLength(64);
    });
});

function makeExitData(vtxoTxid?: string): ExitData {
    const txid = vtxoTxid ?? "aa".repeat(32);
    return {
        vtxoOutpoint: { txid, vout: 0 },
        commitmentTxid: "cc".repeat(32),
        chain: [
            {
                txid: "cc".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT" as any,
                expiresAt: "",
                spends: [],
            },
            {
                txid: "bb".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_TREE" as any,
                expiresAt: "",
                spends: ["cc".repeat(32)],
            },
        ],
        virtualTxs: { ["bb".repeat(32)]: "base64psbt" },
        treeNodes: [{ txid: "bb".repeat(32), tx: "base64psbt", children: {} }],
        storedAt: Date.now(),
    };
}

function createMockOnchain(opts: {
    confirmed?: boolean;
    blockHeight?: number;
}): OnchainProvider {
    return {
        getTxStatus: vi.fn().mockResolvedValue(
            opts.confirmed
                ? {
                      confirmed: true,
                      blockHeight: opts.blockHeight ?? 100,
                      blockTime: 1700000000,
                  }
                : { confirmed: false }
        ),
        getChainTip: vi.fn().mockResolvedValue({
            height: 1100,
            time: 1700001000,
            hash: "00".repeat(32),
        }),
        getTxHex: vi.fn().mockResolvedValue(""),
        getTxOutspends: vi.fn().mockResolvedValue([{ spent: false, txid: "" }]),
        getCoins: vi.fn(),
        getFeeRate: vi.fn(),
        broadcastTransaction: vi.fn().mockResolvedValue("txid"),
        getTransactions: vi.fn(),
        watchAddresses: vi.fn(),
    } as OnchainProvider;
}

async function validPsbtBase64(seedHex: string): Promise<string> {
    const tx = new ArkTransaction();
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

    return base64.encode(tx.toPSBT());
}

async function validMultiInputPsbtBase64(seedHex: string): Promise<string> {
    const tx = new ArkTransaction();
    const inputKey1 = await SingleKey.fromPrivateKey(
        randomPrivateKeyBytes()
    ).xOnlyPublicKey();
    const inputKey2 = await SingleKey.fromPrivateKey(
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
        txid: new Uint8Array(32).fill(0x11),
        index: 0,
        witnessUtxo: {
            script: taprootOutputScript(inputKey1),
            amount: 0n,
        },
    });
    tx.addInput({
        txid: hex.decode(seedHex),
        index: 0,
        witnessUtxo: {
            script: taprootOutputScript(inputKey2),
            amount: 10_000n,
        },
        tapKeySig: new Uint8Array(64).fill(0x22),
    });

    return base64.encode(tx.toPSBT());
}

function taprootOutputScript(xOnlyKey: Uint8Array): Uint8Array {
    const script = new Uint8Array(34);
    script[0] = 0x51;
    script[1] = 0x20;
    script.set(xOnlyKey, 2);
    return script;
}
