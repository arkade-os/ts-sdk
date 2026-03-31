import { BoltzSwap } from "../types";
import { BoltzSwapStatus } from "../boltz-swap-provider";

export type { BoltzSwap };

export type GetSwapsFilter = {
    id?: string | string[];
    status?: BoltzSwapStatus | BoltzSwapStatus[];
    type?: BoltzSwap["type"] | BoltzSwap["type"][];
    orderBy?: "createdAt";
    orderDirection?: "asc" | "desc";
};

export interface SwapRepository extends AsyncDisposable {
    readonly version: 1;

    saveSwap<T extends BoltzSwap>(swap: T): Promise<void>;
    deleteSwap(id: string): Promise<void>;
    getAllSwaps<T extends BoltzSwap>(filter?: GetSwapsFilter): Promise<T[]>;

    clear(): Promise<void>;
}
