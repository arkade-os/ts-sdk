import { hex, base64 } from "@scure/base";
import { ArkAddress } from "../script/address";
import { RestArkProvider } from "../providers/ark";
import { RestIndexerProvider } from "../providers/indexer";
import { RestIntrospectorProvider } from "../providers/introspector";
import { CSVMultisigTapscript, MultisigTapscript } from "../script/tapscript";
import type { RelativeTimelock } from "../script/tapscript";
import { Transaction } from "../utils/transaction";
import { buildOffchainTx } from "../utils/arkTransaction";
import * as arkade from "../arkade";
import * as asset from "../extension/asset";
import { Extension } from "../extension";
import { IntrospectorPacket } from "../extension/introspector";
import type { IWallet, ExtendedVirtualCoin } from "../wallet";
import { selectCoinsWithAsset } from "../wallet/asset";
import { selectVirtualCoins } from "../wallet/wallet";
import { BancoSwap } from "./contract";
import { Offer } from "./offer";

/**
 * Taker of a banco swap.
 *
 * Decodes an offer, locates the swap VTXO, builds the fulfillment
 * transaction, and submits it through the introspector and ark server.
 *
 * @example
 * ```ts
 * const taker = new banco.Taker(wallet, serverUrl, introspectorUrl);
 * const { txid } = await taker.fulfill(offerHex);
 * ```
 */
export class Taker {
    private readonly arkProvider: RestArkProvider;
    private readonly indexer: RestIndexerProvider;
    private readonly introspector: RestIntrospectorProvider;

    constructor(
        private readonly wallet: IWallet,
        arkServerUrl: string,
        introspectorUrl: string
    ) {
        this.arkProvider = new RestArkProvider(arkServerUrl);
        this.indexer = new RestIndexerProvider(arkServerUrl);
        this.introspector = new RestIntrospectorProvider(introspectorUrl);
    }

    /**
     * Fulfill a swap by looking up the funding virtual tx and extracting
     * the embedded Banco offer packet from its extension output.
     *
     * @param txid - The txid of the virtual transaction that funded the swap address.
     * @returns The ark transaction id of the fulfillment.
     */
    async fulfillByTxid(txid: string): Promise<{ txid: string }> {
        const { txs } = await this.indexer.getVirtualTxs([txid]);
        if (txs.length === 0) {
            throw new Error(`Virtual transaction ${txid} not found`);
        }
        const fundingTx = Transaction.fromPSBT(base64.decode(txs[0]));
        const ext = Extension.fromTx(fundingTx);
        const offerData = ext.getBancoOffer();
        if (!offerData) {
            throw new Error(
                `No Banco offer packet found in transaction ${txid}`
            );
        }
        return this.fulfillOffer(offerData);
    }

    /**
     * Fulfill a swap from a hex-encoded TLV offer.
     *
     * @param offerHex - The hex-encoded offer from the maker.
     * @returns The ark transaction id of the fulfillment.
     */
    async fulfill(offerHex: string): Promise<{ txid: string }> {
        return this.fulfillOffer(Offer.fromHex(offerHex));
    }

