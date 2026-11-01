import type { NetworkHostPattern } from "@anthropic-ai/sandbox-runtime";

export interface ApprovalUI {
  readonly hasUI: boolean;
  readonly confirm: (title: string, message: string) => Promise<boolean>;
  readonly notify: (message: string, level: "info" | "warning") => void;
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
      prompt = this.promptNetwork(key);
      this.pendingHostPrompts.set(key, prompt);
    }

    return prompt;
  }

  private async promptNetwork(key: string): Promise<boolean> {
    try {
      const approved = await this.ui.confirm("Network access required", `Allow bash to connect to ${key}?`);
      if (!this.isCurrent()) return false;

      if (approved) {
        this.approvedHosts.add(key);
        this.ui.notify(`User approved network access: ${key}`, "info");
        return true;
      }

      this.ui.notify(`User denied network access: ${key}`, "warning");
      return false;
    } finally {
      this.pendingHostPrompts.delete(key);
    }
  }

  notifyExecutionPrevented(command: string, reason: string): void {
    if (!this.ui.hasUI || !this.isCurrent()) return;
    this.ui.notify(
      `Sandboxed execution did not run. No command was run.\nReason: ${reason}\nCommand: ${command}\nIf desired, manually run this exact command outside Pi.`,
      "warning",
    );
  }
}
