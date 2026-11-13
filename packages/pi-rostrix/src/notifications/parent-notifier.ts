import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskNotification, NotificationQueue } from "./queue.ts";

export class ParentNotifier {
  private readonly _pi?: ExtensionAPI | undefined;
  private readonly _notificationQueue: NotificationQueue;
  private _isParentIdle = true;
  private _disposed = false;
  private readonly _subscriptions: Array<() => void> = [];

  public constructor(notificationQueue: NotificationQueue, pi?: ExtensionAPI) {
    this._notificationQueue = notificationQueue;
    this._pi = pi;

    if (pi) {
      this._subscriptions.push(pi.on("agent_start", () => {
        this._isParentIdle = false;
      }));
      this._subscriptions.push(pi.on("agent_settled", () => {
        this.setParentIdle(true);
      }));
      this._subscriptions.push(pi.on("session_shutdown", () => {
        this.dispose();
      }));
    }
  }

  public setParentIdle(idle: boolean): void {
    if (this._disposed) return;
    this._isParentIdle = idle;
    if (idle) this._notificationQueue.flush();
  }

  public deliver(notifications: readonly TaskNotification[]): boolean {
    if (this._disposed || !this._isParentIdle || !this._pi) return false;

    const payload = { type: "subagent_notifications", notifications };
    try {
      this._pi.sendMessage({
        customType: "rostrix:subagent_notifications",
        content: JSON.stringify(payload),
        display: false,
        details: payload,
      }, { triggerTurn: true, deliverAs: "followUp" });
      return true;
    } catch {
      // The notificationQueue retains unsent notifications for the next delivery opportunity.
      return false;
    }
  }

  public dispose(): void {
    this._disposed = true;
    for (const unsubscribe of this._subscriptions) unsubscribe();
    this._subscriptions.length = 0;
    this._notificationQueue.clear();
  }
}
