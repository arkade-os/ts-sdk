import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import { SigHash } from "@scure/btc-signer";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { SingleKey } from "../../src/identity/singleKey";
import {
    MultisigTapscript,
    CSVMultisigTapscript,
} from "../../src/script/tapscript";
import { VtxoScript } from "../../src/script/base";
import { TxTree } from "../../src/tree/txTree";
import { aggregateKeys } from "../../src/musig2";
import {
    setArkPsbtField,
    CosignerPublicKey,
} from "../../src/utils/unknownFields";
import { Transaction as ArkTransaction } from "../../src/utils/transaction";
import {
    verifyTreeSignatures,
    verifyCosignerKeys,
    verifyInternalKeysUnspendable,
} from "../../src/verification/signatureVerifier";

function taprootOutputScript(xOnlyKey: Uint8Array): Uint8Array {
    const script = new Uint8Array(34);
    script[0] = 0x51;
    script[1] = 0x20;
    script.set(xOnlyKey, 2);
    return script;
}

describe("verifyTreeSignatures", () => {
    it("should pass when all signatures are valid", async () => {
        const { tree } = await buildSignedTree();
        const results = verifyTreeSignatures(tree);

        for (const result of results) {
            expect(result.valid).toBe(true);
        }
    });

    it("should fail when a signature is missing", async () => {
        const { tree } = await buildSignedTree({ skipOneSig: true });
        const results = verifyTreeSignatures(tree);

        const invalid = results.filter((r) => !r.valid);
        expect(invalid.length).toBeGreaterThan(0);
        expect(invalid[0].error).toMatch(/[Mm]issing/);
    });

    it("should fail when a signature is corrupted", async () => {
        const { tree } = await buildSignedTree({ corruptSig: true });
        const results = verifyTreeSignatures(tree);

        const invalid = results.filter((r) => !r.valid);
        expect(invalid.length).toBeGreaterThan(0);
        expect(invalid[0].error).toMatch(/[Ii]nvalid signature/);
    });

    it("should skip inputs without tapLeafScript", async () => {
        const { tree } = await buildSignedTree();
        const results = verifyTreeSignatures(tree);

        const rootInputResults = results.filter(
            (r) => r.txid === tree.root.id && r.inputIndex === 0
        );
        expect(rootInputResults).toHaveLength(0);
    });

    it("should support excluding pubkeys from verification", async () => {
        const { tree, serverPubkeyHex } = await buildSignedTree({
            skipServerSig: true,
        });

        const failResults = verifyTreeSignatures(tree);
        const invalid = failResults.filter((r) => !r.valid);
        expect(invalid.length).toBeGreaterThan(0);

        const passResults = verifyTreeSignatures(tree, [serverPubkeyHex]);
        for (const result of passResults) {
            expect(result.valid).toBe(true);
        }
    });

    it("should return signer keys in the result", async () => {
        const { tree } = await buildSignedTree();
        const results = verifyTreeSignatures(tree);

        const withSigners = results.filter((r) => r.signerKeys.length > 0);
        expect(withSigners.length).toBeGreaterThan(0);
        expect(withSigners[0].signerKeys).toHaveLength(2); // user + server
    });

    it("should report correct txid and inputIndex", async () => {
        const { tree } = await buildSignedTree();
        const results = verifyTreeSignatures(tree);

        for (const result of results) {
            expect(result.txid).toBeTruthy();
            expect(typeof result.inputIndex).toBe("number");
        }
    });
});

