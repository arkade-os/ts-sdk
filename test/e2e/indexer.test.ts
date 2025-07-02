import { expect, describe, it } from "vitest";
import { faucetOffchain, createTestArkWallet, createVtxo } from "./utils";
import { ArkAddress, Outpoint, RestIndexerProvider } from "../../src";
import { hex } from "@scure/base";

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

        const leavesResponse =
            await indexerProvider.getVtxoTreeLeaves(outpoint);
        expect(leavesResponse.leaves).toBeDefined();
        expect(leavesResponse.leaves).toHaveLength(0);

        // TODO: Uncomment when the API is ready
        // const chain = await indexerProvider.getVtxoChain(outpoint);
        // expect(chain).toBeDefined();
        // expect(chain.chain).toHaveLength(1);
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
        // expect(commitmentTx.batches["0"].totalOutputVtxos).toBe(1);
        // TODO: uncomment when fix API

        const connectsResponse =
            await indexerProvider.getCommitmentTxConnectors(txid);
        expect(connectsResponse.connectors).toBeDefined();
        expect(connectsResponse.connectors.length).toBeGreaterThanOrEqual(1);

        const forfeitsResponse =
            await indexerProvider.getCommitmentTxForfeitTxs(txid);
        expect(forfeitsResponse.txids).toBeDefined();
        expect(forfeitsResponse.txids.length).toBeGreaterThanOrEqual(1);

        const leavesResponse =
            await indexerProvider.getCommitmentTxLeaves(txid);
        expect(leavesResponse.leaves).toBeDefined();
        expect(leavesResponse.leaves.length).toBeGreaterThanOrEqual(1);

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
        const abortController = new AbortController();

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
    });
});
