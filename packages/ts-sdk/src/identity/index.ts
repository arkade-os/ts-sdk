import { Transaction } from "../utils/transaction";
import { SignerSession } from "../tree/signingSession";

export interface Identity extends ReadonlyIdentity {
    /** Returns a signer session used for musig2 tree signing flows. */
    signerSession(): SignerSession;

    /** Sign an arbitrary message using the requested signature type. */
    signMessage(message: Uint8Array, signatureType: "schnorr" | "ecdsa"): Promise<Uint8Array>;

    /**
     * Sign the provided transaction inputs.
     *
     * @param tx - Transaction to sign
     * @param inputIndexes - Optional input indexes to sign. When omitted, the implementation should sign every signable input.
     */
    sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction>;
}

export interface ReadonlyIdentity {
    /** Returns the x-only public key used by Taproot scripts. */
    xOnlyPublicKey(): Promise<Uint8Array>;

    /** Returns the compressed public key for this identity. */
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
    /**
     * Sign multiple transactions in a single wallet interaction.
     *
     * @param requests - Transactions and optional input indexes to sign
     * @returns Signed transactions in the same order as the input requests
     */
    signMultiple(requests: SignRequest[]): Promise<Transaction[]>;
}

/** Type guard for identities that support batch signing. */
export function isBatchSignable(identity: Identity): identity is BatchSignableIdentity {
    return (
        "signMultiple" in identity &&
        typeof (identity as BatchSignableIdentity).signMultiple === "function"
    );
}

export * from "./singleKey";
// Explicit named re-export so the barrel stays a documented public surface.
// `serializeSeedOwnedSigningIdentity` and `serializeSeedOwnedReadonlyIdentity`
// are deliberately omitted — they are SDK-internal helpers consumed only by
// `./serialize`, per Appendix A of the plan.
export type {
    NetworkOptions,
    DescriptorOptions,
    SeedIdentityOptions,
    MnemonicOptions,
} from "./seedIdentity";
export { SeedIdentity, MnemonicIdentity, ReadonlyDescriptorIdentity } from "./seedIdentity";
export * from "./serialize";

// Descriptor utilities
export {
    isDescriptor,
    normalizeToDescriptor,
    extractPubKey,
    parseHDDescriptor,
} from "./descriptor";
export type { ParsedHDDescriptor } from "./descriptor";

// Descriptor provider interface
export type { DescriptorProvider, DescriptorSigningRequest } from "./descriptorProvider";

// HD capability markers — readonly (xpub-only) and signing variants
export type { HDCapableIdentity, ReadonlyHDCapableIdentity } from "./hdCapableIdentity";
export { isHDCapableIdentity } from "./hdCapableIdentity";

// Static descriptor provider (wrapper for legacy Identity)
export { StaticDescriptorProvider } from "./staticDescriptorProvider";
