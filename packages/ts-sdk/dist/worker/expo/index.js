export { CONTRACT_POLL_TASK_TYPE, contractPollProcessor, createTaskDependencies, runTasks } from '../../chunk-4IDL2623.js';
import '../../chunk-PX4JLJW7.js';
import '../../chunk-DODG3PG2.js';
import '../../chunk-BUGGGM2S.js';
import '../../chunk-HAYJZIA4.js';
import '../../chunk-NSBPE2FW.js';

// src/worker/expo/taskQueue.ts
var InMemoryTaskQueue = class {
  inbox = /* @__PURE__ */ new Map();
  outbox = /* @__PURE__ */ new Map();
  async addTask(task) {
    this.inbox.set(task.id, task);
  }
  async removeTask(id) {
    this.inbox.delete(id);
  }
  async getTasks(type) {
    const tasks = Array.from(this.inbox.values());
    if (type) {
      return tasks.filter((t) => t.type === type);
    }
    return tasks;
  }
  async clearTasks() {
    this.inbox.clear();
  }
  async pushResult(result) {
    this.outbox.set(result.id, result);
  }
  async getResults() {
    return Array.from(this.outbox.values());
  }
  async acknowledgeResults(ids) {
    for (const id of ids) {
      this.outbox.delete(id);
    }
  }
};

// src/worker/expo/asyncStorageTaskQueue.ts
var AsyncStorageTaskQueue = class {
  constructor(storage, prefix = "ark:task-queue") {
    this.storage = storage;
    this.inboxKey = `${prefix}:inbox`;
    this.outboxKey = `${prefix}:outbox`;
    this.configKey = `${prefix}:config`;
  }
  inboxKey;
  outboxKey;
  configKey;
  // ── Inbox ────────────────────────────────────────────────────────
  async addTask(task) {
    const tasks = await this.readList(this.inboxKey);
    tasks.push(task);
    await this.writeList(this.inboxKey, tasks);
  }
  async removeTask(id) {
    const tasks = await this.readList(this.inboxKey);
    await this.writeList(
      this.inboxKey,
      tasks.filter((t) => t.id !== id)
    );
  }
  async getTasks(type) {
    const tasks = await this.readList(this.inboxKey);
    if (type) {
      return tasks.filter((t) => t.type === type);
    }
    return tasks;
  }
  async clearTasks() {
    await this.storage.removeItem(this.inboxKey);
  }
  // ── Outbox ───────────────────────────────────────────────────────
  async pushResult(result) {
    const results = await this.readList(this.outboxKey);
    results.push(result);
    await this.writeList(this.outboxKey, results);
  }
  async getResults() {
    return this.readList(this.outboxKey);
  }
  async acknowledgeResults(ids) {
    const idSet = new Set(ids);
    const results = await this.readList(this.outboxKey);
    await this.writeList(
      this.outboxKey,
      results.filter((r) => !idSet.has(r.id))
    );
  }
  // ── Config persistence (for background handler rehydration) ──────
  /**
   * Persist a config blob alongside the queue data.
   * Used by @see ExpoWallet.setup to store the wallet parameters
   * that the background handler needs to reconstruct providers.
   */
  async persistConfig(config) {
    await this.storage.setItem(this.configKey, JSON.stringify(config));
  }
  /**
   * Load the persisted config blob.
   * Used by the background handler to rehydrate wallet dependencies.
   */
  async loadConfig() {
    const raw = await this.storage.getItem(this.configKey);
    return raw ? JSON.parse(raw) : null;
  }
  // ── Helpers ──────────────────────────────────────────────────────
  async readList(key) {
    const raw = await this.storage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  }
  async writeList(key, list) {
    await this.storage.setItem(key, JSON.stringify(list));
  }
};

export { AsyncStorageTaskQueue, InMemoryTaskQueue };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map