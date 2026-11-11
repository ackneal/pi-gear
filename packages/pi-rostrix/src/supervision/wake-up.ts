import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ParentInbox } from "./inbox.ts";

export interface WakeUpContext {
  readonly isIdle: () => boolean;
  readonly sendUserMessage?: ((message: string) => Promise<void> | void) | undefined;
}

export class WakeUpManager {
  private readonly _pi?: ExtensionAPI | undefined;
  private readonly _inbox: ParentInbox;
  private _isParentIdle = true;
  private _disposed = false;
  private readonly _subscriptions: Array<() => void> = [];
  private readonly _queuedMessages: string[] = [];

  public constructor(inbox: ParentInbox, pi?: ExtensionAPI) {
    this._inbox = inbox;
    this._pi = pi;

    if (pi) {
      // Listen to agent loop states
      this._subscriptions.push(pi.on("agent_start", () => {
        this._isParentIdle = false;
      }));

      this._subscriptions.push(pi.on("agent_settled", () => {
        this._isParentIdle = true;
        this._flushQueued();
      }));

      this._subscriptions.push(pi.on("session_shutdown", () => {
        this.dispose();
      }));
    }
  }

  public setParentIdle(idle: boolean): void {
    if (this._disposed) return;
    this._isParentIdle = idle;
    if (idle) {
      this._flushQueued();
    }
  }

  public async deliverOrQueue(message: string): Promise<void> {
    if (this._disposed) return;
    if (this._isParentIdle) {
      await this._wakeParent(message);
    } else {
      this._queuedMessages.push(message);
    }
  }

  private async _wakeParent(message: string): Promise<void> {
    if (!this._disposed && this._pi) {
      try {
        await this._pi.sendUserMessage(message);
      } catch {
        // Fallback: queue if send fails
        if (!this._disposed) this._queuedMessages.push(message);
      }
    }
  }

  private _flushQueued(): void {
    if (this._queuedMessages.length === 0) return;
    const combined = this._queuedMessages.join("\n\n");
    this._queuedMessages.length = 0;
    void this._wakeParent(combined);
  }

  public dispose(): void {
    this._disposed = true;
    for (const unsubscribe of this._subscriptions) unsubscribe();
    this._subscriptions.length = 0;
    this._queuedMessages.length = 0;
    this._inbox.clear();
  }
}
