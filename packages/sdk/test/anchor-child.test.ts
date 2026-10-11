import { schnorr } from "@noble/curves/secp256k1.js";
import { p2tr } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { getNetwork } from "../src/networks";
import { DefaultVtxo } from "../src/script/default";
import { CSVMultisigTapscript } from "../src/script/tapscript";
import { buildAnchorChild, ANCHOR_PKSCRIPT, P2A } from "../src/utils/anchor";
import { buildOffchainTx } from "../src/utils/arkTransaction";
import { Transaction } from "../src/utils/transaction";

const network = getNetwork("regtest");
const key = schnorr.getPublicKey(new Uint8Array(32).fill(3));
const pay = p2tr(key, undefined, network);

function makeParentWithAnchor(anchorAmount = P2A.amount): Transaction {
    const tx = new Transaction({ allowUnknownOutputs: true });
    tx.addInput({
        txid: new Uint8Array(32).fill(9),
        index: 0,
        witnessUtxo: { script: pay.script, amount: 10_000n },
        tapInternalKey: pay.tapInternalKey,
    });
    tx.addOutput({ script: pay.script, amount: 10_000n - anchorAmount });
    tx.addOutput({ ...P2A, amount: anchorAmount });
    // parents are always finalized before bumping (finalizeVirtualTx / Session)
    tx.updateInput(0, { finalScriptWitness: [new Uint8Array(64).fill(1)] });
    return tx;
}

describe("buildOffchainTx anchor", () => {
    const vtxoScript = new DefaultVtxo.Script({
        pubKey: key,
        serverPubKey: key,
        csvTimelock: DefaultVtxo.Script.DEFAULT_TIMELOCK,
    });
    const serverUnrollScript = CSVMultisigTapscript.decode(
        hex.decode(
            "039d0440b2752079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
        ),
    );
    const build = (outputAmount: bigint) =>
        buildOffchainTx(
            [
                {
                    txid: "11".repeat(32),
                    vout: 0,
                    value: 1_000,
                    tapLeafScript: vtxoScript.forfeit(),
                    tapTree: vtxoScript.encode(),
                },
            ],
            [{ script: pay.script, amount: outputAmount }],
            serverUnrollScript,
        );

    it("puts the fee in the P2A output so the ark tx itself pays none", () => {
        const { arkTx, checkpoints } = build(890n);
        const anchor = arkTx.getOutput(1);
        expect(anchor.script).toEqual(ANCHOR_PKSCRIPT);
        expect(anchor.amount).toBe(110n);
        expect(checkpoints[0].getOutput(1).amount).toBe(0n);
    });

    it("rejects outputs exceeding inputs", () => {
        expect(() => build(1_001n)).toThrow("outputs exceed inputs");
    });
});

describe("buildAnchorChild", () => {
    it("builds a v3 child spending anchor + funding coin with correct fee", () => {
        const parent = makeParentWithAnchor();
        const coin = { txid: "11".repeat(32), vout: 0, value: 5_000 };
        const { child, fee } = buildAnchorChild({
            parent,
            feeRate: 2,
            fundingCoins: [coin],
            changeAddress: pay.address!,
            changeScript: pay.script,
            tapInternalKey: pay.tapInternalKey,
            network,
        });
        expect(child.version).toBe(3);
        expect(child.inputsLength).toBe(2);
        // single change output pays sum(coins) - fee
        expect(child.outputsLength).toBe(1);
        expect(child.getOutput(0).amount).toBe(BigInt(5_000 - fee));
        expect(fee).toBeGreaterThan(0);
    });

    it("spends a valued anchor at its real amount and credits it to change", () => {
        const parent = makeParentWithAnchor(400n);
        const coin = { txid: "11".repeat(32), vout: 0, value: 5_000 };
        const { child, fee } = buildAnchorChild({
            parent,
            feeRate: 2,
            fundingCoins: [coin],
            changeAddress: pay.address!,
            changeScript: pay.script,
            tapInternalKey: pay.tapInternalKey,
            network,
        });
        expect(child.getInput(0).witnessUtxo?.amount).toBe(400n);
        expect(child.getOutput(0).amount).toBe(BigInt(5_000 + 400 - fee));
    });

    it("throws when change would be below dust", () => {
        const parent = makeParentWithAnchor();
        const coin = { txid: "11".repeat(32), vout: 0, value: 400 };
        expect(() =>
            buildAnchorChild({
                parent,
                feeRate: 2,
                fundingCoins: [coin],
                changeAddress: pay.address!,
                changeScript: pay.script,
                tapInternalKey: pay.tapInternalKey,
                network,
            }),
        ).toThrow(/dust|insufficient/i);
    });
});
