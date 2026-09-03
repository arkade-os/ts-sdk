/**
 * A task item represents a unit of work in the inbox.
 */
export interface TaskItem {
    id: string;
    type: string;
    data: Record<string, unknown>;
    createdAt: number;
}

/**
 * A task result represents the outcome of processing a task item.
 */
export interface TaskResult {
    id: string;
    taskItemId: string;
    type: string;
    status: "success" | "failed" | "noop";
    data?: Record<string, unknown>;
    executedAt: number;
}

/**
 * Persistence layer for handing off work between foreground and background.
 *
 * - **Inbox**: tasks waiting to be processed.
 * - **Outbox**: results produced by processors, waiting to be consumed.
 */
export interface TaskQueue {
    // Inbox
    addTask(task: TaskItem): Promise<void>;
    removeTask(id: string): Promise<void>;
    getTasks(type?: string): Promise<TaskItem[]>;
    clearTasks(): Promise<void>;

    // Outbox
    pushResult(result: TaskResult): Promise<void>;
    getResults(): Promise<TaskResult[]>;
    acknowledgeResults(ids: string[]): Promise<void>;
}

/**
 * In-memory TaskQueue for testing and lightweight use.
 * State is lost when the process exits.
 */
export class InMemoryTaskQueue implements TaskQueue {
    private inbox = new Map<string, TaskItem>();
    private outbox = new Map<string, TaskResult>();

    async addTask(task: TaskItem): Promise<void> {
        this.inbox.set(task.id, task);
    }

    async removeTask(id: string): Promise<void> {
        this.inbox.delete(id);
    }

    async getTasks(type?: string): Promise<TaskItem[]> {
        const tasks = Array.from(this.inbox.values());
        if (type) {
            return tasks.filter((t) => t.type === type);
        }
        return tasks;
    }

    async clearTasks(): Promise<void> {
        this.inbox.clear();
    }

    async pushResult(result: TaskResult): Promise<void> {
        this.outbox.set(result.id, result);
    }

    async getResults(): Promise<TaskResult[]> {
        return Array.from(this.outbox.values());
    }

    async acknowledgeResults(ids: string[]): Promise<void> {
        for (const id of ids) {
            this.outbox.delete(id);
        }
    }
}
