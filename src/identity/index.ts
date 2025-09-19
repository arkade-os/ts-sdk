import { Transaction } from "@scure/btc-signer/transaction.js";
import { SignerSession } from "../tree/signingSession";

export interface Identity {
    // if inputIndexes is not provided, try to sign all inputs
    sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;
    xOnlyPublicKey(): Promise<Uint8Array>;
    signerSession(): SignerSession;
    signMessage(message: string): Promise<Uint8Array>;
}

export * from "./singleKey";
