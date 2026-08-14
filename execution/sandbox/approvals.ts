import type { NetworkHostPattern } from "@anthropic-ai/sandbox-runtime";

export interface ApprovalUI {
  readonly hasUI: boolean;
  readonly confirm: (title: string, message: string) => Promise<boolean>;
  readonly notify: (message: string, level: "warning") => void;
  readonly sendMessage: (content: string) => void | Promise<void>;
}

const networkKey = ({ host, port }: NetworkHostPattern): string =>
  `${host.toLowerCase()}:${port ?? "unknown"}`;

export class SessionApprovals {
  readonly approvedHosts = new Set<string>();
  readonly pendingHostPrompts = new Map<string, Promise<boolean>>();
  private readonly ui: ApprovalUI;
  private readonly isCurrent: () => boolean;

  constructor(
    ui: ApprovalUI,
    isCurrent: () => boolean,
  ) {
    this.ui = ui;
    this.isCurrent = isCurrent;
  }

  clear(): void {
    this.approvedHosts.clear();
    this.pendingHostPrompts.clear();
  }

  async requestNetwork(request: NetworkHostPattern): Promise<boolean> {
    if (!this.ui.hasUI || !this.isCurrent()) return false;

    const key = networkKey(request);
    if (this.approvedHosts.has(key)) return true;

    let prompt = this.pendingHostPrompts.get(key);
    if (prompt === undefined) {
      prompt = this.ui.confirm("Network access required", `Allow connection to ${key}?`);
      this.pendingHostPrompts.set(key, prompt);
    }

    const approved = await prompt;
    if (this.pendingHostPrompts.get(key) === prompt) this.pendingHostPrompts.delete(key);

    if (!approved) {
      void Promise.resolve(this.ui.sendMessage(`User denied network access: ${key}`)).catch(() => undefined);
      return false;
    }
    if (!this.isCurrent()) return false;

    this.approvedHosts.add(key);
    void Promise.resolve(this.ui.sendMessage(`User approved network access: ${key}`)).catch(() => undefined);
    return true;
  }

  notifyExecutionPrevented(command: string, reason: string): void {
    if (!this.ui.hasUI || !this.isCurrent()) return;
    this.ui.notify(
      `Sandboxed execution did not run. No command was run.\nReason: ${reason}\nCommand: ${command}\nIf desired, manually run this exact command outside Pi.`,
      "warning",
    );
  }
}
