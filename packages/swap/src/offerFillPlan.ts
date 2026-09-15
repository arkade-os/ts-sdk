/** Build-only offer-fill plans: the unsigned joint spend as a serialized graph, never signed or submitted here. */
import { base64, hex } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { ArkAddress, Extension, P2A, Transaction, type IWallet } from "@arkade-os/sdk";
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
    type FillOutputRole,
    type TaxiFillInput,
} from "./offer";

/** Template version bound into every graph id. */
export const TAXI_FILL_TEMPLATE = "taxi-fill/1";

/** Assets an output carries, parsed from the built transaction's packet. */
export interface FillPlanAsset {
    readonly assetId: string;
    readonly units: string;
}

/** One payment output of the joint transaction, with its semantic role. */
export interface FillPlanOutput {
    readonly role: FillOutputRole;
    readonly vout: number;
    readonly script: string;
    readonly sats: string;
    readonly assets: readonly FillPlanAsset[];
}

/**
 * Serialized unsigned joint fill: transaction, checkpoints, semantics, binding
 * id. Readonly throughout to match the deep freeze applied at construction —
 * a plan is a snapshot, never a working object.
 */
export interface JointGraph {
    readonly arkTx: string;
    readonly checkpoints: readonly string[];
    readonly graphId: string;
    readonly inputOwners: readonly FillInputOwner[];
    readonly inputOutpoints: readonly FillOutpoint[];
    readonly outputs: readonly FillPlanOutput[];
}

/** Taxi fare output: an asset amount on a sats host, paid from the joint inputs. */
export interface FillSponsorFare {
    assetId: string;
    amount: bigint | number;
    script: Uint8Array;
    /** Sats hosting the output. Defaults to the fill's asset carrier. */
    sats?: bigint | number;
}

/** Taxi sponsor leg. Funding is sats-only and taxi-owned; the solver never signs it. */
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
    const taxi = sponsor !== undefined ? normalizeSponsor(sponsor, assetCarrierSats) : undefined;
    const fill = contract.functions.fulfill();
    const layout = assembleOfferFill(fill, {
        offer,
        vtxo,
        solverFund: fund,
        solverPayout,
        assetCarrierSats,
        taxi,
    });
    const { arkTx, checkpoints } = await fill.build();
    return toJointGraph(arkTx, checkpoints, layout, offer.wantAsset?.toString());
}

function normalizeSponsor(sponsor: FillSponsor, assetCarrierSats: bigint): TaxiFillInput {
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

    const perVout: FillPlanAsset[][] = layout.outputs.map(() => []);
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
            perVout[output.vout].push({ assetId, units: output.amount.toString() });
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
    const outputs: FillPlanOutput[] = layout.outputs.map((expected, vout) => ({
        role: expected.role,
        vout,
        script: hex.encode(expected.script),
        sats: expected.sats.toString(),
        assets: perVout[vout],
    }));
    const graph: JointGraph = {
        arkTx: arkTxPsbt,
        checkpoints: checkpointPsbts,
        graphId: digestPlan({
            arkTx: arkTxPsbt,
            checkpoints: checkpointPsbts,
            inputOwners: layout.inputs.map((input) => input.owner),
            inputOutpoints: layout.inputs.map((input) => ({
                txid: input.txid,
                vout: input.vout,
            })),
            outputs,
        }),
        inputOwners: layout.inputs.map((input) => input.owner),
        inputOutpoints: layout.inputs.map((input) => ({ txid: input.txid, vout: input.vout })),
        outputs,
    };
    return deepFreeze(graph);
}

/** The binding id: template version, exact unsigned PSBTs, owners and semantics. */
function digestPlan(plan: Omit<JointGraph, "graphId">): string {
    return hex.encode(
        sha256(
            new TextEncoder().encode(
                JSON.stringify({
                    template: TAXI_FILL_TEMPLATE,
                    arkTx: plan.arkTx,
                    checkpoints: plan.checkpoints,
                    inputOwners: plan.inputOwners,
                    inputOutpoints: plan.inputOutpoints,
                    outputs: plan.outputs,
                }),
            ),
        ),
    );
}

/**
 * Self-hash integrity ONLY, not authorization: `true` means the plan is
 * unaltered since its id was computed. Never sign on this alone — compare
 * against a trusted graph first.
 */
export function verifyOfferFillPlan(plan: JointGraph): boolean {
    try {
        if (!plan || typeof plan !== "object") return false;
        if (
            !hasExactKeys(plan, [
                "arkTx",
                "checkpoints",
                "graphId",
                "inputOwners",
                "inputOutpoints",
                "outputs",
            ])
        )
            return false;
        if (typeof plan.arkTx !== "string" || plan.arkTx.length === 0) return false;
        if (
            !Array.isArray(plan.checkpoints) ||
            plan.checkpoints.length < 1 ||
            plan.checkpoints.some((c) => typeof c !== "string" || c.length === 0)
        )
            return false;
        if (!/^[0-9a-f]{64}$/.test(plan.graphId)) return false;
        const owners: readonly FillInputOwner[] = ["offer-covenant", "solver", "taxi"];
        if (!Array.isArray(plan.inputOwners) || plan.inputOwners.some((o) => !owners.includes(o)))
            return false;
        if (!Array.isArray(plan.inputOutpoints) || plan.inputOutpoints.length < 1) return false;
        if (
            plan.inputOwners.length !== plan.inputOutpoints.length ||
            plan.checkpoints.length !== plan.inputOutpoints.length
        )
            return false;
        if (
            plan.inputOutpoints.some(
                (o) =>
                    !hasExactKeys(o, ["txid", "vout"]) ||
                    typeof o.txid !== "string" ||
                    !/^[0-9a-f]{64}$/.test(o.txid) ||
                    !isVout(o.vout),
            )
        )
            return false;
        const roles: readonly FillOutputRole[] = ["receiver", "solver", "taxi-fare", "taxi-change"];
        if (!Array.isArray(plan.outputs) || plan.outputs.length < 1) return false;
        if (
            plan.outputs.some(
                (o, i) =>
                    !hasExactKeys(o, ["role", "vout", "script", "sats", "assets"]) ||
                    !roles.includes(o.role) ||
                    o.vout !== i ||
                    typeof o.script !== "string" ||
                    !isScriptHex(o.script) ||
                    !isBoundedDecimal(o.sats, MAX_SAFE_SATS) ||
                    !Array.isArray(o.assets) ||
                    o.assets.some(
                        (a: FillPlanAsset) =>
                            !hasExactKeys(a, ["assetId", "units"]) ||
                            !/^[0-9a-f]{68}$/.test(a.assetId) ||
                            !isBoundedDecimal(a.units, U64_MAX),
                    ),
            )
        )
            return false;
        return digestPlan(plan) === plan.graphId;
    } catch {
        return false;
    }
}

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const MAX_SAFE_SATS = BigInt(Number.MAX_SAFE_INTEGER);

/** A non-empty even-length hex script. */
function isScriptHex(script: string): boolean {
    return script.length > 0 && script.length % 2 === 0 && /^[0-9a-f]+$/.test(script);
}

/** A u32 output index. */
function isVout(vout: unknown): vout is number {
    return typeof vout === "number" && Number.isInteger(vout) && vout >= 0 && vout <= 0xffffffff;
}

/** A decimal integer string within `max`. */
function isBoundedDecimal(value: unknown, max: bigint): value is string {
    if (typeof value !== "string" || !/^\d+$/.test(value)) return false;
    return BigInt(value) <= max;
}

function hasExactKeys(value: object, keys: string[]): boolean {
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every((k) => actual.includes(k));
}

export function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
