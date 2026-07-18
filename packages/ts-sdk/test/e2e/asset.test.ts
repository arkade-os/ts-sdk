import { expect, describe, it, beforeEach } from "vitest";
import {
    Wallet,
    EsploraProvider,
    InMemoryWalletRepository,
    InMemoryContractRepository,
    RestDelegateProvider,
} from "../../src";
import {
    beforeEachFaucet,
    createTestArkWallet,
    createTestIdentity,
    execCommand,
    faucetOffchain,
    waitFor,
} from "./utils";

describe("Asset integration tests", () => {
    beforeEach(beforeEachFaucet, 20000);

    it("collaborative exit", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // alice issues an asset
        const issueAmount = 500n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const vtxosBefore = await alice.wallet.getVtxos();
        expect(vtxosBefore.length).toBeGreaterThan(0);
        const assetVtxo = vtxosBefore.find((v) =>
            v.assets?.some((a) => a.assetId === issueResult.assetId),
        );
        expect(assetVtxo).toBeDefined();

        const exitAmount = 5000;
        // settle with explicit inputs/outputs (includes asset packet)
        const totalValue = vtxosBefore.reduce((sum, v) => sum + v.value, 0);

        const settleTxid = await alice.wallet.settle({
            inputs: vtxosBefore,
            outputs: [
                {
                    address: aliceAddress!,
                    amount: BigInt(totalValue - exitAmount),
                },
                {
                    address: "bcrt1q7dn55unudcpmu3hg05rj9u2cn4m0r2yr0de3f6",
                    amount: BigInt(exitAmount),
                },
            ],
        });

        expect(settleTxid).toBeDefined();

        execCommand("node regtest/regtest.mjs mine 1");
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // verify the asset is still present on the settled vtxos
        const vtxosAfter = await alice.wallet.getVtxos();
        expect(vtxosAfter.length).toBeGreaterThan(0);

        const allAssets = vtxosAfter.flatMap((v) => v.assets ?? []);
        const assetTotal = allAssets
            .filter((a) => a.assetId === issueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(assetTotal).toBe(issueAmount);
    });

    it("should issue an asset without control asset", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        // fund alice offchain
        const fundAmount = 10_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // issue an asset
        const amount = 1000n;
        const result = await alice.wallet.assetManager.issue({ amount });

        expect(result.arkTxId).toBeDefined();
        expect(result.assetId).toBeDefined();

        await new Promise((resolve) => setTimeout(resolve, 3000));

        // verify the asset appears on a vtxo
        const vtxos = await alice.wallet.getVtxos();
        expect(vtxos.length).toBeGreaterThan(0);

        const assetVtxo = vtxos.find((v) => v.assets?.some((a) => a.assetId === result.assetId));
        expect(assetVtxo).toBeDefined();

        const asset = assetVtxo!.assets!.find((a) => a.assetId === result.assetId);
        expect(asset!.amount).toBe(amount);
    });

    it("should issue an asset with existing control asset", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 10_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // first issuance to create a control asset
        const firstIssueResult = await alice.wallet.assetManager.issue({
            amount: 1n,
        });

        // Wait for round completion so change VTXO is indexed
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // second issuance to create a new asset using the control asset
        const secondIssueResult = await alice.wallet.assetManager.issue({
            amount: 500n,
            controlAssetId: firstIssueResult.assetId,
        });

        expect(secondIssueResult.arkTxId).toBeDefined();
        expect(secondIssueResult.assetId).toBeDefined();

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // verify both the issued asset and control asset appear
        const vtxos = await alice.wallet.getVtxos();
        expect(vtxos.length).toBeGreaterThan(0);

        const allAssets = vtxos.flatMap((v) => v.assets ?? []);
        const issuedAsset = allAssets.find((a) => a.assetId === secondIssueResult.assetId);
        expect(issuedAsset).toBeDefined();
        expect(issuedAsset!.amount).toBe(500n);

        const controlAsset = allAssets.find((a) => a.assetId === firstIssueResult.assetId);
        expect(controlAsset).toBeDefined();
        expect(controlAsset!.amount).toBe(1n);
    });

    it("should issue an asset with metadata", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 10_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const metadata = {
            decimals: 2,
            name: "Test Asset",
            ticker: "TA",
            icon: "https://example.com/icon.png",
        };

        const issueResult = await alice.wallet.assetManager.issue({
            amount: 1000n,
            metadata,
        });

        expect(issueResult.arkTxId).toBeDefined();
        expect(issueResult.assetId).toBeDefined();

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const assetDetails = await alice.wallet.assetManager.getAssetDetails(issueResult.assetId);
        expect(assetDetails.metadata).toBeDefined();
        expect(assetDetails.metadata).toEqual(metadata);
    });

    it("should reissue an asset", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // first issuance to create a control asset
        const firstIssueResult = await alice.wallet.assetManager.issue({
            amount: 1n,
        });

        // Wait for round completion so change VTXO is indexed
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // second issuance to create a new asset using the control asset
        const secondIssueResult = await alice.wallet.assetManager.issue({
            amount: 500n,
            controlAssetId: firstIssueResult.assetId,
        });

        // Wait for round completion before reissue
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // reissue more units
        const reissueAmount = 300n;
        const reissueTxid = await alice.wallet.assetManager.reissue({
            assetId: secondIssueResult.assetId,
            amount: reissueAmount,
        });

        expect(reissueTxid).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // verify total asset amount is issueAmount + reissueAmount
        const vtxos = await alice.wallet.getVtxos();
        const allAssets = vtxos.flatMap((v) => v.assets ?? []);

        const totalAssetAmount = allAssets
            .filter((a) => a.assetId === secondIssueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(totalAssetAmount).toBe(500n + reissueAmount);

        // control asset should still exist
        const controlAsset = allAssets.find((a) => a.assetId === firstIssueResult.assetId);
        expect(controlAsset).toBeDefined();
    });

    it("should burn an asset partially", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // issue an asset
        const issueAmount = 1000n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // burn half
        const burnAmount = 400n;
        const burnTxid = await alice.wallet.assetManager.burn({
            assetId: issueResult.assetId,
            amount: burnAmount,
        });

        expect(burnTxid).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // verify remaining amount
        const vtxos = await alice.wallet.getVtxos();
        const allAssets = vtxos.flatMap((v) => v.assets ?? []);
        const remaining = allAssets
            .filter((a) => a.assetId === issueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(remaining).toBe(issueAmount - burnAmount);
    });

    it("should burn an asset completely", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // issue an asset
        const issueAmount = 500n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // burn all
        const burnTxid = await alice.wallet.assetManager.burn({
            assetId: issueResult.assetId,
            amount: issueAmount,
        });

        expect(burnTxid).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // verify asset is gone
        const vtxos = await alice.wallet.getVtxos();
        const allAssets = vtxos.flatMap((v) => v.assets ?? []);
        const remaining = allAssets.filter((a) => a.assetId === issueResult.assetId);
        expect(remaining).toHaveLength(0);
    });

    it("should send an asset to another wallet", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const bob = await createTestArkWallet();

        const aliceAddress = await alice.wallet.getAddress();
        const bobAddress = await bob.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // alice issues an asset
        const issueAmount = 1000n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // alice sends some asset to bob
        const sendAmount = 400n;
        const sendTxid = await alice.wallet.send({
            address: bobAddress!,
            amount: 0,
            assets: [{ assetId: issueResult.assetId, amount: sendAmount }],
        });

        expect(sendTxid).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // verify bob received the asset
        const bobVtxos = await bob.wallet.getVtxos();
        const bobAssets = bobVtxos.flatMap((v) => v.assets ?? []);
        const bobAsset = bobAssets.find((a) => a.assetId === issueResult.assetId);
        expect(bobAsset).toBeDefined();
        expect(bobAsset!.amount).toBe(sendAmount);

        // verify alice has the remaining asset as change
        const aliceVtxos = await alice.wallet.getVtxos();
        const aliceAssets = aliceVtxos.flatMap((v) => v.assets ?? []);
        const aliceRemaining = aliceAssets
            .filter((a) => a.assetId === issueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(aliceRemaining).toBe(issueAmount - sendAmount);
    });

    it("should send all units of an asset", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const bob = await createTestArkWallet();

        const aliceAddress = await alice.wallet.getAddress();
        const bobAddress = await bob.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // alice issues an asset
        const issueAmount = 500n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // alice sends all units to bob
        const sendTxid = await alice.wallet.send({
            address: bobAddress!,
            amount: 0,
            assets: [{ assetId: issueResult.assetId, amount: issueAmount }],
        });

        expect(sendTxid).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // verify bob has all the asset
        const bobVtxos = await bob.wallet.getVtxos();
        const bobAssets = bobVtxos.flatMap((v) => v.assets ?? []);
        const bobTotal = bobAssets
            .filter((a) => a.assetId === issueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(bobTotal).toBe(issueAmount);

        // verify alice has no more of this asset
        const aliceVtxos = await alice.wallet.getVtxos();
        const aliceAssets = aliceVtxos.flatMap((v) => v.assets ?? []);
        const aliceTotal = aliceAssets
            .filter((a) => a.assetId === issueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(aliceTotal).toBe(0n);
    });

    it("should settle VTXOs with assets", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // alice issues an asset
        const issueAmount = 500n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await new Promise((resolve) => setTimeout(resolve, 1000));

        const vtxosBefore = await alice.wallet.getVtxos();
        expect(vtxosBefore.length).toBeGreaterThan(0);
        const assetVtxo = vtxosBefore.find((v) =>
            v.assets?.some((a) => a.assetId === issueResult.assetId),
        );
        expect(assetVtxo).toBeDefined();

        // settle with explicit inputs/outputs (includes asset packet)
        const totalValue = vtxosBefore.reduce((sum, v) => sum + v.value, 0);
        const settleTxid = await alice.wallet.settle({
            inputs: vtxosBefore,
            outputs: [
                {
                    address: aliceAddress!,
                    amount: BigInt(totalValue),
                },
            ],
        });

        expect(settleTxid).toBeDefined();

        execCommand("node regtest/regtest.mjs mine 1");
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // verify the asset is still present on the settled vtxos
        const vtxosAfter = await alice.wallet.getVtxos();
        expect(vtxosAfter.length).toBeGreaterThan(0);

        const allAssets = vtxosAfter.flatMap((v) => v.assets ?? []);
        const assetTotal = allAssets
            .filter((a) => a.assetId === issueResult.assetId)
            .reduce((s, a) => s + a.amount, 0n);
        expect(assetTotal).toBe(issueAmount);
    });

    it(
        "should track and spend VTXOs with assets across delegate add/remove",
        { timeout: 120000 },
        async () => {
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();
            const identity = createTestIdentity();

            const onchainProvider = new EsploraProvider("http://localhost:3000/api", {
                forcePolling: true,
                pollingInterval: 2000,
            });

            // Phase 1 — No delegate: fund and issue asset on default address
            const wallet1 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                settlementConfig: false,
            });

            const addressA = await wallet1.getAddress();
            await wallet1.getContractManager();

            faucetOffchain(addressA, 10_000);
            await waitFor(async () => (await wallet1.getVtxos()).length > 0);

            const issueResult1 = await wallet1.assetManager.issue({
                amount: 100n,
            });
            expect(issueResult1.assetId).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Phase 2 — Add delegate: fund and issue asset on delegate address
            const wallet2 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                delegateProvider: new RestDelegateProvider("http://localhost:7012"),
                settlementConfig: false,
            });

            const addressB = await wallet2.getAddress();
            expect(addressB).not.toBe(addressA);

            const manager2 = await wallet2.getContractManager();

            const contracts2 = await manager2.getContracts({
                type: ["default", "delegate"],
            });
            expect(contracts2).toHaveLength(2);

            faucetOffchain(addressB, 10_000);
            await waitFor(async () => (await wallet2.getVtxos()).length >= 2);

            const issueResult2 = await wallet2.assetManager.issue({
                amount: 200n,
            });
            expect(issueResult2.assetId).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Send assets to bob, forcing both VTXO pools to be consumed
            const bob = await createTestArkWallet();
            const bobAddress = await bob.wallet.getAddress();

            const allVtxos2 = await wallet2.getVtxos();
            const maxSingleVtxo = Math.max(...allVtxos2.map((v) => v.value));
            const sendAmount = maxSingleVtxo + 1_000;

            const txid2 = await wallet2.send({
                address: bobAddress,
                amount: sendAmount,
                assets: [
                    { assetId: issueResult1.assetId, amount: 50n },
                    { assetId: issueResult2.assetId, amount: 100n },
                ],
            });
            expect(txid2).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Verify bob received the assets
            const bobVtxos = await bob.wallet.getVtxos();
            const bobAssets = bobVtxos.flatMap((v) => v.assets ?? []);
            const bobAsset1 = bobAssets.find((a) => a.assetId === issueResult1.assetId);
            expect(bobAsset1).toBeDefined();
            expect(bobAsset1!.amount).toBe(50n);
            const bobAsset2 = bobAssets.find((a) => a.assetId === issueResult2.assetId);
            expect(bobAsset2).toBeDefined();
            expect(bobAsset2!.amount).toBe(100n);

            // Verify alice has remaining assets as change
            const aliceVtxos2 = await wallet2.getVtxos();
            const aliceAssets2 = aliceVtxos2.flatMap((v) => v.assets ?? []);
            const aliceRemaining1 = aliceAssets2
                .filter((a) => a.assetId === issueResult1.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            expect(aliceRemaining1).toBe(50n);
            const aliceRemaining2 = aliceAssets2
                .filter((a) => a.assetId === issueResult2.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            expect(aliceRemaining2).toBe(100n);

            // Phase 3 — Remove delegate: spend via forfeit path with assets
            const wallet3 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                settlementConfig: false,
            });

            const manager3 = await wallet3.getContractManager();

            const contracts3 = await manager3.getContracts();
            expect(contracts3.length).toBeGreaterThanOrEqual(2);

            faucetOffchain(addressA, 10_000);
            faucetOffchain(addressB, 10_000);
            await waitFor(async () => (await wallet3.getVtxos()).length >= 2);

            const issueResult3 = await wallet3.assetManager.issue({
                amount: 300n,
            });
            expect(issueResult3.assetId).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            const allVtxos3 = await wallet3.getVtxos();
            const maxSingleVtxo3 = Math.max(...allVtxos3.map((v) => v.value));
            const sendAmount3 = maxSingleVtxo3 + 1_000;

            // Spending works via forfeit path — assets should be preserved
            const txid3 = await wallet3.send({
                address: bobAddress,
                amount: sendAmount3,
                assets: [{ assetId: issueResult3.assetId, amount: 150n }],
            });
            expect(txid3).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Verify bob received the asset from phase 3
            const bobVtxos3 = await bob.wallet.getVtxos();
            const bobAssets3 = bobVtxos3.flatMap((v) => v.assets ?? []);
            const bobAsset3 = bobAssets3.find((a) => a.assetId === issueResult3.assetId);
            expect(bobAsset3).toBeDefined();
            expect(bobAsset3!.amount).toBe(150n);
        },
    );

    it(
        "should spend VTXOs with assets from both default and delegate contracts in a single send",
        { timeout: 120000 },
        async () => {
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();
            const identity = createTestIdentity();

            const onchainProvider = new EsploraProvider("http://localhost:3000/api", {
                forcePolling: true,
                pollingInterval: 2000,
            });

            // Step 1 — No delegate: fund default address and issue asset
            const wallet1 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                settlementConfig: false,
            });

            const defaultAddress = await wallet1.getAddress();
            await wallet1.getContractManager();

            faucetOffchain(defaultAddress, 1_000);
            await waitFor(async () => (await wallet1.getVtxos()).length > 0);

            const issueResult = await wallet1.assetManager.issue({
                amount: 500n,
            });
            expect(issueResult.assetId).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Step 2 — Enable delegate: fund delegate address
            const wallet2 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                delegateProvider: new RestDelegateProvider("http://localhost:7012"),
                settlementConfig: false,
            });

            const delegateAddress = await wallet2.getAddress();
            expect(delegateAddress).not.toBe(defaultAddress);

            const manager = await wallet2.getContractManager();

            const contracts = await manager.getContracts({
                type: ["default", "delegate"],
            });
            expect(contracts).toHaveLength(2);

            faucetOffchain(delegateAddress, 1_000);
            await waitFor(async () => (await wallet2.getVtxos()).length >= 2);

            // Step 3 — Send requiring both pools, including the asset
            const bob = await createTestArkWallet();
            const bobAddress = await bob.wallet.getAddress();

            const allVtxos = await wallet2.getVtxos();
            const maxSingleVtxo = Math.max(...allVtxos.map((v) => v.value));
            const sendAmount = maxSingleVtxo + 100;

            const txid = await wallet2.send({
                address: bobAddress,
                amount: sendAmount,
                assets: [{ assetId: issueResult.assetId, amount: 200n }],
            });
            expect(txid).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Verify bob received the asset
            const bobVtxos = await bob.wallet.getVtxos();
            const bobAssets = bobVtxos.flatMap((v) => v.assets ?? []);
            const bobAsset = bobAssets.find((a) => a.assetId === issueResult.assetId);
            expect(bobAsset).toBeDefined();
            expect(bobAsset!.amount).toBe(200n);

            // Verify change has remaining asset on delegate contract
            await waitFor(async () => {
                const vtxos = await wallet2.getVtxos();
                return vtxos.some((v) => !v.isSpent);
            });

            const vtxosAfter = await wallet2.getVtxos();
            const aliceAssets = vtxosAfter.flatMap((v) => v.assets ?? []);
            const aliceRemaining = aliceAssets
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            expect(aliceRemaining).toBe(300n);

            // Change should land on delegate contract
            const delegateContractAfter = await manager.getContractsWithVtxos({
                type: ["delegate"],
            });
            const delegateUnspent = delegateContractAfter[0].vtxos.filter((v) => !v.isSpent);
            expect(delegateUnspent.length).toBeGreaterThan(0);
        },
    );

    it(
        "should spend VTXOs with assets from both default and delegate contracts, funded after delegation",
        { timeout: 120000 },
        async () => {
            const walletRepository = new InMemoryWalletRepository();
            const contractRepository = new InMemoryContractRepository();
            const identity = createTestIdentity();

            const onchainProvider = new EsploraProvider("http://localhost:3000/api", {
                forcePolling: true,
                pollingInterval: 2000,
            });

            // Step 1 — Create wallet without delegate
            const wallet1 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                settlementConfig: false,
            });

            const defaultAddress = await wallet1.getAddress();
            await wallet1.getContractManager();

            // Step 2 — Enable delegate before funding
            const wallet2 = await Wallet.create({
                identity,
                arkServerUrl: "http://localhost:7070",
                onchainProvider,
                storage: { walletRepository, contractRepository },
                delegateProvider: new RestDelegateProvider("http://localhost:7012"),
                settlementConfig: false,
            });

            const delegateAddress = await wallet2.getAddress();
            expect(delegateAddress).not.toBe(defaultAddress);

            const manager = await wallet2.getContractManager();

            const contracts = await manager.getContracts({
                type: ["default", "delegate"],
            });
            expect(contracts).toHaveLength(2);

            // Fund default address and issue asset after delegation is set up
            faucetOffchain(defaultAddress, 1_000);
            await waitFor(async () => (await wallet2.getVtxos()).length > 0);

            const issueResult = await wallet2.assetManager.issue({
                amount: 500n,
            });
            expect(issueResult.assetId).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            faucetOffchain(delegateAddress, 1_000);
            await waitFor(async () => (await wallet2.getVtxos()).length >= 2);

            // Step 3 — Send requiring both pools, including the asset
            const bob = await createTestArkWallet();
            const bobAddress = await bob.wallet.getAddress();

            const allVtxos = await wallet2.getVtxos();
            const maxSingleVtxo = Math.max(...allVtxos.map((v) => v.value));
            const sendAmount = maxSingleVtxo + 100;

            const txid = await wallet2.send({
                address: bobAddress,
                amount: sendAmount,
                assets: [{ assetId: issueResult.assetId, amount: 200n }],
            });
            expect(txid).toBeDefined();
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Verify bob received the asset
            const bobVtxos = await bob.wallet.getVtxos();
            const bobAssets = bobVtxos.flatMap((v) => v.assets ?? []);
            const bobAsset = bobAssets.find((a) => a.assetId === issueResult.assetId);
            expect(bobAsset).toBeDefined();
            expect(bobAsset!.amount).toBe(200n);

            // Verify change has remaining asset on delegate contract
            await waitFor(async () => {
                const vtxos = await wallet2.getVtxos();
                return vtxos.some((v) => !v.isSpent);
            });

            const vtxosAfter = await wallet2.getVtxos();
            const aliceAssets = vtxosAfter.flatMap((v) => v.assets ?? []);
            const aliceRemaining = aliceAssets
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            expect(aliceRemaining).toBe(300n);

            // Change should land on delegate contract
            const delegateContractAfter = await manager.getContractsWithVtxos({
                type: ["delegate"],
            });
            const delegateUnspent = delegateContractAfter[0].vtxos.filter((v) => !v.isSpent);
            expect(delegateUnspent.length).toBeGreaterThan(0);
        },
    );
});