describe("verifyCosignerKeys", () => {
    it("should pass when aggregated cosigner keys match parent output", async () => {
        const { tree, sweepTapTreeRoot } = await buildTreeWithCosigners();
        const results = verifyCosignerKeys(tree, sweepTapTreeRoot);

        for (const result of results) {
            expect(result.valid).toBe(true);
        }
    });

    it("should fail when cosigner keys do not aggregate to parent output", async () => {
        const { tree, sweepTapTreeRoot } = await buildTreeWithCosigners({
            wrongCosignerKey: true,
        });
        const results = verifyCosignerKeys(tree, sweepTapTreeRoot);

        const invalid = results.filter((r) => !r.valid);
        expect(invalid.length).toBeGreaterThan(0);
        expect(invalid[0].error).toMatch(/does not match|aggregat/i);
    });

    it("should fail when cosigner public keys are missing", async () => {
        const { tree, sweepTapTreeRoot } = await buildTreeWithCosigners({
            noCosignerKeys: true,
        });
        const results = verifyCosignerKeys(tree, sweepTapTreeRoot);

        const invalid = results.filter((r) => !r.valid);
        expect(invalid.length).toBeGreaterThan(0);
        expect(invalid[0].error).toMatch(/[Mm]issing cosigner/);
    });

    it("should fail when parent output is not a taproot output", async () => {
        const { tree, sweepTapTreeRoot } = await buildTreeWithCosigners({
            nonTaprootParentOutput: true,
        });
        const results = verifyCosignerKeys(tree, sweepTapTreeRoot);

        const invalid = results.filter((r) => !r.valid);
        expect(invalid.length).toBeGreaterThan(0);
        expect(invalid[0].error).toMatch(/not.*taproot/i);
    });
});

describe("verifyInternalKeysUnspendable", () => {
    it("should pass when taproot inputs use NUMS internal key", async () => {
        const { tree } = await buildSignedTree();
        const results = verifyInternalKeysUnspendable(tree);

        for (const result of results) {
            expect(result.valid).toBe(true);
        }
    });

    it("should fail when a taproot input uses a spendable internal key", async () => {
        const { tree } = await buildSignedTree();

        // Directly manipulate internal PSBT data to inject a non-NUMS key
        const child = tree.children.get(0)!;
        const txAny = child.root as any;
        if (txAny.inputs?.[0]?.tapLeafScript?.[0]) {
            const leaf = txAny.inputs[0].tapLeafScript[0];
            const fakeInternalKey = new Uint8Array(32).fill(0x42);
            txAny.inputs[0].tapLeafScript[0] = [
                { ...leaf[0], internalKey: fakeInternalKey },
                leaf[1],
            ];
        }

        const results = verifyInternalKeysUnspendable(tree);
        const invalid = results.filter((r) => !r.valid);
        expect(invalid.length).toBeGreaterThan(0);
        expect(invalid[0].error).toMatch(/not.*unspendable|NUMS/i);
    });

    it("should skip inputs without tapLeafScript", async () => {
        const { tree } = await buildSignedTree();
        const results = verifyInternalKeysUnspendable(tree);

        // Root input has no tapLeafScript — should not appear in results
        const rootResults = results.filter((r) => r.txid === tree.root.id);
        expect(rootResults).toHaveLength(0);
    });

    it("should check all inputs across the tree", async () => {
        const { tree } = await buildSignedTree();
        const results = verifyInternalKeysUnspendable(tree);

        // Should have at least 1 result (the child input with tapLeafScript)
        expect(results.length).toBeGreaterThan(0);
        // All should be valid (NUMS key)
        expect(results.every((r) => r.valid)).toBe(true);
    });
});

// ============================================================
// Test helpers
// ============================================================

interface BuildTreeOptions {
    skipOneSig?: boolean;
    corruptSig?: boolean;
    skipServerSig?: boolean;
}

