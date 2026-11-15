import { truncateToWidth, visibleWidth, type Component, type OverlayOptions } from "@earendil-works/pi-tui";
import type { TaskRecord } from "pi-rostrix";
import type { Theme } from "../subagent/format.ts";
import { readableActivityName } from "../subagent/text-policy.ts";
import {
  resolveSidebarExpanded,
  type MonitorSnapshot,
} from "./state.ts";

export const SIDEBAR_WIDTH = 38;
const MAX_DIFF_FILES = 6;
const MAX_SUBAGENT_DEFS = 5;
const MAX_TASKS_PER_AGENT = 2;

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${minutes}m` : `${minutes}m ${rem}s`;
}

function padLine(text: string, innerWidth: number): string {
  const truncated = truncateToWidth(text, innerWidth, "...");
  const pad = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
  return `${truncated}${pad}`;
}

function frameRows(title: string, rows: readonly string[], width: number, theme: Theme): string[] {
  const boxWidth = Math.max(16, width);
  const innerWidth = boxWidth - 4;
  const headerLabel = ` ${title} `;
  const fillCount = Math.max(0, boxWidth - 3 - visibleWidth(headerLabel));
  const topBorder = theme.fg("dim", `┌─${headerLabel}${"─".repeat(fillCount)}┐`);
  const bottomBorder = theme.fg("dim", `└${"─".repeat(boxWidth - 2)}┘`);

  const lines = [topBorder];
  for (const row of rows) {
    lines.push(`${theme.fg("dim", "│")} ${padLine(row, innerWidth)} ${theme.fg("dim", "│")}`);
  }
  lines.push(bottomBorder);
  return lines;
}

function formatGitSection(snapshot: MonitorSnapshot, innerWidth: number, theme: Theme): string[] {
  const git = snapshot.git;
  if (!git.isRepo) {
    return [theme.bold("Git"), theme.fg("dim", "  (not a git repository)")];
  }

  const tracking: string[] = [];
  if (git.ahead > 0) tracking.push(`↑${git.ahead}`);
  if (git.behind > 0) tracking.push(`↓${git.behind}`);
  const trackText = tracking.length > 0 ? ` ${tracking.join(" ")}` : "";
  const branchText = `${git.branch ?? "HEAD"}${trackText}`;

  const lines: string[] = [
    `${theme.bold("Git")} ${theme.fg("accent", branchText)}`,
  ];

  if (git.files.length === 0) {
    lines.push(theme.fg("dim", "  clean working tree"));
    return lines;
  }

  lines.push(
    theme.fg(
      "dim",
      `  ${git.files.length} changed · +${git.totalInsertions} -${git.totalDeletions}`,
    ),
  );

  for (const file of git.files.slice(0, MAX_DIFF_FILES)) {
    const stat = file.binary
      ? "bin"
      : file.state === "?"
        ? "new"
        : `+${file.insertions} -${file.deletions}`;
    const badgeColor = file.state === "S"
      ? "success"
      : file.state === "U"
        ? "error"
        : file.state === "?"
          ? "accent"
          : "warning";
    const badge = theme.fg(badgeColor, file.state.padEnd(2));
    const statWidth = visibleWidth(stat);
    const maxPathWidth = Math.max(8, innerWidth - 5 - statWidth);
    const pathText = truncateToWidth(file.path, maxPathWidth, "...");
    const gap = " ".repeat(Math.max(1, innerWidth - 4 - visibleWidth(pathText) - statWidth));
    lines.push(` ${badge} ${pathText}${gap}${theme.fg("dim", stat)}`);
  }

  if (git.files.length > MAX_DIFF_FILES) {
    lines.push(theme.fg("dim", `  +${git.files.length - MAX_DIFF_FILES} more files`));
  }
  return lines;
}

function formatNamedList(label: string, items: readonly string[], theme: Theme): string {
  if (items.length === 0) return `  ${label}: ${theme.fg("dim", "none")}`;
  const preview = items.slice(0, 2).join(", ");
  const extra = items.length > 2 ? ` +${items.length - 2}` : "";
  return `  ${label}: ${items.length} ${theme.fg("dim", `(${preview}${extra})`)}`;
}

function formatMainAgentSection(snapshot: MonitorSnapshot, theme: Theme): string[] {
  const { toolsCount, skills, mcpServers } = snapshot.mainResources;
  const { total, errors } = snapshot.tools;
  const errPart = errors > 0 ? theme.fg("error", ` · ${errors} err`) : "";
  const callsPart = total > 0 ? theme.fg("dim", ` (${total} calls)`) : "";

  return [
    `${theme.bold("Agent")} ${theme.fg("accent", snapshot.activeAgent)}`,
    `  tool: ${toolsCount}${callsPart}${errPart}`,
    formatNamedList("skill", skills, theme),
    formatNamedList("mcp", mcpServers, theme),
  ];
}

function shortAgentLabel(id: string): string {
  return id.startsWith("gear:") ? id.slice("gear:".length) : id;
}

function lastToolLabel(task: TaskRecord): string | undefined {
  for (let i = task.activities.length - 1; i >= 0; i -= 1) {
    const item = task.activities[i];
    if (item?.kind === "tool") {
      return readableActivityName(item.name);
    }
  }
  return undefined;
}

function formatTaskChildLine(task: TaskRecord, now: number, theme: Theme): string {
  const icon = task.status === "running" || task.status === "pending"
    ? theme.fg("warning", "◌")
    : task.status === "completed"
      ? theme.fg("success", "✓")
      : theme.fg("error", "✕");
  const elapsedMs = (task.finishedAt ?? now) - (task.startedAt ?? now);
  const duration = task.startedAt !== undefined ? formatDuration(elapsedMs) : "";
  const tool = lastToolLabel(task);
  const details = [duration, tool].filter(Boolean).join(" · ");
  return `  └ ${icon} ${details || task.status}`;
}

function formatSubagentsSection(snapshot: MonitorSnapshot, now: number, theme: Theme): string[] {
  const runningCount = snapshot.tasks.filter((t) => t.status === "running" || t.status === "pending").length;
  const headerSuffix = runningCount > 0 ? ` (${runningCount} running)` : "";
  const lines: string[] = [`${theme.bold("Subagent")}${theme.fg("warning", headerSuffix)}`];

  const tasksByAgent = new Map<string, TaskRecord[]>();
  const orderedTasks = [...snapshot.tasks].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  for (const task of orderedTasks) {
    const list = tasksByAgent.get(task.agentId) ?? [];
    list.push(task);
    tasksByAgent.set(task.agentId, list);
  }

  const seenAgents = new Set<string>();
  for (const agent of snapshot.agents.slice(0, MAX_SUBAGENT_DEFS)) {
    seenAgents.add(agent.id);
    const agentTasks = tasksByAgent.get(agent.id) ?? [];
    const hasRunning = agentTasks.some((t) => t.status === "running" || t.status === "pending");
    const marker = hasRunning ? theme.fg("warning", "●") : theme.fg("dim", "○");
    const modelShort = agent.model ? ` ${theme.fg("dim", agent.model.split("/").pop() ?? agent.model)}` : "";
    lines.push(` ${marker} ${shortAgentLabel(agent.id)}${modelShort}`);

    for (const task of agentTasks.slice(0, MAX_TASKS_PER_AGENT)) {
      lines.push(formatTaskChildLine(task, now, theme));
    }
  }

  for (const [agentId, agentTasks] of tasksByAgent) {
    if (seenAgents.has(agentId)) continue;
    const hasRunning = agentTasks.some((t) => t.status === "running" || t.status === "pending");
    const marker = hasRunning ? theme.fg("warning", "●") : theme.fg("dim", "○");
    lines.push(` ${marker} ${shortAgentLabel(agentId)}`);
    for (const task of agentTasks.slice(0, MAX_TASKS_PER_AGENT)) {
      lines.push(formatTaskChildLine(task, now, theme));
    }
  }

  if (snapshot.agents.length === 0 && snapshot.tasks.length === 0) {
    lines.push(theme.fg("dim", "  none"));
  }
  return lines;
}

export function renderSidebar(
  snapshot: MonitorSnapshot,
  theme: Theme,
  width = SIDEBAR_WIDTH,
  now = Date.now(),
): string[] {
  const innerWidth = Math.max(12, width - 4);
  const rows: string[] = [
    ...formatGitSection(snapshot, innerWidth, theme),
    "",
    ...formatMainAgentSection(snapshot, theme),
    "",
    ...formatSubagentsSection(snapshot, now, theme),
  ];

  return frameRows("Monitor", rows, width, theme);
}

export function sidebarOverlayOptions(
  getManualExpanded: () => boolean | undefined,
): OverlayOptions {
  return {
    width: SIDEBAR_WIDTH,
    anchor: "top-right",
    margin: { top: 1, right: 0, bottom: 2 },
    nonCapturing: true,
    visible: (termWidth: number) => resolveSidebarExpanded(getManualExpanded(), termWidth),
  };
}

export function createSidebarComponent(
  getSnapshot: () => MonitorSnapshot,
  theme: Theme,
): Component {
  return {
    invalidate() {},
    render(width: number): string[] {
      return renderSidebar(getSnapshot(), theme, width);
    },
  };
}
