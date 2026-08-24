import type { SubagentItem, SubagentPresentation, SubagentRun } from "../../subagents/runtime/types.ts";
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
      | "warning",
    text: string,
  ): string;
  bold(text: string): string;
};
export type SubagentRendererProfile = { id: string; label: string; presentation?: SubagentPresentation };

export const STALLED_THRESHOLD_MS = 15_000;
export const STATUS_ICON = { running: "●", success: "✓", error: "✗", aborted: "✗" } as const;

export function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatToolCount(tools: readonly Extract<SubagentItem, { kind: "tool" }>[]): string {
  const completed = tools.filter((item) => item.status === "success").length;
  const failed = tools.filter((item) => item.status === "error").length;
  return failed > 0 ? `${completed}/${tools.length} tools · ${failed} failed` : `${completed}/${tools.length} tools`;
}

function profileLabel(profile: SubagentRendererProfile): string {
  return titleCase(profile.label).trim() || titleCase(profile.id) || "Subagent";
}

function activityPhrase(profile: SubagentRendererProfile, phrase: "starting" | "complete" | "drafting" | "failed" | "aborted", fallback: string): string {
  return profile.presentation?.activity?.[phrase] ?? fallback;
}

function compact(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 99).trimEnd()}…` : oneLine;
}

function failure(run: SubagentRun, profile: SubagentRendererProfile): string {
  const error = usefulText(run.error);
  if (error) return compact(error);

  const label = profileLabel(profile);
  return run.status === "aborted" ? activityPhrase(profile, "aborted", `${label} aborted`) : activityPhrase(profile, "failed", `${label} failed`);
}

function activity(run: SubagentRun | undefined, profile: SubagentRendererProfile): string {
  const label = profileLabel(profile);
  if (!run) return activityPhrase(profile, "starting", `Starting ${label.toLowerCase()}`);
  if (run.status === "success") return activityPhrase(profile, "complete", `${label} complete`);
  if (run.status === "error" || run.status === "aborted") return failure(run, profile);
  const latestRunning = [...run.items].reverse().find((item): item is Extract<SubagentItem, { kind: "tool" }> => item.kind === "tool" && item.status === "running");
  if (latestRunning) return `${readableProvider(latestRunning.name)} running`;
  const latestThought = [...run.items].reverse().find((item): item is Extract<SubagentItem, { kind: "thinking" }> => item.kind === "thinking" && Boolean(usefulText(item.text)));
  if (latestThought) return usefulText(latestThought.text).replace(/\s+/g, " ");
  const latestCompleted = [...run.items].reverse().find((item): item is Extract<SubagentItem, { kind: "tool" }> => item.kind === "tool" && item.status !== "running");
  if (latestCompleted) return `${readableProvider(latestCompleted.name)} ${latestCompleted.status === "success" ? "complete" : "failed"}`;
  return run.result ? activityPhrase(profile, "drafting", `Drafting ${label.toLowerCase()}`) : activityPhrase(profile, "starting", `Starting ${label.toLowerCase()}`);
}

export function idleDuration(run: SubagentRun | undefined, now = Date.now()): number {
  if (run?.status !== "running") return 0;
  return Math.max(0, now - (run.lastActivityAt ?? run.startedAt));
}

function runDuration(run: SubagentRun | undefined, now = Date.now()): number {
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

export function formatUsage(usage: SubagentRun["usage"]): string | undefined {
  if (!usage) return undefined;
  const inTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const outTokens = usage.output ?? 0;
  const totalCost = usage.cost?.total ?? 0;
  return `↑${formatTokens(inTokens)} ↓${formatTokens(outTokens)} · ${formatCost(totalCost)}`;
}

export function formatDuration(durationMs: number): string {
  const elapsed = Math.max(0, durationMs);
  if (elapsed < 1_000) return `${elapsed}ms`;
  if (elapsed < 60_000) return `${(elapsed / 1_000).toFixed(elapsed < 10_000 ? 1 : 0).replace(/\.0$/, "")}s`;
  const seconds = Math.floor(elapsed / 1_000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function metadata(run: SubagentRun | undefined, profile: SubagentRendererProfile, now = Date.now()): string {
  const tools = run?.items.filter((item): item is Extract<SubagentItem, { kind: "tool" }> => item.kind === "tool") ?? [];
  let toolStr: string;
  if (!tools.length) {
    const hasThought = run?.items.some((item) => item.kind === "thinking" && Boolean(usefulText(item.text)));
    const name = profileLabel(profile);
    const label = hasThought ? "Thinking" : run?.status === "success" ? activityPhrase(profile, "complete", `${name} complete`) : run?.status === "error" || run?.status === "aborted" ? failure(run, profile) : activityPhrase(profile, "starting", `Starting ${name.toLowerCase()}`);
    toolStr = compact(label);
  } else {
    toolStr = formatToolCount(tools);
  }
  const usageStr = formatUsage(run?.usage);
  const durStr = formatDuration(runDuration(run, now));
  return [toolStr, ...(usageStr ? [usageStr] : []), durStr].join(" · ");
}

export function collapsed(run: SubagentRun | undefined, profile: SubagentRendererProfile, theme: Theme, icon: string = STATUS_ICON[run?.status ?? "running"], now = Date.now()): string {
  const status = run?.status ?? "running";
  const title = theme.bold(theme.fg("toolTitle", `${titleCase(profile.label) || titleCase(profile.id) || "Subagent"} Task`));
  const iconColor = status === "error" || status === "aborted" ? "error" : status === "success" ? "toolOutput" : "muted";
  const idle = idleDuration(run, now);
  const idleSuffix = status === "running" && idle >= STALLED_THRESHOLD_MS ? ` · idle ${formatDuration(idle)}` : "";
  return ` ${theme.fg(iconColor, icon)} ${title}${theme.fg("muted", ` · ${compact(activity(run, profile))}`)}\n${theme.fg("muted", `   ↳ ${metadata(run, profile, now)}${idleSuffix}`)}`;
}
