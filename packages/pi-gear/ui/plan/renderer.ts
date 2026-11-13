import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { TaskState, TaskStateDetails } from "../../context/state/types.ts";
import { sanitizeDisplayText, visibleWidth } from "./display.ts";
import { formatPlanFinding, formatPlanSnapshot, type PlanTheme } from "./format.ts";

type TranscriptTheme = PlanTheme & { bg(color: "customMessageBg", text: string): string };

const backgrounds = new WeakMap<Component, TranscriptTheme>();

function transcript<T extends Component>(component: T, theme: TranscriptTheme): T {
  if (!backgrounds.has(component)) {
    const render = component.render.bind(component);
    component.render = (width) => {
      const available = Math.max(0, Math.floor(width));
      if (!available) return [];
      const inset = available >= 3 ? 1 : 0;
      const lines = render(Math.max(1, available - inset * 2));
      if (!lines.length) return [];
      return ["", ...lines, ""].map((line) => {
        const padded = " ".repeat(inset) + line;
        return backgrounds.get(component)!.bg("customMessageBg", padded + " ".repeat(Math.max(0, available - visibleWidth(padded))));
      });
    };
  }
  backgrounds.set(component, theme);
  return component;
}

type RenderContext = { args?: unknown; lastComponent?: unknown; isError?: boolean };

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
  private state: TaskState | string | undefined;
  private expanded: boolean;
  private theme: TranscriptTheme;

  constructor(state: TaskState | string | undefined, expanded: boolean, theme: TranscriptTheme) {
    this.state = state;
    this.expanded = expanded;
    this.theme = theme;
  }

  update(state: TaskState | string | undefined, expanded: boolean, theme: TranscriptTheme): void {
    this.state = state;
    this.expanded = expanded;
    this.theme = theme;
  }

  render(width: number): string[] {
    const available = Math.max(0, Math.floor(width));
    if (available === 0) return [];
    const inset = available >= 3 ? 1 : 0;
    const content = typeof this.state === "string"
      ? formatPlanFinding(this.state, this.expanded, this.theme, Math.max(1, available - inset * 2))
      : formatPlanSnapshot(this.state, this.expanded, this.theme, Math.max(1, available - inset * 2));
    return ["", ...content.split("\n"), ""].map((line) => {
      const padded = " ".repeat(inset) + line;
      const filled = padded + " ".repeat(Math.max(0, available - visibleWidth(padded)));
      return this.theme.bg("customMessageBg", filled);
    });
  }
  invalidate(): void {}
}

function isSnapshot(details: TaskStateDetails | undefined): boolean {
  return details?.action === "set_plan" || details?.action === "show";
}

function findingText(result: AgentToolResult<TaskStateDetails>): string | undefined {
  if (result.details?.action !== "add_finding" || contentText(result) === "Finding already recorded") return undefined;
  const finding = result.details.params.finding;
  return typeof finding === "string" ? finding : undefined;
}

function successful(result: AgentToolResult<TaskStateDetails>, expanded: boolean, theme: PlanTheme): string {
  const details = result.details;
  if (!details) return "";
  if (isSnapshot(details)) return formatPlanSnapshot(details.state ?? undefined, expanded, theme);
  const finding = findingText(result);
  return finding === undefined ? "" : formatPlanFinding(finding, expanded, theme);
}

export function renderCall(_args: Record<string, unknown>, _theme: TranscriptTheme, context: RenderContext): Text { return textComponent("", context); }
export function formatPlanResult(result: AgentToolResult<TaskStateDetails>, options: ToolRenderResultOptions, theme: PlanTheme, isError: boolean = false): string {
  return isError ? `${theme.bold(theme.fg("customMessageLabel", "[plan]"))}${theme.fg("error", ` ✗ ${contentText(result)}`)}` : successful(result, options.expanded, theme);
}
export function renderResult(result: AgentToolResult<TaskStateDetails>, options: ToolRenderResultOptions, theme: TranscriptTheme, context: RenderContext): Text | PlanSnapshotComponent {
  const finding = findingText(result);
  if (!context.isError && (isSnapshot(result.details) || finding !== undefined)) {
    const component = context.lastComponent instanceof PlanSnapshotComponent ? context.lastComponent : new PlanSnapshotComponent(finding ?? result.details?.state ?? undefined, options.expanded, theme);
    component.update(finding ?? result.details?.state ?? undefined, options.expanded, theme);
    return component;
  }
  return transcript(textComponent(formatPlanResult(result, options, theme, Boolean(context.isError)), context), theme);
}
