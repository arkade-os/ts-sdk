import { contractPollProcessor, createTaskDependencies, runTasks, CONTRACT_POLL_TASK_TYPE } from '../../chunk-4IDL2623.js';
import { ExpoIndexerProvider, ExpoArkProvider } from '../../chunk-DJTXHUIQ.js';
import { getRandomId } from '../../chunk-PX4JLJW7.js';
import '../../chunk-DODG3PG2.js';
import '../../chunk-BUGGGM2S.js';
import '../../chunk-HAYJZIA4.js';
import '../../chunk-NSBPE2FW.js';
import * as TaskManager from 'expo-task-manager';
import * as BackgroundTask from 'expo-background-task';

function defineExpoBackgroundTask(taskName, options) {
  const {
    taskQueue,
    walletRepository,
    contractRepository,
    processors = [contractPollProcessor]
  } = options;
  TaskManager.defineTask(taskName, async () => {
    try {
      const config = await taskQueue.loadConfig();
      if (!config) {
        return BackgroundTask.BackgroundTaskResult.Success;
      }
      const indexerProvider = new ExpoIndexerProvider(config.arkServerUrl);
      const arkProvider = new ExpoArkProvider(config.arkServerUrl);
      const deps = createTaskDependencies({
        walletRepository,
        contractRepository,
        indexerProvider,
        arkProvider
      });
      await runTasks(taskQueue, processors, deps);
      const results = await taskQueue.getResults();
      if (results.length > 0) {
        await taskQueue.acknowledgeResults(results.map((r) => r.id));
      }
      const existing = await taskQueue.getTasks(CONTRACT_POLL_TASK_TYPE);
      if (existing.length === 0) {
        const task = {
          id: getRandomId(),
          type: CONTRACT_POLL_TASK_TYPE,
          data: {},
          createdAt: Date.now()
        };
        await taskQueue.addTask(task);
      }
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch (error) {
      console.error(
        "[ark-sdk] Background task failed:",
        error instanceof Error ? error.message : error
      );
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}
async function registerExpoBackgroundTask(taskName, options) {
  await BackgroundTask.registerTaskAsync(taskName, {
    minimumInterval: (options?.minimumInterval ?? 15) * 60
  });
}
async function unregisterExpoBackgroundTask(taskName) {
  await BackgroundTask.unregisterTaskAsync(taskName);
}

export { defineExpoBackgroundTask, registerExpoBackgroundTask, unregisterExpoBackgroundTask };
//# sourceMappingURL=background.js.map
//# sourceMappingURL=background.js.map