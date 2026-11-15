import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { TaskRecord } from "pi-rostrix";
import type { Theme } from "../subagent/format.ts";
import { readableActivityName } from "../subagent/text-policy.ts";
import type { MonitorSnapshot } from "./state.ts";

const MAX_DIFF_FILES = 5;
const MAX_SUBAGENT_DEFS = 4;
const MAX_TASKS_PER_AGENT = 2;
const MAX_COMPACT_DETAIL_LINES = 2;
const THREE_COL_MIN_WIDTH = 95;
const TWO_COL_MIN_WIDTH = 70;

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

function wrapCommaItems(
  items: readonly string[],
  maxLineWidth: number,
  maxLines?: number,
): string[] {
  if (items.length === 0) return [];
  const lines: string[] = [];
  let current = "";
  let consumed = 0;

  for (const item of items) {
    const candidate = current ? `${current}, ${item}` : item;
    if (current && visibleWidth(candidate) > maxLineWidth) {
      lines.push(current);
      if (maxLines !== undefined && lines.length >= maxLines) {
        const remaining = items.length - consumed;
        const suffix = ` +${remaining}`;
        const last = lines[lines.length - 1] ?? "";
        lines[lines.length - 1] = `${truncateToWidth(last, Math.max(4, maxLineWidth - visibleWidth(suffix)), "...")}${suffix}`;
        return lines;
      }
      current = item;
    } else {
      current = candidate;
    }
    consumed += 1;
  }

  if (current) {
    lines.push(truncateToWidth(current, maxLineWidth, "..."));
  }
  return lines;
}

function frameRows(
  title: string,
  rows: readonly string[],
  width: number,
  detailExpanded: boolean,
  theme: Theme,
): string[] {
  const lineWidth = Math.max(24, width);
  const headerLabel = `─ ${title} `;
  const toggleLabel = detailExpanded ? " [compact]" : " [+all]";
  const fillCount = Math.max(1, lineWidth - visibleWidth(headerLabel) - visibleWidth(toggleLabel));
  const topRule = `${theme.fg("dim", `${headerLabel}${"─".repeat(fillCount)}`)}${theme.fg("accent", toggleLabel)}`;
  const bottomRule = theme.fg("dim", "─".repeat(lineWidth));

  return [
    topRule,
    ...rows.map((row) => padCell(row, lineWidth)),
    bottomRule,
  ];
}

function formatGitColumn(
  snapshot: MonitorSnapshot,
  colWidth: number,
  detailExpanded: boolean,
  theme: Theme,
): string[] {
  const git = snapshot.git;
  const contentWidth = Math.max(18, colWidth - 1);
  const branchText = git.branch ?? "HEAD";
  const summaryPlain = git.files.length > 0
    ? `${git.files.length} files (+${git.totalInsertions} -${git.totalDeletions})`
    : "";
  const headerPrefix = `${theme.bold("Git")} `;
  const summaryWidth = summaryPlain ? visibleWidth(summaryPlain) + 2 : 0;
  const maxBranchWidth = Math.max(8, contentWidth - 4 - summaryWidth);
  const branchDisplay = theme.fg("accent", truncateToWidth(branchText, maxBranchWidth, "..."));
  const header = summaryPlain
    ? `${headerPrefix}${branchDisplay}  ${theme.fg("dim", summaryPlain)}`
    : `${headerPrefix}${branchDisplay}`;
  const lines: string[] = [header];

  const visibleFiles = detailExpanded ? git.files : git.files.slice(0, MAX_DIFF_FILES);
  for (const file of visibleFiles) {
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
    const maxPathWidth = Math.max(8, contentWidth - 5 - statWidth);
    const pathText = truncateToWidth(file.path, maxPathWidth, "...");
    const gap = " ".repeat(Math.max(2, contentWidth - 3 - visibleWidth(pathText) - statWidth));
    lines.push(`${badge} ${pathText}${gap}${theme.fg("dim", stat)}`);
  }

  if (!detailExpanded && git.files.length > MAX_DIFF_FILES) {
    lines.push(theme.fg("dim", ` +${git.files.length - MAX_DIFF_FILES} more files`));
  }
  return lines;
}

