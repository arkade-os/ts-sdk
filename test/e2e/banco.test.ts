import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    ArkAddress,
    RestArkProvider,
    RestIndexerProvider,
    RestIntrospectorProvider,
    asset,
} from "../../src";
import { banco } from "../../src";
const { Maker, Taker, Offer } = banco;
import { beforeEachFaucet, createTestArkWallet, faucetOffchain } from "./utils";

const ARK_SERVER_URL = "http://localhost:7070";
const INTROSPECTOR_URL = "http://localhost:7073";

describe("banco", () => {
    const indexer = new RestIndexerProvider(ARK_SERVER_URL);

    beforeEach(beforeEachFaucet, 20000);

    async function waitForVtxo(
        pkScript: Uint8Array,
        expectedCount = 1,
        timeout = 15000
    ) {
        let vtxos: any[] = [];
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const resp = await indexer.getVtxos({
                scripts: [hex.encode(pkScript)],
                spendableOnly: true,
            });
            vtxos = resp.vtxos;
            if (vtxos.length >= expectedCount) break;
            await new Promise((r) => setTimeout(r, 1000));
        }
        return vtxos;
    }

    it(
        "swap asset for BTC: maker sells asset, taker pays 10k sats",
        { timeout: 120000 },
        async () => {
            // ── Setup ──
            const makerWallet = await createTestArkWallet();
            const takerWallet = await createTestArkWallet();

            const makerAddress = await makerWallet.wallet.getAddress();
            const takerAddress = await takerWallet.wallet.getAddress();

            // ── Step 1: Maker issues an asset ──
            const assetAmount = 1000;
            faucetOffchain(makerAddress, 20_000);
            await new Promise((r) => setTimeout(r, 1000));

            const issueResult = await makerWallet.wallet.assetManager.issue({
                amount: assetAmount,
            });
            expect(issueResult.assetId).toBeDefined();
            await new Promise((r) => setTimeout(r, 2000));

            // ── Step 2: Maker creates offer via library ──
            const maker = new Maker(
                makerWallet.wallet,
                ARK_SERVER_URL,
                INTROSPECTOR_URL
            );

            const wantAmount = 10_000n;
            const { offer: offerHex, swapAddress } = await maker.createOffer({
                wantAmount,
                cancelDelay: 86400, // 24h
            });

            // ── Step 3: Maker sends asset to swap address ──
            // TODO: embed the banco offer packet in the extension output
            // For now, the funding tx is a standard send; the taker uses the
            // offer hex directly via Offer.fromHex to reconstruct the offer data.
            await makerWallet.wallet.send({
                address: swapAddress,
                amount: 0,
                assets: [{ assetId: issueResult.assetId, amount: assetAmount }],
            });
            await new Promise((r) => setTimeout(r, 2000));

            // Verify swap VTXO exists
            const swapDecoded = ArkAddress.decode(swapAddress);
            const swapVtxos = await waitForVtxo(swapDecoded.pkScript);
            expect(swapVtxos).toHaveLength(1);
            const fundingTxid = swapVtxos[0].txid;

            // ── Step 4: Fund the taker with 10k sats BTC ──
            faucetOffchain(takerAddress, Number(wantAmount));
            await new Promise((r) => setTimeout(r, 1000));

            // ── Step 5: Taker fulfills the offer via library ──
            const taker = new Taker(
                takerWallet.wallet,
                ARK_SERVER_URL,
                INTROSPECTOR_URL
            );

            const { txid } = await taker.fulfill(offerHex);
            expect(txid).toBeDefined();

            // ── Step 6: Verify results ──
            await new Promise((r) => setTimeout(r, 2000));

            const makerDecoded = ArkAddress.decode(makerAddress);
            const makerFinalVtxos = await waitForVtxo(makerDecoded.pkScript, 2);
            const makerBtcReceived = makerFinalVtxos.reduce(
                (s: number, v: any) => s + v.value,
                0
            );
            expect(makerBtcReceived).toBeGreaterThanOrEqual(Number(wantAmount));

            const takerDecoded = ArkAddress.decode(takerAddress);
            const takerFinalVtxos = await waitForVtxo(takerDecoded.pkScript, 1);
            const takerAssets = takerFinalVtxos.flatMap(
                (v: any) => v.assets ?? []
            );
            const takerAsset = takerAssets.find(
                (a: any) => a.assetId === issueResult.assetId
            );
            expect(takerAsset).toBeDefined();
            expect(takerAsset!.amount).toBe(assetAmount);

            console.log(
                `Swap complete: maker got ${makerBtcReceived} sats BTC, ` +
                    `taker got ${assetAmount} units of asset ${issueResult.assetId.slice(0, 16)}... ` +
                    `(txid: ${txid})`
            );
        }
    );

    it(
        "swap asset for asset: maker sells asset A, taker pays asset B",
        { timeout: 120000 },
        async () => {
            const makerWallet = await createTestArkWallet();
            const takerWallet = await createTestArkWallet();

            const makerAddress = await makerWallet.wallet.getAddress();
            const takerAddress = await takerWallet.wallet.getAddress();

            // ── Step 1: Maker issues asset A ──
            const assetAAmount = 500;
            faucetOffchain(makerAddress, 20_000);
            await new Promise((r) => setTimeout(r, 1000));

            const issueA = await makerWallet.wallet.assetManager.issue({
                amount: assetAAmount,
            });
            expect(issueA.assetId).toBeDefined();
            await new Promise((r) => setTimeout(r, 2000));

            // ── Step 2: Taker issues asset B ──
            const assetBAmount = 300;
            faucetOffchain(takerAddress, 20_000);
            await new Promise((r) => setTimeout(r, 1000));

            const issueB = await takerWallet.wallet.assetManager.issue({
                amount: assetBAmount,
            });
            expect(issueB.assetId).toBeDefined();
            await new Promise((r) => setTimeout(r, 2000));

            // ── Step 3: Maker creates offer: sell asset A, want asset B ──
            const maker = new Maker(
                makerWallet.wallet,
                ARK_SERVER_URL,
                INTROSPECTOR_URL
            );

            const wantAsset = asset.AssetId.fromString(issueB.assetId);

            const { offer: offerHex, swapAddress } = await maker.createOffer({
                wantAmount: BigInt(assetBAmount),
                wantAsset,
                cancelDelay: 86400,
            });

            // ── Step 4: Maker sends asset A to swap address ──
            await makerWallet.wallet.send({
                address: swapAddress,
                amount: 0,
                assets: [{ assetId: issueA.assetId, amount: assetAAmount }],
            });
            await new Promise((r) => setTimeout(r, 2000));

            const swapDecoded = ArkAddress.decode(swapAddress);
            const swapVtxos = await waitForVtxo(swapDecoded.pkScript);
            expect(swapVtxos).toHaveLength(1);

            // ── Step 5: Taker fulfills the offer ──
            const taker = new Taker(
                takerWallet.wallet,
                ARK_SERVER_URL,
                INTROSPECTOR_URL
            );

            const { txid } = await taker.fulfill(offerHex);
            expect(txid).toBeDefined();

            // ── Step 6: Verify results ──
            await new Promise((r) => setTimeout(r, 2000));

            // Maker should have received asset B
            const makerDecoded = ArkAddress.decode(makerAddress);
            const makerFinalVtxos = await waitForVtxo(makerDecoded.pkScript, 2);
            const makerAssets = makerFinalVtxos.flatMap(
                (v: any) => v.assets ?? []
            );
            const makerAssetB = makerAssets.find(
                (a: any) => a.assetId === issueB.assetId
            );
            expect(makerAssetB).toBeDefined();
            expect(makerAssetB!.amount).toBe(assetBAmount);

            // Taker should have received asset A
            const takerDecoded = ArkAddress.decode(takerAddress);
            const takerFinalVtxos = await waitForVtxo(takerDecoded.pkScript, 1);
            const takerAssets = takerFinalVtxos.flatMap(
                (v: any) => v.assets ?? []
            );
            const takerAssetA = takerAssets.find(
                (a: any) => a.assetId === issueA.assetId
            );
            expect(takerAssetA).toBeDefined();
            expect(takerAssetA!.amount).toBe(assetAAmount);

            console.log(
                `Asset swap complete: maker got ${assetBAmount} of asset B, ` +
                    `taker got ${assetAAmount} of asset A (txid: ${txid})`
            );
        }
    );
});
