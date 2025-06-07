export class BIP322Error extends Error {
    constructor(message: string) {
        super(message);
        this.name = "BIP322Error";
    }
}

export const ErrMissingInputs = new BIP322Error("missing inputs");
export const ErrMissingData = new BIP322Error("missing data");
export const ErrMissingWitnessUtxo = new BIP322Error("missing witness utxo");
