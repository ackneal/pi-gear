import type { StepStatus, TaskState } from "../../context/state/types.ts";
import { sanitizeDisplayText, truncateToWidth } from "./display.ts";

export const PLAN_WIDGET_ID = "pi-gear.plan";

type WidgetTheme = {
  fg(color: "accent" | "success" | "warning" | "muted" | "dim" | "text", text: string): string;
  bold(text: string): string;
};

export type PlanWidgetView =
  | { kind: "steady"; state: TaskState }
  | { kind: "created"; state: TaskState }
  | { kind: "revised"; state: TaskState }
  | { kind: "status"; before: TaskState; state: TaskState }
  | { kind: "complete"; state: TaskState };

function symbol(status: StepStatus): string {
  return status === "done" ? "✓" : status === "in_progress" ? "●" : "○";
}

function counts(state: TaskState): string {
  return `${state.steps.filter((step) => step.status === "done").length}/${state.steps.length}`;
}

export function hasUnfinishedSteps(state: TaskState | undefined): boolean {
  return state?.steps.some((step) => step.status !== "done") ?? false;
}

function steady(state: TaskState, theme: WidgetTheme): string {
  const current = state.steps.find((step) => step.status === "in_progress")
    ?? state.steps.find((step) => step.status === "pending");

  if (!current) {
    return `${theme.fg("muted", `Plan ${counts(state)} · `)}${theme.fg("success", "✓ Complete")}`;
  }

  const color = current.status === "in_progress" ? "accent" : "dim";
  return `${theme.fg("muted", `Plan ${counts(state)} · `)}${theme.fg(color, `${symbol(current.status)} #${current.id} ${sanitizeDisplayText(current.outcome)}`)}`;
}

function status(before: TaskState, state: TaskState, theme: WidgetTheme): string {
  const changes = state.steps.flatMap((step) => {
    const previous = before.steps.find((item) => item.id === step.id);
    return previous && previous.status !== step.status ? [{ previous, step }] : [];
  });
  const completed = changes.find(({ previous, step }) => previous.status !== "done" && step.status === "done")?.step;
  const started = changes.find(({ previous, step }) => previous.status !== "in_progress" && step.status === "in_progress")?.step;
  const pending = changes.find(({ step }) => step.status === "pending")?.step;

  if (completed && started) {
    return `${theme.fg("success", `✓ #${completed.id}`)}${theme.fg("muted", " → ")}${theme.fg("accent", `● #${started.id} ${sanitizeDisplayText(started.outcome)}`)}`;
  }
  if (completed) return `${theme.fg("success", `✓ #${completed.id} completed`)}${theme.fg("muted", ` · ${counts(state)}`)}`;
  if (started) return `${theme.fg("accent", `● #${started.id} started · ${sanitizeDisplayText(started.outcome)}`)}`;
  if (pending) return `${theme.fg("warning", `○ #${pending.id} pending · ${sanitizeDisplayText(pending.outcome)}`)}`;
  return steady(state, theme);
}

export function formatPlanWidgetView(view: PlanWidgetView, theme: WidgetTheme): string {
  switch (view.kind) {
    case "steady":
      return steady(view.state, theme);
    case "created":
      return `${theme.fg("success", "＋ Plan created")}${theme.fg("muted", ` · ${view.state.steps.length} steps`)}`;
    case "revised":
      return `${theme.fg("accent", "↻ Plan revised")}${theme.fg("muted", ` · ${counts(view.state)}`)}`;
    case "status":
      return status(view.before, view.state, theme);
    case "complete":
      return `${theme.fg("success", "✓ Plan complete")}${theme.fg("muted", ` · ${counts(view.state)}`)}`;
  }
}

export function createPlanWidget(view: PlanWidgetView) {
  return (_tui: unknown, theme: WidgetTheme) => {
    return {
      render: (width: number): string[] => [
        truncateToWidth(formatPlanWidgetView(view, theme), Math.max(1, width), "…"),
      ],
      invalidate: (): void => {},
    };
  };
}
