import { ConditionWitness, setArkPsbtField, Identity, Transaction } from "@arkade-os/sdk";

/**
 * Creates a VHTLC identity handling the claim preimage reveal.
 *
 * Delegates member by member rather than spreading `identity`: a spread copies
 * own properties only, so a class-based identity (`SingleKey`, `SeedIdentity`,
 * `DescriptorIdentity`) would lose every prototype method — including the
 * `signerSession()` a batch join needs.
 *
 * @param identity - The base identity to wrap.
 * @param preimage - The preimage to reveal. optional.
 * @returns The wrapped identity.
 */
export function claimVHTLCIdentity(identity: Identity, preimage: Uint8Array): Identity {
    return {
        xOnlyPublicKey: () => identity.xOnlyPublicKey(),
        compressedPublicKey: () => identity.compressedPublicKey(),
        signerSession: () => identity.signerSession(),
        signMessage: (message, signatureType) => identity.signMessage(message, signatureType),
        sign: async (tx: Transaction, inputIndexes?: number[]): Promise<Transaction> => {
            const cpy = tx.clone();
            let signedTx = await identity.sign(cpy, inputIndexes);
            signedTx = Transaction.fromPSBT(signedTx.toPSBT());

            // If preimage is provided, add it to the witness for claim transactions
            if (preimage) {
                for (const inputIndex of inputIndexes ||
                    Array.from({ length: signedTx.inputsLength }, (_, i) => i)) {
                    setArkPsbtField(signedTx, inputIndex, ConditionWitness, [preimage]);
                }
            }
            return signedTx;
        },
    };
}
