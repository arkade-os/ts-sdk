/** Build-only offer-fill plans: the unsigned joint spend as a serialized graph, never signed or submitted here. */
import { base64, hex } from "@scure/base";
import {
    ArkAddress,
    Extension,
    P2A,
    Transaction,
    deepFreeze,
    digestJointGraph,
    verifyJointGraph,
    type IWallet,
    type JointGraph,
} from "@arkade-os/sdk";
import {
    ASSET_CARRIER_SATS,
    assembleOfferFill,
    connectFillContract,
    decodeOffer,
    resolveDeposit,
    type AssembledFillLayout,
    type FillFunding,
    type FillInputOwner,
    type FillOutpoint,
    type SponsorFillInput,
} from "./offer";

export type { JointGraph };

export const OFFER_FILL_TEMPLATE = "offer-fill/1";

export const OFFER_FILL_OWNERS: readonly (FillInputOwner | null)[] = [null, "solver", "sponsor"];

/** Sponsor fare output: an asset amount on a sats host, paid from the joint inputs. */
export interface FillSponsorFare {
    assetId: string;
    amount: bigint | number;
    script: Uint8Array;
    /** Sats hosting the output. Defaults to the fill's asset carrier. */
    sats?: bigint | number;
}

/** Sponsor leg. Funding is sats-only and sponsor-owned; the solver never signs it. */
export interface FillSponsor {
    fund: FillFunding[];
    netContributionSats: bigint | number;
    fare?: FillSponsorFare;
    changeScript: Uint8Array;
}

export interface BuildOfferFillPlanOpts {
    fund: FillFunding[];
    payoutScript?: Uint8Array;
    fundingTxid?: string;
    fundingOutpoint?: FillOutpoint;
    swapAddress?: string;
    assetCarrierSats?: bigint;
    sponsor?: FillSponsor;
}

/**
 * Assemble the unsigned joint fill as a `JointGraph`. Same assembly as
 * `fillOffer`, so a sponsor-less plan builds the same spend — but makes no
 * signing or submission calls, only reads.
 */
export async function buildOfferFillPlan(
    wallet: IWallet,
    arkServerUrl: string,
    offerHex: string,
    opts: BuildOfferFillPlanOpts,
): Promise<JointGraph> {
    const {
        fund,
        payoutScript,
        fundingTxid,
        fundingOutpoint,
        swapAddress,
        assetCarrierSats = ASSET_CARRIER_SATS,
        sponsor,
    } = opts;
    const offer = decodeOffer(hex.decode(offerHex));
    const contract = await connectFillContract(wallet, arkServerUrl, offer, { swapAddress });
    const vtxos = await contract.getUtxos();
    const vtxo = resolveDeposit(vtxos, { fundingTxid, fundingOutpoint });
    const solverPayout = payoutScript ?? ArkAddress.decode(await wallet.getAddress()).pkScript;
    const sponsorLeg =
        sponsor !== undefined ? normalizeSponsor(sponsor, assetCarrierSats) : undefined;
    const fill = contract.functions.fulfill();
    const layout = assembleOfferFill(fill, {
        offer,
        vtxo,
        solverFund: fund,
        solverPayout,
        assetCarrierSats,
        sponsor: sponsorLeg,
    });
    const { arkTx, checkpoints } = await fill.build();
    for (const [i, input] of layout.inputs.entries()) {
        if (!OFFER_FILL_OWNERS.includes(input.owner)) {
            throw new Error(`fill plan input ${i} names unknown owner ${input.owner}`);
        }
    }
    return toJointGraph(arkTx, checkpoints, layout, offer.wantAsset?.toString());
}

function normalizeSponsor(sponsor: FillSponsor, assetCarrierSats: bigint): SponsorFillInput {
    return {
        fund: sponsor.fund,
        netContributionSats: sponsor.netContributionSats,
        fare:
            sponsor.fare !== undefined
                ? {
                      assetId: sponsor.fare.assetId,
                      amount: sponsor.fare.amount,
                      script: sponsor.fare.script,
                      sats: sponsor.fare.sats ?? assetCarrierSats,
                  }
                : undefined,
        changeScript: sponsor.changeScript,
    };
}

