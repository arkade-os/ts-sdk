import { Identity } from ".";
import { DescriptorProvider } from "./descriptorProvider";
import { deriveDescriptorLeafCompressedPubKey, deriveDescriptorLeafPubKey } from "./descriptor";
import { SignerSession } from "../tree/signingSession";
import { Transaction } from "../utils/transaction";

/**
 * Descriptor-scoped signing surface — the two members every
 * {@link DescriptorProvider} and every `HDCapableIdentity` share.
 */
export type DescriptorSigner = Pick<
    DescriptorProvider,
    "signWithDescriptor" | "signMessageWithDescriptor"
>;

/**
 * Per-descriptor deterministic Schnorr signing. Separate from the baseline
 * `DeterministicSignCapable` marker because the seed holder — not the
 * descriptor — is the only party that can derive the key at an index.
 */
export interface HDDeterministicSignCapable {
    /** BIP-340 sign `messageHash` with the descriptor's key and aux_rand = 0. */
    signSchnorrDeterministicWithDescriptor(
        descriptor: string,
        messageHash: Uint8Array,
    ): Promise<Uint8Array>;
}

/** Type guard for {@link HDDeterministicSignCapable}. */
export function isHDDeterministicSignCapable(value: unknown): value is HDDeterministicSignCapable {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as HDDeterministicSignCapable).signSchnorrDeterministicWithDescriptor ===
            "function"
    );
}

/** Constructor arguments for {@link DescriptorIdentity}. */
export interface DescriptorIdentityOptions {
    /** Materialized descriptor (no wildcard) this identity is pinned to. */
    descriptor: string;
    /** Descriptor-aware signer — an `HDDescriptorProvider` or an HD identity. */
    signer: DescriptorSigner;
    /**
     * Seed-holding identity behind `signer`. Backs the members that are not
     * descriptor-scoped in the provider contract: musig2 sessions and
     * deterministic Schnorr.
     */
    base: Identity;
}

/**
 * {@link Identity} pinned to one materialized HD descriptor: every key and
 * signature it produces belongs to that index rather than to the wallet's
 * baseline key.
 *
 * Lets components that take a plain `Identity` (VHTLC claim/refund, batch
 * joins) operate on a rotated index without knowing about descriptors.
 *
 * Deliberately does NOT satisfy `isBatchSignable`, `isHDCapableIdentity`, or
 * `hasToReadonly` — it is a leaf signer, not another HD root.
 */
export class DescriptorIdentity implements Identity {
    private readonly descriptor: string;
    private readonly signer: DescriptorSigner;
    private readonly base: Identity;

    constructor({ descriptor, signer, base }: DescriptorIdentityOptions) {
        this.descriptor = descriptor;
        this.signer = signer;
        this.base = base;
    }

    async xOnlyPublicKey(): Promise<Uint8Array> {
        return deriveDescriptorLeafPubKey(this.descriptor);
    }

    async compressedPublicKey(): Promise<Uint8Array> {
        return deriveDescriptorLeafCompressedPubKey(this.descriptor);
    }

    async sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> {
        const [signed] = await this.signer.signWithDescriptor([
            { descriptor: this.descriptor, tx, inputIndexes },
        ]);
        if (!signed) {
            throw new Error(`Descriptor signer returned no transaction for ${this.descriptor}`);
        }
        return signed;
    }

    async signMessage(
        message: Uint8Array,
        signatureType: "schnorr" | "ecdsa" = "schnorr",
    ): Promise<Uint8Array> {
        return this.signer.signMessageWithDescriptor(this.descriptor, message, signatureType);
    }

    /**
     * Delegated: `TreeSignerSession.random()` consults no key material, so the
     * session is index-independent.
     */
    signerSession(): SignerSession {
        return this.base.signerSession();
    }

    /**
     * Throws rather than falling back to the baseline key: a preimage derived
     * from the wrong index is unrecoverable, and callers probe this member
     * through a structural guard that cannot tell the two apart.
     */
    async signSchnorrDeterministic(messageHash: Uint8Array): Promise<Uint8Array> {
        if (!isHDDeterministicSignCapable(this.base)) {
            throw new Error(
                `Identity cannot sign deterministically for descriptor ${this.descriptor}`,
            );
        }
        return this.base.signSchnorrDeterministicWithDescriptor(this.descriptor, messageHash);
    }
}
