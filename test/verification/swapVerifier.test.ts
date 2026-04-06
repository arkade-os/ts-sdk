import { describe, expect, it } from "vitest";
import { hash160, sha256 } from "@scure/btc-signer/utils.js";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { SingleKey } from "../../src/identity/singleKey";
import {
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    MultisigTapscript,
} from "../../src/script/tapscript";
import { VtxoScript } from "../../src/script/base";
import { Transaction as ArkTransaction } from "../../src/utils/transaction";
import { Script } from "@scure/btc-signer";
import {
    ConditionWitness,
    setArkPsbtField,
} from "../../src/utils/unknownFields";
import {
    verifyBoltzSwapPreimage,
    verifyBoltzSwapSatisfaction,
} from "../../src/verification/swapVerifier";

describe("verifyBoltzSwapPreimage", () => {
    it("passes for a SHA256 hash-lock swap witness", async () => {
        const { tx } = await buildBoltzSwapTx();
        const result = verifyBoltzSwapPreimage(tx, 0);

        expect(result.valid).toBe(true);
        expect(result.leafType).toBe("condition-multisig");
    });

    it("fails when the swap preimage is wrong", async () => {
        const { tx } = await buildBoltzSwapTx({ wrongPreimage: true });
        const result = verifyBoltzSwapPreimage(tx, 0);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /preimage|hash/i.test(e))).toBe(true);
    });

    it("rejects non swap/hash-lock scripts", async () => {
        const { tx } = await buildPlainMultisigTx();
        const result = verifyBoltzSwapPreimage(tx, 0);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /not a supported swap/i.test(e))).toBe(
            true
        );
    });
});

describe("verifyBoltzSwapSatisfaction", () => {
    const chainTip = { height: 1000, time: 1_700_000_000 };

    it("passes for a CSV + SHA256 swap path when both conditions are satisfied", async () => {
        const { tx } = await buildBoltzSwapCsvTx();
        const result = verifyBoltzSwapSatisfaction(tx, 0, chainTip, {
            blockHeight: 800,
            blockTime: 1_699_999_000,
        });

        expect(result.valid).toBe(true);
        expect(result.leafType).toBe("condition-csv-multisig");
    });

    it("fails for a CSV + SHA256 swap path when the preimage is wrong", async () => {
        const { tx } = await buildBoltzSwapCsvTx({ wrongPreimage: true });
        const result = verifyBoltzSwapSatisfaction(tx, 0, chainTip, {
            blockHeight: 800,
            blockTime: 1_699_999_000,
        });

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /preimage|hash/i.test(e))).toBe(true);
    });
});

async function buildBoltzSwapTx(opts: { wrongPreimage?: boolean } = {}) {
    const key = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const pub = await key.xOnlyPublicKey();
    const serverKey = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const serverPub = await serverKey.xOnlyPublicKey();

    const preimage = new Uint8Array(32);
    crypto.getRandomValues(preimage);
    const preimageHash = sha256(preimage);

    const conditionScript = Script.encode(["SHA256", preimageHash, "EQUAL"]);
    const swapScript = ConditionMultisigTapscript.encode({
        conditionScript,
        pubkeys: [pub, serverPub],
    });
    const vtxoScript = new VtxoScript([swapScript.script]);
    const tx = new ArkTransaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
    });
    tx.addOutput({
        script: taprootOutputScript(
            await SingleKey.fromPrivateKey(
                randomPrivateKeyBytes()
            ).xOnlyPublicKey()
        ),
        amount: 10_000n,
    });

    setArkPsbtField(tx, 0, ConditionWitness, [
        opts.wrongPreimage ? new Uint8Array(32).fill(0xff) : preimage,
    ]);

    return { tx };
}

async function buildBoltzSwapCsvTx(opts: { wrongPreimage?: boolean } = {}) {
    const key = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const pub = await key.xOnlyPublicKey();
    const preimage = new Uint8Array(32);
    crypto.getRandomValues(preimage);
    const preimageHash = hash160(preimage);

    const swapScript = ConditionCSVMultisigTapscript.encode({
        conditionScript: Script.encode(["HASH160", preimageHash, "EQUAL"]),
        timelock: { value: 144n, type: "blocks" },
        pubkeys: [pub],
    });
    const vtxoScript = new VtxoScript([swapScript.script]);
    const tx = new ArkTransaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
        sequence: 144,
    });
    tx.addOutput({
        script: taprootOutputScript(
            await SingleKey.fromPrivateKey(
                randomPrivateKeyBytes()
            ).xOnlyPublicKey()
        ),
        amount: 10_000n,
    });

    setArkPsbtField(tx, 0, ConditionWitness, [
        opts.wrongPreimage ? new Uint8Array(32).fill(0xff) : preimage,
    ]);

    return { tx };
}

async function buildPlainMultisigTx() {
    const key = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const pub = await key.xOnlyPublicKey();
    const script = MultisigTapscript.encode({
        pubkeys: [pub],
        type: MultisigTapscript.MultisigType.CHECKSIG,
    });
    const vtxoScript = new VtxoScript([script.script]);
    const tx = new ArkTransaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
    });
    tx.addOutput({
        script: taprootOutputScript(
            await SingleKey.fromPrivateKey(
                randomPrivateKeyBytes()
            ).xOnlyPublicKey()
        ),
        amount: 10_000n,
    });

    return { tx };
}

function taprootOutputScript(xOnlyKey: Uint8Array): Uint8Array {
    const script = new Uint8Array(34);
    script[0] = 0x51;
    script[1] = 0x20;
    script.set(xOnlyKey, 2);
    return script;
}
