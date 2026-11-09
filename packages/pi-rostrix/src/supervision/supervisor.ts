import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskRegistry } from "../runtime/task-registry.ts";
import type { TaskRecord } from "../runtime/task-types.ts";
import { ParentInbox } from "./inbox.ts";
import { WakeUpManager } from "./wake-up.ts";

export interface TaskSupervisorOptions {
  readonly checkIntervalMs?: number | undefined;
  readonly defaultStallTimeoutMs?: number | undefined;
  readonly debounceMs?: number | undefined;
}

export class TaskSupervisor {
  private readonly _taskRegistry: TaskRegistry;
  private readonly _inbox: ParentInbox;
  private readonly _wakeUpManager: WakeUpManager;
  private readonly _checkIntervalMs: number;
  private readonly _defaultStallTimeoutMs: number;
  private _intervalTimer?: NodeJS.Timeout | undefined;
  private readonly _activeSubscriptions: Array<() => void> = [];

  public constructor(taskRegistry: TaskRegistry, pi?: ExtensionAPI, options?: TaskSupervisorOptions) {
    this._taskRegistry = taskRegistry;
    this._checkIntervalMs = options?.checkIntervalMs ?? 5000;
    this._defaultStallTimeoutMs = options?.defaultStallTimeoutMs ?? 60_000;

    this._inbox = new ParentInbox({
      debounceMs: options?.debounceMs ?? 150,
      onDeliver: async (formattedMessage) => {
        await this._wakeUpManager.deliverOrQueue(formattedMessage);
      },
    });

    this._wakeUpManager = new WakeUpManager(this._inbox, pi);
    this._startMonitoring();
  }

  public get inbox(): ParentInbox {
    return this._inbox;
  }

  public get wakeUpManager(): WakeUpManager {
    return this._wakeUpManager;
  }

  public notifyTaskSettled(task: TaskRecord): void {
    const durationMs = task.startedAt ? (task.finishedAt ?? Date.now()) - task.startedAt : undefined;

    this._inbox.enqueue({
      taskId: task.id,
      profileId: task.profileId,
      status: task.status,
      result: task.result,
      error: task.error,
      durationMs,
      timestamp: Date.now(),
    });
  }

  private _startMonitoring(): void {
    if (this._intervalTimer) return;

    this._intervalTimer = setInterval(() => {
      this._checkTasks();
    }, this._checkIntervalMs);
  }

  private _checkTasks(): void {
    const now = Date.now();
    const runningTasks = this._taskRegistry.listTasks({ status: "running" });

    for (const task of runningTasks) {
      // Check stall timeout
      const inactiveDuration = now - task.lastActivityAt;
      if (inactiveDuration > this._defaultStallTimeoutMs) {
        void this._taskRegistry.cancel(task.id, `Task stalled: no activity for ${Math.round(inactiveDuration / 1000)}s`);
        this.notifyTaskSettled(task);
      }
    }
  }

  public dispose(): void {
    if (this._intervalTimer) {
      clearInterval(this._intervalTimer);
      this._intervalTimer = undefined;
    }
    for (const unsub of this._activeSubscriptions) {
      unsub();
    }
    this._activeSubscriptions.length = 0;
    this._wakeUpManager.dispose();
  }
}
