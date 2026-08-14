import type { SubagentItem, SubagentPresentation, SubagentRun } from "../../subagents/runtime/types.ts";

export type Theme = { fg(color: "toolTitle" | "muted" | "error" | "thinkingText" | "toolOutput" | "text", text: string): string; bold(text: string): string };
export type SubagentRendererProfile = { id: string; label: string; presentation?: SubagentPresentation };

const STATUS_ICON = { running: "◌", success: "✓", error: "✗", aborted: "✗" } as const;
const INTERNAL_ID = /\b(?:call|toolu|tool|msg|run)_[A-Za-z0-9_-]+\b|\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b|\b[0-9a-f]{24,}\b/gi;
const JSON_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
const USEFUL_JSON_KEYS = new Set(["text", "content", "result", "output", "message", "detail", "details", "summary", "answer", "title", "snippet", "description"]);

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function profileLabel(profile: SubagentRendererProfile): string {
  return titleCase(profile.label).trim() || titleCase(profile.id) || "Subagent";
}

function activityPhrase(profile: SubagentRendererProfile, phrase: "starting" | "complete" | "drafting" | "failed" | "aborted", fallback: string): string {
  return profile.presentation?.activity?.[phrase] ?? fallback;
}

function readableProvider(name: string): string {
  const normalized = name.toLowerCase();
  if (/(?:^|__|[_-])exa(?:__|[_-]|$)/.test(normalized)) return "Exa";
  if (/(?:^|__|[_-])context7(?:__|[_-]|$)/.test(normalized)) return "Context7";
  if (/(?:^|__|[_-])gh_grep(?:__|[_-]|$)|(?:^|__|[_-])searchgithub(?:__|[_-]|$)/.test(normalized)) return "GitHub grep";
  const parts = name.split(/__|::|\//).filter(Boolean);
  const provider = (parts.length > 1 && /^mcp$/i.test(parts[0] ?? "") ? parts[1] : parts[0]) ?? name;
  return provider.replace(/^(?:mcp|tool)[_-]*/i, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Tool";
}

function cleanPlainText(value: string): string {
  return value.replace(INTERNAL_ID, "").replace(/^\s*thinking:\s*/i, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

function stringsFromJson(value: unknown, collected: string[] = []): string[] {
  if (typeof value === "string") {
    const text = cleanPlainText(value);
    if (text) collected.push(text);
    return collected;
  }
  if (Array.isArray(value)) {
    for (const entry of value) stringsFromJson(entry, collected);
    return collected;
  }
  if (typeof value !== "object" || value === null) return collected;
  for (const [key, entry] of Object.entries(value)) if (USEFUL_JSON_KEYS.has(key.toLowerCase())) stringsFromJson(entry, collected);
  return collected;
}

function usefulText(value: string | undefined): string {
  if (!value) return "";
  const candidate = value.trim().match(JSON_FENCE)?.[1] ?? value.trim();
  if (/^[{[]/.test(candidate)) {
    try { return [...new Set(stringsFromJson(JSON.parse(candidate)))].join("\n"); } catch { return ""; }
  }
  return cleanPlainText(value);
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

function formatDuration(run: SubagentRun | undefined): string {
  const elapsed = Math.max(0, (run?.finishedAt ?? Date.now()) - (run?.startedAt ?? Date.now()));
  if (elapsed < 1_000) return `${elapsed}ms`;
  if (elapsed < 60_000) return `${(elapsed / 1_000).toFixed(elapsed < 10_000 ? 1 : 0).replace(/\.0$/, "")}s`;
  const seconds = Math.floor(elapsed / 1_000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function metadata(run: SubagentRun | undefined, profile: SubagentRendererProfile): string {
  const tools = run?.items.filter((item): item is Extract<SubagentItem, { kind: "tool" }> => item.kind === "tool") ?? [];
  if (!tools.length) {
    const hasThought = run?.items.some((item) => item.kind === "thinking" && Boolean(usefulText(item.text)));
    const name = profileLabel(profile);
    const label = hasThought ? "Thinking" : run?.status === "success" ? activityPhrase(profile, "complete", `${name} complete`) : run?.status === "error" || run?.status === "aborted" ? failure(run, profile) : activityPhrase(profile, "starting", `Starting ${name.toLowerCase()}`);
    return `${compact(label)} · ${formatDuration(run)}`;
  }
  const completed = tools.filter((item) => item.status === "success").length;
  const failed = tools.filter((item) => item.status === "error").length;
  return [`${tools.length} tools`, `${completed} ok`, ...(failed ? [`${failed} failed`] : []), formatDuration(run)].join(" · ");
}

function connected(text: string, prefix: string, theme: Theme, color: "thinkingText" | "toolOutput" | "error"): string[] {
  return text.split("\n").map((line) => theme.fg(color, `${prefix}${line}`));
}

export function collapsed(run: SubagentRun | undefined, profile: SubagentRendererProfile, theme: Theme, icon: string = STATUS_ICON[run?.status ?? "running"]): string {
  const status = run?.status ?? "running";
  const title = theme.bold(theme.fg("toolTitle", `${titleCase(profile.label) || titleCase(profile.id) || "Subagent"} Task`));
  const iconColor = status === "error" || status === "aborted" ? "error" : status === "success" ? "toolOutput" : "muted";
  return `${theme.fg(iconColor, icon)} ${title}${theme.fg("muted", ` · ${compact(activity(run, profile))}`)}\n${theme.fg("muted", `  ↳ ${metadata(run, profile)}`)}`;
}

export function expanded(run: SubagentRun, profile: SubagentRendererProfile, theme: Theme, icon?: string): string {
  const lines = collapsed(run, profile, theme, icon).split("\n");
  for (const item of run.items) {
    if (item.kind === "thinking") {
      const thought = usefulText(item.text);
      if (thought) lines.push(...connected(thought, "  │ ✦ ", theme, "thinkingText"));
      continue;
    }
    const color = item.status === "error" ? "error" : "toolOutput";
    lines.push(theme.fg(color, `  │ ${STATUS_ICON[item.status]} ${readableProvider(item.name)}`));
    const detail = usefulText(item.result);
    if (detail) lines.push(...connected(detail, "  │   ", theme, color));
  }
  const finalAnswer = usefulText(run.result) || usefulText(run.error) || (run.status === "success" ? activityPhrase(profile, "complete", `${profileLabel(profile)} complete`) : failure(run, profile));
  lines.push(theme.bold(theme.fg("text", "  ╰ Result")));
  lines.push(...connected(finalAnswer, "     ", theme, run.error ? "error" : "toolOutput"));
  return lines.join("\n");
}
