import { expect, describe, it } from "vitest";
import { createTestWallet } from "./utils";
import { Outpoint, RestIndexerProvider } from "../../src";
import { execSync } from "child_process";
import { arkdExec } from "./utils";

describe("Indexer provider", () => {
    it("should inspect a VTXO", { timeout: 60000 }, async () => {
        // Create fresh wallet instance for this test
        const alice = await createTestWallet();
        const aliceOffchainAddress = (await alice.wallet.getAddress()).offchain;
        expect(aliceOffchainAddress).toBeDefined();

        const fundAmount = 1000;
        execSync(
            `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const indexerProvider = new RestIndexerProvider(
            "http://localhost:7070"
        );

        const spendableVtxos = await indexerProvider.getVtxos({
            addresses: [aliceOffchainAddress!],
            spendableOnly: true,
        });
        expect(spendableVtxos).toHaveLength(1);

        const spendableVtxo = spendableVtxos[0];
        expect(spendableVtxo.txid).toBeDefined();
        expect(spendableVtxo.vout).toBeDefined();
        expect(spendableVtxo.value).toBe(fundAmount);

        const outpoint: Outpoint = {
            txid: spendableVtxo.txid,
            vout: spendableVtxo.vout,
        };

        const tree = await indexerProvider.getVtxoTree(outpoint);
        expect(tree).toBeDefined();
        expect(tree).toHaveLength(0);

        const leaves = await indexerProvider.getVtxoTreeLeaves(outpoint);
        expect(leaves).toBeDefined();
        expect(leaves).toHaveLength(0);

        // TODO: Uncomment when the API is ready
        // const chain = await indexerProvider.getVtxoChain(outpoint);
        // expect(chain).toBeDefined();
        // expect(chain.chain).toHaveLength(1);
    });

    it("should inspect a commitment tx", { timeout: 60000 }, async () => {
        // Create fresh wallet instance for this test
        const alice = await createTestWallet();
        const aliceOffchainAddress = (await alice.wallet.getAddress()).offchain;
        expect(aliceOffchainAddress).toBeDefined();

        const fundAmount = 1000;
        execSync(
            `${arkdExec} ark send --to ${aliceOffchainAddress} --amount ${fundAmount} --password secret`
        );

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const indexerProvider = new RestIndexerProvider(
            "http://localhost:7070"
        );

        const virtualCoins = await alice.wallet.getVtxos();
        expect(virtualCoins).toHaveLength(1);
        const vtxo = virtualCoins[0];
        expect(vtxo.txid).toBeDefined();

        const settleTxid = await alice.wallet.settle({
            inputs: [vtxo],
            outputs: [
                {
                    address: aliceOffchainAddress!,
                    amount: BigInt(fundAmount),
                },
            ],
        });
        const txid = settleTxid;

        expect(settleTxid).toBeDefined();
        const fundAmountStr = fundAmount.toString();
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const commitmentTx = await indexerProvider.getCommitmentTx(txid);
        expect(commitmentTx).toBeDefined();
        expect(commitmentTx.startedAt).toBeDefined();
        expect(commitmentTx.endedAt).toBeDefined();
        expect(commitmentTx.batches).toBeDefined();
        expect(commitmentTx.batches).toHaveProperty("0");
        expect(commitmentTx.batches["0"].totalOutputAmount).toBe(fundAmountStr);
        expect(commitmentTx.batches["0"].totalOutputVtxos).toBe(1);

        const connects = await indexerProvider.getCommitmentTxConnectors(txid);
        expect(connects).toBeDefined();
        expect(connects.length).toBe(1);
        expect(connects[0].level).toBe(0);
        expect(connects[0].levelIndex).toBe(0);
        expect(connects[0].parentTxid).toBe(txid);

        const forfeits = await indexerProvider.getCommitmentTxForfeitTxs(txid);
        expect(forfeits).toBeDefined();
        expect(forfeits.length).toBe(1);

        const leaves = await indexerProvider.getCommitmentTxForfeitTxs(txid);
        expect(leaves).toBeDefined();
        expect(leaves.length).toBe(1);

        const swepts = await indexerProvider.getCommitmentTxSwept(txid);
        expect(swepts).toBeDefined();
        expect(swepts.length).toBe(0);

        const batchTree = await indexerProvider.getVtxoTree({ txid, vout: 0 });
        expect(batchTree.length).toBe(1);
        expect(batchTree[0].parentTxid).toBe(txid);

        const btl = await indexerProvider.getVtxoTreeLeaves({ txid, vout: 0 });
        expect(btl.length).toBe(1);
        expect(btl[0].txid).toBe(batchTree[0].txid);
    });
});
