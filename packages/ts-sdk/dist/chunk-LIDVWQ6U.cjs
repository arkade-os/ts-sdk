'use strict';

var chunkGVJ5NNTJ_cjs = require('./chunk-GVJ5NNTJ.cjs');

// src/worker/expo/taskRunner.ts
async function runTasks(queue, processors, deps) {
  const tasks = await queue.getTasks();
  const processorMap = new Map(processors.map((p) => [p.taskType, p]));
  const results = [];
  for (const task of tasks) {
    const processor = processorMap.get(task.type);
    let partial;
    if (!processor) {
      partial = {
        taskItemId: task.id,
        type: task.type,
        status: "noop"
      };
    } else {
      try {
        partial = await processor.execute(task, deps);
      } catch (error) {
        partial = {
          taskItemId: task.id,
          type: task.type,
          status: "failed",
          data: {
            error: error instanceof Error ? error.message : String(error)
          }
        };
      }
    }
    const result = {
      ...partial,
      id: chunkGVJ5NNTJ_cjs.getRandomId(),
      executedAt: Date.now()
    };
    await queue.pushResult(result);
    await queue.removeTask(task.id);
    results.push(result);
  }
  return results;
}
function createTaskDependencies(options) {
  return {
    ...options,
    extendVtxo: (vtxo, contract) => chunkGVJ5NNTJ_cjs.extendVirtualCoinForContract(vtxo, contract)
  };
}

// src/worker/expo/processors/contractPollProcessor.ts
var CONTRACT_POLL_TASK_TYPE = "contract-poll";
var contractPollProcessor = {
  taskType: CONTRACT_POLL_TASK_TYPE,
  async execute(item, deps) {
    const { contractRepository, walletRepository, indexerProvider, extendVtxo } = deps;
    const contracts = await contractRepository.getContracts();
    let contractsProcessed = 0;
    let vtxosSaved = 0;
    for (const contract of contracts) {
      const pageSize = 100;
      let pageIndex = 0;
      let hasMore = true;
      const allVtxos = [];
      while (hasMore) {
        const { vtxos, page } = await indexerProvider.getVtxos({
          scripts: [contract.script],
          pageIndex,
          pageSize
        });
        for (const vtxo of vtxos) {
          allVtxos.push(extendVtxo(vtxo, contract));
        }
        hasMore = page ? vtxos.length === pageSize : false;
        pageIndex++;
      }
      const filtered = chunkGVJ5NNTJ_cjs.warnAndFilterVtxosForScript(
        allVtxos,
        contract.script,
        "contractPollProcessor"
      );
      await chunkGVJ5NNTJ_cjs.saveVtxosForContract(walletRepository, contract, filtered);
      vtxosSaved += filtered.length;
      contractsProcessed++;
    }
    return {
      taskItemId: item.id,
      type: CONTRACT_POLL_TASK_TYPE,
      status: "success",
      data: { contractsProcessed, vtxosSaved }
    };
  }
};

exports.CONTRACT_POLL_TASK_TYPE = CONTRACT_POLL_TASK_TYPE;
exports.contractPollProcessor = contractPollProcessor;
exports.createTaskDependencies = createTaskDependencies;
exports.runTasks = runTasks;
//# sourceMappingURL=chunk-LIDVWQ6U.cjs.map
//# sourceMappingURL=chunk-LIDVWQ6U.cjs.map