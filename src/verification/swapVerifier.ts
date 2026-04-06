import type {
    ChainTip,
    ParentConfirmation,
    ScriptVerificationResult,
} from "./scriptVerifier";
import { verifyHashPreimage, verifyScriptSatisfaction } from "./scriptVerifier";
import type { Transaction } from "@scure/btc-signer/transaction.js";

function isBoltzLikeLeaf(leafType: string): boolean {
    return (
        leafType === "condition-multisig" ||
        leafType === "condition-csv-multisig"
    );
}

export function verifyBoltzSwapPreimage(
    tx: Transaction,
    inputIndex: number
): ScriptVerificationResult {
    const result = verifyHashPreimage(tx, inputIndex);
    if (!isBoltzLikeLeaf(result.leafType)) {
        return {
            ...result,
            valid: false,
            errors: [
                `Script type ${result.leafType} is not a supported swap/hash-lock tapscript`,
            ],
        };
    }

    return result;
}

export function verifyBoltzSwapSatisfaction(
    tx: Transaction,
    inputIndex: number,
    chainTip: ChainTip,
    parentConfirmation?: ParentConfirmation
): ScriptVerificationResult {
    const result = verifyScriptSatisfaction(
        tx,
        inputIndex,
        chainTip,
        parentConfirmation
    );
    if (!isBoltzLikeLeaf(result.leafType)) {
        return {
            ...result,
            valid: false,
            errors: [
                `Script type ${result.leafType} is not a supported swap/hash-lock tapscript`,
            ],
        };
    }

    return result;
}
