import { stripVTControlCharacters } from "node:util";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TaskViewSnapshot } from "./types.ts";
import { readableProvider } from "./text-policy.ts";
import type { Theme } from "./format.ts";

function oneLine(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
}

/** Activities are retained in tool-start order by the runtime; completion updates them in place. */
export function expandedActivity(run: TaskViewSnapshot | undefined, theme: Theme, width: number): string {
  if (!run) return "";
  const tools = run.activities.filter((item) => item.kind === "tool");
  const omitted = run.activitiesTruncated;
  if (!tools.length && !omitted) return "";

  const lines = [theme.fg("muted", "Execution history")];
  if (omitted) lines.push(theme.fg("muted", truncateToWidth("Earlier activity omitted", width)));
  for (const tool of tools) {
    const status = tool.status === "running" && run.status !== "running"
      ? run.status === "unknown" ? "unknown" : "interrupted"
      : tool.status;
    const target = ["path", "file_path", "filepath", "command", "pattern", "action"].map((key) => tool.args?.[key]).find((value) => typeof value === "string" && value.trim());
    const name = readableProvider(oneLine(tool.name));
    const row = `${name} · ${status}${typeof target === "string" ? ` · ${oneLine(target)}` : ""}`;
    lines.push(theme.fg(status === "error" ? "error" : status === "success" ? "success" : "muted", truncateToWidth(row, width)));
  }
  return `\n\n${lines.join("\n")}`;
}
