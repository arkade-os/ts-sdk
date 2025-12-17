export type FeeAmount = number;

export function feeAmountToSatoshis(fee: FeeAmount): number {
    return Math.ceil(fee);
}

export interface Config {
    intentOffchainInputProgram?: string;
    intentOnchainInputProgram?: string;
    intentOffchainOutputProgram?: string;
    intentOnchainOutputProgram?: string;
}

export type VtxoType = "recoverable" | "vtxo" | "note";

export interface OffchainInput {
    amount: number;
    expiry?: Date;
    birth?: Date;
    type: VtxoType;
    weight: number;
}

export interface OnchainInput {
    amount: number;
}

export interface FeeOutput {
    amount: number;
    script: string;
}
