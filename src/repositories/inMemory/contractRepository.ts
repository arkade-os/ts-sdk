import {
    ContractFilter,
    ContractRepository,
    CONTRACTS_COLLECTION,
} from "../contractRepository";
import { Contract } from "../../contracts";

const contractKey = (contractId: string, key: string) =>
    `contract:${contractId}:${key}`;

/**
 * In-memory implementation of ContractRepository.
 * Data is ephemeral and scoped to the instance.
 */
export class InMemoryContractRepository implements ContractRepository {
    private readonly contractData = new Map<string, unknown>();
    private readonly collections = new Map<string, unknown[]>();

    async getContractData<T>(
        contractId: string,
        key: string
    ): Promise<T | null> {
        const value = this.contractData.get(contractKey(contractId, key));
        return (value as T | undefined) ?? null;
    }

    async setContractData<T>(
        contractId: string,
        key: string,
        data: T
    ): Promise<void> {
        this.contractData.set(contractKey(contractId, key), data);
    }

    async deleteContractData(contractId: string, key: string): Promise<void> {
        this.contractData.delete(contractKey(contractId, key));
    }

    async clearContractData(): Promise<void> {
        this.contractData.clear();
        this.collections.clear();
    }

    async getContractCollection<T>(
        contractType: string
    ): Promise<ReadonlyArray<T>> {
        return (this.collections.get(contractType) as T[] | undefined) ?? [];
    }

    async saveToContractCollection<T, K extends keyof T>(
        contractType: string,
        item: T,
        idField: K
    ): Promise<void> {
        const itemId = item[idField];
        if (itemId === undefined || itemId === null) {
            throw new Error(
                `Item is missing required field '${String(idField)}'`
            );
        }

        const existing = (this.collections.get(contractType) as T[]) ?? [];
        const existingIndex = existing.findIndex((i) => i[idField] === itemId);
        const next =
            existingIndex !== -1
                ? existing.map((entry, index) =>
                      index === existingIndex ? item : entry
                  )
                : [...existing, item];
        this.collections.set(contractType, next);
    }

    async removeFromContractCollection<T, K extends keyof T>(
        contractType: string,
        id: T[K],
        idField: K
    ): Promise<void> {
        if (id === undefined || id === null) {
            throw new Error(`Invalid id provided for removal: ${String(id)}`);
        }

        const existing = (this.collections.get(contractType) as T[]) ?? [];
        const next = existing.filter((item) => item[idField] !== id);
        this.collections.set(contractType, next);
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

            // Filter by states
            if (
                filter.states !== undefined &&
                !filter.states.includes(c.state)
            ) {
                return false;
            }

            // Filter by state
            if (filter.state !== undefined && filter.state !== c.state) {
                return false;
            }

            if (filter.type !== undefined && filter.type !== c.type) {
                return false;
            }

            if (filter.types !== undefined && !filter.types.includes(c.type)) {
                return false;
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

    async [Symbol.asyncDispose](): Promise<void> {
        // nothing to dispose, data is ephemeral and scoped to the instance
        return;
    }
}
