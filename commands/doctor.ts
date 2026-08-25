import type { SandboxStatus } from "../execution/sandbox/controller.ts";
import { formatSubagentDispatch } from "../subagents/runtime/dispatch.ts";
import type { SubagentSummary } from "../subagents/settings.ts";

const describeDomains = (domains: readonly string[]): string => domains.length > 0 ? domains.join(", ") : "(none)";

export interface LspServerSummary {
  extensions: readonly string[];
  executable: string;
  available: boolean;
  running: boolean;
}

export function formatDoctor(
  status: SandboxStatus,
  subagents: SubagentSummary[],
  activeTools: readonly string[],
  platform: NodeJS.Platform = process.platform,
  runtimeError?: string,
  lspServers: readonly LspServerSummary[] = [],
): string {
  const sandboxState = !status.configured ? "disabled by configuration" : status.enabled ? "enabled" : "unavailable";
  const lines = [
    `Sandbox: ${sandboxState}`,
    `Platform: ${platform}`,
    `Workspace: ${status.workspace}`,
    "Filesystem: read/edit/write guarded; other tools warn when unguarded",
  ];

  if (!status.configured) {
    lines.push("Network: not applied; Bash runs on the host");
  } else if (status.network !== undefined) {
    lines.push(`Network allow: ${describeDomains(status.network.allowedDomains)}`);
    lines.push(`Network deny: ${describeDomains(status.network.deniedDomains)}`);
    lines.push(`Network other hosts: ${status.network.strictAllowlist ? "denied" : "require approval"}`);
  } else {
    lines.push("Network: unavailable");
  }
  if (status.configured && !status.enabled && status.reason !== undefined) {
    lines.splice(1, 0, `Reason: ${status.reason}`);
  }

  lines.push("", "Subagents:");
  if (runtimeError) lines.push(`Runtime config: invalid · ${runtimeError}`);
  for (const summary of subagents) {
    const availability = activeTools.includes(summary.id) ? "enabled" : "disabled";
    const dispatch = formatSubagentDispatch(summary.dispatch) ?? "unresolved";
    const modelStatus = summary.available ? "" : " · model unavailable";
    lines.push(`- ${summary.id}: ${availability} · ${summary.source} ${summary.mode} · ${dispatch}${modelStatus}`);
  }

  if (lspServers.length > 0) {
    lines.push("", "LSP:");
    for (const server of lspServers) {
      const status = server.running ? "running" : server.available ? "available" : "not found";
      lines.push(`- ${status} ${server.extensions.join(" ")} · ${server.executable}`);
    }
  }

  return lines.join("\n");
}
