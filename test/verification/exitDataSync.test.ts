import { describe, expect, it, vi } from "vitest";
import { base64 } from "@scure/base";
import type { IndexerProvider } from "../../src/providers/indexer";
import type { VirtualCoin } from "../../src/wallet";
import {
    buildExitDataForVtxo,
    buildExitDataForVtxos,
    syncExitData,
} from "../../src/verification/exitDataSync";
import { InMemoryExitDataRepository } from "../../src/verification/exitDataStore";
import { Transaction as ArkTransaction } from "../../src/utils/transaction";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { SingleKey } from "../../src/identity/singleKey";

describe("exitDataSync", () => {
    it("builds exit data for a single VTXO", async () => {
        const indexer = createMockIndexer();
        const vtxo = makeVtxo("bb".repeat(32));

        const result = await buildExitDataForVtxo(vtxo, indexer);

        expect(result.vtxoOutpoint.txid).toBe(vtxo.txid);
        expect(result.commitmentTxid).toBe("cc".repeat(32));
        expect(result.treeNodes).toHaveLength(1);
    });

    it("builds exit data for multiple VTXOs", async () => {
        const indexer = createMockIndexer();

        const result = await buildExitDataForVtxos(
            [makeVtxo("bb".repeat(32)), makeVtxo("dd".repeat(32))],
            indexer
        );

        expect(result).toHaveLength(2);
    });

    it("syncs built exit data into a repository", async () => {
        const indexer = createMockIndexer();
        const repo = new InMemoryExitDataRepository();

        await syncExitData([makeVtxo("bb".repeat(32))], indexer, repo);

        expect(
            await repo.getExitData({ txid: "bb".repeat(32), vout: 0 })
        ).not.toBeNull();
    });
});

function makeVtxo(txid: string): VirtualCoin {
    return {
        txid,
        vout: 0,
        value: 10_000n,
        virtualStatus: {
            state: "confirmed",
            batchTxid: "cc".repeat(32),
            commitmentTxIds: ["cc".repeat(32)],
        },
    } as VirtualCoin;
}

function createMockIndexer(): IndexerProvider {
    return {
        getVtxoChain: vi.fn().mockImplementation(async (outpoint) => ({
            chain: [
                {
                    txid: "cc".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: outpoint.txid,
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: ["cc".repeat(32)],
                },
            ],
        })),
        getVirtualTxs: vi.fn().mockImplementation(async (txids: string[]) => ({
            txs: await Promise.all(txids.map((txid) => validPsbtBase64(txid))),
        })),
        getVtxoTree: vi.fn(),
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
        txid: new Uint8Array(32).fill(0x11),
        index: 0,
        witnessUtxo: {
            script: taprootOutputScript(inputKey),
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
