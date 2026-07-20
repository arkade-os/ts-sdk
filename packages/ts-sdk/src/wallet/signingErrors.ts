/**
 * Thrown when a descriptor-capable contract (default, delegate, or boarding)
 * cannot be routed to any signer: its owner key (`params.pubKey`) is not this
 * wallet's baseline signing key, and the record carries no
 * `metadata.signingDescriptor` to send it to a descriptor-aware signer.
 *
 * Note that this can arise also when a contract belongs to a different identity (storage reuse).
 */
export class MissingSigningDescriptorError extends Error {
    readonly name = "MissingSigningDescriptorError";

    constructor(
        readonly contractScript: string,
        readonly contractType: "default" | "delegate" | "boarding",
    ) {
        super(
            `Cannot sign input for ${contractType} contract ${contractScript}: ` +
                `metadata.signingDescriptor is missing. Possible causes: this wallet was rotated ` +
                `on an earlier build that did not persist signing descriptors, or the contract ` +
                `belongs to a different identity. ` +
                `Manually set metadata.signingDescriptor on the contract record, ` +
                `or restore from a pre-rotation snapshot or delete the contract.`,
        );
    }
}

/**
 * Thrown when an input needs descriptor-aware signing but no
 * DescriptorProvider was wired into the wallet.
 *
 * @deprecated Unreachable since descriptor signing moved to a composite of
 * signing sources that is always present. A descriptor no source can sign
 * now raises {@link UnknownSigningDescriptorError} instead. Kept exported
 * for compatibility; removal is a later public API cleanup.
 */
export class DescriptorSigningProviderMissingError extends Error {
    readonly name = "DescriptorSigningProviderMissingError";

    constructor() {
        super("Descriptor signing requested but no DescriptorProvider was wired into this wallet");
    }
}

/**
 * Thrown when no signing source claims a descriptor: neither the wallet's
 * own descriptor provider nor its keyring of imported raw keys holds the
 * key the contract names.
 *
 * Failing here is deliberate. The alternative — skipping the input — would
 * surface much later as a server-side rejection of a half-signed
 * settlement, with nothing left to point at the descriptor that caused it.
 */
export class UnknownSigningDescriptorError extends Error {
    readonly name = "UnknownSigningDescriptorError";

    constructor(
        readonly descriptor: string,
        readonly sourceCount: number,
    ) {
        super(
            `No signing source holds the key for descriptor ${descriptor} ` +
                `(${sourceCount} source${sourceCount === 1 ? "" : "s"} consulted). ` +
                `Possible causes: the contract belongs to a different identity, or the key was ` +
                `imported for recovery and has since been purged.`,
        );
    }
}
