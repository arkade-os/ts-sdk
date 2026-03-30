import { describe, it, expect } from "vitest";
import * as bip68 from "bip68";
import { hex } from "@scure/base";
import { SigHash, DEFAULT_SEQUENCE } from "@scure/btc-signer";
import {
    hash160,
    sha256,
    randomPrivateKeyBytes,
} from "@scure/btc-signer/utils.js";
import { Transaction } from "../../src/utils/transaction";
import { VtxoScript } from "../../src/script/base";
import {
    CSVMultisigTapscript,
    CLTVMultisigTapscript,
    ConditionMultisigTapscript,
    ConditionCSVMultisigTapscript,
    MultisigTapscript,
    TapscriptType,
} from "../../src/script/tapscript";
import { SingleKey } from "../../src/identity/singleKey";
import { verifyScriptSatisfaction } from "../../src/verification/scriptVerifier";
import { Script } from "@scure/btc-signer";

const chainTip = { height: 1000, time: 1700000000 };

describe("verifyScriptSatisfaction", () => {
    describe("CSV timelock", () => {
        it("should pass when sequence meets CSV block timelock", async () => {
            const identity = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
            const pk = await identity.xOnlyPublicKey();

            const csvScript = CSVMultisigTapscript.encode({
                timelock: { type: "blocks", value: 144n },
                pubkeys: [pk],
            });
            const vtxoScript = new VtxoScript([csvScript.script]);
            const leafProof = vtxoScript.leaves[0];

            const sequence = bip68.encode({ blocks: 144 });
            const tx = new Transaction({ version: 3 });
            tx.addInput({
                txid: new Uint8Array(32).fill(1),
                index: 0,
                sequence,
                witnessUtxo: {
                    script: vtxoScript.pkScript,
                    amount: 5000n,
                },
                tapLeafScript: [leafProof],
            });
            tx.addOutput({ amount: 4670n, script: vtxoScript.pkScript });
            tx.signIdx(identity["key"], 0, [SigHash.DEFAULT]);

            const result = verifyScriptSatisfaction(tx, 0, chainTip, {
                height: 800,
                time: 1699999000,
            });
            expect(result.scriptType).toBe(TapscriptType.CSVMultisig);
            expect(result.timelockSatisfied).toBe(true);
            expect(result.signaturesSatisfied).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it("should fail when sequence is below CSV requirement", async () => {
            const identity = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
            const pk = await identity.xOnlyPublicKey();

            const csvScript = CSVMultisigTapscript.encode({
                timelock: { type: "blocks", value: 144n },
                pubkeys: [pk],
            });
            const vtxoScript = new VtxoScript([csvScript.script]);
            const leafProof = vtxoScript.leaves[0];

            // Sequence only encodes 10 blocks (too low)
            const sequence = bip68.encode({ blocks: 10 });
            const tx = new Transaction({ version: 3 });
            tx.addInput({
                txid: new Uint8Array(32).fill(1),
                index: 0,
                sequence,
                witnessUtxo: {
                    script: vtxoScript.pkScript,
                    amount: 5000n,
                },
                tapLeafScript: [leafProof],
            });
            tx.addOutput({ amount: 4670n, script: vtxoScript.pkScript });
            tx.signIdx(identity["key"], 0, [SigHash.DEFAULT]);

            const result = verifyScriptSatisfaction(tx, 0, chainTip, {
                height: 800,
                time: 1699999000,
            });
            expect(result.timelockSatisfied).toBe(false);
            expect(result.errors.some((e) => e.includes("CSV"))).toBe(true);
        });

        it("should fail when not enough blocks elapsed since parent", async () => {
            const identity = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
            const pk = await identity.xOnlyPublicKey();

            const csvScript = CSVMultisigTapscript.encode({
                timelock: { type: "blocks", value: 144n },
                pubkeys: [pk],
            });
            const vtxoScript = new VtxoScript([csvScript.script]);
            const leafProof = vtxoScript.leaves[0];

            const sequence = bip68.encode({ blocks: 144 });
            const tx = new Transaction({ version: 3 });
            tx.addInput({
                txid: new Uint8Array(32).fill(1),
                index: 0,
                sequence,
                witnessUtxo: {
                    script: vtxoScript.pkScript,
                    amount: 5000n,
                },
                tapLeafScript: [leafProof],
            });
            tx.addOutput({ amount: 4670n, script: vtxoScript.pkScript });
            tx.signIdx(identity["key"], 0, [SigHash.DEFAULT]);

            // Parent confirmed at height 990, only 10 blocks elapsed
            const result = verifyScriptSatisfaction(tx, 0, chainTip, {
                height: 990,
                time: 1699999900,
            });
            expect(result.timelockSatisfied).toBe(false);
            expect(
                result.errors.some((e) => e.includes("blocks elapsed"))
            ).toBe(true);
        });
    });

    describe("CLTV timelock", () => {
        it("should pass when locktime meets CLTV height requirement", async () => {
            const identity = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
            const pk = await identity.xOnlyPublicKey();

            const cltvScript = CLTVMultisigTapscript.encode({
                absoluteTimelock: 500n,
                pubkeys: [pk],
            });
            const vtxoScript = new VtxoScript([cltvScript.script]);
            const leafProof = vtxoScript.leaves[0];

            const tx = new Transaction({ version: 3, lockTime: 500 });
            tx.addInput({
                txid: new Uint8Array(32).fill(1),
                index: 0,
                sequence: DEFAULT_SEQUENCE - 1,
                witnessUtxo: {
                    script: vtxoScript.pkScript,
                    amount: 5000n,
                },
                tapLeafScript: [leafProof],
            });
            tx.addOutput({ amount: 4670n, script: vtxoScript.pkScript });
            tx.signIdx(identity["key"], 0, [SigHash.DEFAULT]);

            const result = verifyScriptSatisfaction(tx, 0, chainTip);
            expect(result.scriptType).toBe(TapscriptType.CLTVMultisig);
            expect(result.timelockSatisfied).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it("should fail when locktime is below CLTV requirement", async () => {
            const identity = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
            const pk = await identity.xOnlyPublicKey();

            const cltvScript = CLTVMultisigTapscript.encode({
                absoluteTimelock: 2000n, // requires height 2000
                pubkeys: [pk],
            });
            const vtxoScript = new VtxoScript([cltvScript.script]);
            const leafProof = vtxoScript.leaves[0];

            const tx = new Transaction({ version: 3, lockTime: 500 });
            tx.addInput({
                txid: new Uint8Array(32).fill(1),
                index: 0,
                sequence: DEFAULT_SEQUENCE - 1,
                witnessUtxo: {
                    script: vtxoScript.pkScript,
                    amount: 5000n,
                },
                tapLeafScript: [leafProof],
            });
            tx.addOutput({ amount: 4670n, script: vtxoScript.pkScript });
            tx.signIdx(identity["key"], 0, [SigHash.DEFAULT]);

            const result = verifyScriptSatisfaction(tx, 0, chainTip);
            expect(result.timelockSatisfied).toBe(false);
            expect(result.errors.some((e) => e.includes("CLTV"))).toBe(true);
        });

        it("should fail when chain tip height is below CLTV requirement", async () => {
            const identity = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
            const pk = await identity.xOnlyPublicKey();

            const cltvScript = CLTVMultisigTapscript.encode({
                absoluteTimelock: 5000n, // chain tip is only 1000
                pubkeys: [pk],
            });
            const vtxoScript = new VtxoScript([cltvScript.script]);
            const leafProof = vtxoScript.leaves[0];

            const tx = new Transaction({ version: 3, lockTime: 5000 });
            tx.addInput({
                txid: new Uint8Array(32).fill(1),
                index: 0,
                sequence: DEFAULT_SEQUENCE - 1,
                witnessUtxo: {
                    script: vtxoScript.pkScript,
                    amount: 5000n,
                },
                tapLeafScript: [leafProof],
            });
            tx.addOutput({ amount: 4670n, script: vtxoScript.pkScript });
            tx.signIdx(identity["key"], 0, [SigHash.DEFAULT]);

            const result = verifyScriptSatisfaction(tx, 0, chainTip);
            expect(result.timelockSatisfied).toBe(false);
            expect(
                result.errors.some((e) => e.includes("chain tip height"))
            ).toBe(true);
        });
    });

    describe("Hash preimage (HASH160)", () => {
        it("should pass with correct preimage in witness", async () => {
            const identity = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
            const pk = await identity.xOnlyPublicKey();

            const preimage = new Uint8Array(32).fill(0x42);
            const preimageHash = hash160(preimage);

            const conditionScript = Script.encode([
                "HASH160",
                preimageHash,
                "EQUAL",
            ]);

            const conditionMultisig = ConditionMultisigTapscript.encode({
                conditionScript,
                pubkeys: [pk],
            });
            const vtxoScript = new VtxoScript([conditionMultisig.script]);
            const leafProof = vtxoScript.leaves[0];

            const tx = new Transaction({ version: 3 });
            tx.addInput({
                txid: new Uint8Array(32).fill(1),
                index: 0,
                witnessUtxo: {
                    script: vtxoScript.pkScript,
                    amount: 5000n,
                },
                tapLeafScript: [leafProof],
            });
            tx.addOutput({ amount: 4670n, script: vtxoScript.pkScript });
            // Add witness after outputs to avoid "signed outputs" error
            tx.updateInput(0, { finalScriptWitness: [preimage] });

            const result = verifyScriptSatisfaction(tx, 0, chainTip);
            expect(result.scriptType).toBe(TapscriptType.ConditionMultisig);
            expect(result.hashPreimageSatisfied).toBe(true);
        });

        it("should fail with wrong preimage", async () => {
            const identity = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
            const pk = await identity.xOnlyPublicKey();

            const correctPreimage = new Uint8Array(32).fill(0x42);
            const wrongPreimage = new Uint8Array(32).fill(0x99);
            const preimageHash = hash160(correctPreimage);

            const conditionScript = Script.encode([
                "HASH160",
                preimageHash,
                "EQUAL",
            ]);

            const conditionMultisig = ConditionMultisigTapscript.encode({
                conditionScript,
                pubkeys: [pk],
            });
            const vtxoScript = new VtxoScript([conditionMultisig.script]);
            const leafProof = vtxoScript.leaves[0];

            const tx = new Transaction({ version: 3 });
            tx.addInput({
                txid: new Uint8Array(32).fill(1),
                index: 0,
                witnessUtxo: {
                    script: vtxoScript.pkScript,
                    amount: 5000n,
                },
                tapLeafScript: [leafProof],
            });
            tx.addOutput({ amount: 4670n, script: vtxoScript.pkScript });
            tx.updateInput(0, { finalScriptWitness: [wrongPreimage] });

            const result = verifyScriptSatisfaction(tx, 0, chainTip);
            expect(result.hashPreimageSatisfied).toBe(false);
            expect(result.errors.some((e) => e.includes("HASH160"))).toBe(true);
        });

        it("should fail with no witness data", async () => {
            const identity = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
            const pk = await identity.xOnlyPublicKey();

            const preimage = new Uint8Array(32).fill(0x42);
            const preimageHash = hash160(preimage);

            const conditionScript = Script.encode([
                "HASH160",
                preimageHash,
                "EQUAL",
            ]);

            const conditionMultisig = ConditionMultisigTapscript.encode({
                conditionScript,
                pubkeys: [pk],
            });
            const vtxoScript = new VtxoScript([conditionMultisig.script]);
            const leafProof = vtxoScript.leaves[0];

            const tx = new Transaction({ version: 3 });
            tx.addInput({
                txid: new Uint8Array(32).fill(1),
                index: 0,
                witnessUtxo: {
                    script: vtxoScript.pkScript,
                    amount: 5000n,
                },
                tapLeafScript: [leafProof],
                // No witness data
            });
            tx.addOutput({ amount: 4670n, script: vtxoScript.pkScript });

            const result = verifyScriptSatisfaction(tx, 0, chainTip);
            expect(result.hashPreimageSatisfied).toBe(false);
            expect(result.errors.some((e) => e.includes("no witness"))).toBe(
                true
            );
        });
    });

    describe("Edge cases", () => {
        it("should handle input without tapLeafScript", async () => {
            const tx = new Transaction({ version: 3 });
            tx.addInput({
                txid: new Uint8Array(32).fill(1),
                index: 0,
            });
            tx.addOutput({
                amount: 4670n,
                script: new Uint8Array(34).fill(0x51),
            });

            const result = verifyScriptSatisfaction(tx, 0, chainTip);
            expect(result.errors).toContain("No tapLeafScript on input");
        });

        it("should pass simple multisig (no timelocks, no conditions)", async () => {
            const identity = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
            const pk = await identity.xOnlyPublicKey();

            const multisig = MultisigTapscript.encode({
                pubkeys: [pk],
            });
            const vtxoScript = new VtxoScript([multisig.script]);
            const leafProof = vtxoScript.leaves[0];

            const tx = new Transaction({ version: 3 });
            tx.addInput({
                txid: new Uint8Array(32).fill(1),
                index: 0,
                witnessUtxo: {
                    script: vtxoScript.pkScript,
                    amount: 5000n,
                },
                tapLeafScript: [leafProof],
            });
            tx.addOutput({ amount: 4670n, script: vtxoScript.pkScript });
            tx.signIdx(identity["key"], 0, [SigHash.DEFAULT]);

            const result = verifyScriptSatisfaction(tx, 0, chainTip);
            expect(result.scriptType).toBe(TapscriptType.Multisig);
            expect(result.timelockSatisfied).toBe(true);
            expect(result.signaturesSatisfied).toBe(true);
            expect(result.hashPreimageSatisfied).toBe(true);
            expect(result.errors).toHaveLength(0);
        });
    });
});
