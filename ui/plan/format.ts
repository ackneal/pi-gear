import type { TaskState, TodoStatus } from "../../context/state/types.ts";
import { sanitizeDisplayText, truncateToWidth, wrapDisplayText } from "./display.ts";

export type PlanTheme = { fg(color: "toolTitle" | "muted" | "toolOutput" | "error" | "text", text: string): string; bold(text: string): string };

function symbol(status: TodoStatus): string { return status === "done" ? "✓" : status === "in_progress" ? "●" : "○"; }

function section(lines: string[], heading: string, values: readonly string[], width: number): void {
  if (!values.length) return;
  lines.push(truncateToWidth(`  ${heading}`, width, "…"));
  for (const value of values) lines.push(...wrapDisplayText(value, "    • ", "      ", width));
}

export function formatPlanSnapshotLines(state: TaskState | undefined, expanded: boolean, width: number): string[] {
  if (!state) return [truncateToWidth("Plan · Empty", width, "…")];
  const done = state.todos.filter((todo) => todo.status === "done").length;
  const lines = [truncateToWidth(`Plan · ${done}/${state.todos.length} complete`, width, "…")];
  if (expanded) section(lines, "Goal", [state.goal], width);
  lines.push(truncateToWidth("  Steps", width, "…"));
  for (const todo of state.todos) {
    lines.push(...wrapDisplayText(`#${todo.id} ${todo.text}`, `    ${symbol(todo.status)} `, "      ", width));
    if (expanded) lines.push(...wrapDisplayText(`Done when: ${todo.doneWhen}`, "      ", "      ", width));
  }
  if (expanded) {
    section(lines, "Constraints", state.constraints, width);
    section(lines, "Findings", state.findings, width);
  }
  return lines;
}

export function formatPlanSnapshot(state: TaskState | undefined, expanded: boolean, theme: PlanTheme, width: number = 76): string {
  return formatPlanSnapshotLines(state, expanded, width).map((line, index) => index === 0 ? theme.bold(theme.fg("toolTitle", line)) : theme.fg("text", line)).join("\n");
}

export function formatPlanChange(label: string, value: string, theme: PlanTheme): string {
  return `${theme.fg("toolOutput", "✓")} ${theme.bold(theme.fg("toolTitle", label))}${theme.fg("text", ` · ${sanitizeDisplayText(value)}`)}`;
}

export function formatPlanRemoval(label: string, value: string, theme: PlanTheme): string {
  return `${theme.fg("muted", "✓")} ${theme.bold(theme.fg("toolTitle", `${label} removed`))}${theme.fg("text", ` · ${sanitizeDisplayText(value)}`)}`;
}
