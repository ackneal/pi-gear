import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import type { SubagentActivity, SubagentPresentation } from "../../subagents/runtime/types.ts";
import type { TaskViewSnapshot } from "./types.ts";
import { readableProvider, usefulText } from "./text-policy.ts";

export type Theme = {
  fg(
    color:
      | "toolTitle"
      | "muted"
      | "error"
      | "thinkingText"
      | "toolOutput"
      | "text"
      | "accent"
      | "border"
      | "dim"
      | "warning"
      | "success",
    text: string,
  ): string;
  bold(text: string): string;
};
export type SubagentDisplayMetadata = { id: string; label: string; presentation?: SubagentPresentation };

export const STALLED_THRESHOLD_MS = 15_000;
export const STATUS_ICON = { running: "◌", success: "●", error: "✗", aborted: "✗", unknown: "?" } as const;

export function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatToolCount(tools: readonly Extract<SubagentActivity, { kind: "tool" }>[]): string {
  const completed = tools.filter((item) => item.status === "success").length;
  const failed = tools.filter((item) => item.status === "error").length;
  return failed > 0 ? `${completed}/${tools.length} tools · ${failed} failed` : `${completed}/${tools.length} tools`;
}

function metadataLabel(metadata: SubagentDisplayMetadata): string {
  return titleCase(metadata.label).trim() || titleCase(metadata.id) || "Subagent";
}

function activityPhrase(metadata: SubagentDisplayMetadata, phrase: "starting" | "complete" | "drafting" | "failed" | "aborted", fallback: string): string {
  return metadata.presentation?.activity?.[phrase] ?? fallback;
}

function compact(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 99).trimEnd()}…` : oneLine;
}

function failure(run: TaskViewSnapshot, metadata: SubagentDisplayMetadata): string {
  const error = usefulText(run.error);
  if (error) return compact(error);

  const label = metadataLabel(metadata);
  return run.status === "aborted" ? activityPhrase(metadata, "aborted", `${label} aborted`) : activityPhrase(metadata, "failed", `${label} failed`);
}

function activity(run: TaskViewSnapshot | undefined, metadata: SubagentDisplayMetadata): string {
  const label = metadataLabel(metadata);
  if (!run) return activityPhrase(metadata, "starting", `Starting ${label.toLowerCase()}`);
  if (run.status === "unknown") return "Status unavailable";
  if (run.status === "success") return activityPhrase(metadata, "complete", `${label} complete`);
  if (run.status === "error" || run.status === "aborted") return failure(run, metadata);
  const latestRunning = [...run.activities].reverse().find((item): item is Extract<SubagentActivity, { kind: "tool" }> => item.kind === "tool" && item.status === "running");
  if (latestRunning) return `${readableProvider(latestRunning.name)} running`;
  const latestThought = [...run.activities].reverse().find((item): item is Extract<SubagentActivity, { kind: "thinking" }> => item.kind === "thinking" && Boolean(usefulText(item.text)));
  if (latestThought) return usefulText(latestThought.text).replace(/\s+/g, " ");
  const latestCompleted = [...run.activities].reverse().find((item): item is Extract<SubagentActivity, { kind: "tool" }> => item.kind === "tool" && item.status !== "running");
  if (latestCompleted) return `${readableProvider(latestCompleted.name)} ${latestCompleted.status === "success" ? "complete" : "failed"}`;
  return run.result ? activityPhrase(metadata, "drafting", `Drafting ${label.toLowerCase()}`) : activityPhrase(metadata, "starting", `Starting ${label.toLowerCase()}`);
}

export function idleDuration(run: TaskViewSnapshot | undefined, now = Date.now()): number {
  if (run?.status !== "running") return 0;
  return Math.max(0, now - (run.lastActivityAt ?? run.startedAt));
}

function runDuration(run: TaskViewSnapshot | undefined, now = Date.now()): number {
  return Math.max(0, (run?.finishedAt ?? now) - (run?.startedAt ?? now));
}

export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatCost(cost: number): string {
  if (cost <= 0) return "$0.000";
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatUsage(usage: TaskViewSnapshot["usage"]): string | undefined {
  if (!usage) return undefined;
  const inTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const outTokens = usage.output ?? 0;
  const totalCost = usage.cost?.total ?? 0;
  const outStr = usage.estimated ? `~${formatTokens(outTokens)}` : formatTokens(outTokens);
  return `↑${formatTokens(inTokens)} ↓${outStr} · ${formatCost(totalCost)}${usage.estimated ? " (est.)" : ""}`;
}

export function formatDuration(durationMs: number): string {
  const elapsed = Math.max(0, durationMs);
  if (elapsed < 1_000) return `${elapsed}ms`;
  if (elapsed < 60_000) return `${(elapsed / 1_000).toFixed(elapsed < 10_000 ? 1 : 0).replace(/\.0$/, "")}s`;
  const seconds = Math.floor(elapsed / 1_000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function runSummary(run: TaskViewSnapshot | undefined, metadata: SubagentDisplayMetadata, now = Date.now()): string {
  const tools = run?.activities.filter((item): item is Extract<SubagentActivity, { kind: "tool" }> => item.kind === "tool") ?? [];
  let toolStr: string;
  if (!tools.length) {
    const hasThought = run?.activities.some((item) => item.kind === "thinking" && Boolean(usefulText(item.text)));
    const name = metadataLabel(metadata);
    const label = run?.status === "unknown" ? "Status unavailable" : hasThought ? "Thinking" : run?.status === "success" ? activityPhrase(metadata, "complete", `${name} complete`) : run?.status === "error" || run?.status === "aborted" ? failure(run, metadata) : activityPhrase(metadata, "starting", `Starting ${name.toLowerCase()}`);
    toolStr = compact(label);
  } else {
    toolStr = formatToolCount(tools);
  }
  const usageStr = formatUsage(run?.usage);
  const durStr = formatDuration(runDuration(run, now));
  return [toolStr, ...(usageStr ? [usageStr] : []), durStr].join(" · ");
}

export function collapsed(run: TaskViewSnapshot | undefined, metadata: SubagentDisplayMetadata, theme: Theme, icon: string = STATUS_ICON[run?.status ?? "running"], now = Date.now(), task?: string, showActivity = true): string {
  const status = run?.status ?? "running";
  const title = theme.bold(theme.fg("toolTitle", `Agent(${metadata.id || metadataLabel(metadata)}${task ? `: ${compact(task)}` : ""})`));
  const iconColor = status === "error" || status === "aborted" ? "error" : status === "success" ? "success" : "muted";
  const idle = idleDuration(run, now);
  const idleSuffix = status === "running" && idle >= STALLED_THRESHOLD_MS ? ` · idle ${formatDuration(idle)}` : "";
  return `${theme.fg(iconColor, icon)} ${title}${showActivity ? theme.fg("muted", ` · ${compact(activity(run, metadata))}`) : ""}\n  ${theme.fg("dim", "└")} ${theme.fg("muted", `${runSummary(run, metadata, now)}${idleSuffix}`)}`;
}

export function expandedDetails(run: TaskViewSnapshot | undefined, theme: Theme, width: number): string {
  if (!run) return "";

  const lines: string[] = [];
  const result = run.result?.trim();
  if (result) {
    const markdown = new Markdown(result, 0, 0, getMarkdownTheme(), {
      color: (text) => theme.fg("text", text),
    });
    lines.push(...markdown.render(width));
  }

  const error = usefulText(run.error);
  if (error) lines.push(...error.split("\n").map((line) => theme.fg("error", line)));
  return lines.length ? `\n\n${lines.join("\n")}` : "";
}
