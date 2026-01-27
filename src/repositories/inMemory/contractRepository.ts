import { ContractFilter, ContractRepository } from "../contractRepository";
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
    private readonly contractsById = new Map<string, Contract>();

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

    async clear(): Promise<void> {
        this.contractData.clear();
        this.collections.clear();
        this.contractsById.clear();
    }

    // Contract entity management methods

    async getContracts(filter?: ContractFilter): Promise<Contract[]> {
        const contracts = this.contractsById.values();

        if (!filter) {
            return [...contracts];
        }

        const matches = <T>(value: T, criterion?: T | T[]) => {
            if (criterion === undefined) {
                return true;
            }
            return Array.isArray(criterion)
                ? criterion.includes(value)
                : value === criterion;
        };

        const results: Contract[] = [];
        for (const contract of contracts) {
            if (
                matches(contract.id, filter.id) &&
                matches(contract.script, filter.script) &&
                matches(contract.state, filter.state) &&
                matches(contract.type, filter.type)
            ) {
                results.push(contract);
            }
        }
        return results;
    }

    async saveContract(contract: Contract): Promise<void> {
        this.contractsById.set(contract.id, contract);
    }

    async deleteContract(id: string): Promise<void> {
        this.contractsById.delete(id);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // nothing to dispose, data is ephemeral and scoped to the instance
        return;
    }
}
