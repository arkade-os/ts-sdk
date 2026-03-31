import { hex, base64 } from "@scure/base";
import { ArkAddress } from "../script/address";
import { RestArkProvider } from "../providers/ark";
import { RestIndexerProvider } from "../providers/indexer";
import { RestIntrospectorProvider } from "../providers/introspector";
import {
    CSVMultisigTapscript,
    CLTVMultisigTapscript,
} from "../script/tapscript";
import type { RelativeTimelock } from "../script/tapscript";
import { Transaction } from "../utils/transaction";
import { buildOffchainTx } from "../utils/arkTransaction";
import * as asset from "../extension/asset";
import type { ExtensionPacket } from "../extension/packet";
import type { IWallet } from "../wallet";
import { gcd } from "../utils/math";
import { BancoSwap } from "./contract";
import { Offer } from "./offer";

export interface CreateOfferParams {
    /** Amount the maker wants to receive (in sats or asset units). */
    wantAmount: bigint;
    /** Asset the maker wants. Omit for BTC. */
    wantAsset?: asset.AssetId;
    /** Asset the maker is offering (locked in the VTXO). Omit for BTC. */
    offerAsset?: asset.AssetId;
    /**
     * Partial-fill ratio numerator.
     * Must be provided together with `ratioDen`. Both must be positive.
     * Automatically reduced by GCD before encoding.
     */
    ratioNum?: bigint;
    /**
     * Partial-fill ratio denominator.
     * Must be provided together with `ratioNum`. Both must be positive.
     */
    ratioDen?: bigint;
    /** Seconds from now after which the maker can cancel. */
    cancelDelay?: number;
}

/** Status of a VTXO at a swap address. */
export interface OfferStatus {
    txid: string;
    vout: number;
    value: number;
    assets?: { assetId: string; amount: number }[];
    spendable: boolean;
}

/**
 * Maker (sell-side) of a banco swap.
 *
 * Creates offers, queries their status, and cancels them.
 * The caller is responsible for funding the swap address after creating an offer.
 *
 * @example
 * ```ts
 * const maker = new banco.Maker(wallet, serverUrl, introspectorUrl);
 * const { offer, swapAddress } = await maker.createOffer({ wantAmount: 10_000n });
 * await wallet.send({ address: swapAddress, amount: 50_000 });
 * ```
 */
export class Maker {
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
     * Create a new swap offer.
     * @returns The offer as hex, as an extension packet, and the swap address to fund.
     *
     * Embed `packet` in the funding transaction's extension output so the
     * taker can discover the offer by txid.
     */
    async createOffer(params: CreateOfferParams): Promise<{
        offer: string;
        packet: ExtensionPacket;
        swapAddress: string;
    }> {
        const info = await this.arkProvider.getInfo();
        const serverPubKey = hex.decode(info.signerPubkey).slice(1);

        const introInfo = await this.introspector.getInfo();
        const rawIntroPubkey = hex.decode(introInfo.signerPubkey);
        const introspectorPubkey =
            rawIntroPubkey.length === 33
                ? rawIntroPubkey.slice(1)
                : rawIntroPubkey;

        const address = await this.wallet.getAddress();
        const decoded = ArkAddress.decode(address);
        const makerPublicKey = decoded.vtxoTaprootKey;
        const makerPkScript = decoded.pkScript;

        const exitDelay = info.unilateralExitDelay;
        const exitTimelock: RelativeTimelock = {
            value: exitDelay,
            type: exitDelay < 512n ? "blocks" : "seconds",
        };

        const cancelTimestamp = params.cancelDelay
            ? BigInt(Math.floor(Date.now() / 1000) + params.cancelDelay)
            : undefined;

        let ratioNum: bigint | undefined;
        let ratioDen: bigint | undefined;
        const hasNum = params.ratioNum !== undefined;
        const hasDen = params.ratioDen !== undefined;
        if (hasNum !== hasDen) {
            throw new Error(
                "ratioNum and ratioDen must both be provided or both omitted"
            );
        }
        if (hasNum && hasDen) {
            if (params.ratioNum! <= 0n || params.ratioDen! <= 0n) {
                throw new Error("ratioNum and ratioDen must be positive");
            }
            const g = gcd(params.ratioNum!, params.ratioDen!);
            ratioNum = params.ratioNum! / g;
            ratioDen = params.ratioDen! / g;
        }

        const swap = new BancoSwap(
            {
                wantAmount: params.wantAmount,
                want: params.wantAsset ?? "btc",
                offer: params.offerAsset ?? "btc",
                ratioNum,
                ratioDen,
                cltvCancelTimelock: cancelTimestamp,
                exitTimelock,
                makerPkScript,
                makerPublicKey,
            },
            serverPubKey,
            [introspectorPubkey]
        );

        const hrp = this.getHrp(info.network);
        const swapAddress = swap
            .vtxoScript()
            .address(hrp, serverPubKey)
            .encode();

        const offerData: Offer.Data = {
            swapAddress,
            wantAmount: params.wantAmount,
            wantAsset: params.wantAsset,
            offerAsset: params.offerAsset,
            ratioNum,
            ratioDen,
            cancelDelay: cancelTimestamp,
            makerPkScript,
            makerPublicKey,
            introspectorPubkey,
        };

        return {
            offer: Offer.toHex(offerData),
            packet: Offer.toPacket(offerData),
            swapAddress,
        };
    }

