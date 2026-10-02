import { Contract, ContractState, ContractWatchState } from "../contracts/types";
import { collectPages, type PageRequest, type PageResult } from "./page";

/**
 * Filter options for querying contracts.
 */
export interface ContractFilter {
    /** Filter by script(s) */
    script?: string | string[];
    /** Filter by state(s) */
    state?: ContractState | ContractState[];
    /** Filter by contract type(s) */
    type?: string | string[];
    /**
     * Filter by watch state(s). Rows written before the field existed
     * have no stored value and match `"watched"`.
     * @see ContractWatchState
     */
    watch?: ContractWatchState | ContractWatchState[];
}

export interface ContractRepository extends AsyncDisposable {
    /**
     * 2 — {@link Contract.watch}. An implementation must persist and
     * round-trip it, and treat a row without one as `"watched"`.
     */
    readonly version: 2;

    /**
     * Clear all data from storage.
     */
    clear(): Promise<void>;

    /** Bounded contracts in script order; `after` is exclusive. */
    getContractsPage(
        filter: ContractFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<Contract>>;

    /**
     * Save or update a contract.
     */
    saveContract(contract: Contract): Promise<void>;

    /**
     * Delete a contract by script.
     */
    deleteContract(script: string): Promise<void>;
}

/** No row satisfies an empty array, so a backend building a predicate must
 * short-circuit rather than omit the clause and match everything. */
export function contractFilterMatchesNothing(filter?: ContractFilter): boolean {
    return [filter?.script, filter?.state, filter?.type, filter?.watch].some(
        (value) => Array.isArray(value) && value.length === 0,
    );
}

export const collectContracts = (
    repository: Pick<ContractRepository, "getContractsPage">,
    filter?: ContractFilter,
) => collectPages((page: PageRequest) => repository.getContractsPage(filter, page));