function formatNamedResource(
  label: string,
  items: readonly string[],
  colWidth: number,
  detailExpanded: boolean,
  theme: Theme,
): string[] {
  if (items.length === 0) {
    return [` ${label}: ${theme.fg("dim", "none")}`];
  }

  const maxDetailWidth = Math.max(12, colWidth - 5);
  const wrapped = wrapCommaItems(
    items,
    maxDetailWidth,
    detailExpanded ? undefined : MAX_COMPACT_DETAIL_LINES,
  );
  return [
    ` ${label}: ${items.length}`,
    ...wrapped.map((line) => `  ${theme.fg("dim", `└ ${line}`)}`),
  ];
}

function formatToolItems(
  snapshot: MonitorSnapshot,
  detailExpanded: boolean,
): string[] {
  const { byTool } = snapshot.tools;
  const seen = new Set<string>(snapshot.mainResources.tools);
  for (const name of Object.keys(byTool)) {
    if (!name.startsWith("mcp__")) {
      seen.add(name);
    }
  }

  const ordered = [...seen].sort((a, b) => {
    const callsDiff = (byTool[b]?.calls ?? 0) - (byTool[a]?.calls ?? 0);
    return callsDiff !== 0 ? callsDiff : a.localeCompare(b);
  });

  return ordered.map((name) => {
    const stats = byTool[name];
    if (!stats || stats.calls === 0) return name;
    const rate = Math.round(((stats.calls - stats.errors) / stats.calls) * 100);
    return detailExpanded
      ? `${name} (${stats.calls} · ${rate}%)`
      : `${name} ${rate}%`;
  });
}

function formatMcpItems(
  snapshot: MonitorSnapshot,
  detailExpanded: boolean,
): string[] {
  const serverStats = new Map<string, { calls: number; errors: number }>();
  for (const server of snapshot.mainResources.mcpServers) {
    serverStats.set(server, { calls: 0, errors: 0 });
  }
  for (const [toolName, stats] of Object.entries(snapshot.tools.byTool)) {
    const match = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__/);
    if (!match?.[1]) continue;
    const prev = serverStats.get(match[1]) ?? { calls: 0, errors: 0 };
    prev.calls += stats.calls;
    prev.errors += stats.errors;
    serverStats.set(match[1], prev);
  }

  const ordered = [...serverStats.entries()].sort(([aName, a], [bName, b]) => {
    const callsDiff = b.calls - a.calls;
    return callsDiff !== 0 ? callsDiff : aName.localeCompare(bName);
  });

  return ordered.map(([server, stats]) => {
    if (stats.calls === 0) return server;
    const rate = Math.round(((stats.calls - stats.errors) / stats.calls) * 100);
    return detailExpanded
      ? `${server} (${stats.calls} · ${rate}%)`
      : `${server} ${rate}%`;
  });
}

