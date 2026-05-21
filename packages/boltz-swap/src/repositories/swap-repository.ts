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

interface SwapShape {
    id: string;
    status: string;
    type: string;
}

interface OrderableSwapShape {
    createdAt: number;
}

// An empty array filter on id/status/type cannot match anything; backends use
// this to short-circuit before issuing a query.
export function hasImpossibleSwapsFilter(filter?: GetSwapsFilter): boolean {
    if (!filter) return false;
    return (
        (Array.isArray(filter.id) && filter.id.length === 0) ||
        (Array.isArray(filter.status) && filter.status.length === 0) ||
        (Array.isArray(filter.type) && filter.type.length === 0)
    );
}

function matchesCriterion<V>(value: V, criterion: V | V[] | undefined): boolean {
    if (criterion === undefined) return true;
    return Array.isArray(criterion) ? criterion.includes(value) : value === criterion;
}

export function applySwapsFilter<T extends SwapShape>(
    swaps: (T | undefined)[],
    filter: GetSwapsFilter,
): T[] {
    return swaps.filter(
        (swap): swap is T =>
            !!swap &&
            matchesCriterion(swap.id, filter.id) &&
            matchesCriterion(swap.status, filter.status) &&
            matchesCriterion(swap.type, filter.type),
    );
}

export function applyCreatedAtOrder<T extends OrderableSwapShape>(
    swaps: T[],
    filter?: GetSwapsFilter,
): T[] {
    if (filter?.orderBy !== "createdAt") return swaps;
    const direction = filter.orderDirection === "asc" ? 1 : -1;
    return swaps.slice().sort((a, b) => (a.createdAt - b.createdAt) * direction);
}