    /**
     * Query VTXOs at a swap address.
     * @param swapAddress - The ark address of the swap contract.
     */
    async getOffers(swapAddress: string): Promise<OfferStatus[]> {
        const decoded = ArkAddress.decode(swapAddress);
        const { vtxos } = await this.indexer.getVtxos({
            scripts: [hex.encode(decoded.pkScript)],
            spendableOnly: false,
        });

        return vtxos.map((v) => ({
            txid: v.txid,
            vout: v.vout,
            value: v.value,
            assets: v.assets?.map((a) => ({
                assetId: a.assetId,
                amount: a.amount,
            })),
            spendable: v.virtualStatus.state !== "spent",
        }));
    }

    /**
     * Cancel an offer by spending the swap VTXO back to the maker via the CLTV cancel path.
     * @param offerHex - The hex-encoded TLV offer.
     * @returns The ark transaction id.
     * @throws If the offer has no cancel path or the CLTV timelock hasn't expired.
     */
    async cancelOffer(offerHex: string): Promise<string> {
        const offer = Offer.fromHex(offerHex);
        if (offer.cancelDelay === undefined) {
            throw new Error("Offer does not have a cancel path");
        }

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

        const vtxoScript = swap.vtxoScript();
        const cancelTapscript = CLTVMultisigTapscript.encode({
            pubkeys: [offer.makerPublicKey, serverPubKey],
            absoluteTimelock: offer.cancelDelay,
        });
        const cancelLeaf = vtxoScript.findLeaf(
            hex.encode(cancelTapscript.script)
        );

        const { vtxos } = await this.indexer.getVtxos({
            scripts: [hex.encode(vtxoScript.pkScript)],
            spendableOnly: true,
        });
        if (vtxos.length === 0) {
            throw new Error("No spendable VTXO found at swap address");
        }

        const swapVtxo = vtxos[0];
        const makerAddress = await this.wallet.getAddress();
        const makerPkScript = ArkAddress.decode(makerAddress).pkScript;

        const { arkTx, checkpoints } = buildOffchainTx(
            [
                {
                    ...swapVtxo,
                    tapLeafScript: cancelLeaf,
                    tapTree: vtxoScript.encode(),
                },
            ],
            [{ script: makerPkScript, amount: BigInt(swapVtxo.value) }],
            checkpointUnrollClosure
        );

        const signedArkTx = await this.wallet.identity.sign(arkTx);
        const { arkTxid, signedCheckpointTxs } =
            await this.arkProvider.submitTx(
                base64.encode(signedArkTx.toPSBT()),
                checkpoints.map((c) => base64.encode(c.toPSBT()))
            );

        const finalCheckpoints = await Promise.all(
            signedCheckpointTxs.map(async (serverCp) => {
                const tx = Transaction.fromPSBT(base64.decode(serverCp));
                const signed = await this.wallet.identity.sign(tx, [0]);
                return base64.encode(signed.toPSBT());
            })
        );

        await this.arkProvider.finalizeTx(arkTxid, finalCheckpoints);
        return arkTxid;
    }

    private getHrp(network: string): string {
        const hrpMap: Record<string, string> = {
            mainnet: "ark",
            testnet: "tark",
            regtest: "tark",
            signet: "tark",
            mutinynet: "tark",
        };
        return hrpMap[network] ?? "tark";
    }
}
