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
import type { IWallet } from "../wallet";
import { BancoSwap } from "./contract";
import { Offer } from "./offer";

/**
 * Taker (buy-side) of a banco swap.
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

        let want: "btc" | asset.AssetId = "btc";
        if (offer.wantAsset) {
            const [txid, voutStr] = offer.wantAsset.split(":");
            want = asset.AssetId.create(txid, Number(voutStr ?? 0));
        }

        const swap = new BancoSwap(
            {
                wantAmount: offer.wantAmount,
                want,
                cltvCancelTimelock: offer.cancelDelay,
                exitTimelock,
                makerPkScript: offer.makerPkScript,
                makerPublicKey: offer.makerPublicKey,
            },
            serverPubKey,
            [offer.introspectorPubkey]
        );

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

        const takerVtxos = await this.wallet.getVtxos();
        if (takerVtxos.length === 0) {
            throw new Error("Taker wallet has no VTXOs");
        }

        const takerAddress = await this.wallet.getAddress();
        const takerPkScript = ArkAddress.decode(takerAddress).pkScript;

        const totalTaker = takerVtxos.reduce((s, v) => s + v.value, 0);
        const changeAmount = BigInt(totalTaker) - offer.wantAmount;
        if (changeAmount < 0n) {
            throw new Error(
                `Insufficient funds: have ${totalTaker} sats, need ${offer.wantAmount}`
            );
        }

        // Build outputs: maker payment, taker receives swap value, optional change
        const outputs: { script: Uint8Array; amount: bigint }[] = [
            { script: offer.makerPkScript, amount: offer.wantAmount },
            { script: takerPkScript, amount: BigInt(swapVtxo.value) },
        ];
        if (changeAmount > 0n) {
            outputs.push({ script: takerPkScript, amount: changeAmount });
        }

        // Build extension: introspector packet + optional asset transfer
        const extensionPackets: Parameters<typeof Extension.create>[0] = [
            IntrospectorPacket.create([
                {
                    vin: 0,
                    script: swap.fulfillScript(),
                    witness: new Uint8Array(0),
                },
            ]),
        ];
        if (swapVtxo.assets && swapVtxo.assets.length > 0) {
            const assetGroups = swapVtxo.assets.map(
                (a: { assetId: string; amount: number }) =>
                    asset.AssetGroup.create(
                        asset.AssetId.fromString(a.assetId),
                        null,
                        [asset.AssetInput.create(0, a.amount)],
                        [asset.AssetOutput.create(1, a.amount)],
                        []
                    )
            );
            extensionPackets.unshift(asset.Packet.create(assetGroups));
        }
        outputs.push(Extension.create(extensionPackets).txOut());

        // Build the offchain transaction
        const swapInput = {
            ...swapVtxo,
            tapLeafScript: swapTapLeafScript,
            tapTree: swapTapTree,
        };
        const takerInputs = takerVtxos.map((v) => ({
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

        // Merge introspector sigs into server checkpoints and counter-sign
        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (serverCp, i) => {
                const serverTx = Transaction.fromPSBT(base64.decode(serverCp));
                const introTx = Transaction.fromPSBT(
                    base64.decode(introResult.signedCheckpointTxs[i])
                );

                for (let j = 0; j < introTx.inputsLength; j++) {
                    const introInput = introTx.getInput(j);
                    if (introInput.tapScriptSig) {
                        const serverInput = serverTx.getInput(j);
                        serverTx.updateInput(j, {
                            tapScriptSig: [
                                ...(serverInput.tapScriptSig ?? []),
                                ...introInput.tapScriptSig,
                            ],
                        });
                    }
                }

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
