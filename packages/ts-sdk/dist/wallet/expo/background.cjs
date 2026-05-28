'use strict';

var chunkEEUWJXQS_cjs = require('../../chunk-EEUWJXQS.cjs');
var chunk2IJFJJDM_cjs = require('../../chunk-2IJFJJDM.cjs');
var chunkONLBFWK4_cjs = require('../../chunk-ONLBFWK4.cjs');
require('../../chunk-ISZA7V2J.cjs');
require('../../chunk-JH7WWDEA.cjs');
require('../../chunk-4QHMS5XH.cjs');
require('../../chunk-5BLDMQED.cjs');
var TaskManager = require('expo-task-manager');
var BackgroundTask = require('expo-background-task');

function _interopNamespace(e) {
  if (e && e.__esModule) return e;
  var n = Object.create(null);
  if (e) {
    Object.keys(e).forEach(function (k) {
      if (k !== 'default') {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: function () { return e[k]; }
        });
      }
    });
  }
  n.default = e;
  return Object.freeze(n);
}

var TaskManager__namespace = /*#__PURE__*/_interopNamespace(TaskManager);
var BackgroundTask__namespace = /*#__PURE__*/_interopNamespace(BackgroundTask);

function defineExpoBackgroundTask(taskName, options) {
  const {
    taskQueue,
    walletRepository,
    contractRepository,
    processors = [chunk2IJFJJDM_cjs.contractPollProcessor]
  } = options;
  TaskManager__namespace.defineTask(taskName, async () => {
    try {
      const config = await taskQueue.loadConfig();
      if (!config) {
        return BackgroundTask__namespace.BackgroundTaskResult.Success;
      }
      const indexerProvider = new chunkEEUWJXQS_cjs.ExpoIndexerProvider(config.arkServerUrl);
      const arkProvider = new chunkEEUWJXQS_cjs.ExpoArkProvider(config.arkServerUrl);
      const deps = chunk2IJFJJDM_cjs.createTaskDependencies({
        walletRepository,
        contractRepository,
        indexerProvider,
        arkProvider
      });
      await chunk2IJFJJDM_cjs.runTasks(taskQueue, processors, deps);
      const results = await taskQueue.getResults();
      if (results.length > 0) {
        await taskQueue.acknowledgeResults(results.map((r) => r.id));
      }
      const existing = await taskQueue.getTasks(chunk2IJFJJDM_cjs.CONTRACT_POLL_TASK_TYPE);
      if (existing.length === 0) {
        const task = {
          id: chunkONLBFWK4_cjs.getRandomId(),
          type: chunk2IJFJJDM_cjs.CONTRACT_POLL_TASK_TYPE,
          data: {},
          createdAt: Date.now()
        };
        await taskQueue.addTask(task);
      }
      return BackgroundTask__namespace.BackgroundTaskResult.Success;
    } catch (error) {
      console.error(
        "[ark-sdk] Background task failed:",
        error instanceof Error ? error.message : error
      );
      return BackgroundTask__namespace.BackgroundTaskResult.Failed;
    }
  });
}
async function registerExpoBackgroundTask(taskName, options) {
  await BackgroundTask__namespace.registerTaskAsync(taskName, {
    minimumInterval: (options?.minimumInterval ?? 15) * 60
  });
}
async function unregisterExpoBackgroundTask(taskName) {
  await BackgroundTask__namespace.unregisterTaskAsync(taskName);
}

exports.defineExpoBackgroundTask = defineExpoBackgroundTask;
exports.registerExpoBackgroundTask = registerExpoBackgroundTask;
exports.unregisterExpoBackgroundTask = unregisterExpoBackgroundTask;
//# sourceMappingURL=background.cjs.map
//# sourceMappingURL=background.cjs.map