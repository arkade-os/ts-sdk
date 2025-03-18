import { pubSchnorr, randomPrivateKeyBytes } from "@scure/btc-signer/utils";
import { hex } from "@scure/base";
import { TreeSignerSession } from "./signingSession";
import { SignerSession } from "./signingSession";
import { Transaction } from "@scure/btc-signer";

const ZERO_32 = new Uint8Array(32).fill(0);

export interface Identity {
    // if inputIndexes is not provided, try to sign all inputs
    sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;
    xOnlyPublicKey(): Uint8Array;
    // TODO deterministic signer session
    signerSession(): SignerSession;
}

export class InMemoryKey implements Identity {
    private key: Uint8Array;

    private constructor(key: Uint8Array | undefined) {
        this.key = key || randomPrivateKeyBytes();
    }

    static fromPrivateKey(privateKey: Uint8Array): InMemoryKey {
        return new InMemoryKey(privateKey);
    }

    static fromHex(privateKeyHex: string): InMemoryKey {
        return new InMemoryKey(hex.decode(privateKeyHex));
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        const txCpy = tx.clone();

        if (!inputIndexes) {
            if (!txCpy.sign(this.key, undefined, ZERO_32)) {
                throw new Error("Failed to sign transaction");
            }
            return txCpy;
        }

        for (const inputIndex of inputIndexes) {
            if (!txCpy.signIdx(this.key, inputIndex, undefined, ZERO_32)) {
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
