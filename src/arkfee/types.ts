/**
 * FeeAmount is a wrapper around a number that represents a fee amount in satoshis floating point.
 * @param value - The fee amount in floating point.
 * @method satoshis - Returns the fee amount in satoshis as a integer.
 * @example
 * const fee = new FeeAmount(1.23456789);
 * console.log(fee.value); // 1.23456789
 * console.log(fee.satoshis); // 2
 */
export class FeeAmount {
    static ZERO = new FeeAmount(0);

    constructor(readonly value: number) {}
    get satoshis(): number {
        return this.value ? Math.ceil(this.value) : 0;
    }

    add(other: FeeAmount): FeeAmount {
        return new FeeAmount(this.value + other.value);
    }
}

export interface IntentFeeConfig {
    offchainInput?: string;
    onchainInput?: string;
    offchainOutput?: string;
    onchainOutput?: string;
}

export type VtxoType = "recoverable" | "vtxo" | "note";

export interface OffchainInput {
    amount: bigint;
    expiry?: Date;
    birth?: Date;
    type: VtxoType;
    weight: number;
}

export interface OnchainInput {
    amount: bigint;
}

export interface FeeOutput {
    amount: bigint;
    script: string;
}
