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
 */
export class DescriptorSigningProviderMissingError extends Error {
    readonly name = "DescriptorSigningProviderMissingError";

    constructor() {
        super("Descriptor signing requested but no DescriptorProvider was wired into this wallet");
    }
}
