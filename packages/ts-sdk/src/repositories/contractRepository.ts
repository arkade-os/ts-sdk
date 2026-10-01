import { Contract, ContractScope, ContractState, ContractWatchState } from "../contracts/types";

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
    /**
     * Filter by scope(s). Rows without a stored scope resolve via
     * `scopeOf`.
     */
    scope?: ContractScope | ContractScope[];
}

export interface ContractRepository extends AsyncDisposable {
    /**
     * 2 — {@link Contract.watch}. An implementation must persist and
     * round-trip it, and treat a row without one as `"watched"`.
     *
     * 3 — {@link Contract.scope}. Persist and round-trip it; a row without
     * one resolves via {@link scopeOf}.
     */
    readonly version: 3;

    /**
     * Clear all data from storage.
     */
    clear(): Promise<void>;

    /**
     * Get contracts with optional filter.
     * Returns all contracts if no filter provided.
     */
    getContracts(filter?: ContractFilter): Promise<Contract[]>;

    /**
     * Save or update a contract.
     */
    saveContract(contract: Contract): Promise<void>;

    /**
     * Delete a contract by script.
     */
    deleteContract(script: string): Promise<void>;
}