/** Parse the built transaction back into semantic outputs, checking the layout. */
function toJointGraph(
    arkTx: Transaction,
    checkpoints: Transaction[],
    layout: AssembledFillLayout,
    wantedAssetId: string | undefined,
): JointGraph {
    if (arkTx.inputsLength !== layout.inputs.length) {
        throw new Error(
            `fill plan built ${arkTx.inputsLength} inputs, expected ${layout.inputs.length}`,
        );
    }
    if (checkpoints.length !== layout.inputs.length) {
        throw new Error(
            `fill plan built ${checkpoints.length} checkpoints, expected ${layout.inputs.length}`,
        );
    }
    layout.inputs.forEach((input, i) => {
        const spent = checkpoints[i].getInput(0);
        if (
            !(spent.txid instanceof Uint8Array) ||
            hex.encode(spent.txid) !== input.txid ||
            spent.index !== input.vout
        ) {
            throw new Error(`fill plan checkpoint ${i} does not spend ${input.txid}:${input.vout}`);
        }
    });

    // Payments, extension, anchor — re-read from the transaction, not assumed.
    const payments = layout.outputs.length;
    if (arkTx.outputsLength !== payments + 2) {
        throw new Error(
            `fill plan built ${arkTx.outputsLength} outputs, expected ${payments} payments plus extension and anchor`,
        );
    }
    layout.outputs.forEach((expected, i) => {
        const out = arkTx.getOutput(i);
        if (!out?.script || hex.encode(out.script) !== hex.encode(expected.script)) {
            throw new Error(`fill plan output ${i} is not the ${expected.role} script`);
        }
        if (out.amount !== expected.sats) {
            throw new Error(
                `fill plan output ${i} carries ${out.amount}, expected ${expected.sats}`,
            );
        }
    });
    const ext = arkTx.getOutput(payments);
    if (!ext?.script || !Extension.isExtension(ext.script)) {
        throw new Error(`fill plan output ${payments} is not the extension packet`);
    }
    const anchor = arkTx.getOutput(payments + 1);
    if (
        !anchor?.script ||
        hex.encode(anchor.script) !== hex.encode(P2A.script) ||
        anchor.amount !== P2A.amount
    ) {
        throw new Error(`fill plan output ${payments + 1} is not the anchor`);
    }

    const packet = Extension.fromTx(arkTx).getAssetPacket();
    for (const group of packet?.groups ?? []) {
        if (group.assetId === null) throw new Error("fill plan carries an issuance group");
        const assetId = group.assetId.toString();
        const unitsIn = group.inputs.reduce((s, input) => s + input.amount, BigInt(0));
        const unitsOut = group.outputs.reduce((s, output) => s + output.amount, BigInt(0));
        if (unitsIn !== unitsOut) {
            throw new Error(`fill plan asset ${assetId} mints ${unitsOut - unitsIn} units`);
        }
        for (const output of group.outputs) {
            const hosted = arkTx.getOutput(output.vout);
            if (
                output.vout >= payments ||
                !hosted?.script ||
                Extension.isExtension(hosted.script)
            ) {
                throw new Error(
                    `fill plan asset ${assetId} pays nonexistent output ${output.vout}`,
                );
            }
        }
    }
    if (wantedAssetId !== undefined && (packet?.groups.length ?? 0) > 0) {
        const first = packet?.groups[0].assetId?.toString();
        if (first !== wantedAssetId) {
            throw new Error(
                `fill plan asset group 0 is ${first}, expected the wanted ${wantedAssetId}`,
            );
        }
    }

    const arkTxPsbt = base64.encode(arkTx.toPSBT());
    const checkpointPsbts = checkpoints.map((c) => base64.encode(c.toPSBT()));
    const inputOwners = layout.inputs.map((input) => input.owner);
    const graph: JointGraph = {
        arkTx: arkTxPsbt,
        checkpoints: checkpointPsbts,
        graphId: digestJointGraph(
            { arkTx: arkTxPsbt, checkpoints: checkpointPsbts, inputOwners },
            OFFER_FILL_TEMPLATE,
        ),
        inputOwners,
    };
    return deepFreeze(graph);
}

export function verifyOfferFillPlan(plan: JointGraph): boolean {
    return verifyJointGraph(plan, OFFER_FILL_TEMPLATE);
}
