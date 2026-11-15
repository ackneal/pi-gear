import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { TaskRecord } from "pi-rostrix";
import type { Theme } from "../subagent/format.ts";
import { readableActivityName } from "../subagent/text-policy.ts";
import type { MonitorSnapshot } from "./state.ts";

const MAX_DIFF_FILES = 5;
const MAX_SUBAGENT_DEFS = 4;
const MAX_TASKS_PER_AGENT = 2;
const THREE_COL_MIN_WIDTH = 95;

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${minutes}m` : `${minutes}m ${rem}s`;
}

function padCell(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "...");
  const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  return `${truncated}${pad}`;
}

function frameRows(title: string, rows: readonly string[], width: number, theme: Theme): string[] {
  const boxWidth = Math.max(20, width);
  const innerWidth = boxWidth - 4;
  const headerLabel = ` ${title} `;
  const fillCount = Math.max(0, boxWidth - 3 - visibleWidth(headerLabel));
  const topBorder = theme.fg("dim", `┌─${headerLabel}${"─".repeat(fillCount)}┐`);
  const bottomBorder = theme.fg("dim", `└${"─".repeat(boxWidth - 2)}┘`);

  const lines = [topBorder];
  for (const row of rows) {
    lines.push(`${theme.fg("dim", "│")} ${padCell(row, innerWidth)} ${theme.fg("dim", "│")}`);
  }
  lines.push(bottomBorder);
  return lines;
}

function formatGitColumn(snapshot: MonitorSnapshot, colWidth: number, theme: Theme): string[] {
  const git = snapshot.git;
  if (!git.isRepo) {
    return [theme.bold("Git"), theme.fg("dim", " (not a git repository)")];
  }

  const branchText = git.branch ?? "HEAD";
  const summary = git.files.length === 0
    ? theme.fg("dim", "clean")
    : theme.fg("dim", `${git.files.length} files · +${git.totalInsertions} -${git.totalDeletions}`);
  const lines: string[] = [`${theme.bold("Git")} ${theme.fg("accent", branchText)} ${summary}`];

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
    const maxPathWidth = Math.max(8, colWidth - 4 - statWidth);
    const pathText = truncateToWidth(file.path, maxPathWidth, "...");
    const gap = " ".repeat(Math.max(1, colWidth - 3 - visibleWidth(pathText) - statWidth));
    lines.push(`${badge} ${pathText}${gap}${theme.fg("dim", stat)}`);
  }

  if (git.files.length > MAX_DIFF_FILES) {
    lines.push(theme.fg("dim", ` +${git.files.length - MAX_DIFF_FILES} more files`));
  }
  return lines;
}

function formatNamedList(label: string, items: readonly string[], theme: Theme): string {
  if (items.length === 0) return ` ${label}: ${theme.fg("dim", "none")}`;
  const preview = items.slice(0, 2).join(", ");
  const extra = items.length > 2 ? ` +${items.length - 2}` : "";
  return ` ${label}: ${items.length} ${theme.fg("dim", `(${preview}${extra})`)}`;
}

function formatMainAgentColumn(snapshot: MonitorSnapshot, theme: Theme): string[] {
  const { toolsCount, skills, mcpServers } = snapshot.mainResources;
  const { total, errors } = snapshot.tools;
  const rateText = total > 0 ? ` (${Math.round(((total - errors) / total) * 100)}%)` : "";
  const callsPart = total > 0 ? theme.fg("dim", ` (${total} calls${rateText})`) : "";

  return [
    `${theme.bold("Agent")} ${theme.fg("accent", snapshot.activeAgent)}`,
    ` tool: ${toolsCount}${callsPart}`,
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
  return ` └ ${icon} ${details || task.status}`;
}

function formatSubagentsColumn(snapshot: MonitorSnapshot, now: number, theme: Theme): string[] {
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
    lines.push(`${marker} ${shortAgentLabel(agent.id)}${modelShort}`);

    for (const task of agentTasks.slice(0, MAX_TASKS_PER_AGENT)) {
      lines.push(formatTaskChildLine(task, now, theme));
    }
  }

  for (const [agentId, agentTasks] of tasksByAgent) {
    if (seenAgents.has(agentId)) continue;
    const hasRunning = agentTasks.some((t) => t.status === "running" || t.status === "pending");
    const marker = hasRunning ? theme.fg("warning", "●") : theme.fg("dim", "○");
    lines.push(`${marker} ${shortAgentLabel(agentId)}`);
    for (const task of agentTasks.slice(0, MAX_TASKS_PER_AGENT)) {
      lines.push(formatTaskChildLine(task, now, theme));
    }
  }

  if (snapshot.agents.length === 0 && snapshot.tasks.length === 0) {
    lines.push(theme.fg("dim", " none"));
  }
  return lines;
}

export function renderMonitorPanel(
  snapshot: MonitorSnapshot,
  theme: Theme,
  width: number,
  now = Date.now(),
): string[] {
  const boxWidth = Math.max(24, width);
  const innerWidth = boxWidth - 4;

  if (boxWidth < THREE_COL_MIN_WIDTH) {
    const rows = [
      ...formatGitColumn(snapshot, innerWidth, theme),
      "",
      ...formatMainAgentColumn(snapshot, theme),
      "",
      ...formatSubagentsColumn(snapshot, now, theme),
    ];
    return frameRows("Monitor", rows, boxWidth, theme);
  }

  // Divide inner width across 3 columns with two 3-char " │ " dividers.
  const colContentWidth = Math.max(18, innerWidth - 6);
  const col1Width = Math.floor(colContentWidth * 0.38);
  const col2Width = Math.floor(colContentWidth * 0.30);
  const col3Width = colContentWidth - col1Width - col2Width;

  const col1 = formatGitColumn(snapshot, col1Width, theme);
  const col2 = formatMainAgentColumn(snapshot, theme);
  const col3 = formatSubagentsColumn(snapshot, now, theme);
  const rowCount = Math.max(col1.length, col2.length, col3.length);
  const divider = theme.fg("dim", " │ ");

  const rows: string[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const c1 = padCell(col1[i] ?? "", col1Width);
    const c2 = padCell(col2[i] ?? "", col2Width);
    const c3 = padCell(col3[i] ?? "", col3Width);
    rows.push(`${c1}${divider}${c2}${divider}${c3}`);
  }

  return frameRows("Monitor", rows, boxWidth, theme);
}

export function createMonitorPanelComponent(
  getSnapshot: () => MonitorSnapshot,
  theme: Theme,
): Component {
  return {
    invalidate() {},
    render(width: number): string[] {
      return renderMonitorPanel(getSnapshot(), theme, width);
    },
  };
}
