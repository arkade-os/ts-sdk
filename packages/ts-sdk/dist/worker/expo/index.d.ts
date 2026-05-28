import { T as TaskProcessor } from '../../taskRunner-BE_kKvy-.js';
export { C as CreateTaskDependenciesOptions, I as InMemoryTaskQueue, a as TaskDependencies, b as TaskItem, c as TaskQueue, d as TaskResult, e as createTaskDependencies, r as runTasks } from '../../taskRunner-BE_kKvy-.js';
export { A as AsyncStorageLike, a as AsyncStorageTaskQueue } from '../../asyncStorageTaskQueue-CoCB9Woa.js';
import '../../ark-loKbOrJY.js';
import '@scure/btc-signer/transaction.js';
import '@scure/btc-signer/utils.js';
import '@scure/btc-signer/psbt.js';
import '@scure/btc-signer';

declare const CONTRACT_POLL_TASK_TYPE = "contract-poll";
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
declare const contractPollProcessor: TaskProcessor;

export { CONTRACT_POLL_TASK_TYPE, TaskProcessor, contractPollProcessor };
