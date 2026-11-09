import type { TaskFilter, TaskRecord, TaskStatus, TaskUsage } from "./task-types.ts";
import type { ResolvedProfile } from "../core/resolver.ts";
import { InProcessSubagentRunner } from "./session-runner.ts";

export interface TaskRegistryOptions {
  readonly maxGlobalConcurrent?: number | undefined;
}

export interface SpawnTaskOptions {
  readonly profile: ResolvedProfile;
  readonly task: string;
  readonly targetFiles?: readonly string[] | undefined;
  readonly parentTaskId?: string | undefined;
  readonly depth?: number | undefined;
  readonly timeoutSeconds?: number | undefined;
  readonly cwd?: string | undefined;
  readonly model?: string | undefined;
  readonly thinkingLevel?: import("../core/schema.ts").ThinkingLevel | undefined;
  readonly signal?: AbortSignal | undefined;
}

type TaskListener = (task: TaskRecord) => void;

export function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

export class TaskRegistry {
  private readonly _tasks: Map<string, TaskRecord> = new Map();
  private readonly _runners: Map<string, InProcessSubagentRunner> = new Map();
  private readonly _runnerPromises: Map<string, Promise<void>> = new Map();
  private readonly _abortControllers: Map<string, AbortController> = new Map();
  private readonly _listeners: Map<string, Set<TaskListener>> = new Map();
  private readonly _maxGlobalConcurrent: number;
  private _nextId = 1;

  public constructor(options?: TaskRegistryOptions) {
    this._maxGlobalConcurrent = options?.maxGlobalConcurrent ?? 4;
  }

  public getTask(id: string): TaskRecord | undefined {
    return this._tasks.get(id);
  }

  public listTasks(filter?: TaskFilter): TaskRecord[] {
    const all = Array.from(this._tasks.values());
    if (!filter) return all;

    return all.filter((t) => {
      if (filter.profileId && t.profileId !== filter.profileId) return false;
      if (filter.parentTaskId !== undefined && t.parentTaskId !== filter.parentTaskId) return false;
      if (filter.status) {
        if (Array.isArray(filter.status)) {
          if (!filter.status.includes(t.status)) return false;
        } else if (t.status !== filter.status) {
          return false;
        }
      }
      return true;
    });
  }

  public getRunningCount(profileId?: string): number {
    let count = 0;
    for (const t of this._tasks.values()) {
      if (t.status === "running") {
        if (!profileId || t.profileId === profileId) {
          count++;
        }
      }
    }
    return count;
  }

  public spawn(options: SpawnTaskOptions): TaskRecord {
    const profile = options.profile;
    const depth = options.depth ?? 0;

    // Check depth restriction
    const maxDepth = profile.subagents?.maxDepth ?? 2;
    if (depth >= maxDepth) {
      throw new Error(`Exceeded maximum delegation depth of ${maxDepth} for profile ${profile.id}`);
    }

    // Check concurrency limits
    const currentGlobalRunning = this.getRunningCount();
    if (currentGlobalRunning >= this._maxGlobalConcurrent) {
      throw new Error(`Global concurrent task limit of ${this._maxGlobalConcurrent} reached`);
    }

    const maxConcurrentForProfile = profile.subagents?.maxConcurrent ?? 2;
    const currentProfileRunning = this.getRunningCount(profile.id);
    if (currentProfileRunning >= maxConcurrentForProfile) {
      throw new Error(`Profile ${profile.id} concurrent limit of ${maxConcurrentForProfile} reached`);
    }

    // Check targetFiles write scope collision with running tasks
    if (options.targetFiles && options.targetFiles.length > 0) {
      const activeTasksWithScopes = this.listTasks({ status: "running" }).filter(
        (t) => t.targetFiles && t.targetFiles.length > 0,
      );
      for (const runningTask of activeTasksWithScopes) {
        if (scopesOverlap(options.targetFiles, runningTask.targetFiles)) {
          throw new Error(
            `Target files overlap with running task ${runningTask.id}: ${runningTask.targetFiles.join(", ")}`,
          );
        }
      }
    }

    const taskId = `task-${this._nextId++}-${Date.now().toString(36)}`;
    const now = Date.now();

    const taskRecord: TaskRecord = {
      id: taskId,
      profileId: profile.id,
      task: options.task,
      parentTaskId: options.parentTaskId,
      depth,
      targetFiles: Object.freeze(options.targetFiles ? [...options.targetFiles] : []),
      status: "running",
      revision: 1,
      createdAt: now,
      startedAt: now,
      lastActivityAt: now,
      items: [],
      timeoutSeconds: options.timeoutSeconds,
    };

    this._tasks.set(taskId, taskRecord);

    const controller = new AbortController();
    this._abortControllers.set(taskId, controller);

    if (options.signal) {
      if (options.signal.aborted) {
        controller.abort(options.signal.reason);
      } else {
        options.signal.addEventListener("abort", () => {
          this.cancel(taskId, "Cancelled by caller signal");
        }, { once: true });
      }
    }

    let timeoutTimer: NodeJS.Timeout | undefined;
    if (options.timeoutSeconds && options.timeoutSeconds > 0) {
      timeoutTimer = setTimeout(() => {
        this.cancel(taskId, `Task timed out after ${options.timeoutSeconds}s`);
      }, options.timeoutSeconds * 1000);
    }

    const runner = new InProcessSubagentRunner({
      profile,
      cwd: options.cwd,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      signal: controller.signal,
      onEvent: () => {
        this._updateTask(taskId, {});
      },
      onTextDelta: () => {
        this._updateTask(taskId, {});
      },
    });
    this._runners.set(taskId, runner);

    // Kick off execution asynchronously
    const runPromise = (async () => {
      try {
        const result = await runner.run(options.task);
        if (timeoutTimer) clearTimeout(timeoutTimer);

        let finalStatus: TaskStatus = "completed";
        if (result.status === "failed") finalStatus = "failed";
        else if (result.status === "aborted") finalStatus = "aborted";

        this._updateTask(taskId, {
          status: finalStatus,
          finishedAt: Date.now(),
          result: result.result,
          error: result.error,
          usage: {
            input: result.usage.inputTokens,
            output: result.usage.outputTokens,
            cacheRead: result.usage.cacheReadTokens,
            cacheWrite: result.usage.cacheWriteTokens,
            totalTokens: result.usage.totalTokens,
            cost: {
              total: result.usage.cost,
            },
          },
        });
      } catch (err) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        const isAborted = controller.signal.aborted;
        this._updateTask(taskId, {
          status: isAborted ? "aborted" : "failed",
          finishedAt: Date.now(),
          error: isAborted ? (controller.signal.reason instanceof Error ? controller.signal.reason.message : String(controller.signal.reason ?? "Aborted")) : (err instanceof Error ? err.message : String(err)),
        });
      } finally {
        this._runners.delete(taskId);
        this._abortControllers.delete(taskId);
        this._runnerPromises.delete(taskId);
      }
    })();
    this._runnerPromises.set(taskId, runPromise);

