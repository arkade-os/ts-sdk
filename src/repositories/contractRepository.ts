import { Contract, ContractState } from "../contracts/types";

/**
 * Filter options for querying contracts.
 */
export interface ContractFilter {
    /** Filter by contract ID */
    id?: string;
    /** Filter by multiple contract IDs */
    ids?: string[];
    /** Filter by script */
    script?: string;
    /** Filter by state(s) */
    state?: ContractState | ContractState[];
    /** Filter by contract type */
    type?: string;
    /** Filter by multiple contract types */
    types?: string[];
}

/** Storage key for the contracts collection */
export const CONTRACTS_COLLECTION = "ark_contracts";

export interface ContractRepository extends AsyncDisposable {
    // Generic contract metadata (for SDK users like boltz-swap)
    getContractData<T>(contractId: string, key: string): Promise<T | null>;
    setContractData<T>(contractId: string, key: string, data: T): Promise<void>;
    deleteContractData(contractId: string, key: string): Promise<void>;
    clearContractData(): Promise<void>;

    // Contract collections (following boltz-swap pattern) - with type-safe id fields
    getContractCollection<T>(contractType: string): Promise<ReadonlyArray<T>>;
    saveToContractCollection<T, K extends keyof T>(
        contractType: string,
        item: T,
        idField: K
    ): Promise<void>;
    removeFromContractCollection<T, K extends keyof T>(
        contractType: string,
        id: T[K],
        idField: K
    ): Promise<void>;

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
     * Delete a contract by ID.
     */
    deleteContract(id: string): Promise<void>;
}
