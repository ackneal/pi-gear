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
  private readonly _queuedMessages: string[] = [];

  public constructor(inbox: ParentInbox, pi?: ExtensionAPI) {
    this._inbox = inbox;
    this._pi = pi;

    if (pi) {
      // Listen to agent loop states
      pi.on("agent_start" as any, () => {
        this._isParentIdle = false;
      });

      pi.on("agent_settle" as any, () => {
        this._isParentIdle = true;
        this._flushQueued();
      });

      pi.on("session_shutdown" as any, () => {
        this.dispose();
      });
    }
  }

  public setParentIdle(idle: boolean): void {
    this._isParentIdle = idle;
    if (idle) {
      this._flushQueued();
    }
  }

  public async deliverOrQueue(message: string): Promise<void> {
    if (this._isParentIdle) {
      await this._wakeParent(message);
    } else {
      this._queuedMessages.push(message);
    }
  }

  private async _wakeParent(message: string): Promise<void> {
    if (this._pi && typeof (this._pi as any).sendUserMessage === "function") {
      try {
        await (this._pi as any).sendUserMessage(message);
      } catch {
        // Fallback: queue if send fails
        this._queuedMessages.push(message);
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
    this._queuedMessages.length = 0;
    this._inbox.clear();
  }
}
