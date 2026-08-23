import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskState, TaskStateAction } from "../../context/state/types.ts";
import { createPlanWidget, hasUnfinishedSteps, PLAN_WIDGET_ID, type PlanWidgetView } from "./widget.ts";

export const TRANSITION_DURATION_MS = 2_000;
export const COMPLETION_DURATION_MS = 3_000;

export interface PlanScheduler {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export type PlanUiChange = { action: TaskStateAction };

type WidgetContext = Pick<ExtensionContext, "hasUI" | "mode" | "ui">;
type Transition = { view: PlanWidgetView; before?: TaskState };

const scheduler: PlanScheduler = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class PlanWidgetController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private latest: TaskState | undefined;
  private transition: Transition | undefined;
  private readonly timers: PlanScheduler;

  constructor(timers: PlanScheduler = scheduler) {
    this.timers = timers;
  }

  reconstruct(ctx: WidgetContext, state: TaskState | undefined): void {
    this.cancelTimer();
    this.transition = undefined;
    this.latest = state;
    this.render(ctx, hasUnfinishedSteps(state) && state ? { kind: "steady", state } : undefined);
  }

  update(
    ctx: WidgetContext,
    previous: TaskState | undefined,
    state: TaskState | undefined,
    change: PlanUiChange,
  ): void {
    this.latest = state;

    if (!this.isTui(ctx) || state === undefined) {
      this.cancelTimer();
      this.transition = undefined;
      this.render(ctx, undefined);
      return;
    }

    if (!hasUnfinishedSteps(state) && hasUnfinishedSteps(previous)) {
      this.begin(ctx, { view: { kind: "complete", state } }, COMPLETION_DURATION_MS);
      return;
    }

    if (change.action === "set_plan" && previous === undefined) {
      this.begin(ctx, { view: { kind: "created", state } }, TRANSITION_DURATION_MS);
      return;
    }

    if (this.isStatusTransition(change) && this.hasStatusChange(previous, state)) {
      const before = this.transition?.view.kind === "status"
        ? this.transition.before ?? previous ?? state
        : previous ?? state;
      this.begin(ctx, { view: { kind: "status", before, state }, before }, TRANSITION_DURATION_MS);
      return;
    }

    if (this.isStructural(change)) {
      this.begin(ctx, { view: { kind: "revised", state } }, TRANSITION_DURATION_MS);
      return;
    }

    if (this.transition) {
      this.transition = { ...this.transition, view: this.refreshView(this.transition.view, state) };
      this.render(ctx, this.transition.view);
      return;
    }

    this.render(ctx, hasUnfinishedSteps(state) ? { kind: "steady", state } : undefined);
  }

  shutdown(ctx: WidgetContext): void {
    this.cancelTimer();
    this.transition = undefined;
    this.latest = undefined;
    this.render(ctx, undefined);
  }

  private begin(ctx: WidgetContext, transition: Transition, delay: number): void {
    this.cancelTimer();
    this.transition = transition;
    this.render(ctx, transition.view);

    const generation = ++this.generation;
    this.timer = this.timers.setTimeout(() => {
      if (generation !== this.generation) return;

      this.timer = undefined;
      this.transition = undefined;
      this.render(
        ctx,
        hasUnfinishedSteps(this.latest) && this.latest
          ? { kind: "steady", state: this.latest }
          : undefined,
      );
    }, delay);
  }

  private refreshView(view: PlanWidgetView, state: TaskState): PlanWidgetView {
    if (view.kind === "status") return { ...view, state };
    if (view.kind === "created" || view.kind === "revised" || view.kind === "complete") {
      return { ...view, state };
    }
    return { kind: "steady", state };
  }

  private isStatusTransition(change: PlanUiChange): boolean {
    return change.action === "start_step" || change.action === "complete_step";
  }

  private isStructural(change: PlanUiChange): boolean {
    return change.action === "set_plan"
      || change.action === "add_step"
      || change.action === "revise_step"
      || change.action === "remove_step";
  }

  private hasStatusChange(previous: TaskState | undefined, state: TaskState): boolean {
    return previous?.steps.some((step) =>
      state.steps.find((item) => item.id === step.id)?.status !== step.status,
    ) ?? false;
  }

  private cancelTimer(): void {
    this.generation += 1;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private isTui(ctx: WidgetContext): boolean {
    return ctx.hasUI && ctx.mode === "tui";
  }

  private render(ctx: WidgetContext, view: PlanWidgetView | undefined): void {
    if (this.isTui(ctx)) {
      ctx.ui.setWidget(
        PLAN_WIDGET_ID,
        view ? createPlanWidget(view) : undefined,
        { placement: "aboveEditor" },
      );
    }
  }
}
