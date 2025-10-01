import { Transaction } from "@scure/btc-signer/transaction.js";
import { SignerSession } from "../tree/signingSession";

export interface Identity {
    // todo: check if we need promise here as well
    signerSession(): SignerSession;
    xOnlyPublicKey(): Promise<Uint8Array>;
    compressedPublicKey(): Promise<Uint8Array>;
    signMessage(
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa"
    ): Promise<Uint8Array>;
    // if inputIndexes is not provided, try to sign all inputs
    sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;
}

export * from "./singleKey";