async function buildSignedTree(opts: BuildTreeOptions = {}) {
    const userKey = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const serverKey = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const userPub = await userKey.xOnlyPublicKey();
    const serverPub = await serverKey.xOnlyPublicKey();

    const multisig = MultisigTapscript.encode({
        pubkeys: [userPub, serverPub],
        type: MultisigTapscript.MultisigType.CHECKSIG,
    });
    const vtxoScript = new VtxoScript([multisig.script]);

    const destKey = await SingleKey.fromPrivateKey(
        randomPrivateKeyBytes()
    ).xOnlyPublicKey();
    const destScript = taprootOutputScript(destKey);

    const commitmentTxid = new Uint8Array(32).fill(0x01);
    const rootTx = new ArkTransaction();
    rootTx.addInput({
        txid: commitmentTxid,
        index: 0,
        witnessUtxo: { script: destScript, amount: 10_000n },
    });
    rootTx.addOutput({ script: vtxoScript.pkScript, amount: 10_000n });

    const childTx = new ArkTransaction();
    childTx.addInput({
        txid: hex.decode(rootTx.id),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
    });
    childTx.addOutput({ script: destScript, amount: 10_000n });

    const signers: SingleKey[] = [];
    if (!opts.skipOneSig && !opts.skipServerSig) {
        signers.push(userKey, serverKey);
    } else if (opts.skipOneSig) {
        signers.push(userKey);
    } else if (opts.skipServerSig) {
        signers.push(userKey);
    }

    for (const signer of signers) {
        childTx.signIdx(signer["key"], 0, [SigHash.DEFAULT]);
    }

    if (opts.corruptSig) {
        const txAny = childTx as any;
        if (txAny.inputs?.[0]?.tapScriptSig?.[0]) {
            const [sigData] = txAny.inputs[0].tapScriptSig[0];
            const corrupted = new Uint8Array(64);
            crypto.getRandomValues(corrupted);
            txAny.inputs[0].tapScriptSig[0] = [sigData, corrupted];
        }
    }

    const tree = new TxTree(rootTx, new Map([[0, new TxTree(childTx)]]));

    return {
        tree,
        userPubkeyHex: hex.encode(userPub),
        serverPubkeyHex: hex.encode(serverPub),
    };
}

interface BuildCosignerTreeOptions {
    wrongCosignerKey?: boolean;
    noCosignerKeys?: boolean;
    nonTaprootParentOutput?: boolean;
}

async function buildTreeWithCosigners(opts: BuildCosignerTreeOptions = {}) {
    const cosignerKey1 = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const cosignerKey2 = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const cosigner1Compressed = await cosignerKey1.compressedPublicKey();
    const cosigner2Compressed = await cosignerKey2.compressedPublicKey();

    const sweepScript = CSVMultisigTapscript.encode({
        timelock: { value: 144n, type: "blocks" },
        pubkeys: [await cosignerKey1.xOnlyPublicKey()],
    }).script;
    const sweepTapTreeRoot = tapLeafHash(sweepScript);

    const cosignerKeysForPsbt = opts.wrongCosignerKey
        ? [
              cosigner1Compressed,
              await SingleKey.fromPrivateKey(
                  randomPrivateKeyBytes()
              ).compressedPublicKey(),
          ]
        : [cosigner1Compressed, cosigner2Compressed];

    const { finalKey } = aggregateKeys(
        [cosigner1Compressed, cosigner2Compressed],
        true,
        { taprootTweak: sweepTapTreeRoot }
    );

    let parentOutputScript: Uint8Array;
    if (opts.nonTaprootParentOutput) {
        parentOutputScript = new Uint8Array([
            0xa9,
            0x14,
            ...new Uint8Array(20),
            0x87,
        ]);
    } else {
        parentOutputScript = new Uint8Array(34);
        parentOutputScript[0] = 0x51;
        parentOutputScript[1] = 0x20;
        parentOutputScript.set(finalKey.slice(1), 2);
    }

    const destKey = await SingleKey.fromPrivateKey(
        randomPrivateKeyBytes()
    ).xOnlyPublicKey();
    const destScript = taprootOutputScript(destKey);

    const rootTx = new ArkTransaction();
    rootTx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: destScript, amount: 10_000n },
    });
    rootTx.addOutput({ script: parentOutputScript, amount: 10_000n });

    const childTx = new ArkTransaction();
    childTx.addInput({
        txid: hex.decode(rootTx.id),
        index: 0,
        witnessUtxo: { script: parentOutputScript, amount: 10_000n },
    });
    childTx.addOutput({ script: destScript, amount: 10_000n });

    if (!opts.noCosignerKeys) {
        for (let i = 0; i < cosignerKeysForPsbt.length; i++) {
            setArkPsbtField(childTx, 0, CosignerPublicKey, {
                index: i,
                key: cosignerKeysForPsbt[i],
            });
        }
    }

    const tree = new TxTree(rootTx, new Map([[0, new TxTree(childTx)]]));
    return { tree, sweepTapTreeRoot };
}
