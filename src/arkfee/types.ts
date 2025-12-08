/**
 * FeeAmount represents a fee amount in satoshis (as a floating-point number)
 */
export type FeeAmount = {
    satoshis(): number;
    amount: number;
};

export function newFeeAmount(amount: number): FeeAmount {
    return {
        satoshis: () => Math.ceil(amount),
        amount,
    };
}

/**
 * InputType represents the type of an input
 */
export enum InputType {
    Recoverable = "recoverable",
    Vtxo = "vtxo",
    Boarding = "boarding",
    Note = "note",
}

/**
 * Input represents an input to an intent
 */
export interface Input {
    amount: number;
    expiry?: Date;
    birth?: Date;
    type: InputType;
    weight: number;
}

/**
 * OutputType represents the type of an output
 */
export enum OutputType {
    Vtxo = "vtxo",
    Onchain = "onchain",
}

/**
 * Output represents an output from an intent
 */
export interface Output {
    amount: number;
    type: OutputType;
}