function formatMainAgentColumn(
  snapshot: MonitorSnapshot,
  colWidth: number,
  detailExpanded: boolean,
  theme: Theme,
): string[] {
  const { toolsCount, skills } = snapshot.mainResources;
  const { total, errors, activeTools } = snapshot.tools;
  const rateText = total > 0 ? `${Math.round(((total - errors) / total) * 100)}%` : undefined;
  const summaryParts: string[] = [];
  if (total > 0) summaryParts.push(`${total} calls · ${rateText}`);
  if (activeTools.length > 0) summaryParts.push(`${activeTools.length} running`);
  const toolSummary = summaryParts.length > 0
    ? `  ${theme.fg("dim", `(${summaryParts.join(" · ")})`)}`
    : "";

  const toolItems = formatToolItems(snapshot, detailExpanded);
  const maxDetailWidth = Math.max(12, colWidth - 5);
  const toolLines = wrapCommaItems(
    toolItems,
    maxDetailWidth,
    detailExpanded ? undefined : MAX_COMPACT_DETAIL_LINES,
  );

  const mcpItems = formatMcpItems(snapshot, detailExpanded);

  return [
    `${theme.bold("Agent")} ${theme.fg("accent", snapshot.activeAgent)}`,
    ` tool: ${toolsCount}${toolSummary}`,
    ...toolLines.map((line) => `  ${theme.fg("dim", `└ ${line}`)}`),
    ...formatNamedResource("skill", skills, colWidth, detailExpanded, theme),
    ...formatNamedResource("mcp", mcpItems, colWidth, detailExpanded, theme),
  ];
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
  detailExpanded: boolean,
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
  const visibleAgents = detailExpanded ? snapshot.agents : snapshot.agents.slice(0, MAX_SUBAGENT_DEFS);
  for (const agent of visibleAgents) {
    seenAgents.add(agent.id);
    const agentTasks = tasksByAgent.get(agent.id) ?? [];
    const hasRunning = agentTasks.some((t) => t.status === "running" || t.status === "pending");
    const marker = hasRunning ? theme.fg("warning", "●") : theme.fg("dim", "○");
    const label = shortAgentLabel(agent.id);
    const metaMaxWidth = Math.max(10, colWidth - visibleWidth(label) - 3);
    const meta = formatModelAndLevel(agent.model, agent.thinkingLevel, metaMaxWidth);
    const metaPart = meta ? ` ${theme.fg("dim", meta)}` : "";
    lines.push(`${marker} ${label}${metaPart}`);

    const visibleTasks = detailExpanded ? agentTasks : agentTasks.slice(0, MAX_TASKS_PER_AGENT);
    for (const task of visibleTasks) {
      lines.push(formatTaskChildLine(task, now, theme));
    }
  }

  for (const [agentId, agentTasks] of tasksByAgent) {
    if (seenAgents.has(agentId)) continue;
    const hasRunning = agentTasks.some((t) => t.status === "running" || t.status === "pending");
    const marker = hasRunning ? theme.fg("warning", "●") : theme.fg("dim", "○");
    lines.push(`${marker} ${shortAgentLabel(agentId)}`);
    const visibleTasks = detailExpanded ? agentTasks : agentTasks.slice(0, MAX_TASKS_PER_AGENT);
    for (const task of visibleTasks) {
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
  detailExpanded = false,
): string[] {
  const lineWidth = Math.max(24, width);
  const showGit = snapshot.git.isRepo;

  if ((showGit && lineWidth < THREE_COL_MIN_WIDTH) || (!showGit && lineWidth < TWO_COL_MIN_WIDTH)) {
    const rows = [
      ...(showGit ? [...formatGitColumn(snapshot, lineWidth, detailExpanded, theme), ""] : []),
      ...formatMainAgentColumn(snapshot, lineWidth, detailExpanded, theme),
      "",
      ...formatSubagentsColumn(snapshot, lineWidth, now, detailExpanded, theme),
    ];
    return frameRows("Monitor", rows, lineWidth, detailExpanded, theme);
  }

  const divider = theme.fg("dim", " │ ");
  if (!showGit) {
    const colContentWidth = Math.max(18, lineWidth - 3);
    const col1Width = Math.floor(colContentWidth * 0.52);
    const col2Width = colContentWidth - col1Width;

    const col1 = formatMainAgentColumn(snapshot, col1Width, detailExpanded, theme);
    const col2 = formatSubagentsColumn(snapshot, col2Width, now, detailExpanded, theme);
    const rowCount = Math.max(col1.length, col2.length);
    const rows: string[] = [];
    for (let i = 0; i < rowCount; i += 1) {
      rows.push(`${padCell(col1[i] ?? "", col1Width)}${divider}${padCell(col2[i] ?? "", col2Width)}`);
    }
    return frameRows("Monitor", rows, lineWidth, detailExpanded, theme);
  }

  const colContentWidth = Math.max(18, lineWidth - 6);
  const col1Width = Math.floor(colContentWidth * 0.34);
  const col2Width = Math.floor(colContentWidth * 0.32);
  const col3Width = colContentWidth - col1Width - col2Width;

  const col1 = formatGitColumn(snapshot, col1Width, detailExpanded, theme);
  const col2 = formatMainAgentColumn(snapshot, col2Width, detailExpanded, theme);
  const col3 = formatSubagentsColumn(snapshot, col3Width, now, detailExpanded, theme);
  const rowCount = Math.max(col1.length, col2.length, col3.length);

  const rows: string[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const c1 = padCell(col1[i] ?? "", col1Width);
    const c2 = padCell(col2[i] ?? "", col2Width);
    const c3 = padCell(col3[i] ?? "", col3Width);
    rows.push(`${c1}${divider}${c2}${divider}${c3}`);
  }

  return frameRows("Monitor", rows, lineWidth, detailExpanded, theme);
}

export function createMonitorPanelComponent(
  getSnapshot: () => MonitorSnapshot,
  isDetailExpanded: () => boolean,
  onToggleDetail: () => void,
  theme: Theme,
): Component & {
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
} {
  return {
    invalidate() {},
    render(width: number): string[] {
      return renderMonitorPanel(getSnapshot(), theme, width, Date.now(), isDetailExpanded());
    },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.type === "click" && event.button === "left" && event.y === 0 && event.x >= event.width - 10) {
        onToggleDetail();
        return { handled: true, render: true };
      }
      return undefined;
    },
  };
}
