import {
    GetSwapsFilter,
    PendingSwap,
    SwapRepository,
} from "../swap-repository";
export class InMemorySwapRepository implements SwapRepository {
    readonly version = 1 as const;
    private readonly swaps: Map<string, PendingSwap> = new Map();

    async saveSwap<T extends PendingSwap>(swap: T): Promise<void> {
        this.swaps.set(swap.id, swap);
    }

    async deleteSwap(id: string): Promise<void> {
        this.swaps.delete(id);
    }

    async getAllSwaps<T extends PendingSwap>(
        filter?: GetSwapsFilter
    ): Promise<T[]> {
        const swaps = [...this.swaps.values()];
        if (!filter || Object.keys(filter).length === 0) return swaps as T[];
        const filtered = this.applySwapsFilter(swaps, filter);
        if (filter.orderBy === "createdAt") {
            const direction = filter.orderDirection === "asc" ? 1 : -1;
            return filtered
                .slice()
                .sort((a, b) => (a.createdAt - b.createdAt) * direction) as T[];
        }
        return filtered as T[];
    }

    async clear(): Promise<void> {
        this.swaps.clear();
    }

    private applySwapsFilter<
        T extends { id: string; status: string; type: string },
    >(swaps: (T | undefined)[], filter: GetSwapsFilter): T[] {
        const matches = <T>(value: T, criterion?: T | T[]) => {
            if (criterion === undefined) {
                return true;
            }
            return Array.isArray(criterion)
                ? criterion.includes(value)
                : value === criterion;
        };
        return swaps.filter(
            (swap): swap is T =>
                !!swap &&
                matches(swap.id, filter.id) &&
                matches(swap.status, filter.status) &&
                matches(swap.type, filter.type)
        );
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.clear();
    }
}
