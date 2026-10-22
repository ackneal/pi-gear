import { keyText } from "@earendil-works/pi-coding-agent";
import type { StepStatus, TaskState } from "../../context/state/types.ts";
import { sanitizeDisplayText, truncateToWidth, visibleWidth, wrapDisplayText } from "./display.ts";

export type PlanTheme = { fg(color: "muted" | "error" | "customMessageLabel" | "customMessageText" | "dim", text: string): string; bold(text: string): string };

function symbol(status: StepStatus): string {
  return status === "done" ? "✓" : status === "in_progress" ? "●" : "○";
}

function collapsed(state: TaskState | undefined, width: number): string {
  const hint = ` (${sanitizeDisplayText(keyText("app.tools.expand"))} to expand)`;
  if (!state) return truncateToWidth("[plan] Empty", width, "…");

  const done = state.steps.filter((step) => step.status === "done").length;
  const active = state.steps.filter((step) => step.status === "in_progress");
  const step = active[0] ?? state.steps.find((step) => step.status === "pending") ?? state.steps.at(-1);
  const prefix = step ? `[plan] #${step.id} ` : "[plan] ";
  const suffix = `${active.length > 1 ? ` +${active.length - 1} active` : ""} · ${done}/${state.steps.length} complete${state.findings.length ? ` · ${state.findings.length} finding${state.findings.length === 1 ? "" : "s"}` : ""}${hint}`;
  const available = width - visibleWidth(prefix + suffix);
  const outcome = sanitizeDisplayText(step?.outcome ?? state.goal);

  if (available >= 1) return prefix + truncateToWidth(outcome, available, "…") + suffix;
  return truncateToWidth(prefix + suffix.trimStart(), width, "…");
}

export function formatPlanSnapshotLines(state: TaskState | undefined, expanded: boolean, width: number): string[] {
  width = Math.max(0, Math.floor(width));
  if (!expanded) return [collapsed(state, width)];
  const lines: string[] = [];
  const text = (value: string, prefix = "", continuation = "") => {
    lines.push(...wrapDisplayText(value, prefix, continuation, width).map((line) => truncateToWidth(line, width, "…")));
  };

  text(state ? "[plan]" : "[plan] Empty");
  if (!state) return lines;
  text("Goal");
  text(state.goal);
  lines.push("");
  text("Progress");
  text(`${state.steps.filter((step) => step.status === "done").length}/${state.steps.length} complete`);
  lines.push("");
  text("Steps");
  if (!state.steps.length) text("None");
  for (const step of state.steps) {
    text(`#${step.id} ${step.outcome}`, `${symbol(step.status)} `, "  ");
    text(`Status: ${step.status}`, "  ", "  ");
    text(`Done when: ${step.doneWhen}`, "  ", "  ");
    if (step !== state.steps.at(-1)) lines.push("");
  }
  for (const [heading, values] of [["Constraints", state.constraints], ["Findings", state.findings]] as const) {
    if (!values.length) continue;
    lines.push("");
    text(heading);
    for (const value of values) text(value, "• ", "  ");
  }
  return lines;
}

export function formatPlanSnapshot(state: TaskState | undefined, expanded: boolean, theme: PlanTheme, width: number = 76): string {
  return formatPlanSnapshotLines(state, expanded, width).map((line, index) => {
    if (index === 0) {
      const label = line.startsWith("[plan]") ? "[plan]" : line;
      const rest = line.slice(label.length);
      const metadata = rest.search(/ · \d+\/\d+ complete| \([^)]* to expand\)/);
      return theme.bold(theme.fg("customMessageLabel", label)) + (metadata < 0
        ? theme.fg("customMessageText", rest)
        : theme.fg("customMessageText", rest.slice(0, metadata)) + theme.fg("dim", rest.slice(metadata)));
    }
    const muted = /^(Goal|Progress|Steps|Constraints|Findings|None)$/.test(line) || /^\s*(Status:|Done when:|\d+\/\d+ complete)/.test(line);
    return theme.fg(muted ? "muted" : "customMessageText", line);
  }).join("\n");
}

export function formatPlanFinding(finding: string, expanded: boolean, theme: PlanTheme, width = 76): string {
  const text = sanitizeDisplayText(finding);
  const prefix = "[plan] Finding · ";
  const hint = ` (${sanitizeDisplayText(keyText("app.tools.expand"))} to expand)`;
  const long = visibleWidth(prefix + text) > width;
  const lines = expanded
    ? [truncateToWidth(prefix.trimEnd(), width, "…"), ...wrapDisplayText(text, "", "", width)]
    : [long ? truncateToWidth(prefix + text, Math.max(0, width - visibleWidth(hint)), "…") + hint : prefix + text];
  return lines.map((line, index) => {
    line = truncateToWidth(line, width, "…");
    return index === 0 && line.startsWith("[plan]")
      ? theme.bold(theme.fg("customMessageLabel", "[plan]")) + theme.fg("customMessageText", line.slice(6))
      : theme.fg("customMessageText", line);
  }).join("\n");
}
