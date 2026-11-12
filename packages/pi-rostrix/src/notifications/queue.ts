import type { TaskRecord } from "../tasks/types.ts";

export interface TaskNotification {
  readonly taskId: string;
  readonly profileId: string;
  readonly status: TaskRecord["status"];
  readonly result?: string | undefined;
  readonly error?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly timestamp: number;
}

export type NotificationDeliveryHandler = (notifications: readonly TaskNotification[]) => boolean;

export interface NotificationQueueOptions {
  readonly debounceMs?: number | undefined;
  readonly onDeliver?: NotificationDeliveryHandler | undefined;
}

export class NotificationQueue {
  private readonly _debounceMs: number;
  private readonly _onDeliver?: NotificationDeliveryHandler | undefined;
  private readonly _pendingNotifications: Map<string, TaskNotification> = new Map();
  private _timer?: NodeJS.Timeout | undefined;

  public constructor(options?: NotificationQueueOptions) {
    this._debounceMs = options?.debounceMs ?? 150;
    this._onDeliver = options?.onDeliver;
  }

  public enqueue(notification: TaskNotification): void {
    this._pendingNotifications.set(notification.taskId, notification);
    if (this._timer) clearTimeout(this._timer);

    this._timer = setTimeout(() => this.flush(), this._debounceMs);
    this._timer.unref();
  }

  public remove(taskId: string): void {
    this._pendingNotifications.delete(taskId);
    if (this._pendingNotifications.size === 0) this.clear();
  }

  public flush(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    if (this._pendingNotifications.size === 0) return;

    const notifications = Array.from(this._pendingNotifications.values());
    if (!this._onDeliver?.(notifications)) return;

    // Keep replacements enqueued by a reentrant delivery callback.
    for (const notification of notifications) {
      if (this._pendingNotifications.get(notification.taskId) === notification) {
        this._pendingNotifications.delete(notification.taskId);
      }
    }
  }

  public clear(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    this._pendingNotifications.clear();
  }
}
