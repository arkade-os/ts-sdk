import { Transaction } from "../utils/transaction";
import { SignerSession } from "../tree/signingSession";

export interface Identity {
    signerSession(): SignerSession;
    xOnlyPublicKey(): Promise<Uint8Array>;
    compressedPublicKey(): Promise<Uint8Array>;
    signMessage(
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa"
    ): Promise<Uint8Array>;
    // if inputIndexes is not provided, try to sign all inputs
    sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;
    // decrypt data encrypted with the corresponding public key
    decrypt(pubkey: string, data: string): string;
}

export * from "./singleKey";
