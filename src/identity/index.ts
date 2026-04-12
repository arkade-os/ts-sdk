import { Transaction } from "../utils/transaction";
import { SignerSession } from "../tree/signingSession";

export interface Identity extends ReadonlyIdentity {
    signerSession(): SignerSession;
    signMessage(
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa"
    ): Promise<Uint8Array>;
    // if inputIndexes is not provided, try to sign all inputs
    sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;
}

export interface ReadonlyIdentity {
    xOnlyPublicKey(): Promise<Uint8Array>;
    compressedPublicKey(): Promise<Uint8Array>;
}

/** A single PSBT signing request within a batch. */
export interface SignRequest {
    tx: Transaction;
    inputIndexes?: number[];
}

/**
 * Identity that supports signing multiple PSBTs in a single wallet interaction.
 * Browser wallet providers that support batch signing (e.g. Xverse, UniSat, OKX)
 * should implement this interface to reduce the number of confirmation popups
 * from N+1 to 1 during Arkade send transactions.
 *
 * Contract: implementations MUST return exactly one `Transaction` per request,
 * in the same order as the input array. The SDK validates this at runtime and
 * will throw if the lengths do not match.
 */
export interface BatchSignableIdentity extends Identity {
    signMultiple(requests: SignRequest[]): Promise<Transaction[]>;
}

/** Type guard for identities that support batch signing. */
export function isBatchSignable(
    identity: Identity
): identity is BatchSignableIdentity {
    return (
        "signMultiple" in identity &&
        typeof (identity as BatchSignableIdentity).signMultiple === "function"
    );
}

export * from "./singleKey";
export * from "./seedIdentity";
