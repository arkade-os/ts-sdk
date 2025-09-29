export class IntentProofError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "IntentProofError";
    }
}

export const ErrMissingInputs = new IntentProofError("missing inputs");
export const ErrMissingData = new IntentProofError("missing data");
export const ErrMissingWitnessUtxo = new IntentProofError(
    "missing witness utxo"
);
