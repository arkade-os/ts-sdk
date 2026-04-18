import {
    ConditionWitness,
    setArkPsbtField,
    Identity,
    Transaction,
} from "@arkade-os/sdk";

/**
 * Creates a VHTLC identity handling the claim preimage reveal.
 * @param identity - The base identity to wrap.
 * @param preimage - The preimage to reveal. optional.
 * @returns The wrapped identity.
 */
export function claimVHTLCIdentity(
    identity: Identity,
    preimage: Uint8Array
): Identity {
    return {
        ...identity,
        sign: async (
            tx: Transaction,
            inputIndexes?: number[]
        ): Promise<Transaction> => {
            const cpy = tx.clone();
            let signedTx = await identity.sign(cpy, inputIndexes);
            signedTx = Transaction.fromPSBT(signedTx.toPSBT());

            // If preimage is provided, add it to the witness for claim transactions
            if (preimage) {
                for (const inputIndex of inputIndexes ||
                    Array.from(
                        { length: signedTx.inputsLength },
                        (_, i) => i
                    )) {
                    setArkPsbtField(signedTx, inputIndex, ConditionWitness, [
                        preimage,
                    ]);
                }
            }
            return signedTx;
        },
    };
}
