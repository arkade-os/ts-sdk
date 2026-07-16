import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { TransactionInputUpdate } from "@scure/btc-signer/psbt.js";
import { Network } from "../networks";
import { Transaction as ArkTransaction } from "./transaction";
import { TxWeightEstimator } from "./txSizeEstimator";

export const ANCHOR_VALUE = 0n;
export const ANCHOR_PKSCRIPT = new Uint8Array([0x51, 0x02, 0x4e, 0x73]);

/**
 * A zero-value anchor output.
 */
export const P2A = {
    script: ANCHOR_PKSCRIPT,
    amount: ANCHOR_VALUE,
};

const hexP2Ascript = hex.encode(P2A.script);

/**
 * search for anchor in the given transaction.
 * @throws {Error} if the anchor is not found or has the wrong amount
 */
export function findP2AOutput(tx: Transaction): TransactionInputUpdate {
    for (let i = 0; i < tx.outputsLength; i++) {
        const output = tx.getOutput(i);
        if (output.script && hex.encode(output.script) === hexP2Ascript) {
            if (output.amount !== P2A.amount) {
                throw new Error(
                    `P2A output has wrong amount, expected ${P2A.amount} got ${output.amount}`,
                );
            }

            return {
                txid: tx.id,
                index: i,
                witnessUtxo: P2A,
            };
        }
    }

    throw new Error("P2A output not found");
}

export interface AnchorBumper {
    // bumpP2A creates a new transaction spending the P2A output from the given transaction
    // it returns the package to broadcast [parent, child] in order to get the tx confirmed
    bumpP2A(parent: Transaction): Promise<[string, string]>;
}

export const CHILD_DUST_AMOUNT = 546; // sats — matches wallet DUST_AMOUNT

/** Minimal coin shape for fee funding (avoids importing wallet types here). */
export type FundingCoin = { txid: string; vout: number; value: number };

export type AnchorChildParams = {
    /** Finalized parent transaction carrying a P2A output. */
    parent: Transaction;
    /** Target fee rate (sat/vB) for the WHOLE package (parent + child). */
    feeRate: number;
    /** Confirmed coins paying the fee. */
    fundingCoins: FundingCoin[];
    changeAddress: string;
    /** pkScript of the funding coins (P2TR). */
    changeScript: Uint8Array;
    /** Internal key for the funding inputs. */
    tapInternalKey: Uint8Array;
    network: Network;
};

/**
 * Build the (unsigned) v3 CPFP child paying for a 1P1C package.
 * Pure construction: no coin selection, no signing, no broadcast.
 */
export function buildAnchorChild(params: AnchorChildParams): {
    child: ArkTransaction;
    fee: number;
} {
    const { parent, feeRate, fundingCoins, changeAddress, tapInternalKey, network } = params;

    const child = new ArkTransaction({ version: 3, allowLegacyWitnessUtxo: true });
    child.addInput(findP2AOutput(parent)); // throws if no anchor

    const estimator = TxWeightEstimator.create().addP2AInput();
    for (const _ of fundingCoins) {
        estimator.addKeySpendInput(true);
    }
    estimator.addOutputAddress(changeAddress, network);
    const childVsize = Number(estimator.vsize().value);

    const fee = Math.ceil(feeRate * (parent.vsize + childVsize));

    let total = 0n;
    for (const coin of fundingCoins) {
        total += BigInt(coin.value);
        child.addInput({
            txid: coin.txid,
            index: coin.vout,
            witnessUtxo: { script: params.changeScript, amount: BigInt(coin.value) },
            tapInternalKey,
        });
    }

    const change = total + P2A.amount - BigInt(fee);
    if (change < BigInt(CHILD_DUST_AMOUNT)) {
        throw new Error(
            `insufficient funding for anchor child: need change >= ${CHILD_DUST_AMOUNT}, got ${change}`,
        );
    }
    child.addOutputAddress(changeAddress, change, network);
    return { child, fee };
}
