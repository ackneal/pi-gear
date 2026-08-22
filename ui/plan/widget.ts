import type { TaskState, TodoStatus } from "../../context/state/types.ts";
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

function symbol(status: TodoStatus): string {
  return status === "done" ? "✓" : status === "in_progress" ? "●" : "○";
}

function counts(state: TaskState): string {
  return `${state.todos.filter((todo) => todo.status === "done").length}/${state.todos.length}`;
}

export function hasUnfinishedTodos(state: TaskState | undefined): boolean {
  return state?.todos.some((todo) => todo.status !== "done") ?? false;
}

function steady(state: TaskState, theme: WidgetTheme): string {
  const current = state.todos.find((todo) => todo.status === "in_progress")
    ?? state.todos.find((todo) => todo.status === "pending");

  if (!current) {
    return `${theme.fg("muted", `Plan ${counts(state)} · `)}${theme.fg("success", "✓ Complete")}`;
  }

  const color = current.status === "in_progress" ? "accent" : "dim";
  return `${theme.fg("muted", `Plan ${counts(state)} · `)}${theme.fg(color, `${symbol(current.status)} #${current.id} ${sanitizeDisplayText(current.text)}`)}`;
}

function status(before: TaskState, state: TaskState, theme: WidgetTheme): string {
  const changes = state.todos.flatMap((todo) => {
    const previous = before.todos.find((item) => item.id === todo.id);
    return previous && previous.status !== todo.status ? [{ previous, todo }] : [];
  });
  const completed = changes.find(({ previous, todo }) => previous.status !== "done" && todo.status === "done")?.todo;
  const started = changes.find(({ previous, todo }) => previous.status !== "in_progress" && todo.status === "in_progress")?.todo;
  const pending = changes.find(({ todo }) => todo.status === "pending")?.todo;

  if (completed && started) {
    return `${theme.fg("success", `✓ #${completed.id}`)}${theme.fg("muted", " → ")}${theme.fg("accent", `● #${started.id} ${sanitizeDisplayText(started.text)}`)}`;
  }
  if (completed) return `${theme.fg("success", `✓ #${completed.id} completed`)}${theme.fg("muted", ` · ${counts(state)}`)}`;
  if (started) return `${theme.fg("accent", `● #${started.id} started · ${sanitizeDisplayText(started.text)}`)}`;
  if (pending) return `${theme.fg("warning", `○ #${pending.id} pending · ${sanitizeDisplayText(pending.text)}`)}`;
  return steady(state, theme);
}

export function formatPlanWidgetView(view: PlanWidgetView, theme: WidgetTheme): string {
  switch (view.kind) {
    case "steady":
      return steady(view.state, theme);
    case "created":
      return `${theme.fg("success", "＋ Plan created")}${theme.fg("muted", ` · ${view.state.todos.length} steps`)}`;
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
