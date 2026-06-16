/**
 * Thrown when a descriptor-capable contract (default, delegate, or boarding)
 * cannot be routed to any signer: its owner key (`params.pubKey`) is not this
 * wallet's baseline signing key, and the record carries no
 * `metadata.signingDescriptor` to send it to a descriptor-aware signer.
 *
 * The violated invariant is "non-baseline owner key with no signing
 * descriptor" — not any single scenario. Rotation is only one way to reach it;
 * it can also arise from:
 *  - rotation on an earlier build that did not persist signing descriptors;
 *  - a contract belonging to a different identity whose contract storage was
 *    reused by this wallet (e.g. a re-imported seed sharing one repository);
 *  - an external or migration write that created the record without a
 *    descriptor.
 *
 * The exposed {@link ownerPubKey} / {@link baselinePubKey} fields disambiguate
 * these: an owner key derivable from this wallet's seed points at rotation
 * residue (recoverable by restoring the descriptor); an unrelated key points
 * at a foreign contract that should be ignored or removed. They are optional so
 * callers without key context can still construct the error.
 */
export class MissingSigningDescriptorError extends Error {
    readonly name = "MissingSigningDescriptorError";

    constructor(
        readonly contractScript: string,
        readonly contractType: "default" | "delegate" | "boarding",
        readonly ownerPubKey?: string,
        readonly baselinePubKey?: string,
    ) {
        super(
            buildMissingSigningDescriptorMessage(
                contractType,
                contractScript,
                ownerPubKey,
                baselinePubKey,
            ),
        );
    }
}

function describeOwnerKeyMismatch(ownerPubKey?: string, baselinePubKey?: string): string {
    if (!baselinePubKey) {
        // Constructed without key context (legacy / non-router callers).
        return "its owner key is not this wallet's baseline signing key";
    }
    if (!ownerPubKey) {
        return (
            `it has no owner key (params.pubKey) to match against this wallet's ` +
            `baseline signing key (${baselinePubKey})`
        );
    }
    return `its owner key (${ownerPubKey}) is not this wallet's baseline signing key (${baselinePubKey})`;
}

function buildMissingSigningDescriptorMessage(
    contractType: "default" | "delegate" | "boarding",
    contractScript: string,
    ownerPubKey?: string,
    baselinePubKey?: string,
): string {
    return (
        `Cannot sign input for ${contractType} contract ${contractScript}: ` +
        `the record has no metadata.signingDescriptor and ` +
        `${describeOwnerKeyMismatch(ownerPubKey, baselinePubKey)}, so the input ` +
        `cannot be routed to the baseline identity signer or a descriptor-aware signer. ` +
        `Likely causes: (a) the wallet rotated on an earlier build that did not persist ` +
        `signing descriptors; (b) the contract belongs to a different identity whose ` +
        `contract storage was reused by this wallet; (c) an external or migration write ` +
        `created the record without a descriptor. Resolve by setting ` +
        `metadata.signingDescriptor on the record when the owner key is derivable from ` +
        `this wallet, otherwise treat the contract as foreign and remove or ignore it.`
    );
}

/**
 * Thrown when an input needs descriptor-aware signing but no
 * DescriptorProvider was wired into the wallet.
 */
export class DescriptorSigningProviderMissingError extends Error {
    readonly name = "DescriptorSigningProviderMissingError";

    constructor() {
        super("Descriptor signing requested but no DescriptorProvider was wired into this wallet");
    }
}
