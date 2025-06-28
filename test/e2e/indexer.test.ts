import { expect, describe, it } from "vitest";
import { faucetOffchain, createTestArkWallet, createVtxo } from "./utils";
import { ArkAddress, Outpoint, RestIndexerProvider } from "../../src";
import { hex } from "@scure/base";

describe("Indexer provider", () => {
    it("should inspect a VTXO", { timeout: 60000 }, async () => {
        // Create fresh wallet instance for this test
        const alice = await createTestArkWallet();
        const aliceOffchainAddress = (await alice.wallet.getAddress()).offchain;
        expect(aliceOffchainAddress).toBeDefined();

        const fundAmount = 1000;
        faucetOffchain(aliceOffchainAddress!, fundAmount);

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
        const alice = await createTestArkWallet();
        const aliceOffchainAddress = (await alice.wallet.getAddress()).offchain;
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

    it("should subscribe to scripts", { timeout: 60000 }, async () => {
        const start = Date.now();
        const fundAmount = 1000;
        const delayMilliseconds = 2100;
        const abortController = new AbortController();

        // Create fresh wallet instance for this test
        const alice = await createTestArkWallet();
        const aliceAddress = (await alice.wallet.getAddress()).offchain;
        const aliceScript = ArkAddress.decode(aliceAddress!).pkScript.slice(2);

        // Create fresh wallet instance for this test
        const bob = await createTestArkWallet();
        const bobAddress = (await bob.wallet.getAddress()).offchain;
        const bobScript = ArkAddress.decode(bobAddress!).pkScript.slice(2);

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
