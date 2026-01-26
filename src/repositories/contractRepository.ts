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
    /** Filter by state */
    state?: ContractState;
    /** Filter by multiples states */
    states?: ContractState[];
    /** Filter by contract type */
    type?: string;
    /** Filter by multiple contract types */
    types?: string[];
}

/** Storage key for the contracts collection */
export const CONTRACTS_COLLECTION = "ark_contracts";

export interface ContractRepository extends AsyncDisposable {
    /**
     * @deprecated Use getContracts instead, this was done for boltz-swap compatibility.
     */
    getContractData<T>(contractId: string, key: string): Promise<T | null>;
    /**
     * @deprecated Use saveContract instead, this was done for boltz-swap compatibility.
     */
    setContractData<T>(contractId: string, key: string, data: T): Promise<void>;

    /**
     * @deprecated Use deleteContract instead, this was done for boltz-swap compatibility.
     */
    deleteContractData(contractId: string, key: string): Promise<void>;

    clearContractData(): Promise<void>;

    /**
     * @deprecated Use getContracts instead, this was done for boltz-swap compatibility.
     */
    getContractCollection<T>(contractType: string): Promise<ReadonlyArray<T>>;

    /**
     * @deprecated Use saveContract instead, this was done for boltz-swap compatibility.
     */
    saveToContractCollection<T, K extends keyof T>(
        contractType: string,
        item: T,
        idField: K
    ): Promise<void>;

    /**
     * @deprecated Use deleteContract instead, this was done for boltz-swap compatibility.
     */
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
