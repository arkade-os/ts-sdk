import { pubSchnorr, randomPrivateKeyBytes } from "@scure/btc-signer/utils";
import { hex } from "@scure/base";
import { SigHash, Transaction } from "@scure/btc-signer";
import { Identity } from ".";
import { SignerSession, TreeSignerSession } from "../tree/signingSession";

const ZERO_32 = new Uint8Array(32).fill(0);
const ALL_SIGHASH = Object.values(SigHash).filter((x) => typeof x === "number");

/**
 * In-memory single key implementation for Bitcoin transaction signing.
 *
 * @example
 * ```typescript
 * // Create from hex string
 * const key = SingleKey.fromHex('your_private_key_hex');
 *
 * // Create from raw bytes
 * const key = SingleKey.fromPrivateKey(privateKeyBytes);
 *
 * // Sign a transaction
 * const signedTx = await key.sign(transaction);
 * ```
 */
export class SingleKey implements Identity {
    private key: Uint8Array;

    private constructor(key: Uint8Array | undefined) {
        this.key = key || randomPrivateKeyBytes();
    }

    static fromPrivateKey(privateKey: Uint8Array): SingleKey {
        return new SingleKey(privateKey);
    }

    static fromHex(privateKeyHex: string): SingleKey {
        return new SingleKey(hex.decode(privateKeyHex));
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        const txCpy = tx.clone();

        if (!inputIndexes) {
            try {
                if (!txCpy.sign(this.key, ALL_SIGHASH, ZERO_32)) {
                    throw new Error("Failed to sign transaction");
                }
            } catch (e) {
                if (
                    e instanceof Error &&
                    e.message.includes("No inputs signed")
                ) {
                    // ignore
                } else {
                    throw e;
                }
            }
            return txCpy;
        }

        for (const inputIndex of inputIndexes) {
            if (!txCpy.signIdx(this.key, inputIndex, ALL_SIGHASH, ZERO_32)) {
                throw new Error(`Failed to sign input #${inputIndex}`);
            }
        }

        return txCpy;
    }

    xOnlyPublicKey(): Uint8Array {
        return pubSchnorr(this.key);
    }

    signerSession(): SignerSession {
        return TreeSignerSession.random();
    }
}
