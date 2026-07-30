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
        await waitFor(async () => (await alice.wallet.getBalance()).total >= fundAmount);

        // alice issues an asset
        const issueAmount = 500n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await waitFor(async () =>
            (await alice.wallet.getVtxos()).some((v) =>
                v.assets?.some((a) => a.assetId === issueResult.assetId),
            ),
        );

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

        // poll until the settled vtxos carry the full asset balance again
        await waitFor(async () => {
            const vtxos = await alice.wallet.getVtxos();
            const total = vtxos
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            return total === issueAmount;
        });

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
        await waitFor(async () => (await alice.wallet.getBalance()).total >= fundAmount);

        // issue an asset
        const amount = 1000n;
        const result = await alice.wallet.assetManager.issue({ amount });

        expect(result.arkTxId).toBeDefined();
        expect(result.assetId).toBeDefined();

        // poll until the issued asset appears on a vtxo with the full amount
        await waitFor(async () =>
            (await alice.wallet.getVtxos()).some((v) =>
                v.assets?.some((a) => a.assetId === result.assetId && a.amount === amount),
            ),
        );

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
        await waitFor(async () => (await alice.wallet.getBalance()).total >= fundAmount);

        // first issuance to create a control asset
        const firstIssueResult = await alice.wallet.assetManager.issue({
            amount: 1n,
        });

        // wait until the control asset's change VTXO is indexed
        await waitFor(async () =>
            (await alice.wallet.getVtxos()).some((v) =>
                v.assets?.some((a) => a.assetId === firstIssueResult.assetId),
            ),
        );

        // second issuance to create a new asset using the control asset
        const secondIssueResult = await alice.wallet.assetManager.issue({
            amount: 500n,
            controlAssetId: firstIssueResult.assetId,
        });

        expect(secondIssueResult.arkTxId).toBeDefined();
        expect(secondIssueResult.assetId).toBeDefined();

        // poll until both the issued asset and control asset appear at full amount
        await waitFor(async () => {
            const assets = (await alice.wallet.getVtxos()).flatMap((v) => v.assets ?? []);
            const issued = assets.find((a) => a.assetId === secondIssueResult.assetId);
            const control = assets.find((a) => a.assetId === firstIssueResult.assetId);
            return issued?.amount === 500n && control?.amount === 1n;
        });

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
        await waitFor(async () => (await alice.wallet.getBalance()).total >= fundAmount);

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

        // poll until the issued asset's metadata is indexed and retrievable
        await waitFor(async () => {
            try {
                const details = await alice.wallet.assetManager.getAssetDetails(
                    issueResult.assetId,
                );
                return details.metadata !== undefined;
            } catch {
                return false;
            }
        });

        const assetDetails = await alice.wallet.assetManager.getAssetDetails(issueResult.assetId);
        expect(assetDetails.metadata).toBeDefined();
        expect(assetDetails.metadata).toEqual(metadata);
    });

    it("should reissue an asset", { timeout: 60000 }, async () => {
        const alice = await createTestArkWallet();
        const aliceAddress = await alice.wallet.getAddress();

        const fundAmount = 20_000;
        faucetOffchain(aliceAddress!, fundAmount);
        await waitFor(async () => (await alice.wallet.getBalance()).total >= fundAmount);

        // first issuance to create a control asset
        const firstIssueResult = await alice.wallet.assetManager.issue({
            amount: 1n,
        });

        // wait until the control asset's change VTXO is indexed
        await waitFor(async () =>
            (await alice.wallet.getVtxos()).some((v) =>
                v.assets?.some((a) => a.assetId === firstIssueResult.assetId),
            ),
        );

        // second issuance to create a new asset using the control asset
        const secondIssueResult = await alice.wallet.assetManager.issue({
            amount: 500n,
            controlAssetId: firstIssueResult.assetId,
        });

        // wait until the second issuance is indexed at its full amount before reissue
        await waitFor(async () => {
            const total = (await alice.wallet.getVtxos())
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === secondIssueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            return total === 500n;
        });

        // reissue more units
        const reissueAmount = 300n;
        const reissueTxid = await alice.wallet.assetManager.reissue({
            assetId: secondIssueResult.assetId,
            amount: reissueAmount,
        });

        expect(reissueTxid).toBeDefined();

        // poll until the reissued units are reflected in the total
        await waitFor(async () => {
            const total = (await alice.wallet.getVtxos())
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === secondIssueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            return total === 500n + reissueAmount;
        });

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
        await waitFor(async () => (await alice.wallet.getBalance()).total >= fundAmount);

        // issue an asset
        const issueAmount = 1000n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        // poll until the issued asset is indexed at its full amount
        await waitFor(async () => {
            const total = (await alice.wallet.getVtxos())
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            return total === issueAmount;
        });

        // burn half
        const burnAmount = 400n;
        const burnTxid = await alice.wallet.assetManager.burn({
            assetId: issueResult.assetId,
            amount: burnAmount,
        });

        expect(burnTxid).toBeDefined();

        // poll until the remaining amount reflects the burn
        await waitFor(async () => {
            const total = (await alice.wallet.getVtxos())
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            return total === issueAmount - burnAmount;
        });

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
        await waitFor(async () => (await alice.wallet.getBalance()).total >= fundAmount);

        // issue an asset
        const issueAmount = 500n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        // poll until the issued asset is indexed at its full amount
        await waitFor(async () => {
            const total = (await alice.wallet.getVtxos())
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            return total === issueAmount;
        });

        // burn all
        const burnTxid = await alice.wallet.assetManager.burn({
            assetId: issueResult.assetId,
            amount: issueAmount,
        });

        expect(burnTxid).toBeDefined();

        // poll until the asset is fully gone from the wallet's vtxos
        await waitFor(async () => {
            const remaining = (await alice.wallet.getVtxos())
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === issueResult.assetId);
            return remaining.length === 0;
        });

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
        await waitFor(async () => (await alice.wallet.getBalance()).total >= fundAmount);

        // alice issues an asset
        const issueAmount = 1000n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        // poll until the issued asset is indexed at its full amount
        await waitFor(async () => {
            const total = (await alice.wallet.getVtxos())
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            return total === issueAmount;
        });

        // alice sends some asset to bob
        const sendAmount = 400n;
        const sendTxid = await alice.wallet.send({
            address: bobAddress!,
            amount: 0,
            assets: [{ assetId: issueResult.assetId, amount: sendAmount }],
        });

        expect(sendTxid).toBeDefined();

        // poll until bob received the asset and alice holds the change
        await waitFor(async () => {
            const bobTotal = (await bob.wallet.getVtxos())
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            const aliceTotal = (await alice.wallet.getVtxos())
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            return bobTotal === sendAmount && aliceTotal === issueAmount - sendAmount;
        });

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
        await waitFor(async () => (await alice.wallet.getBalance()).total >= fundAmount);

        // alice issues an asset
        const issueAmount = 500n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        // poll until the issued asset is indexed at its full amount
        await waitFor(async () => {
            const total = (await alice.wallet.getVtxos())
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            return total === issueAmount;
        });

        // alice sends all units to bob
        const sendTxid = await alice.wallet.send({
            address: bobAddress!,
            amount: 0,
            assets: [{ assetId: issueResult.assetId, amount: issueAmount }],
        });

        expect(sendTxid).toBeDefined();

        // poll until bob holds all units and alice holds none
        await waitFor(async () => {
            const bobTotal = (await bob.wallet.getVtxos())
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            const aliceTotal = (await alice.wallet.getVtxos())
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            return bobTotal === issueAmount && aliceTotal === 0n;
        });

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
        await waitFor(async () => (await alice.wallet.getBalance()).total >= fundAmount);

        // alice issues an asset
        const issueAmount = 500n;
        const issueResult = await alice.wallet.assetManager.issue({
            amount: issueAmount,
        });

        await waitFor(async () =>
            (await alice.wallet.getVtxos()).some((v) =>
                v.assets?.some((a) => a.assetId === issueResult.assetId),
            ),
        );

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

        // poll until the settled vtxos carry the full asset balance again
        await waitFor(async () => {
            const total = (await alice.wallet.getVtxos())
                .flatMap((v) => v.assets ?? [])
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            return total === issueAmount;
        });

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
            await waitFor(async () =>
                (await wallet1.getVtxos()).some((v) =>
                    v.assets?.some((a) => a.assetId === issueResult1.assetId),
                ),
            );

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
            await waitFor(async () =>
                (await wallet2.getVtxos()).some((v) =>
                    v.assets?.some((a) => a.assetId === issueResult2.assetId),
                ),
            );

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
            await waitFor(async () => {
                const bobAssets = (await bob.wallet.getVtxos()).flatMap((v) => v.assets ?? []);
                const gotAsset1 =
                    bobAssets.find((a) => a.assetId === issueResult1.assetId)?.amount === 50n;
                const gotAsset2 =
                    bobAssets.find((a) => a.assetId === issueResult2.assetId)?.amount === 100n;
                return gotAsset1 && gotAsset2;
            });

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
            await waitFor(async () =>
                (await wallet3.getVtxos()).some((v) =>
                    v.assets?.some((a) => a.assetId === issueResult3.assetId),
                ),
            );

            // Snapshot the removed-delegate VTXOs so we can prove the forfeit
            // path actually spends one of them — not merely that the send
            // required multiple inputs.
            const delegateOutpoints = new Set(
                (await manager3.getContractsWithVtxos({ type: ["delegate"] }))
                    .flatMap((c) => c.vtxos.filter((v) => !v.isSpent))
                    .map((v) => `${v.txid}:${v.vout}`),
            );
            expect(delegateOutpoints.size).toBeGreaterThan(0);

            // Send more sats than the default contract alone can cover, forcing
            // coin selection to reach into the removed-delegate pool and spend a
            // delegate VTXO via the forfeit path.
            const defaultTotal = (await manager3.getContractsWithVtxos({ type: ["default"] }))
                .flatMap((c) => c.vtxos.filter((v) => !v.isSpent))
                .reduce((s, v) => s + v.value, 0);
            const sendAmount3 = defaultTotal + 1_000;

            // Spending works via forfeit path — assets should be preserved
            const txid3 = await wallet3.send({
                address: bobAddress,
                amount: sendAmount3,
                assets: [{ assetId: issueResult3.assetId, amount: 150n }],
            });
            expect(txid3).toBeDefined();
            await waitFor(async () => {
                const bobAssets3 = (await bob.wallet.getVtxos()).flatMap((v) => v.assets ?? []);
                return bobAssets3.find((a) => a.assetId === issueResult3.assetId)?.amount === 150n;
            });

            // Prove a specific removed-delegate VTXO was consumed: at least one
            // outpoint that was unspent before the send is no longer unspent.
            await waitFor(async () => {
                const delegateUnspentNow = new Set(
                    (await manager3.getContractsWithVtxos({ type: ["delegate"] }))
                        .flatMap((c) => c.vtxos.filter((v) => !v.isSpent))
                        .map((v) => `${v.txid}:${v.vout}`),
                );
                return [...delegateOutpoints].some((op) => !delegateUnspentNow.has(op));
            });

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
            await waitFor(async () =>
                (await wallet1.getVtxos()).some((v) =>
                    v.assets?.some((a) => a.assetId === issueResult.assetId),
                ),
            );

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

            // Snapshot delegate outpoints before the send so the change check can
            // require a NEW delegate output created by this transaction rather
            // than any pre-existing unspent VTXO.
            const delegateBefore = new Set(
                (await manager.getContractsWithVtxos({ type: ["delegate"] }))
                    .flatMap((c) => c.vtxos)
                    .map((v) => `${v.txid}:${v.vout}`),
            );

            const txid = await wallet2.send({
                address: bobAddress,
                amount: sendAmount,
                assets: [{ assetId: issueResult.assetId, amount: 200n }],
            });
            expect(txid).toBeDefined();
            await waitFor(async () => {
                const bobAssets = (await bob.wallet.getVtxos()).flatMap((v) => v.assets ?? []);
                return bobAssets.find((a) => a.assetId === issueResult.assetId)?.amount === 200n;
            });

            // Verify bob received the asset
            const bobVtxos = await bob.wallet.getVtxos();
            const bobAssets = bobVtxos.flatMap((v) => v.assets ?? []);
            const bobAsset = bobAssets.find((a) => a.assetId === issueResult.assetId);
            expect(bobAsset).toBeDefined();
            expect(bobAsset!.amount).toBe(200n);

            // Poll until this send is fully reflected: the wallet retains 300n of
            // the asset AND the change landed on the delegate contract as a NEW
            // outpoint (not a pre-existing unspent VTXO).
            await waitFor(async () => {
                const remaining = (await wallet2.getVtxos())
                    .flatMap((v) => v.assets ?? [])
                    .filter((a) => a.assetId === issueResult.assetId)
                    .reduce((s, a) => s + a.amount, 0n);
                if (remaining !== 300n) return false;
                const delegateNow = await manager.getContractsWithVtxos({
                    type: ["delegate"],
                });
                return delegateNow[0].vtxos.some(
                    (v) => !v.isSpent && !delegateBefore.has(`${v.txid}:${v.vout}`),
                );
            });

            const vtxosAfter = await wallet2.getVtxos();
            const aliceAssets = vtxosAfter.flatMap((v) => v.assets ?? []);
            const aliceRemaining = aliceAssets
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            expect(aliceRemaining).toBe(300n);

            // Change should land on the delegate contract as a new outpoint
            // created by this send, not merely leave some delegate VTXO unspent.
            const delegateContractAfter = await manager.getContractsWithVtxos({
                type: ["delegate"],
            });
            const newDelegateUnspent = delegateContractAfter[0].vtxos.filter(
                (v) => !v.isSpent && !delegateBefore.has(`${v.txid}:${v.vout}`),
            );
            expect(newDelegateUnspent.length).toBeGreaterThan(0);
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
            await waitFor(async () =>
                (await wallet2.getVtxos()).some((v) =>
                    v.assets?.some((a) => a.assetId === issueResult.assetId),
                ),
            );

            faucetOffchain(delegateAddress, 1_000);
            await waitFor(async () => (await wallet2.getVtxos()).length >= 2);

            // Step 3 — Send requiring both pools, including the asset
            const bob = await createTestArkWallet();
            const bobAddress = await bob.wallet.getAddress();

            const allVtxos = await wallet2.getVtxos();
            const maxSingleVtxo = Math.max(...allVtxos.map((v) => v.value));
            const sendAmount = maxSingleVtxo + 100;

            // Snapshot delegate outpoints before the send so the change check can
            // require a NEW delegate output created by this transaction rather
            // than any pre-existing unspent VTXO.
            const delegateBefore = new Set(
                (await manager.getContractsWithVtxos({ type: ["delegate"] }))
                    .flatMap((c) => c.vtxos)
                    .map((v) => `${v.txid}:${v.vout}`),
            );

            const txid = await wallet2.send({
                address: bobAddress,
                amount: sendAmount,
                assets: [{ assetId: issueResult.assetId, amount: 200n }],
            });
            expect(txid).toBeDefined();
            await waitFor(async () => {
                const bobAssets = (await bob.wallet.getVtxos()).flatMap((v) => v.assets ?? []);
                return bobAssets.find((a) => a.assetId === issueResult.assetId)?.amount === 200n;
            });

            // Verify bob received the asset
            const bobVtxos = await bob.wallet.getVtxos();
            const bobAssets = bobVtxos.flatMap((v) => v.assets ?? []);
            const bobAsset = bobAssets.find((a) => a.assetId === issueResult.assetId);
            expect(bobAsset).toBeDefined();
            expect(bobAsset!.amount).toBe(200n);

            // Poll until this send is fully reflected: the wallet retains 300n of
            // the asset AND the change landed on the delegate contract as a NEW
            // outpoint (not a pre-existing unspent VTXO).
            await waitFor(async () => {
                const remaining = (await wallet2.getVtxos())
                    .flatMap((v) => v.assets ?? [])
                    .filter((a) => a.assetId === issueResult.assetId)
                    .reduce((s, a) => s + a.amount, 0n);
                if (remaining !== 300n) return false;
                const delegateNow = await manager.getContractsWithVtxos({
                    type: ["delegate"],
                });
                return delegateNow[0].vtxos.some(
                    (v) => !v.isSpent && !delegateBefore.has(`${v.txid}:${v.vout}`),
                );
            });

            const vtxosAfter = await wallet2.getVtxos();
            const aliceAssets = vtxosAfter.flatMap((v) => v.assets ?? []);
            const aliceRemaining = aliceAssets
                .filter((a) => a.assetId === issueResult.assetId)
                .reduce((s, a) => s + a.amount, 0n);
            expect(aliceRemaining).toBe(300n);

            // Change should land on the delegate contract as a new outpoint
            // created by this send, not merely leave some delegate VTXO unspent.
            const delegateContractAfter = await manager.getContractsWithVtxos({
                type: ["delegate"],
            });
            const newDelegateUnspent = delegateContractAfter[0].vtxos.filter(
                (v) => !v.isSpent && !delegateBefore.has(`${v.txid}:${v.vout}`),
            );
            expect(newDelegateUnspent.length).toBeGreaterThan(0);
        },
    );
});
