import { Transaction } from "@scure/btc-signer";
import { SignerSession } from "../tree/signingSession";

export interface Identity {
    // if inputIndexes is not provided, try to sign all inputs
    sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;
    xOnlyPublicKey(): Promise<Uint8Array>;
    // TODO deterministic signer session
    signerSession(): SignerSession;
}

export * from "./singleKey";
