import type { NetworkHostPattern } from "@anthropic-ai/sandbox-runtime";

export type NetworkApprovalChoice = "once" | "always" | "deny";

export interface ApprovalUI {
  readonly hasUI: boolean;
  readonly promptNetwork: (request: NetworkHostPattern) => Promise<NetworkApprovalChoice>;
  readonly notify: (message: string, level: "info" | "warning") => void;
  readonly persistAllowedHost?: (host: string) => Promise<void>;
}

export const networkKey = ({ host, port }: NetworkHostPattern): string =>
  `${host.toLowerCase()}:${port ?? "unknown"}`;

export class SessionApprovals {
  readonly approvedHosts = new Set<string>();
  readonly permanentlyApprovedHosts = new Set<string>();
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
    this.permanentlyApprovedHosts.clear();
    this.pendingHostPrompts.clear();
  }

  async requestNetwork(request: NetworkHostPattern): Promise<boolean> {
    if (!this.ui.hasUI || !this.isCurrent()) return false;

    const host = request.host.toLowerCase();
    if (this.permanentlyApprovedHosts.has(host)) return true;

    const key = networkKey(request);
    if (this.approvedHosts.has(key)) return true;

    let prompt = this.pendingHostPrompts.get(key);
    if (prompt === undefined) {
      prompt = this.promptNetwork(request, key);
      this.pendingHostPrompts.set(key, prompt);
    }

    return prompt;
  }

  private async promptNetwork(request: NetworkHostPattern, key: string): Promise<boolean> {
    try {
      const choice = await this.ui.promptNetwork(request);
      if (!this.isCurrent()) return false;

      if (choice === "always") {
        if (this.ui.persistAllowedHost) {
          try {
            await this.ui.persistAllowedHost(request.host.toLowerCase());
          } catch (error) {
            this.ui.notify(
              `Failed to persist network access to config: ${error instanceof Error ? error.message : String(error)}`,
              "warning",
            );
          }
        }
        this.permanentlyApprovedHosts.add(request.host.toLowerCase());
        this.approvedHosts.add(key);
        this.ui.notify(`User permanently approved network access: ${request.host.toLowerCase()}`, "info");
        return true;
      }

      if (choice === "once") {
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
