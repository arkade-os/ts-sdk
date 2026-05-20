import {
    applyCreatedAtOrder,
    applySwapsFilter,
    BoltzSwap,
    GetSwapsFilter,
    SwapRepository,
} from "../swap-repository";

export class InMemorySwapRepository implements SwapRepository {
    readonly version = 1 as const;
    private readonly swaps: Map<string, BoltzSwap> = new Map();

    async saveSwap<T extends BoltzSwap>(swap: T): Promise<void> {
        this.swaps.set(swap.id, swap);
    }

    async deleteSwap(id: string): Promise<void> {
        this.swaps.delete(id);
    }

    async getAllSwaps<T extends BoltzSwap>(filter?: GetSwapsFilter): Promise<T[]> {
        const swaps = [...this.swaps.values()];
        if (!filter || Object.keys(filter).length === 0) return swaps as T[];
        const filtered = applySwapsFilter(swaps, filter) as T[];
        return applyCreatedAtOrder(filtered, filter);
    }

    async clear(): Promise<void> {
        this.swaps.clear();
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.clear();
    }
}
