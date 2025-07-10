import { expect, describe, it } from "vitest";
import { faucetOffchain, createTestArkWallet, createVtxo } from "./utils";
import {
    ArkAddress,
    Outpoint,
    RestIndexerProvider,
    TxTree,
    TxTreeNode,
    ChainTxType,
} from "../../src";
import { hex } from "@scure/base";
import { sha256x2 } from "@scure/btc-signer/utils";

describe("Indexer provider", () => {
    it("should inspect a VTXO", { timeout: 60000 }, async () => {
        // Create fresh wallet instance for this test
        const alice = await createTestArkWallet();
        const aliceOffchainAddress = await alice.wallet.getAddress();
        expect(aliceOffchainAddress).toBeDefined();

        const fundAmount = 1000;
        faucetOffchain(aliceOffchainAddress!, fundAmount);

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const indexerProvider = new RestIndexerProvider(
            "http://localhost:7070"
        );

        const spendableVtxosResponse = await indexerProvider.getVtxos({
            scripts: [
                hex.encode(ArkAddress.decode(aliceOffchainAddress!).pkScript),
            ],
            spendableOnly: true,
        });
        expect(spendableVtxosResponse.vtxos).toHaveLength(1);

        const spendableVtxo = spendableVtxosResponse.vtxos[0];
        expect(spendableVtxo.txid).toBeDefined();
        expect(spendableVtxo.vout).toBeDefined();
        expect(spendableVtxo.value).toBe(fundAmount);

        const outpoint: Outpoint = {
            txid: spendableVtxo.txid,
            vout: spendableVtxo.vout,
        };

        const treeResponse = await indexerProvider.getVtxoTree(outpoint);
        expect(treeResponse.vtxoTree).toBeDefined();
        expect(treeResponse.vtxoTree).toHaveLength(0);

        const leaves = await indexerProvider.getVtxoTreeLeaves(outpoint);
        expect(leaves).toBeDefined();
        expect(leaves.leaves).toHaveLength(0);
    });

    it("should inspect a commitment tx", { timeout: 60000 }, async () => {
        // Create fresh wallet instance for this test
        const alice = await createTestArkWallet();
        const aliceOffchainAddress = await alice.wallet.getAddress();
        expect(aliceOffchainAddress).toBeDefined();

        const indexerProvider = new RestIndexerProvider(
            "http://localhost:7070"
        );

        const fundAmount = 1000;
        const txid = await createVtxo(alice, fundAmount);
        expect(txid).toBeDefined();
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

        const connectsResponse =
            await indexerProvider.getCommitmentTxConnectors(txid);
        expect(connectsResponse.connectors).toBeDefined();
        expect(connectsResponse.connectors.length).toBeGreaterThanOrEqual(1);

        const forfeitsResponse =
            await indexerProvider.getCommitmentTxForfeitTxs(txid);
        expect(forfeitsResponse.txids).toBeDefined();
        expect(forfeitsResponse.txids.length).toBeGreaterThanOrEqual(1);

        const sweptsResponse = await indexerProvider.getBatchSweepTransactions({
            txid,
            vout: 0,
        });
        expect(sweptsResponse.sweptBy).toBeDefined();
        expect(sweptsResponse.sweptBy.length).toBeGreaterThanOrEqual(0);

        const batchTreeResponse = await indexerProvider.getVtxoTree({
            txid,
            vout: 0,
        });
        expect(batchTreeResponse.vtxoTree.length).toBeGreaterThanOrEqual(1);

        const btlResponse = await indexerProvider.getVtxoTreeLeaves({
            txid,
            vout: 0,
        });
        expect(btlResponse.leaves.length).toBeGreaterThanOrEqual(1);
    });

    it("should subscribe to scripts", { timeout: 60000 }, async () => {
        const start = Date.now();
        const fundAmount = 1000;
        const delayMilliseconds = 2100;
        let abortController = new AbortController();

        // Create fresh wallet instance for this test
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();
        const aliceScript = ArkAddress.decode(aliceAddress!).pkScript;

        // Create fresh wallet instance for this test
        const bob = await createTestArkWallet();
        const bobAddress = await bob.wallet.getAddress();
        const bobScript = ArkAddress.decode(bobAddress!).pkScript;

        if (!bobAddress || !aliceAddress) {
            throw new Error("Offchain address not defined.");
        }

        const indexerUrl = "http://localhost:7070";
        const indexerProvider = new RestIndexerProvider(indexerUrl);

        // First we subscribe to Alice's script
        // Then we generate a VTXO for Bob, which should not trigger an update
        // Then we generate a VTXO for Alice, which should trigger an update
        // After Alice's update we update the subscription to Bob's script
        // Finally we generate another VTXO for Bob, which should trigger an update
        const fixtures = [
            {
                user: bob,
                address: bobAddress,
                amount: fundAmount,
                delayMilliseconds: delayMilliseconds,
                note: "should be ignored on subcription",
            },
            {
                user: alice,
                address: aliceAddress,
                amount: 2 * fundAmount,
                delayMilliseconds: 2 * delayMilliseconds,
                note: "should generate an update on subscription",
            },
            {
                user: bob,
                address: bobAddress,
                amount: 3 * fundAmount,
                delayMilliseconds: 3 * delayMilliseconds,
                note: "should generate an update on subscription",
            },
        ];

        fixtures.forEach(({ address, amount, delayMilliseconds }) => {
            setTimeout(
                () => faucetOffchain(address, amount),
                delayMilliseconds
            );
        });

        const subscriptionId = await indexerProvider.subscribeForScripts([
            hex.encode(aliceScript),
        ]);

        const subscription = indexerProvider.getSubscription(
            subscriptionId,
            abortController.signal
        );

        for await (const update of subscription) {
            const now = Date.now();
            expect(update).toBeDefined();
            expect(update.newVtxos).toBeDefined();
            expect(update.spentVtxos).toBeDefined();
            expect(update.newVtxos).toHaveLength(1);
            expect(update.spentVtxos).toHaveLength(0);
            const vtxo = update.newVtxos[0];
            expect(vtxo.txid).toBeDefined();
            expect(vtxo.vout).toBeDefined();
            if (now - start < 3 * delayMilliseconds) {
                // event generated by alice's VTXO
                expect(vtxo.value).toBe(fixtures[1].amount);
                // update subscription with bob's scripts
                await indexerProvider.subscribeForScripts(
                    [hex.encode(bobScript)],
                    subscriptionId
                );
            } else {
                // event generated by bob's VTXO
                expect(vtxo.value).toBe(fixtures[2].amount);
                // stop subscription
                abortController.abort();
                break;
            }
        }

        // Test unsubscribeForScripts
        // Unsubscribe from Alice's script specifically
        await indexerProvider.unsubscribeForScripts(subscriptionId, [
            hex.encode(aliceScript),
        ]);

        abortController = new AbortController();

        // get subscription, should not fail cause bob script is still subscribed
        indexerProvider.getSubscription(subscriptionId, abortController.signal);

        abortController.abort();

        // Unsubscribe from all scripts in the subscription
        await indexerProvider.unsubscribeForScripts(subscriptionId);

        abortController = new AbortController();
        // get subscription, should fail cause all scripts are unsubscribed
        const subscriptionAfterUnsubscribe = indexerProvider.getSubscription(
            subscriptionId,
            abortController.signal
        );

        // The error will be thrown when we try to iterate over the generator
        await expect(async () => {
            for await (const _ of subscriptionAfterUnsubscribe) {
                // This should never be reached
                break;
            }
        }).rejects.toThrow();

        abortController.abort();
    });

    it("should get vtxo chain", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();

        const indexerProvider = new RestIndexerProvider(
            "http://localhost:7070"
        );

        const fundAmount = 1000;
        const commitmentTxid = await createVtxo(alice, fundAmount);
        expect(commitmentTxid).toBeDefined();

        const aliceVtxos = await alice.wallet.getVtxos();
        expect(aliceVtxos).toBeDefined();
        expect(aliceVtxos).toHaveLength(1);
        const aliceVtxo = aliceVtxos[0];
        expect(aliceVtxo.txid).toBeDefined();
        expect(aliceVtxo.vout).toBeDefined();

        const chainResponse = await indexerProvider.getVtxoChain(aliceVtxo);
        expect(chainResponse.chain).toBeDefined();
        expect(chainResponse.chain.length).toBeGreaterThanOrEqual(2);

        const commitmentChainTx = chainResponse.chain.find(
            (tx) => tx.txid === commitmentTxid
        );
        expect(commitmentChainTx).toBeDefined();
        expect(commitmentChainTx?.type).toBe(ChainTxType.COMMITMENT);

        const virtualChainTxs = chainResponse.chain
            .filter((tx) => tx.type !== ChainTxType.COMMITMENT)
            .map((tx) => tx);

        // should get virtual txs in the chain
        const virtualTxs = await indexerProvider.getVirtualTxs(
            virtualChainTxs.map((tx) => tx.txid)
        );
        expect(virtualTxs.txs).toBeDefined();
        expect(virtualTxs.txs.length).toBe(virtualChainTxs.length);
        expect(virtualTxs.txs.length).toBeGreaterThanOrEqual(1);

        // every virtual tx should be a tree tx
        for (const tx of virtualChainTxs) {
            expect(tx.type).toBe(ChainTxType.TREE);
        }

        // then alice sends a vtxo to herself via an offchain tx
        const aliceOffchainAddress = await alice.wallet.getAddress();
        const arkTxId = await alice.wallet.sendBitcoin({
            address: aliceOffchainAddress,
            amount: fundAmount,
        });

        // wait for the ark tx to be processed by the ark server
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const aliceVtxosAfterArkTx = await alice.wallet.getVtxos();
        expect(aliceVtxosAfterArkTx).toBeDefined();
        expect(aliceVtxosAfterArkTx).toHaveLength(1);

        // should get the offchain tx in the chain
        const chainResponseAfterOffchain = await indexerProvider.getVtxoChain(
            aliceVtxosAfterArkTx[0]
        );
        expect(chainResponseAfterOffchain.chain).toBeDefined();
        expect(chainResponseAfterOffchain.chain.length).toBeGreaterThan(
            chainResponse.chain.length
        );

        // verify that the new chain is composed by the previous chain + the checkpoint + the ark tx
        expect(chainResponseAfterOffchain.chain.length).toBe(
            chainResponse.chain.length + 2
        );

        // every tx of the initial chain should be in the new chain
        for (const tx of chainResponse.chain) {
            expect(
                chainResponseAfterOffchain.chain.some((t) => t.txid === tx.txid)
            ).toBe(true);
        }

        // the ark tx should be the first tx in the chain
        const firstTx = chainResponseAfterOffchain.chain[0];
        expect(firstTx.type).toBe(ChainTxType.ARK);
        expect(firstTx.txid).toBe(arkTxId);

        // the checkpoint tx should be the second tx in the chain
        const checkpointTx = chainResponseAfterOffchain.chain[1];
        expect(checkpointTx.type).toBe(ChainTxType.CHECKPOINT);

        expect(firstTx.spends).toHaveLength(1);
        expect(firstTx.spends[0]).toBe(checkpointTx.txid);
    });

    it("should get vtxo tree txs", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();

        const indexerProvider = new RestIndexerProvider(
            "http://localhost:7070"
        );

        const fundAmount = 1000;
        const commitmentTxid = await createVtxo(alice, fundAmount);
        expect(commitmentTxid).toBeDefined();

        const treeResponse = await indexerProvider.getVtxoTree({
            txid: commitmentTxid,
            vout: 0,
        });

        const chunks: TxTreeNode[] = [];
        for (const vtxoTreeTx of treeResponse.vtxoTree) {
            const virtualTxs = await indexerProvider.getVirtualTxs([
                vtxoTreeTx.txid,
            ]);
            expect(virtualTxs.txs).toBeDefined();
            expect(virtualTxs.txs.length).toBe(1);
            const virtualTx = virtualTxs.txs[0];

            chunks.push({
                txid: vtxoTreeTx.txid,
                children: vtxoTreeTx.children,
                tx: virtualTx,
            });
        }

        const txTree = TxTree.create(chunks);
        expect(txTree).toBeDefined();

        txTree.validate();

        const aliceVtxo = await alice.wallet.getVtxos();
        expect(aliceVtxo).toBeDefined();
        expect(aliceVtxo).toHaveLength(1);
        const aliceVtxoOutpoint = aliceVtxo[0];
        expect(aliceVtxoOutpoint.txid).toBeDefined();
        expect(aliceVtxoOutpoint.vout).toBeDefined();

        const leaves = txTree.leaves();
        expect(leaves).toBeDefined();
        expect(leaves.length).toBeGreaterThanOrEqual(1);

        const found = leaves.find((leaf) => {
            const txid = hex.encode(sha256x2(leaf.toBytes(true)).reverse());
            return txid === aliceVtxoOutpoint.txid;
        });
        expect(found).toBeDefined();
    });

    it(
        "should get connectors from commitment tx",
        { timeout: 60000 },
        async () => {
            const alice = await createTestArkWallet();

            const indexerProvider = new RestIndexerProvider(
                "http://localhost:7070"
            );

            const fundAmount = 1000;
            const commitmentTxid = await createVtxo(alice, fundAmount);
            expect(commitmentTxid).toBeDefined();

            const connectors =
                await indexerProvider.getCommitmentTxConnectors(commitmentTxid);
            expect(connectors.connectors).toBeDefined();
            expect(connectors.connectors.length).toBeGreaterThanOrEqual(1);

            const chunks: TxTreeNode[] = [];
            for (const connector of connectors.connectors) {
                const virtualTxs = await indexerProvider.getVirtualTxs([
                    connector.txid,
                ]);
                expect(virtualTxs.txs).toBeDefined();
                expect(virtualTxs.txs.length).toBe(1);
                const virtualTx = virtualTxs.txs[0];

                chunks.push({
                    txid: connector.txid,
                    children: connector.children,
                    tx: virtualTx,
                });
            }

            const txTree = TxTree.create(chunks);
            expect(txTree).toBeDefined();

            txTree.validate();

            const leaves = txTree.leaves();
            expect(leaves).toBeDefined();
            expect(leaves.length).toBeGreaterThanOrEqual(1);
        }
    );
});
