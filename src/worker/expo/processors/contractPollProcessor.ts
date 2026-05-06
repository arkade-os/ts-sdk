import type { TaskItem, TaskResult } from "../taskQueue";
import type { TaskProcessor, TaskDependencies } from "../taskRunner";
import type { ExtendedVirtualCoin } from "../../../wallet";
import {
    warnAndFilterVtxosForScript,
    saveVtxosForContract,
} from "../../../contracts/vtxoOwnership";

export const CONTRACT_POLL_TASK_TYPE = "contract-poll";

/**
 * Polls the indexer for the latest VTXO state of every contract and
 * persists the results to the wallet repository.
 *
 * Replicates the polling subset of @see ContractManager.initialize:
 * 1. Load all contracts from the contract repository.
 * 2. Paginated fetch of every VTXO (including spent) from the indexer.
 * 3. Extend each VTXO with tapscript data.
 * 4. Save to the wallet repository.
 *
 * NOTE: the indexer query deliberately omits `spendableOnly`. Every
 * repository implements `saveVtxos` as an upsert with no batch delete,
 * so filtering to spendable-only would leave VTXOs that became spent
 * between polls marked as spendable forever. Fetching the full set lets
 * the upsert overwrite stale records with their latest state.
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
        let contractsProcessed = 0;
        let vtxosSaved = 0;

        for (const contract of contracts) {
            // Paginated fetch of spendable virtual outputs
            const pageSize = 100;
            let pageIndex = 0;
            let hasMore = true;
            const allVtxos: ExtendedVirtualCoin[] = [];

            while (hasMore) {
                const { vtxos, page } = await indexerProvider.getVtxos({
                    scripts: [contract.script],
                    pageIndex,
                    pageSize,
                });

                for (const vtxo of vtxos) {
                    allVtxos.push(extendVtxo(vtxo, contract));
                }

                hasMore = page ? vtxos.length === pageSize : false;
                pageIndex++;
            }

            // Skip wrong-script rows (legacy duplicates or indexer drift)
            // before persisting; the loop must keep going for the remaining
            // contracts even when one row is rejected.
            const filtered = warnAndFilterVtxosForScript(
                allVtxos,
                contract.script,
                "contractPollProcessor"
            );
            await saveVtxosForContract(walletRepository, contract, filtered);
            vtxosSaved += filtered.length;
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
