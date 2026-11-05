/**
 * FeeAmount is a wrapper around a number that represents a fee amount in satoshis floating point.
 * @param value - The fee amount in floating point.
 * @example
 * const fee = new FeeAmount(1.23456789);
 * console.log(fee.value); // 1.23456789
 * console.log(fee.satoshis); // 2
 */
export class FeeAmount {
    static ZERO = new FeeAmount(0);

    constructor(readonly value: number) {}

    /** Returns the fee amount rounded up to whole satoshis. */
    get satoshis(): number {
        return this.value ? Math.ceil(this.value) : 0;
    }

    /** Add two fee amounts together. */
    add(other: FeeAmount): FeeAmount {
        return new FeeAmount(this.value + other.value);
    }
}

export interface BatchFeeConfig {
    offchainInput?: string;
    onchainInput?: string;
    offchainOutput?: string;
    onchainOutput?: string;
}

/** @deprecated Use {@link BatchFeeConfig}. */
export type IntentFeeConfig = BatchFeeConfig;

/**
 * The batch fee config in `fees`, read from the deprecated `intentFee` key only
 * when `batchFee` is absent.
 *
 * `batchFee` wins when both keys are set, so `{ ...info.fees, intentFee: x }`
 * has no effect here. Override `batchFee` instead.
 */
export const batchFeeConfig = (fees?: {
    batchFee?: BatchFeeConfig;
    intentFee?: BatchFeeConfig;
}): BatchFeeConfig => fees?.batchFee ?? fees?.intentFee ?? {};

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
