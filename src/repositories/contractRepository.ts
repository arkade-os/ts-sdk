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
}
