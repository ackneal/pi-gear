import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Theme } from "../subagent/format.ts";
import {
  formatCwd,
  formatTokens,
  type MonitorSnapshot,
  type PanelMode,
} from "./state.ts";

function formatDurationCompact(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return remSeconds === 0 ? `${minutes}m` : `${minutes}m ${remSeconds}s`;
}

function formatTurnsAndToolsSummary(snapshot: MonitorSnapshot): string | undefined {
  const turns = snapshot.sessionUsage.turns;
  const { total, errors, activeTools } = snapshot.tools;
  if (turns === 0 && total === 0 && activeTools.length === 0) return undefined;

  const activeSuffix = activeTools.length > 0 ? ` (+${activeTools.length})` : "";
  const rateSuffix = total > 0
    ? ` (${Math.round(((total - errors) / total) * 100)}%)`
    : "";
  return `↻ step ${turns} · ⚙ activity ${total}${activeSuffix}${rateSuffix}`;
}

function shortAgentLabel(id: string): string {
  return id.startsWith("gear:") ? id.slice("gear:".length) : id;
}

function formatRunningAgentsSummary(snapshot: MonitorSnapshot, now: number): string | undefined {
  const running = snapshot.tasks.filter((task) => task.status === "running" || task.status === "pending");
  if (running.length === 0) return undefined;

  let longestMs = 0;
  let focusTask = running[0];
  for (const task of running) {
    if (task.startedAt !== undefined) {
      const elapsed = now - task.startedAt;
      if (elapsed >= longestMs) {
        longestMs = elapsed;
        focusTask = task;
      }
    }
  }
  const agentLabel = focusTask ? shortAgentLabel(focusTask.agentId) : "agent";
  const prefix = running.length === 1 ? `◌ ${agentLabel}` : `◌ ${running.length} ${agentLabel}`;
  return longestMs > 0 ? `${prefix} (${formatDurationCompact(longestMs)})` : prefix;
}

function formatWorkspaceBranch(snapshot: MonitorSnapshot): string {
  let base = formatCwd(snapshot.cwd, snapshot.home);
  const branch = snapshot.git.branch;
  if (branch) {
    const { totalInsertions, totalDeletions, files } = snapshot.git;
    const diffSummary = totalInsertions > 0 || totalDeletions > 0
      ? ` +${totalInsertions} -${totalDeletions}`
      : files.length > 0
        ? "*"
        : "";
    base = `${base} (${branch}${diffSummary})`;
  }
  if (snapshot.sessionName) {
    base = `${base} • ${snapshot.sessionName}`;
  }
  return base;
}

function panelModeIcon(mode: PanelMode): string {
  if (mode === "full") return "▾+";
  if (mode === "compact") return "▾";
  return "▴";
}

export function renderFooterLine1(
  snapshot: MonitorSnapshot,
  theme: Theme,
  width: number,
  panelMode: PanelMode,
  now = Date.now(),
): string {
  const sep = theme.fg("dim", " │ ");
  const parts: string[] = [
    theme.fg("dim", formatWorkspaceBranch(snapshot)),
    theme.fg("accent", snapshot.activeAgent),
  ];

  const runningText = formatRunningAgentsSummary(snapshot, now);
  if (runningText) {
    parts.push(theme.fg("warning", runningText));
  }

  const activityText = formatTurnsAndToolsSummary(snapshot);
  if (activityText) {
    parts.push(theme.fg(snapshot.tools.activeTools.length > 0 ? "accent" : "dim", activityText));
  }

  const leftText = parts.join(sep);
  if (width < 20) {
    return truncateToWidth(leftText, width, "");
  }

  const icon = theme.fg("accent", panelModeIcon(panelMode));
  const iconWidth = visibleWidth(icon);
  const maxLeftWidth = Math.max(0, width - iconWidth - 1);
  const truncatedLeft = truncateToWidth(leftText, maxLeftWidth, theme.fg("dim", "..."));
  const padding = " ".repeat(Math.max(1, width - visibleWidth(truncatedLeft) - iconWidth));
  return `${truncatedLeft}${padding}${icon}`;
}

