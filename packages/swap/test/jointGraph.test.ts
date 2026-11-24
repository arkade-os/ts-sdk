import { describe, expect, it } from "vitest";
import { base64 } from "@scure/base";
import { SigHash } from "@scure/btc-signer";
import { SingleKey, Transaction } from "@arkade-os/sdk";
import {
    OFFER_FILL_TEMPLATE,
    digestJointGraph,
    unsignedPsbtBytes,
    verifyJointGraph,
    verifyOfferFillPlan,
    type JointGraph,
} from "../src/index";
import originalPlan from "./fixtures/offer-fill-plan.json";

const fixture: JointGraph = originalPlan;
const digest = (plan: JointGraph) => digestJointGraph(plan, OFFER_FILL_TEMPLATE);

describe("joint graph commitment", () => {
    it("preserves the original Taxi template and serialized graph digest", () => {
        expect(OFFER_FILL_TEMPLATE).toBe("offer-fill/1");
        expect(digest(fixture)).toBe(fixture.graphId);
        expect(verifyJointGraph(fixture, OFFER_FILL_TEMPLATE)).toBe(true);
        expect(verifyOfferFillPlan(fixture)).toBe(true);
    });

    it("preserves its digest across ark and checkpoint signing without mutating either", async () => {
        const signer = SingleKey.fromPrivateKey(new Uint8Array(32).fill(0x7a));
        const ark = Transaction.fromPSBT(base64.decode(fixture.arkTx));
        const checkpoint = Transaction.fromPSBT(base64.decode(fixture.checkpoints[1]));
        const signedArk = await signer.sign(ark.clone(), [1]);
        const signedCheckpoint = await signer.sign(checkpoint.clone(), [0]);
        const arkBefore = signedArk.toPSBT();
        const checkpointBefore = signedCheckpoint.toPSBT();
        const signed: JointGraph = {
            ...fixture,
            arkTx: base64.encode(signedArk.toPSBT()),
            checkpoints: [
                fixture.checkpoints[0],
                base64.encode(signedCheckpoint.toPSBT()),
                fixture.checkpoints[2],
            ],
        };
        expect(signedArk.getInput(1).tapScriptSig).toHaveLength(1);
        expect(signedCheckpoint.getInput(0).tapScriptSig).toHaveLength(1);
        expect(unsignedPsbtBytes(signedArk)).toEqual(ark.toPSBT());
        expect(unsignedPsbtBytes(signedCheckpoint)).toEqual(checkpoint.toPSBT());
        expect(digest(signed)).toBe(fixture.graphId);
        expect(verifyOfferFillPlan(signed)).toBe(true);
        expect(signedArk.toPSBT()).toEqual(arkBefore);
        expect(signedCheckpoint.toPSBT()).toEqual(checkpointBefore);
    });

    it("binds template, ordered checkpoints, owners and declared sighash", () => {
        expect(digestJointGraph(fixture, "offer-fill/2")).not.toBe(fixture.graphId);
        expect(digest({ ...fixture, checkpoints: [...fixture.checkpoints].reverse() })).not.toBe(
            fixture.graphId,
        );
        expect(digest({ ...fixture, inputOwners: [null, "sponsor", "solver"] })).not.toBe(
            fixture.graphId,
        );
        const ark = Transaction.fromPSBT(base64.decode(fixture.arkTx));
        ark.updateInput(1, { sighashType: SigHash.ALL });
        expect(digest({ ...fixture, arkTx: base64.encode(ark.toPSBT()) })).not.toBe(
            fixture.graphId,
        );
    });

    it("preserves non-tapscript signature fields in the commitment", () => {
        const ark = Transaction.fromPSBT(base64.decode(fixture.arkTx));
        ark.updateInput(1, { tapKeySig: new Uint8Array(64).fill(1) });
        expect(unsignedPsbtBytes(ark)).toEqual(ark.toPSBT());
        expect(digest({ ...fixture, arkTx: base64.encode(ark.toPSBT()) })).not.toBe(
            fixture.graphId,
        );
    });
});
