import type { TaskItem, TaskResult } from "../taskQueue";
import type { TaskProcessor, TaskDependencies } from "../taskRunner";
import type { ExtendedVirtualCoin } from "../../../wallet";

export const CONTRACT_POLL_TASK_TYPE = "contract-poll";

/**
 * Polls the indexer for the latest VTXO state of every contract and
 * persists the results to the wallet repository.
 *
 * Replicates the polling subset of {@link ContractManager.initialize}:
 * 1. Load all contracts from the contract repository.
 * 2. Mark expired active contracts as inactive.
 * 3. Paginated fetch of spendable VTXOs from the indexer.
 * 4. Extend each VTXO with tapscript data.
 * 5. Save to the wallet repository.
 */
export const contractPollProcessor: TaskProcessor = {
    taskType: CONTRACT_POLL_TASK_TYPE,

    async execute(
        item: TaskItem,
        deps: TaskDependencies
    ): Promise<Omit<TaskResult, "id" | "executedAt">> {
        const {
            contractRepository,
            walletRepository,
            indexerProvider,
            extendVtxo,
        } = deps;

        const contracts = await contractRepository.getContracts();
        const now = Date.now();
        let contractsProcessed = 0;
        let vtxosSaved = 0;

        for (const contract of contracts) {
            // Mark expired active contracts as inactive
            if (
                contract.state === "active" &&
                contract.expiresAt &&
                contract.expiresAt <= now
            ) {
                contract.state = "inactive";
                await contractRepository.saveContract(contract);
            }

            // Paginated fetch of spendable VTXOs
            const pageSize = 100;
            let pageIndex = 0;
            let hasMore = true;
            const allVtxos: ExtendedVirtualCoin[] = [];

            while (hasMore) {
                const { vtxos, page } = await indexerProvider.getVtxos({
                    scripts: [contract.script],
                    spendableOnly: true,
                    pageIndex,
                    pageSize,
                });

                for (const vtxo of vtxos) {
                    allVtxos.push(extendVtxo(vtxo, contract));
                }

                hasMore = page ? vtxos.length === pageSize : false;
                pageIndex++;
            }

            await walletRepository.saveVtxos(contract.address, allVtxos);
            vtxosSaved += allVtxos.length;
            contractsProcessed++;
        }

        return {
            taskItemId: item.id,
            type: CONTRACT_POLL_TASK_TYPE,
            status: "success",
            data: { contractsProcessed, vtxosSaved },
        };
    },
};
