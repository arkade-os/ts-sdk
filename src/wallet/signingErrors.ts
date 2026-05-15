/**
 * Thrown when a rotated contract (default or delegate) is missing the
 * metadata.signingDescriptor required to route it to a descriptor-aware
 * signer.
 */
export class MissingSigningDescriptorError extends Error {
    readonly name = "MissingSigningDescriptorError";

    constructor(
        readonly contractScript: string,
        readonly contractType: "default" | "delegate"
    ) {
        super(
            `Cannot sign input for ${contractType} contract ${contractScript}: ` +
                `metadata.signingDescriptor is missing. This wallet was rotated ` +
                `on an earlier build that did not persist signing descriptors. ` +
                `Manually set metadata.signingDescriptor on the contract record, ` +
                `or restore from a pre-rotation snapshot.`
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
        super(
            "Descriptor signing requested but no DescriptorProvider was wired into this wallet"
        );
    }
}