    return taskRecord;
  }

  public async cancel(taskId: string, reason = "Cancelled by user or supervisor"): Promise<boolean> {
    const task = this._tasks.get(taskId);
    if (!task) return false;
    if (task.status === "completed" || task.status === "failed" || task.status === "aborted") {
      return false;
    }

    const controller = this._abortControllers.get(taskId);
    if (controller) {
      controller.abort(new Error(reason));
    }

    const runnerPromise = this._runnerPromises.get(taskId);
    if (runnerPromise) {
      await runnerPromise;
    }

    // Ensure status is aborted and error is recorded if not already set
    if (task.status !== "aborted") {
      this._updateTask(taskId, {
        status: "aborted",
        finishedAt: task.finishedAt ?? Date.now(),
        error: task.error ?? reason,
      });
    } else if (!task.error) {
      this._updateTask(taskId, {
        error: reason,
      });
    }

    return true;
  }

  public async wait(
    taskId: string,
    options?: { afterRevision?: number; timeoutSeconds?: number },
  ): Promise<TaskRecord> {
    const task = this._tasks.get(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    const targetRev = options?.afterRevision ?? task.revision;
    const isDone = task.status === "completed" || task.status === "failed" || task.status === "aborted";

    // If already modified past target revision or already settled
    if (task.revision > targetRev || isDone) {
      return task;
    }

    const timeoutMs = (options?.timeoutSeconds ?? 30) * 1000;

    return new Promise<TaskRecord>((resolve) => {
      let timer: NodeJS.Timeout | undefined;

      const listener: TaskListener = (updated) => {
        if (updated.revision > targetRev || updated.status === "completed" || updated.status === "failed" || updated.status === "aborted") {
          cleanup();
          resolve(updated);
        }
      };

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        const set = this._listeners.get(taskId);
        if (set) {
          set.delete(listener);
          if (set.size === 0) this._listeners.delete(taskId);
        }
      };

      if (!this._listeners.has(taskId)) {
        this._listeners.set(taskId, new Set());
      }
      this._listeners.get(taskId)!.add(listener);

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          resolve(this._tasks.get(taskId)!);
        }, timeoutMs);
      }
    });
  }

  public subscribe(taskId: string, listener: TaskListener): () => void {
    if (!this._listeners.has(taskId)) {
      this._listeners.set(taskId, new Set());
    }
    const set = this._listeners.get(taskId)!;
    set.add(listener);

    return () => {
      set.delete(listener);
      if (set.size === 0) this._listeners.delete(taskId);
    };
  }

  private _updateTask(taskId: string, patch: Partial<TaskRecord>): void {
    const task = this._tasks.get(taskId);
    if (!task) return;

    Object.assign(task, patch);
    task.revision++;
    task.lastActivityAt = Date.now();

    const listeners = this._listeners.get(taskId);
    if (listeners) {
      for (const listener of [...listeners]) {
        try {
          listener(task);
        } catch {
          // ignore listener errors
        }
      }
    }

    const wildcardListeners = this._listeners.get("*");
    if (wildcardListeners) {
      for (const listener of [...wildcardListeners]) {
        try {
          listener(task);
        } catch {
          // ignore listener errors
        }
      }
    }
  }
}
