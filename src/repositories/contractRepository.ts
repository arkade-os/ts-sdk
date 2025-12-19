import { StorageAdapter } from "../storage";
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
}

const getContractStorageKey = (id: string, key: string) =>
    `contract:${id}:${key}`;
const getCollectionStorageKey = (type: string) => `collection:${type}`;

/** Storage key for the contracts collection */
const CONTRACTS_COLLECTION = "ark_contracts";

export interface ContractRepository {
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

/**
 * Extended repository interface for ContractManager functionality.
 * Implementations must provide these methods to use ContractManager.
 */
export interface ContractManagerRepository extends ContractRepository {
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

export class ContractRepositoryImpl implements ContractManagerRepository {
    private storage: StorageAdapter;

    constructor(storage: StorageAdapter) {
        this.storage = storage;
    }

    async getContractData<T>(
        contractId: string,
        key: string
    ): Promise<T | null> {
        const stored = await this.storage.getItem(
            getContractStorageKey(contractId, key)
        );
        if (!stored) return null;

        try {
            const data = JSON.parse(stored) as T;
            return data;
        } catch (error) {
            console.error(
                `Failed to parse contract data for ${contractId}:${key}:`,
                error
            );
            return null;
        }
    }

    async setContractData<T>(
        contractId: string,
        key: string,
        data: T
    ): Promise<void> {
        try {
            await this.storage.setItem(
                getContractStorageKey(contractId, key),
                JSON.stringify(data)
            );
        } catch (error) {
            console.error(
                `Failed to persist contract data for ${contractId}:${key}:`,
                error
            );
            throw error; // Rethrow to notify caller of failure
        }
    }

    async deleteContractData(contractId: string, key: string): Promise<void> {
        try {
            await this.storage.removeItem(
                getContractStorageKey(contractId, key)
            );
        } catch (error) {
            console.error(
                `Failed to remove contract data for ${contractId}:${key}:`,
                error
            );
            throw error; // Rethrow to notify caller of failure
        }
    }

    async getContractCollection<T>(
        contractType: string
    ): Promise<ReadonlyArray<T>> {
        const stored = await this.storage.getItem(
            getCollectionStorageKey(contractType)
        );
        if (!stored) return [];

        try {
            const collection = JSON.parse(stored) as T[];
            return collection;
        } catch (error) {
            console.error(
                `Failed to parse contract collection ${contractType}:`,
                error
            );
            return [];
        }
    }

    async saveToContractCollection<T, K extends keyof T>(
        contractType: string,
        item: T,
        idField: K
    ): Promise<void> {
        const collection = await this.getContractCollection<T>(contractType);

        // Validate that the item has the required id field
        const itemId = item[idField];
        if (itemId === undefined || itemId === null) {
            throw new Error(
                `Item is missing required field '${String(idField)}'`
            );
        }

        // Find existing item index without mutating the original collection
        const existingIndex = collection.findIndex(
            (i) => i[idField] === itemId
        );

        // Build new collection without mutating the cached one
        let newCollection: T[];
        if (existingIndex !== -1) {
            // Replace existing item
            newCollection = [
                ...collection.slice(0, existingIndex),
                item,
                ...collection.slice(existingIndex + 1),
            ];
        } else {
            // Add new item
            newCollection = [...collection, item];
        }

        try {
            await this.storage.setItem(
                getCollectionStorageKey(contractType),
                JSON.stringify(newCollection)
            );
        } catch (error) {
            console.error(
                `Failed to persist contract collection ${contractType}:`,
                error
            );
            throw error; // Rethrow to notify caller of failure
        }
    }

    async removeFromContractCollection<T, K extends keyof T>(
        contractType: string,
        id: T[K],
        idField: K
    ): Promise<void> {
        // Validate input parameters
        if (id === undefined || id === null) {
            throw new Error(`Invalid id provided for removal: ${String(id)}`);
        }

        const collection = await this.getContractCollection<T>(contractType);

        // Build new collection without the specified item
        const filtered = collection.filter((item) => item[idField] !== id);

        try {
            await this.storage.setItem(
                getCollectionStorageKey(contractType),
                JSON.stringify(filtered)
            );
        } catch (error) {
            console.error(
                `Failed to persist contract collection removal for ${contractType}:`,
                error
            );
            throw error; // Rethrow to notify caller of failure
        }
    }

    async clearContractData(): Promise<void> {
        await this.storage.clear();
    }

    // Contract entity management methods

    async getContracts(filter?: ContractFilter): Promise<Contract[]> {
        const contracts =
            await this.getContractCollection<Contract>(CONTRACTS_COLLECTION);

        if (!filter) {
            return [...contracts];
        }

        return contracts.filter((c) => {
            // Filter by ID
            if (filter.id !== undefined && c.id !== filter.id) {
                return false;
            }

            // Filter by multiple IDs
            if (filter.ids !== undefined && !filter.ids.includes(c.id)) {
                return false;
            }

            // Filter by script
            if (filter.script !== undefined && c.script !== filter.script) {
                return false;
            }

            // Filter by state(s)
            if (filter.state !== undefined) {
                const states = Array.isArray(filter.state)
                    ? filter.state
                    : [filter.state];
                if (!states.includes(c.state)) {
                    return false;
                }
            }

            return true;
        });
    }

    async saveContract(contract: Contract): Promise<void> {
        await this.saveToContractCollection(
            CONTRACTS_COLLECTION,
            contract,
            "id"
        );
    }

    async deleteContract(id: string): Promise<void> {
        await this.removeFromContractCollection<Contract, "id">(
            CONTRACTS_COLLECTION,
            id,
            "id"
        );
    }
}
