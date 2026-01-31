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

export * from "./singleKey";
export { SeedIdentity, ReadonlySeedIdentity } from "./seedIdentity";
export type {
    SeedIdentityOptions,
    MnemonicOptions,
    SigningRequest,
} from "./seedIdentity";

// Descriptor utilities
export {
    isDescriptor,
    normalizeToDescriptor,
    extractPubKey,
    parseHDDescriptor,
} from "./descriptor";
export type { ParsedHDDescriptor } from "./descriptor";

// Descriptor provider interface
export type {
    DescriptorProvider,
    DescriptorSigningRequest,
} from "./descriptorProvider";
