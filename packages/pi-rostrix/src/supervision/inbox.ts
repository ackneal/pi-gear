import type { TaskRecord } from "../runtime/task-types.ts";

export interface InboxNotification {
  readonly taskId: string;
  readonly profileId: string;
  readonly status: TaskRecord["status"];
  readonly result?: string | undefined;
  readonly error?: string | undefined;
  readonly durationMs?: number | undefined;
  readonly timestamp: number;
}

export type InboxDeliveryHandler = (notifications: readonly InboxNotification[]) => boolean;

export interface ParentInboxOptions {
  readonly debounceMs?: number | undefined;
  readonly onDeliver?: InboxDeliveryHandler | undefined;
}

export class ParentInbox {
  private readonly _debounceMs: number;
  private readonly _onDeliver?: InboxDeliveryHandler | undefined;
  private readonly _pendingNotifications: Map<string, InboxNotification> = new Map();
  private _timer?: NodeJS.Timeout | undefined;

  public constructor(options?: ParentInboxOptions) {
    this._debounceMs = options?.debounceMs ?? 150;
    this._onDeliver = options?.onDeliver;
  }

  public enqueue(notification: InboxNotification): void {
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
