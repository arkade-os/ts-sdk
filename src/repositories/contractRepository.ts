import { StorageAdapter } from "../storage";
import { Contract, ContractState, ContractVtxo } from "../contracts/types";

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
    // Contract entity management (for Ark contracts with addresses)
    /**
     * Get all stored contracts.
     */
    getContracts(): Promise<Contract[]>;

    /**
     * Get contracts filtered by state.
     */
    getContractsByState(state: ContractState): Promise<Contract[]>;

    /**
     * Get a contract by ID.
     */
    getContractById(id: string): Promise<Contract | null>;

    /**
     * Get a contract by its script.
     */
    getContractByScript(script: string): Promise<Contract | null>;

    /**
     * Save or update a contract.
     */
    saveContract(contract: Contract): Promise<void>;

    /**
     * Delete a contract by ID.
     */
    deleteContract(id: string): Promise<void>;

    /**
     * Update a contract's state.
     */
    updateContractState(id: string, state: ContractState): Promise<void>;

    /**
     * Update a contract's runtime data.
     */
    updateContractData(id: string, data: Record<string, string>): Promise<void>;

    // VTXO management for contracts

    /**
     * Get cached VTXOs for a contract.
     */
    getContractVtxos(contractId: string): Promise<ContractVtxo[]>;

    /**
     * Save VTXOs for a contract.
     */
    saveContractVtxos(contractId: string, vtxos: ContractVtxo[]): Promise<void>;

    /**
     * Clear VTXOs for a contract.
     */
    clearContractVtxos(contractId: string): Promise<void>;
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

    async getContracts(): Promise<Contract[]> {
        const contracts =
            await this.getContractCollection<Contract>(CONTRACTS_COLLECTION);
        return [...contracts];
    }

    async getContractsByState(state: ContractState): Promise<Contract[]> {
        const contracts = await this.getContracts();
        return contracts.filter((c) => c.state === state);
    }

    async getContractById(id: string): Promise<Contract | null> {
        const contracts = await this.getContracts();
        return contracts.find((c) => c.id === id) || null;
    }

    async getContractByScript(script: string): Promise<Contract | null> {
        const contracts = await this.getContracts();
        return contracts.find((c) => c.script === script) || null;
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

    async updateContractState(id: string, state: ContractState): Promise<void> {
        const contract = await this.getContractById(id);
        if (!contract) {
            throw new Error(`Contract ${id} not found`);
        }

        const updated: Contract = { ...contract, state };
        await this.saveContract(updated);
    }

    async updateContractData(
        id: string,
        data: Record<string, string>
    ): Promise<void> {
        const contract = await this.getContractById(id);
        if (!contract) {
            throw new Error(`Contract ${id} not found`);
        }

        const updated: Contract = {
            ...contract,
            data: {
                ...contract.data,
                ...data,
            },
        };
        await this.saveContract(updated);
    }

    // VTXO management methods

    async getContractVtxos(contractId: string): Promise<ContractVtxo[]> {
        const stored = await this.storage.getItem(
            getContractStorageKey(contractId, "vtxos")
        );
        if (!stored) return [];

        try {
            return JSON.parse(stored) as ContractVtxo[];
        } catch (error) {
            console.error(
                `Failed to parse VTXOs for contract ${contractId}:`,
                error
            );
            return [];
        }
    }

    async saveContractVtxos(
        contractId: string,
        vtxos: ContractVtxo[]
    ): Promise<void> {
        try {
            await this.storage.setItem(
                getContractStorageKey(contractId, "vtxos"),
                JSON.stringify(vtxos)
            );
        } catch (error) {
            console.error(
                `Failed to persist VTXOs for contract ${contractId}:`,
                error
            );
            throw error;
        }
    }

    async clearContractVtxos(contractId: string): Promise<void> {
        try {
            await this.storage.removeItem(
                getContractStorageKey(contractId, "vtxos")
            );
        } catch (error) {
            console.error(
                `Failed to clear VTXOs for contract ${contractId}:`,
                error
            );
            throw error;
        }
    }
}
