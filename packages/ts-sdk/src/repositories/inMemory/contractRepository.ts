import { ContractFilter, ContractRepository } from "../contractRepository";
import { Contract, watchStateOf } from "../../contracts";
import { assertPageRequest, pageResult, type PageRequest, type PageResult } from "../page";

/**
 * In-memory implementation of ContractRepository.
 * Data is ephemeral and scoped to the instance.
 */
export class InMemoryContractRepository implements ContractRepository {
    readonly version = 2 as const;
    private readonly contractData = new Map<string, unknown>();
    private readonly collections = new Map<string, unknown[]>();
    private readonly contractsByScript = new Map<string, Contract>();

    async clear(): Promise<void> {
        this.contractData.clear();
        this.collections.clear();
        this.contractsByScript.clear();
    }

    async getContractsPage(
        filter: ContractFilter | undefined,
        page: PageRequest,
    ): Promise<PageResult<Contract>> {
        assertPageRequest(page);
        const matches = <T>(value: T, criterion?: T | T[]) =>
            criterion === undefined ||
            (Array.isArray(criterion) ? criterion.includes(value) : value === criterion);
        const rows = [...this.contractsByScript.values()]
            .filter((contract) => page.after === undefined || contract.script > page.after)
            .filter(
                (contract) =>
                    !filter ||
                    (matches(contract.script, filter.script) &&
                        matches(contract.state, filter.state) &&
                        matches(contract.type, filter.type) &&
                        matches(watchStateOf(contract), filter.watch)),
            )
            .sort((a, b) => (a.script < b.script ? -1 : a.script > b.script ? 1 : 0))
            .slice(0, page.limit + 1);
        return pageResult(rows, page.limit, (contract) => contract.script);
    }

    async saveContract(contract: Contract): Promise<void> {
        this.contractsByScript.set(contract.script, contract);
    }

    async deleteContract(script: string): Promise<void> {
        this.contractsByScript.delete(script);
    }

    async [Symbol.asyncDispose](): Promise<void> {
        // nothing to dispose, data is ephemeral and scoped to the instance
        return;
    }
}
