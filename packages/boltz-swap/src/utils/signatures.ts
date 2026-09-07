import { verifyTapscriptSignatures } from "@arkade-os/sdk";
import { Transaction } from "@scure/btc-signer";
import { hex } from "@scure/base";

/**
 * Verifies that a transaction input has valid tapscript signatures
 * from all required signers for a specific tapscript leaf.
 *
 * @param tx - The transaction to verify.
 * @param inputIndex - The index of the input to check.
 * @param requiredSigners - Hex-encoded x-only public keys of all required signers.
 * @param expectedLeafHash - The tapscript leaf hash that signatures must commit to.
 * @returns `true` if every signature on the input commits to the expected leaf and all
 * required signers are present, `false` otherwise.
 */
export const verifySignatures = (
    tx: Transaction,
    inputIndex: number,
    requiredSigners: string[],
    expectedLeafHash: Uint8Array,
): boolean => {
    try {
        verifyTapscriptSignatures(
            tx,
            inputIndex,
            requiredSigners,
            undefined,
            undefined,
            expectedLeafHash,
        );
        return true;
    } catch (_) {
        return false;
    }
};

/**
 * Validate we are using a x-only public key
 * @param publicKey
 * @param keyName
 * @param swapId
 * @returns Uint8Array
 */
export const normalizeToXOnlyKey = (
    someKey: Uint8Array | string,
    keyName = "",
    swapId = "",
): Uint8Array => {
    const keyBytes = typeof someKey === "string" ? hex.decode(someKey) : someKey;
    if (keyBytes.length === 33) {
        return keyBytes.slice(1);
    }
    if (keyBytes.length !== 32) {
        throw new Error(
            `Invalid ${keyName} key length: ${keyBytes.length} ${swapId ? "for swap " + swapId : ""}`,
        );
    }
    return keyBytes;
};
