import { hex } from "@scure/base";
import { Script } from "@scure/btc-signer";
import { FeesResponse } from "../types";
import bip68 from "bip68";

/**
 * Extracts and calculates the timelock (relative or absolute) from a Bitcoin script.
 * Handles both relative timelocks (CSV/OP_NOP3) and absolute timelocks (CLTV/OP_NOP2).
 * @param scriptHex The Bitcoin script in hexadecimal format.
 * @returns The timelock value in blocks or seconds.
 */
export function extractTimeLockFromLeafOutput(scriptHex: string): number {
    // return 0 if no script provided
    if (!scriptHex) return 0;

    try {
        // decode the script into opcodes using @scure/btc-signer
        const opcodes = Script.decode(hex.decode(scriptHex));

        // look for CHECKLOCKTIMEVERIFY (CLTV)
        const hasCLTV = opcodes.findIndex((op) => op === "CHECKLOCKTIMEVERIFY");

        if (hasCLTV > 0) {
            const data = opcodes[hasCLTV - 1];
            if (data instanceof Uint8Array) {
                const dataBytes = new Uint8Array(data).reverse(); // reverse for little-endian
                return parseInt(hex.encode(dataBytes), 16);
            }
        }

        // look for CHECKSEQUENCEVERIFY (CSV)
        const hasCSV = opcodes.findIndex((op) => op === "CHECKSEQUENCEVERIFY");

        if (hasCSV > 0) {
            const data = opcodes[hasCSV - 1];
            if (data instanceof Uint8Array) {
                const dataBytes = new Uint8Array(data).reverse(); // reverse for little-endian
                const {
                    blocks,
                    seconds,
                }: { blocks?: number; seconds?: number } = bip68.decode(
                    parseInt(hex.encode(dataBytes), 16)
                );
                return blocks ?? seconds ?? 0;
            }
        }
    } catch (error) {
        // Return 0 for malformed scripts
        return 0;
    }

    return 0;
}

/**
 * In a reverse swap, finds the invoice amount before fees were applied.
 * @param amountSats amount in sats received after fees
 * @param fees fees structure (we need reverse fees)
 * @returns invoice amount in sats before fees
 */
export function extractInvoiceAmount(
    amountSats: number | undefined,
    fees: FeesResponse
): number {
    // validate inputs
    if (!amountSats) return 0;
    const { percentage, minerFees } = fees.reverse;
    const miner = minerFees.lockup + minerFees.claim;

    // validate inputs
    if (percentage >= 100 || percentage < 0) return 0;
    if (miner >= amountSats) return 0;

    return Math.ceil((amountSats - miner) / (1 - percentage / 100));
}