    private async fulfillOffer(offer: Offer.Data): Promise<{ txid: string }> {
        const info = await this.arkProvider.getInfo();
        const serverPubKey = hex.decode(info.signerPubkey).slice(1);
        const checkpointUnrollClosure = CSVMultisigTapscript.decode(
            hex.decode(info.checkpointTapscript)
        );

        const exitDelay = info.unilateralExitDelay;
        const exitTimelock: RelativeTimelock = {
            value: exitDelay,
            type: exitDelay < 512n ? "blocks" : "seconds",
        };

        const swap = BancoSwap.fromOffer(offer, serverPubKey, exitTimelock);

        const swapVtxoScript = swap.vtxoScript();
        const swapPkScript = hex.encode(swapVtxoScript.pkScript);

        // Verify that the reconstructed contract matches the offer's swapAddress
        const expectedPkScript = hex.encode(
            ArkAddress.decode(offer.swapAddress).pkScript
        );
        if (swapPkScript !== expectedPkScript) {
            throw new Error(
                "Offer inconsistency: swapAddress does not match the reconstructed contract"
            );
        }

        const { vtxos: swapVtxos } = await this.indexer.getVtxos({
            scripts: [swapPkScript],
            spendableOnly: true,
        });
        if (swapVtxos.length === 0) {
            throw new Error("No spendable VTXO found at swap address");
        }
        const swapVtxo = swapVtxos[0];

        // Locate the fulfill leaf (arkade multisig: server + tweaked introspector)
        const fulfillMultisig = MultisigTapscript.encode({
            pubkeys: [
                serverPubKey,
                arkade.computeArkadeScriptPublicKey(
                    offer.introspectorPubkey,
                    swap.fulfillScript()
                ),
            ],
        });
        const swapTapLeafScript = swapVtxoScript.findLeaf(
            hex.encode(fulfillMultisig.script)
        );
        const swapTapTree = swapVtxoScript.encode();

        const allTakerVtxos = await this.wallet.getVtxos();
        if (allTakerVtxos.length === 0) {
            throw new Error("Taker wallet has no VTXOs");
        }

        const takerAddress = await this.wallet.getAddress();
        const takerPkScript = ArkAddress.decode(takerAddress).pkScript;

        const wantAssetStr = offer.wantAsset?.toString();
        const DUST = 450n;

        // ── Coin selection (mirrors wallet.send logic) ──
        let selectedTakerVtxos: ExtendedVirtualCoin[];
        let takerAssetChange = 0n;

        if (wantAssetStr) {
            // Select coins carrying the wanted asset
            const { selected, totalAssetAmount } = selectCoinsWithAsset(
                allTakerVtxos,
                wantAssetStr,
                offer.wantAmount
            );
            selectedTakerVtxos = selected;
            takerAssetChange = totalAssetAmount - offer.wantAmount;

            // Asset coins may not carry enough BTC for the maker's dust output;
            // select additional BTC coins if needed.
            const selectedBtc = selected.reduce((s, v) => s + v.value, 0);
            if (selectedBtc < Number(DUST)) {
                const remaining = allTakerVtxos.filter(
                    (c) =>
                        !selected.find(
                            (sc) => sc.txid === c.txid && sc.vout === c.vout
                        )
                );
                const { inputs: extraCoins } = selectVirtualCoins(
                    remaining,
                    Number(DUST) - selectedBtc
                );
                selectedTakerVtxos = [...selected, ...extraCoins];
            }
        } else {
            // BTC: target-based selection sorted by expiry then amount
            const { inputs } = selectVirtualCoins(
                allTakerVtxos,
                Number(offer.wantAmount)
            );
            selectedTakerVtxos = inputs;
        }

        const totalTakerBtc = BigInt(
            selectedTakerVtxos.reduce((s, v) => s + v.value, 0)
        );

        // ── Build asset groups ──
        const assetGroups: asset.AssetGroup[] = [];

        // Assets from the swap VTXO (input 0) → taker (output 1)
        if (swapVtxo.assets && swapVtxo.assets.length > 0) {
            for (const a of swapVtxo.assets) {
                assetGroups.push(
                    asset.AssetGroup.create(
                        asset.AssetId.fromString(a.assetId),
                        null,
                        [asset.AssetInput.create(0, a.amount)],
                        [asset.AssetOutput.create(1, a.amount)],
                        []
                    )
                );
            }
        }

        // Wanted asset from taker → maker (output 0), change → taker (output 1)
        if (offer.wantAsset) {
            const assetInputs: asset.AssetInput[] = [];
            for (let i = 0; i < selectedTakerVtxos.length; i++) {
                const vtxo = selectedTakerVtxos[i];
                const entry = vtxo.assets?.find(
                    (a) => a.assetId === wantAssetStr
                );
                if (entry)
                    assetInputs.push(
                        asset.AssetInput.create(i + 1, entry.amount)
                    );
            }
            const assetOutputs: asset.AssetOutput[] = [
                asset.AssetOutput.create(0, Number(offer.wantAmount)),
            ];
            if (takerAssetChange > 0n) {
                assetOutputs.push(
                    asset.AssetOutput.create(1, Number(takerAssetChange))
                );
            }
            // Wanted-asset group must be at array index 0,
            // matching gidx=0 in the fulfillScript's INSPECTOUTASSETLOOKUP call.
            assetGroups.unshift(
                asset.AssetGroup.create(
                    offer.wantAsset,
                    null,
                    assetInputs,
                    assetOutputs,
                    []
                )
            );
        }

        // Collateral assets on selected taker coins → taker (output 1)
        // (coins selected for BTC or asset may carry unrelated assets)
        const collateral = new Map<
            string,
            { inputs: asset.AssetInput[]; total: number }
        >();
        for (let i = 0; i < selectedTakerVtxos.length; i++) {
            const vtxo = selectedTakerVtxos[i];
            if (!vtxo.assets) continue;
            for (const a of vtxo.assets) {
                if (a.assetId === wantAssetStr) continue;
                let entry = collateral.get(a.assetId);
                if (!entry) {
                    entry = { inputs: [], total: 0 };
                    collateral.set(a.assetId, entry);
                }
                entry.inputs.push(asset.AssetInput.create(i + 1, a.amount));
                entry.total += a.amount;
            }
        }
        for (const [id, { inputs, total }] of collateral) {
            assetGroups.push(
                asset.AssetGroup.create(
                    asset.AssetId.fromString(id),
                    null,
                    inputs,
                    [asset.AssetOutput.create(1, total)],
                    []
                )
            );
        }

        // ── Build outputs ──
        const makerBtcAmount = offer.wantAsset ? DUST : offer.wantAmount;
        const btcChange = totalTakerBtc - makerBtcAmount;
        if (btcChange < 0n) {
            throw new Error(
                `Insufficient BTC: have ${totalTakerBtc}, need ${makerBtcAmount}`
            );
        }

        const outputs: { script: Uint8Array; amount: bigint }[] = [
            { script: offer.makerPkScript, amount: makerBtcAmount },
            { script: takerPkScript, amount: BigInt(swapVtxo.value) },
        ];
        if (btcChange > 0n) {
            outputs.push({ script: takerPkScript, amount: btcChange });
        }

        // ── Build extension ──
        const fulfillScriptBytes = swap.fulfillScript();
        const extensionPackets: Parameters<typeof Extension.create>[0] = [
            IntrospectorPacket.create([
                {
                    vin: 0,
                    script: fulfillScriptBytes,
                    witness: new Uint8Array(0),
                },
            ]),
        ];
        if (assetGroups.length > 0) {
            extensionPackets.unshift(asset.Packet.create(assetGroups));
        }
        outputs.push(Extension.create(extensionPackets).txOut());

        // Build the offchain transaction
        const swapInput = {
            ...swapVtxo,
            tapLeafScript: swapTapLeafScript,
            tapTree: swapTapTree,
        };
        const takerInputs = selectedTakerVtxos.map((v) => ({
            ...v,
            tapLeafScript: v.forfeitTapLeafScript,
            tapTree: v.tapTree,
        }));

        const { arkTx, checkpoints } = buildOffchainTx(
            [swapInput, ...takerInputs],
            outputs,
            checkpointUnrollClosure
        );

        // Sign taker inputs only (swap input at index 0 is server + introspector)
        const takerInputIndexes = takerInputs.map((_, i) => i + 1);
        const signedArkTx = await this.wallet.identity.sign(
            arkTx,
            takerInputIndexes
        );

        // Submit to introspector
        const introResult = await this.introspector.submitTx(
            base64.encode(signedArkTx.toPSBT()),
            checkpoints.map((c) => base64.encode(c.toPSBT()))
        );

        // Verify the introspector actually signed the swap checkpoint
        const introCheckpoint0 = Transaction.fromPSBT(
            base64.decode(introResult.signedCheckpointTxs[0])
        );
        const introInput0 = introCheckpoint0.getInput(0);
        if (
            !introInput0.tapScriptSig ||
            introInput0.tapScriptSig.length === 0
        ) {
            throw new Error("Introspector did not sign the swap checkpoint");
        }

        // Submit to ark server
        const { arkTxid, signedCheckpointTxs } =
            await this.arkProvider.submitTx(
                introResult.signedArkTx,
                introResult.signedCheckpointTxs
            );

        // Merge introspector sigs + taproot metadata into server checkpoints,
        // then counter-sign. The server reconstructs PSBTs and discards
        // taproot metadata, so combine() restores it from the introspector copy.
        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (serverCp, i) => {
                const serverTx = Transaction.fromPSBT(base64.decode(serverCp));
                const introTx = Transaction.fromPSBT(
                    base64.decode(introResult.signedCheckpointTxs[i])
                );
                serverTx.combine(introTx);

                if (i > 0) {
                    const signed = await this.wallet.identity.sign(serverTx, [
                        0,
                    ]);
                    return base64.encode(signed.toPSBT());
                }
                return base64.encode(serverTx.toPSBT());
            })
        );

        await this.arkProvider.finalizeTx(arkTxid, finalCheckpoints);
        return { txid: arkTxid };
    }
}
