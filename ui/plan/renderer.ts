import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { padOutput } from "../tools/padding.ts";
import type { TaskState, TaskStateDetails } from "../../context/state/types.ts";
import { sanitizeDisplayText } from "./display.ts";
import { formatPlanChange, formatPlanSnapshot, formatPlanSnapshotLines, type PlanTheme } from "./format.ts";

type TranscriptTheme = PlanTheme & { bg(color: "customMessageBg", text: string): string };

const backgrounds = new WeakMap<Component, TranscriptTheme>();

function transcript<T extends Component>(component: T, theme: TranscriptTheme): T {
  if (!backgrounds.has(component)) {
    padOutput(component);
    const render = component.render.bind(component);
    component.render = (width) => render(width).map((line) =>
      new Text(line, 0, 0, (text) => backgrounds.get(component)!.bg("customMessageBg", text)).render(width)[0] ?? "",
    );
  }
  backgrounds.set(component, theme);
  return component;
}

type RenderContext = { args?: unknown; lastComponent?: unknown; isError?: boolean };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function textComponent(text: string, context: RenderContext): Text {
  const component = context.lastComponent instanceof Text
    ? context.lastComponent
    : new Text("", 0, 0);
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
    || details?.action === "update_step"
    || details?.action === "show";
}

function successful(result: AgentToolResult<TaskStateDetails>, expanded: boolean, theme: PlanTheme): string {
  const details = result.details;
  if (!details) return "";
  if (isSnapshot(details)) return formatPlanSnapshot(details.state ?? undefined, expanded, theme);
  const params = record(details.params);
  switch (details.action) {
    case "add_finding": return typeof params?.finding === "string"
      ? formatPlanChange(contentText(result) === "Finding already recorded" ? "Finding already recorded" : "Finding", params.finding, theme)
      : "";
    case "clear": return theme.fg("muted", "Plan cleared");
    default: return "";
  }
}

export function renderCall(_args: Record<string, unknown>, _theme: TranscriptTheme, context: RenderContext): Text { return textComponent("", context); }
export function formatPlanResult(result: AgentToolResult<TaskStateDetails>, options: ToolRenderResultOptions, theme: PlanTheme, isError: boolean = false): string {
  return isError ? `${theme.fg("error", "✗")} ${theme.bold(theme.fg("toolTitle", "Plan"))}${theme.fg("error", ` · ${contentText(result)}`)}` : successful(result, options.expanded, theme);
}
export function renderResult(result: AgentToolResult<TaskStateDetails>, options: ToolRenderResultOptions, theme: TranscriptTheme, context: RenderContext): Text | PlanSnapshotComponent {
  if (!context.isError && isSnapshot(result.details)) {
    const component = context.lastComponent instanceof PlanSnapshotComponent ? context.lastComponent : new PlanSnapshotComponent(result.details?.state ?? undefined, options.expanded, theme);
    component.update(result.details?.state ?? undefined, options.expanded, theme);
    return transcript(component, theme);
  }
  return transcript(textComponent(formatPlanResult(result, options, theme, Boolean(context.isError)), context), theme);
}
