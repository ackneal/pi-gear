import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskController } from "./controller.ts";
import type { TaskRecord } from "./types.ts";
import { NotificationQueue } from "../notifications/queue.ts";
import { ParentNotifier } from "../notifications/parent-notifier.ts";

export interface TaskMonitorOptions {
  readonly checkIntervalMs?: number | undefined;
  readonly defaultStallTimeoutMs?: number | undefined;
  readonly debounceMs?: number | undefined;
}

export class TaskMonitor {
  private readonly _taskController: TaskController;
  private readonly _notificationQueue: NotificationQueue;
  private readonly _notifier: ParentNotifier;
  private readonly _checkIntervalMs: number;
  private readonly _defaultStallTimeoutMs: number;
  private _intervalTimer?: NodeJS.Timeout | undefined;
  private _disposed = false;
  private readonly _handledTasks = new WeakSet<TaskRecord>();

  public constructor(taskController: TaskController, pi?: ExtensionAPI, options?: TaskMonitorOptions) {
    this._taskController = taskController;
    this._checkIntervalMs = options?.checkIntervalMs ?? 5000;
    this._defaultStallTimeoutMs = options?.defaultStallTimeoutMs ?? 60_000;

    this._notificationQueue = new NotificationQueue({
      debounceMs: options?.debounceMs ?? 150,
      onDeliver: (notifications) => this._notifier.deliver(notifications),
    });

    this._notifier = new ParentNotifier(this._notificationQueue, pi);
    this._startMonitoring();
  }

  public get notificationQueue(): NotificationQueue {
    return this._notificationQueue;
  }

  public get notifier(): ParentNotifier {
    return this._notifier;
  }

  public acknowledgeTask(taskId: string): void {
    if (this._disposed) return;
    const task = this._taskController.getTask(taskId);
    if (task && !["completed", "failed", "aborted"].includes(task.status)) return;

    if (task) this._handledTasks.add(task);
    this._notificationQueue.remove(taskId);
  }

  public notifyTaskSettled(task: TaskRecord): void {
    if (this._disposed || this._handledTasks.has(task)) return;

    // The runtime has no blocked/input event; needs_input is not synthesized.
    const trigger = task.status === "completed" || task.status === "failed"
      ? task.status
      : task.status === "aborted" && task.cancellationCause === "stalled" ? "stalled" : undefined;
    if (!trigger || !task.wakeOn.includes(trigger)) return;

    const durationMs = task.startedAt ? (task.finishedAt ?? Date.now()) - task.startedAt : undefined;

    this._handledTasks.add(task);
    this._notificationQueue.enqueue({
      taskId: task.id,
      agentId: task.agentId,
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
    this._intervalTimer.unref();
  }

  private _checkTasks(): void {
    const now = Date.now();
    const runningTasks = this._taskController.listTasks({ status: "running" });

    for (const task of runningTasks) {
      // Check stall timeout
      const inactiveDuration = now - task.lastActivityAt;
      if (inactiveDuration > this._defaultStallTimeoutMs) {
        void this._taskController.cancel(task.id, `Task stalled: no activity for ${Math.round(inactiveDuration / 1000)}s`, "stalled");
      }
    }
  }

  public dispose(): void {
    this._disposed = true;
    if (this._intervalTimer) {
      clearInterval(this._intervalTimer);
      this._intervalTimer = undefined;
    }
    this._notifier.dispose();
  }
}
