import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { p2tr, Script } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { SingleKey } from "../src/identity/singleKey";
import { getNetwork } from "../src/networks";
import { VtxoScript } from "../src/script/base";
import { ConditionCSVMultisigTapscript, CSVMultisigTapscript } from "../src/script/tapscript";
import { timelockToSequence } from "../src/utils/timelock";
import { buildSignedSweep } from "../src/wallet/exit/sweep";

const network = getNetwork("regtest");
const identity = SingleKey.fromHex("aa".repeat(32));
const timelock = { type: "blocks", value: 144n } as const;
const expectedSequence = timelockToSequence(timelock);

const destKey = schnorr.getPublicKey(new Uint8Array(32).fill(4));
const destAddress = p2tr(destKey, undefined, network).address!;

async function ownerPubkey(): Promise<Uint8Array> {
    return (await identity.xOnlyPublicKey())!;
}

describe("buildSignedSweep", () => {
    it("signs and finalizes a plain CSV exit path", async () => {
        const owner = await ownerPubkey();
        const exit = CSVMultisigTapscript.encode({ pubkeys: [owner], timelock });
        const script = new VtxoScript([exit.script]);
        const leaf = script.findLeaf(hex.encode(exit.script));

        const { tx, fee } = await buildSignedSweep({
            vtxo: { txid: "22".repeat(32), vout: 0, value: 50_000, pkScript: script.pkScript },
            path: { leaf, sequence: expectedSequence },
            outputAddress: destAddress,
            feeRate: 2,
            network,
            identity,
        });

        expect(fee).toBeGreaterThan(0);
        expect(tx.getInput(0).sequence).toBe(expectedSequence);
        expect(tx.getInput(0).finalScriptWitness).toBeDefined();
        // plain path: witness = [sig, script, controlBlock]
        expect(tx.getInput(0).finalScriptWitness!.length).toBe(3);
        expect(tx.getOutput(0).amount).toBe(BigInt(50_000 - fee));
    });

    it("appends extraWitness between sig and script for condition paths", async () => {
        const owner = await ownerPubkey();
        const preimage = new Uint8Array(32).fill(5);
        const conditionScript = Script.encode(["HASH160", new Uint8Array(20).fill(9), "EQUAL"]);
        const exit = ConditionCSVMultisigTapscript.encode({
            conditionScript,
            pubkeys: [owner],
            timelock,
        });
        const script = new VtxoScript([exit.script]);
        const leaf = script.findLeaf(hex.encode(exit.script));

        const { tx } = await buildSignedSweep({
            vtxo: { txid: "33".repeat(32), vout: 0, value: 50_000, pkScript: script.pkScript },
            path: { leaf, sequence: expectedSequence, extraWitness: [preimage] },
            outputAddress: destAddress,
            feeRate: 2,
            network,
            identity,
        });

        const witness = tx.getInput(0).finalScriptWitness!;
        // [sig, preimage, script, controlBlock]
        expect(witness.length).toBe(4);
        expect(witness[0].length).toBe(64); // schnorr sig (SIGHASH_DEFAULT)
        expect(witness[1]).toEqual(preimage);
        expect(tx.getInput(0).sequence).toBe(expectedSequence);
    });

    it("charges a larger fee for condition paths (extra witness bytes)", async () => {
        const owner = await ownerPubkey();
        const preimage = new Uint8Array(32).fill(5);
        const plain = CSVMultisigTapscript.encode({ pubkeys: [owner], timelock });
        const conditioned = ConditionCSVMultisigTapscript.encode({
            conditionScript: Script.encode(["HASH160", new Uint8Array(20).fill(9), "EQUAL"]),
            pubkeys: [owner],
            timelock,
        });
        const plainScript = new VtxoScript([plain.script]);
        const condScript = new VtxoScript([conditioned.script]);

        const a = await buildSignedSweep({
            vtxo: {
                txid: "55".repeat(32),
                vout: 0,
                value: 50_000,
                pkScript: plainScript.pkScript,
            },
            path: {
                leaf: plainScript.findLeaf(hex.encode(plain.script)),
                sequence: expectedSequence,
            },
            outputAddress: destAddress,
            feeRate: 2,
            network,
            identity,
        });
        const b = await buildSignedSweep({
            vtxo: { txid: "66".repeat(32), vout: 0, value: 50_000, pkScript: condScript.pkScript },
            path: {
                leaf: condScript.findLeaf(hex.encode(conditioned.script)),
                sequence: expectedSequence,
                extraWitness: [preimage],
            },
            outputAddress: destAddress,
            feeRate: 2,
            network,
            identity,
        });
        expect(b.fee).toBeGreaterThan(a.fee);
    });

    it("throws when value minus fee is below dust", async () => {
        const owner = await ownerPubkey();
        const exit = CSVMultisigTapscript.encode({ pubkeys: [owner], timelock });
        const script = new VtxoScript([exit.script]);
        const leaf = script.findLeaf(hex.encode(exit.script));
        await expect(
            buildSignedSweep({
                vtxo: { txid: "44".repeat(32), vout: 0, value: 500, pkScript: script.pkScript },
                path: { leaf, sequence: expectedSequence },
                outputAddress: destAddress,
                feeRate: 2,
                network,
                identity,
            }),
        ).rejects.toThrow(/dust|uneconomic/i);
    });
});
