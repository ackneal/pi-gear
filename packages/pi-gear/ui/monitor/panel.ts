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
  const lineWidth = Math.max(24, width);
  const headerLabel = `─ ${title} `;
  const fillCount = Math.max(0, lineWidth - visibleWidth(headerLabel));
  const topRule = theme.fg("dim", `${headerLabel}${"─".repeat(fillCount)}`);
  const bottomRule = theme.fg("dim", "─".repeat(lineWidth));

  return [
    topRule,
    ...rows.map((row) => padCell(row, lineWidth)),
    bottomRule,
  ];
}

function formatGitColumn(snapshot: MonitorSnapshot, colWidth: number, theme: Theme): string[] {
  const git = snapshot.git;
  if (!git.isRepo) {
    return [theme.bold("Git"), theme.fg("dim", " (not a git repository)")];
  }

  const branchText = git.branch ?? "HEAD";
  const summaryPlain = git.files.length > 0
    ? `${git.files.length} files · +${git.totalInsertions} -${git.totalDeletions}`
    : "";
  const headerPrefix = `${theme.bold("Git")} `;
  const summaryWidth = summaryPlain ? visibleWidth(summaryPlain) + 2 : 0;
  const maxBranchWidth = Math.max(8, colWidth - 4 - summaryWidth);
  const branchDisplay = theme.fg("accent", truncateToWidth(branchText, maxBranchWidth, "..."));
  const header = summaryPlain
    ? `${headerPrefix}${branchDisplay}  ${theme.fg("dim", summaryPlain)}`
    : `${headerPrefix}${branchDisplay}`;
  const lines: string[] = [header];

  for (const file of git.files.slice(0, MAX_DIFF_FILES)) {
    const stat = file.binary
      ? "bin"
      : file.state === "?"
        ? "new"
        : `+${file.insertions} -${file.deletions}`;
    const badgeColor = file.state === "S" || file.state === "A"
      ? "success"
      : file.state === "U" || file.state === "D"
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

function formatNamedResource(
  label: string,
  items: readonly string[],
  colWidth: number,
  theme: Theme,
): string[] {
  if (items.length === 0) {
    return [` ${label}: ${theme.fg("dim", "none")}`];
  }

  const maxDetailWidth = Math.max(12, colWidth - 4);
  const joined = truncateToWidth(items.join(", "), maxDetailWidth, "...");
  return [
    ` ${label}: ${items.length}`,
    `  ${theme.fg("dim", `└ ${joined}`)}`,
  ];
}

function formatMainAgentColumn(snapshot: MonitorSnapshot, colWidth: number, theme: Theme): string[] {
  const { toolsCount, skills, mcpServers } = snapshot.mainResources;
  const { total, errors, activeTools } = snapshot.tools;

  const lines: string[] = [
    `${theme.bold("Agent")} ${theme.fg("accent", snapshot.activeAgent)}`,
    ` tool: ${toolsCount}`,
  ];

  if (total > 0 || activeTools.length > 0) {
    const rateText = total > 0 ? ` (${Math.round(((total - errors) / total) * 100)}%)` : "";
    const activeText = activeTools.length > 0 ? ` · ${activeTools.length} running` : "";
    lines.push(`  ${theme.fg("dim", `└ ${total} calls${rateText}${activeText}`)}`);
  }

  lines.push(...formatNamedResource("skill", skills, colWidth, theme));
  lines.push(...formatNamedResource("mcp", mcpServers, colWidth, theme));
  return lines;
}

function shortAgentLabel(id: string): string {
  return id.startsWith("gear:") ? id.slice("gear:".length) : id;
}

function formatModelAndLevel(
  model: string | undefined,
  thinkingLevel: string | undefined,
  maxWidth: number,
): string {
  const modelShort = model ? (model.split("/").pop() ?? model) : undefined;
  const levelSuffix = thinkingLevel ? ` • ${thinkingLevel}` : "";
  if (!modelShort && !levelSuffix) return "";
  if (!modelShort) return thinkingLevel ?? "";

  const availableForModel = Math.max(6, maxWidth - visibleWidth(levelSuffix));
  const truncatedModel = truncateToWidth(modelShort, availableForModel, "...");
  return `${truncatedModel}${levelSuffix}`;
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

function formatSubagentsColumn(
  snapshot: MonitorSnapshot,
  colWidth: number,
  now: number,
  theme: Theme,
): string[] {
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
    const label = shortAgentLabel(agent.id);
    const metaMaxWidth = Math.max(10, colWidth - visibleWidth(label) - 3);
    const meta = formatModelAndLevel(agent.model, agent.thinkingLevel, metaMaxWidth);
    const metaPart = meta ? ` ${theme.fg("dim", meta)}` : "";
    lines.push(`${marker} ${label}${metaPart}`);

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
  const lineWidth = Math.max(24, width);

  if (lineWidth < THREE_COL_MIN_WIDTH) {
    const rows = [
      ...formatGitColumn(snapshot, lineWidth, theme),
      "",
      ...formatMainAgentColumn(snapshot, lineWidth, theme),
      "",
      ...formatSubagentsColumn(snapshot, lineWidth, now, theme),
    ];
    return frameRows("Monitor", rows, lineWidth, theme);
  }

  // Divide full width across 3 columns with two 3-char " │ " dividers.
  const colContentWidth = Math.max(18, lineWidth - 6);
  const col1Width = Math.floor(colContentWidth * 0.34);
  const col2Width = Math.floor(colContentWidth * 0.30);
  const col3Width = colContentWidth - col1Width - col2Width;

  const col1 = formatGitColumn(snapshot, col1Width, theme);
  const col2 = formatMainAgentColumn(snapshot, col2Width, theme);
  const col3 = formatSubagentsColumn(snapshot, col3Width, now, theme);
  const rowCount = Math.max(col1.length, col2.length, col3.length);
  const divider = theme.fg("dim", " │ ");

  const rows: string[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const c1 = padCell(col1[i] ?? "", col1Width);
    const c2 = padCell(col2[i] ?? "", col2Width);
    const c3 = padCell(col3[i] ?? "", col3Width);
    rows.push(`${c1}${divider}${c2}${divider}${c3}`);
  }

  return frameRows("Monitor", rows, lineWidth, theme);
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
