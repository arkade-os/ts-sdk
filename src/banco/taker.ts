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

export interface FulfillOptions {
    /** Amount of asset to deliver. If omitted, fills the entire offer. */
    fillAmount?: bigint;
}

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
     * @param options - Optional fill parameters (e.g. `fillAmount` for partial fills).
     * @returns The ark transaction id of the fulfillment.
     */
    async fulfillByTxid(
        txid: string,
        options?: FulfillOptions
    ): Promise<{ txid: string }> {
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
        return this.fulfillOffer(offerData, options);
    }

    /**
     * Fulfill a swap from a hex-encoded TLV offer.
     *
     * @param offerHex - The hex-encoded offer from the maker.
     * @param options - Optional fill parameters (e.g. `fillAmount` for partial fills).
     * @returns The ark transaction id of the fulfillment.
     */
    async fulfill(
        offerHex: string,
        options?: FulfillOptions
    ): Promise<{ txid: string }> {
        return this.fulfillOffer(Offer.fromHex(offerHex), options);
    }

    private async fulfillOffer(
        offer: Offer.Data,
        options?: FulfillOptions
    ): Promise<{ txid: string }> {
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
        const isPartial = swap.isPartialFill();
        const covenantScriptBytes = swap.covenantScript();

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

        const fulfillMultisig = MultisigTapscript.encode({
            pubkeys: [
                serverPubKey,
                arkade.computeArkadeScriptPublicKey(
                    offer.introspectorPubkey,
                    covenantScriptBytes
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
        const offerAssetStr = offer.offerAsset?.toString();
        const isAssetOffer = offerAssetStr !== undefined;
        const DUST = 450n;
        const swapValue = BigInt(swapVtxo.value);

        // ── Determine fill amount ──
        const fillAmount =
            isPartial && options?.fillAmount !== undefined
                ? options.fillAmount
                : offer.wantAmount;
        if (isPartial && fillAmount <= 0n) {
            throw new Error("fillAmount must be positive");
        }

        // ── Coin selection ──
        let selectedTakerVtxos: ExtendedVirtualCoin[];
        let takerAssetChange = 0n;

        if (wantAssetStr) {
            const { selected, totalAssetAmount } = selectCoinsWithAsset(
                allTakerVtxos,
                wantAssetStr,
                fillAmount
            );
            selectedTakerVtxos = selected;
            takerAssetChange = totalAssetAmount - fillAmount;

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
            const { inputs } = selectVirtualCoins(
                allTakerVtxos,
                Number(fillAmount)
            );
            selectedTakerVtxos = inputs;
        }

        const totalTakerBtc = BigInt(
            selectedTakerVtxos.reduce((s, v) => s + v.value, 0)
        );

        // ── Build outputs and asset groups ──
        const outputs: { script: Uint8Array; amount: bigint }[] = [];
        const assetGroups: asset.AssetGroup[] = [];

        if (isPartial) {
            const consumed = (fillAmount * offer.ratioNum!) / offer.ratioDen!;
            const makerOutputIdx = 1;

            if (isAssetOffer) {
                // ────────────────────────────────
                // asset→BTC or asset→asset
                //   Partial: [0: bancoChange(dust+asset), 1: maker, 2: taker]
                //   Full:    [0: makerDustReturn, 1: maker, 2: taker]
                // ────────────────────────────────
                const offerEntry = swapVtxo.assets?.find(
                    (a) => a.assetId === offerAssetStr
                );
                if (!offerEntry) {
                    throw new Error(
                        "Swap VTXO does not carry the offered asset"
                    );
                }
                const swapOfferAmount = BigInt(offerEntry.amount);
                const isFullFill = consumed >= swapOfferAmount;
                const takerOutputIdx = 2;

                // asset→BTC: maker gets fillAmount BTC
                // asset→asset: maker gets DUST (as asset carrier)
                const makerBtc = wantAssetStr ? DUST : fillAmount;
                const takerBtc = totalTakerBtc - makerBtc;

                if (totalTakerBtc < makerBtc) {
                    throw new Error(
                        `Insufficient BTC: have ${totalTakerBtc}, need ${makerBtc}`
                    );
                }

                if (isFullFill) {
                    outputs.push(
                        { script: offer.makerPkScript, amount: swapValue },
                        { script: offer.makerPkScript, amount: makerBtc },
                        { script: takerPkScript, amount: takerBtc }
                    );
                } else {
                    outputs.push(
                        {
                            script: swapVtxoScript.pkScript,
                            amount: swapValue,
                        },
                        { script: offer.makerPkScript, amount: makerBtc },
                        { script: takerPkScript, amount: takerBtc }
                    );
                }

                // Route offer asset from swap VTXO (input 0)
                const offerOutputs: asset.AssetOutput[] = [];
                if (isFullFill) {
                    offerOutputs.push(
                        asset.AssetOutput.create(
                            takerOutputIdx,
                            offerEntry.amount
                        )
                    );
                } else {
                    offerOutputs.push(
                        asset.AssetOutput.create(
                            0,
                            Number(swapOfferAmount - consumed)
                        ),
                        asset.AssetOutput.create(
                            takerOutputIdx,
                            Number(consumed)
                        )
                    );
                }
                assetGroups.push(
                    asset.AssetGroup.create(
                        offer.offerAsset!,
                        null,
                        [asset.AssetInput.create(0, offerEntry.amount)],
                        offerOutputs,
                        []
                    )
                );

                // Other assets on swap VTXO → taker
                if (swapVtxo.assets) {
                    for (const a of swapVtxo.assets) {
                        if (a.assetId === offerAssetStr) continue;
                        assetGroups.push(
                            asset.AssetGroup.create(
                                asset.AssetId.fromString(a.assetId),
                                null,
                                [asset.AssetInput.create(0, a.amount)],
                                [
                                    asset.AssetOutput.create(
                                        takerOutputIdx,
                                        a.amount
                                    ),
                                ],
                                []
                            )
                        );
                    }
                }

                // Want asset from taker → maker (asset→asset only)
                if (offer.wantAsset) {
                    const wantInputs: asset.AssetInput[] = [];
                    for (let i = 0; i < selectedTakerVtxos.length; i++) {
                        const vtxo = selectedTakerVtxos[i];
                        const entry = vtxo.assets?.find(
                            (a) => a.assetId === wantAssetStr
                        );
                        if (entry) {
                            wantInputs.push(
                                asset.AssetInput.create(i + 1, entry.amount)
                            );
                        }
                    }
                    const wantOutputs: asset.AssetOutput[] = [
                        asset.AssetOutput.create(
                            makerOutputIdx,
                            Number(fillAmount)
                        ),
                    ];
                    if (takerAssetChange > 0n) {
                        wantOutputs.push(
                            asset.AssetOutput.create(
                                takerOutputIdx,
                                Number(takerAssetChange)
                            )
                        );
                    }
                    assetGroups.push(
                        asset.AssetGroup.create(
                            offer.wantAsset,
                            null,
                            wantInputs,
                            wantOutputs,
                            []
                        )
                    );
                }

                this.collectCollateral(
                    selectedTakerVtxos,
                    [wantAssetStr, offerAssetStr].filter(Boolean) as string[],
                    takerOutputIdx,
                    assetGroups
                );
            } else {
                // ────────────────────────────────
                // BTC→asset
                //   Partial: [0: bancoChange, 1: maker, 2: taker]
                //   Full:    [0: taker, 1: maker]
                // ────────────────────────────────
                const isFullFill = consumed >= swapValue;
                const takerOutputIdx = isFullFill ? 0 : 2;

                const makerBtc = DUST;
                const freedBtc = isFullFill ? swapValue : consumed;
                const takerBtc = freedBtc + totalTakerBtc - makerBtc;

                if (totalTakerBtc < makerBtc) {
                    throw new Error(
                        `Insufficient BTC: have ${totalTakerBtc}, need ${makerBtc}`
                    );
                }

                if (isFullFill) {
                    outputs.push(
                        { script: takerPkScript, amount: takerBtc },
                        { script: offer.makerPkScript, amount: makerBtc }
                    );
                } else {
                    const bancoChange = swapValue - consumed;
                    outputs.push(
                        {
                            script: swapVtxoScript.pkScript,
                            amount: bancoChange,
                        },
                        { script: offer.makerPkScript, amount: makerBtc },
                        { script: takerPkScript, amount: takerBtc }
                    );
                }

                if (offer.wantAsset) {
                    const wantInputs: asset.AssetInput[] = [];
                    for (let i = 0; i < selectedTakerVtxos.length; i++) {
                        const vtxo = selectedTakerVtxos[i];
                        const entry = vtxo.assets?.find(
                            (a) => a.assetId === wantAssetStr
                        );
                        if (entry) {
                            wantInputs.push(
                                asset.AssetInput.create(i + 1, entry.amount)
                            );
                        }
                    }
                    const wantOutputs: asset.AssetOutput[] = [
                        asset.AssetOutput.create(
                            makerOutputIdx,
                            Number(fillAmount)
                        ),
                    ];
                    if (takerAssetChange > 0n) {
                        wantOutputs.push(
                            asset.AssetOutput.create(
                                takerOutputIdx,
                                Number(takerAssetChange)
                            )
                        );
                    }
                    assetGroups.push(
                        asset.AssetGroup.create(
                            offer.wantAsset,
                            null,
                            wantInputs,
                            wantOutputs,
                            []
                        )
                    );
                }

                this.collectCollateral(
                    selectedTakerVtxos,
                    wantAssetStr ? [wantAssetStr] : [],
                    takerOutputIdx,
                    assetGroups
                );
            }
        } else {
            // ────────────────────────────────
            // Legacy full-fill output layout
            //   [0: maker, 1: taker(swap BTC), 2?: taker change]
            // ────────────────────────────────

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

            // Wanted asset: taker → maker (output 0), change → taker (output 1)
            if (offer.wantAsset) {
                const assetInputs: asset.AssetInput[] = [];
                for (let i = 0; i < selectedTakerVtxos.length; i++) {
                    const vtxo = selectedTakerVtxos[i];
                    const entry = vtxo.assets?.find(
                        (a) => a.assetId === wantAssetStr
                    );
                    if (entry) {
                        assetInputs.push(
                            asset.AssetInput.create(i + 1, entry.amount)
                        );
                    }
                }
                const assetOutputs: asset.AssetOutput[] = [
                    asset.AssetOutput.create(0, Number(offer.wantAmount)),
                ];
                if (takerAssetChange > 0n) {
                    assetOutputs.push(
                        asset.AssetOutput.create(1, Number(takerAssetChange))
                    );
                }
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

            // Collateral assets → taker (output 1)
            this.collectCollateral(
                selectedTakerVtxos,
                wantAssetStr ? [wantAssetStr] : [],
                1,
                assetGroups
            );

            const makerBtcAmount = offer.wantAsset ? DUST : offer.wantAmount;
            const btcChange = totalTakerBtc - makerBtcAmount;
            if (btcChange < 0n) {
                throw new Error(
                    `Insufficient BTC: have ${totalTakerBtc}, need ${makerBtcAmount}`
                );
            }

            outputs.push(
                { script: offer.makerPkScript, amount: makerBtcAmount },
                { script: takerPkScript, amount: swapValue }
            );
            if (btcChange > 0n) {
                outputs.push({ script: takerPkScript, amount: btcChange });
            }
        }

        // ── Extension ──
        const extensionPackets: Parameters<typeof Extension.create>[0] = [
            IntrospectorPacket.create([
                {
                    vin: 0,
                    script: covenantScriptBytes,
                    witness: new Uint8Array(0),
                },
            ]),
        ];
        if (assetGroups.length > 0) {
            extensionPackets.unshift(asset.Packet.create(assetGroups));
        }
        outputs.push(Extension.create(extensionPackets).txOut());

        // ── Build, sign, and submit ──
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

        const takerInputIndexes = takerInputs.map((_, i) => i + 1);
        const signedArkTx = await this.wallet.identity.sign(
            arkTx,
            takerInputIndexes
        );

        const introResult = await this.introspector.submitTx(
            base64.encode(signedArkTx.toPSBT()),
            checkpoints.map((c) => base64.encode(c.toPSBT()))
        );

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

        const { arkTxid, signedCheckpointTxs } =
            await this.arkProvider.submitTx(
                introResult.signedArkTx,
                introResult.signedCheckpointTxs
            );

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

    /** Gather unrelated (collateral) assets from taker coins into asset groups. */
    private collectCollateral(
        selectedVtxos: ExtendedVirtualCoin[],
        excludeAssetIds: string[],
        takerOutputIdx: number,
        assetGroups: asset.AssetGroup[]
    ): void {
        const excludeSet = new Set(excludeAssetIds);
        const collateral = new Map<
            string,
            { inputs: asset.AssetInput[]; total: number }
        >();
        for (let i = 0; i < selectedVtxos.length; i++) {
            const vtxo = selectedVtxos[i];
            if (!vtxo.assets) continue;
            for (const a of vtxo.assets) {
                if (excludeSet.has(a.assetId)) continue;
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
                    [asset.AssetOutput.create(takerOutputIdx, total)],
                    []
                )
            );
        }
    }
}
