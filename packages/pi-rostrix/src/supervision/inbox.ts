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

export type InboxDeliveryHandler = (message: string, notifications: InboxNotification[]) => Promise<void> | void;

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
    // Keep most recent notification per taskId
    this._pendingNotifications.set(notification.taskId, notification);

    if (this._timer) {
      clearTimeout(this._timer);
    }

    this._timer = setTimeout(() => {
      this.flush();
    }, this._debounceMs);
  }

  public flush(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }

    if (this._pendingNotifications.size === 0) return;

    const list = Array.from(this._pendingNotifications.values());
    this._pendingNotifications.clear();

    const formatted = this.formatNotifications(list);
    if (this._onDeliver) {
      void this._onDeliver(formatted, list);
    }
  }

  public formatNotifications(notifications: InboxNotification[]): string {
    const lines: string[] = ["<subagent_notifications>"];
    for (const n of notifications) {
      lines.push(`  <notification task_id="${n.taskId}" profile="${n.profileId}" status="${n.status}">`);
      if (n.durationMs !== undefined) {
        lines.push(`    <duration_ms>${n.durationMs}</duration_ms>`);
      }
      if (n.error) {
        lines.push(`    <error>${escapeXml(n.error)}</error>`);
      }
      if (n.result) {
        lines.push(`    <result>${escapeXml(n.result)}</result>`);
      }
      lines.push("  </notification>");
    }
    lines.push("</subagent_notifications>");
    return lines.join("\n");
  }

  public clear(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    this._pendingNotifications.clear();
  }
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
