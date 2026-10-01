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
     * @param inputIndexes - Inputs to sign; when omitted, sign every signable input.
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
 * Identity that signs multiple PSBTs in one wallet interaction. Batch-capable browser wallets
 * (e.g. Xverse, UniSat, OKX) implement it to cut Arkade send popups from N+1 to 1.
 *
 * Contract:
 * - Return exactly one `Transaction` per request, in request order (validated at runtime).
 * - Preserve partial signatures already on the PSBTs and only ADD your own. The pending-tx
 *   recovery path (`Wallet.finalizePendingTxs`) passes checkpoints already carrying the
 *   server's `tapScriptSig`; dropping it fails server-side finalization and strands the tx.
 */
export interface BatchSignableIdentity extends Identity {
    /**
     * Sign multiple transactions in a single wallet interaction (see the interface contract).
     *
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
// Named, not `*`: `serializeSeedOwned*Identity` are SDK-internal (used only by `./serialize`).
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
    identityDescriptor,
    deriveDescriptorLeafPubKey,
    deriveDescriptorLeafCompressedPubKey,
} from "./descriptor";
export type { ParsedHDDescriptor } from "./descriptor";

// Descriptor-scoped identity adapter
export { DescriptorIdentity, isHDDeterministicSignCapable } from "./descriptorIdentity";
export type {
    DescriptorIdentityOptions,
    DescriptorSigner,
    HDDeterministicSignCapable,
} from "./descriptorIdentity";

// Descriptor provider interface
export type { DescriptorProvider, DescriptorSigningRequest } from "./descriptorProvider";

// HD capability markers — readonly (xpub-only) and signing variants
export type { HDCapableIdentity, ReadonlyHDCapableIdentity } from "./hdCapableIdentity";
export { isHDCapableIdentity } from "./hdCapableIdentity";

// Static descriptor provider (wrapper for legacy Identity)
export { StaticDescriptorProvider } from "./staticDescriptorProvider";

/**
 * Whether `value` is a complete {@link Identity} rather than the read-only half of one.
 *
 * All four members are checked (notably `signerSession`, needed by an interactive refund): a
 * partial identity otherwise fails as a `TypeError` deep in a signing path, which callers read
 * as retryable. Keep this the one shared guard, so it can't drift when `Identity` grows.
 */
export function isSigningIdentity(value: unknown): value is Identity {
    if (typeof value !== "object" || value === null) return false;
    const v = value as Partial<Identity>;
    return (
        typeof v.sign === "function" &&
        typeof v.signMessage === "function" &&
        typeof v.signerSession === "function" &&
        typeof v.xOnlyPublicKey === "function"
    );
}
