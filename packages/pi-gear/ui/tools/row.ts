import type { Theme } from "@earendil-works/pi-coding-agent";

export type ToolStatus = "pending" | "running" | "success" | "error";

const STATUS_MARK = {
  pending: ["dim", "·"],
  running: ["muted", "◌"],
  success: ["success", "●"],
  error: ["error", "✗"],
} as const;

export function toolStatus(context: { isError: boolean; isPartial: boolean; executionStarted?: boolean }): ToolStatus {
  if (context.isError) return "error";
  if (!context.isPartial) return "success";
  return context.executionStarted === false ? "pending" : "running";
}

export function statusMark(status: ToolStatus, theme: Theme): string {
  const [color, mark] = STATUS_MARK[status];
  return theme.fg(color, mark);
}

/** `● Name(target)` — the primary line of every tool row. */
export function titleLine(status: ToolStatus, name: string, target: string, theme: Theme): string {
  const title = theme.bold(theme.fg("toolTitle", name));
  return `${statusMark(status, theme)} ${title}${target ? theme.fg("text", `(${target})`) : ""}`;
}

/** `  └ text` — the muted secondary line below a tool title. */
export function summaryLine(text: string, theme: Theme, color: "muted" | "error" = "muted"): string {
  return `  ${theme.fg("dim", "└")} ${theme.fg(color, text)}`;
}

export function titleCase(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
