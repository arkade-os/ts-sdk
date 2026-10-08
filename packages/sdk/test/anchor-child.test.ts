import { schnorr } from "@noble/curves/secp256k1.js";
import { p2tr } from "@scure/btc-signer";
import { describe, expect, it } from "vitest";
import { getNetwork } from "../src/networks";
import { buildAnchorChild, P2A } from "../src/utils/anchor";
import { Transaction } from "../src/utils/transaction";

const network = getNetwork("regtest");
const key = schnorr.getPublicKey(new Uint8Array(32).fill(3));
const pay = p2tr(key, undefined, network);

function makeParentWithAnchor(): Transaction {
    const tx = new Transaction({ allowUnknownOutputs: true });
    tx.addInput({
        txid: new Uint8Array(32).fill(9),
        index: 0,
        witnessUtxo: { script: pay.script, amount: 10_000n },
        tapInternalKey: pay.tapInternalKey,
    });
    tx.addOutput({ script: pay.script, amount: 10_000n });
    tx.addOutput(P2A);
    // parents are always finalized before bumping (finalizeVirtualTx / Session)
    tx.updateInput(0, { finalScriptWitness: [new Uint8Array(64).fill(1)] });
    return tx;
}

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
