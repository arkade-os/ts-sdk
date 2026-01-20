import { ContractRepository } from "../contractRepository";

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

    async [Symbol.asyncDispose](): Promise<void> {
        // nothing to dispose, data is ephemeral and scoped to the instance
        return;
    }
}