export function renderFooterLine2(snapshot: MonitorSnapshot, theme: Theme, width: number): string {
  const usage = snapshot.sessionUsage;
  const statsParts: string[] = [];
  if (usage.input) statsParts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) statsParts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) statsParts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) statsParts.push(`W${formatTokens(usage.cacheWrite)}`);
  if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.cacheHitRate !== undefined) {
    statsParts.push(`CH${usage.cacheHitRate.toFixed(1)}%`);
  }
  if (usage.cost || snapshot.model?.usingSubscription) {
    statsParts.push(`$${usage.cost.toFixed(3)}${snapshot.model?.usingSubscription ? " (sub)" : ""}`);
  }

  const pctValue = usage.contextPercent ?? 0;
  const pctStr = usage.contextPercent !== null ? pctValue.toFixed(1) : "?";
  const contextDisplay = `${pctStr}%/${formatTokens(usage.contextWindow)} (auto)`;
  const coloredContext = pctValue > 90
    ? theme.fg("error", contextDisplay)
    : pctValue > 70
      ? theme.fg("warning", contextDisplay)
      : contextDisplay;
  statsParts.push(coloredContext);

  let statsLeft = statsParts.join(" ");
  if (visibleWidth(statsLeft) > width) {
    statsLeft = truncateToWidth(statsLeft, width, "...");
  }
  const statsLeftWidth = visibleWidth(statsLeft);

  const model = snapshot.model;
  const modelName = model?.id || "no-model";
  let rightWithoutProvider = modelName;
  if (model?.reasoning) {
    const level = model.thinkingLevel || "off";
    rightWithoutProvider = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
  }

  const minPadding = 2;
  let rightSide = rightWithoutProvider;
  if (snapshot.availableProviderCount > 1 && model) {
    const withProvider = `(${model.provider}) ${rightWithoutProvider}`;
    if (statsLeftWidth + minPadding + visibleWidth(withProvider) <= width) {
      rightSide = withProvider;
    }
  }

  const rightWidth = visibleWidth(rightSide);
  const dimLeft = theme.fg("dim", statsLeft);
  if (statsLeftWidth + minPadding + rightWidth <= width) {
    const padding = " ".repeat(width - statsLeftWidth - rightWidth);
    return dimLeft + theme.fg("dim", padding + rightSide);
  }

  const availableForRight = width - statsLeftWidth - minPadding;
  if (availableForRight > 0) {
    const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
    const padding = " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight)));
    return dimLeft + theme.fg("dim", padding + truncatedRight);
  }
  return dimLeft;
}

export function renderMonitorFooter(
  snapshot: MonitorSnapshot,
  theme: Theme,
  width: number,
  panelMode: PanelMode,
  now = Date.now(),
): string[] {
  const lines = [
    renderFooterLine1(snapshot, theme, width, panelMode, now),
    renderFooterLine2(snapshot, theme, width),
  ];

  if (snapshot.extensionStatuses.size > 0) {
    const statusLine = Array.from(snapshot.extensionStatuses.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
      .join(" ");
    if (statusLine) {
      lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
    }
  }
  return lines;
}

export function createMonitorFooterComponent(
  getSnapshot: () => MonitorSnapshot,
  getPanelMode: () => PanelMode,
  onCyclePanelMode: () => void,
  theme: Theme,
): Component & {
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  dispose?(): void;
} {
  return {
    invalidate() {},
    render(width: number): string[] {
      return renderMonitorFooter(getSnapshot(), theme, width, getPanelMode());
    },
    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.type === "click" && event.button === "left" && event.y === 0 && event.x >= event.width - 4) {
        onCyclePanelMode();
        return { handled: true, render: true };
      }
      return undefined;
    },
  };
}
