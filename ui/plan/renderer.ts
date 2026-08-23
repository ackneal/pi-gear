import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TaskState, TaskStateDetails } from "../../context/state/types.ts";
import { sanitizeDisplayText } from "./display.ts";
import { formatPlanChange, formatPlanRemoval, formatPlanSnapshot, formatPlanSnapshotLines, type PlanTheme } from "./format.ts";

type RenderContext = { args?: unknown; lastComponent?: unknown; isError?: boolean };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function textComponent(text: string, context: RenderContext): Text {
  const component = context.lastComponent instanceof Text
    ? context.lastComponent
    : new Text("");
  component.setText(text);
  return component;
}

function contentText(result: AgentToolResult<TaskStateDetails>): string {
  const content = result.content.find((entry) => entry.type === "text")?.text ?? "Plan update failed";
  return sanitizeDisplayText(content.split("\n")[0] ?? "Plan update failed");
}

export class PlanSnapshotComponent {
  private state: TaskState | undefined;
  private expanded: boolean;
  private theme: PlanTheme;

  constructor(state: TaskState | undefined, expanded: boolean, theme: PlanTheme) {
    this.state = state;
    this.expanded = expanded;
    this.theme = theme;
  }

  update(state: TaskState | undefined, expanded: boolean, theme: PlanTheme): void {
    this.state = state;
    this.expanded = expanded;
    this.theme = theme;
  }

  render(width: number): string[] {
    return formatPlanSnapshotLines(this.state, this.expanded, width).map((line, index) =>
      index === 0
        ? this.theme.bold(this.theme.fg("toolTitle", line))
        : this.theme.fg("text", line),
    );
  }
  invalidate(): void {}
}

function isSnapshot(details: TaskStateDetails | undefined): boolean {
  return details?.action === "set_plan"
    || details?.action === "add_step"
    || details?.action === "revise_step"
    || details?.action === "remove_step"
    || details?.action === "show";
}

function successful(details: TaskStateDetails | undefined, expanded: boolean, theme: PlanTheme): string {
  if (!details) return "";
  if (isSnapshot(details)) return formatPlanSnapshot(details.state ?? undefined, expanded, theme);
  const params = record(details.params);
  switch (details.action) {
    case "add_finding": return typeof params?.finding === "string" ? formatPlanChange("Finding", params.finding, theme) : "";
    case "remove_finding": return typeof params?.finding === "string" ? formatPlanRemoval("Finding", params.finding, theme) : "";
    case "add_constraint": return typeof params?.constraint === "string" ? formatPlanChange("Constraint", params.constraint, theme) : "";
    case "remove_constraint": return typeof params?.constraint === "string" ? formatPlanRemoval("Constraint", params.constraint, theme) : "";
    case "clear": return theme.fg("muted", "Plan cleared");
    default: return "";
  }
}

export function renderCall(_args: Record<string, unknown>, _theme: PlanTheme, context: RenderContext): Text { return textComponent("", context); }
export function formatPlanResult(result: AgentToolResult<TaskStateDetails>, options: ToolRenderResultOptions, theme: PlanTheme, isError: boolean = false): string {
  return isError ? `${theme.fg("error", "✗")} ${theme.bold(theme.fg("toolTitle", "Plan"))}${theme.fg("error", ` · ${contentText(result)}`)}` : successful(result.details, options.expanded, theme);
}
export function renderResult(result: AgentToolResult<TaskStateDetails>, options: ToolRenderResultOptions, theme: PlanTheme, context: RenderContext): Text | PlanSnapshotComponent {
  if (!context.isError && isSnapshot(result.details)) {
    const component = context.lastComponent instanceof PlanSnapshotComponent ? context.lastComponent : new PlanSnapshotComponent(result.details?.state ?? undefined, options.expanded, theme);
    component.update(result.details?.state ?? undefined, options.expanded, theme);
    return component;
  }
  return textComponent(formatPlanResult(result, options, theme, Boolean(context.isError)), context);
}
