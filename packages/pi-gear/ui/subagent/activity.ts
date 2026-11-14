import { stripVTControlCharacters } from "node:util";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TaskViewSnapshot } from "./types.ts";
import { readableActivityName } from "./text-policy.ts";
import type { Theme } from "./format.ts";

const TARGET_ARG_KEYS = ["path", "file_path", "filepath", "command", "pattern", "query", "url"] as const;

function oneLine(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
}

function extractTarget(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;

  for (const key of TARGET_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string") {
      const cleaned = oneLine(value);
      if (cleaned) return cleaned;
    }
  }

  if (Array.isArray(args.urls)) {
    for (const value of args.urls) {
      if (typeof value === "string") {
        const cleaned = oneLine(value);
        if (cleaned) return cleaned;
      }
    }
  }

  if (typeof args.action === "string") {
    const cleaned = oneLine(args.action);
    if (cleaned) return cleaned;
  }

  return undefined;
}

/** Activities are retained in tool-start order by the runtime; completion updates them in place. */
export function expandedActivity(run: TaskViewSnapshot | undefined, theme: Theme, width: number): string {
  if (!run) return "";
  const tools = run.activities.filter((item) => item.kind === "tool");
  const omitted = run.toolActivitiesTruncated ?? run.activitiesTruncated;
  if (!tools.length && !omitted) return "";

  const lines = [theme.fg("muted", "Tool activity")];
  if (omitted) lines.push(theme.fg("muted", truncateToWidth("Earlier tool activity omitted", width)));
  for (const tool of tools) {
    const status = tool.status === "running" && run.status !== "running"
      ? run.status === "unknown" ? "unknown" : "interrupted"
      : tool.status;
    const target = extractTarget(tool.args);
    const name = readableActivityName(oneLine(tool.name));
    const row = `${name} · ${status}${target ? ` · ${target}` : ""}`;
    lines.push(theme.fg(status === "error" ? "error" : status === "success" ? "success" : "muted", truncateToWidth(row, width)));
  }
  return `\n\n${lines.join("\n")}`;
}
