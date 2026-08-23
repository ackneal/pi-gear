import assert from "node:assert/strict";
import test from "node:test";
import { COMPLETION_DURATION_MS, type PlanScheduler, PlanWidgetController, TRANSITION_DURATION_MS } from "./controller.ts";
import { visibleWidth } from "./display.ts";
import { PLAN_WIDGET_ID } from "./widget.ts";

class ManualScheduler implements PlanScheduler {
  readonly callbacks: Array<() => void> = [];
  readonly cleared = new Set<number>();
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    assert.ok(delay === TRANSITION_DURATION_MS || delay === COMPLETION_DURATION_MS);
    this.callbacks.push(callback);
    return (this.callbacks.length - 1) as never;
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.cleared.add(handle as never as number);
  }

  run(index: number): void {
    this.callbacks[index]?.();
  }
}

const theme = { fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[0m`, bold: (text: string) => `\x1b[1m${text}\x1b[0m` };

function state(statuses: Array<"pending" | "in_progress" | "done"> = ["pending", "in_progress", "pending", "pending"], outcome: string = "Integrate context") {
  return { goal: "Ship the Plan UI", steps: statuses.map((status, index) => ({ id: index + 1, outcome: index === 2 ? outcome : `Step ${index + 1}`, doneWhen: "Verified", status })), constraints: [], findings: [] };
}

function harness() {
  const calls: Array<[string, unknown, { placement: "aboveEditor" }]> = [];
  const ctx = { hasUI: true, mode: "tui" as const, ui: { setWidget: (key: string, content: unknown, options: { placement: "aboveEditor" }) => calls.push([key, content, options]) } };
  const line = (index: number, width: number = 120): string => ((calls[index]?.[1] as ((tui: unknown, currentTheme: typeof theme) => { render(width: number): string[] }) | undefined)?.(undefined, theme).render(width)[0] ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  return { calls, ctx, line };
}

test("rapid done then started updates coalesce from the original stable state", () => {
  const timers = new ManualScheduler();
  const { ctx, line } = harness();
  const controller = new PlanWidgetController(timers);
  const before = state();
  const done = state(["pending", "done", "pending", "pending"]);
  const started = state(["pending", "done", "in_progress", "pending"]);
  controller.reconstruct(ctx as never, before);
  controller.update(ctx as never, before, done, { action: "complete_step" });
  controller.update(ctx as never, done, started, { action: "start_step" });
  assert.match(line(2), /✓ #2 completed · ✓1\/4 → ● #3 started · Integrate context/);
  timers.run(0);
  assert.match(line(2), /✓ #2 completed · ✓1\/4 → ● #3 started/);
  timers.run(1);
  assert.match(line(3), /Plan · ✓1\/4 · ● #3 Integrate context/);
});

test("final completion stays visible before hiding", () => {
  const timers = new ManualScheduler();
  const { calls, ctx, line } = harness();
  const controller = new PlanWidgetController(timers);
  const before = state(["done", "done", "in_progress", "done"]);
  const complete = state(["done", "done", "done", "done"]);
  controller.reconstruct(ctx as never, before);
  controller.update(ctx as never, before, complete, { action: "complete_step" });
  assert.match(line(1), /✓ Plan complete · 4\/4/);
  timers.run(0);
  assert.deepEqual(calls[2], [PLAN_WIDGET_ID, undefined, { placement: "aboveEditor" }]);
});

test("revisions settle while findings, constraints, and show do not reset their timer", () => {
  const timers = new ManualScheduler();
  const { calls, ctx, line } = harness();
  const controller = new PlanWidgetController(timers);
  const before = state();
  const revised = { ...before, steps: [{ ...before.steps[0]!, outcome: "Revised outcome" }, ...before.steps.slice(1)] };
  const withFinding = { ...revised, findings: ["Useful finding"] };
  controller.reconstruct(ctx as never, before);
  controller.update(ctx as never, before, revised, { action: "revise_step" });
  controller.update(ctx as never, revised, withFinding, { action: "add_finding" });
  controller.update(ctx as never, withFinding, withFinding, { action: "show" });
  assert.equal(timers.callbacks.length, 1);
  assert.match(line(3), /↻ Plan revised · ✓0\/4/);
  timers.run(0);
  assert.match(line(4), /Plan · ✓0\/4 · ● #2 Step 2/);
  assert.equal(calls.length, 5);
});

test("reconstruction is steady, shutdown cancels timers, and widget lines fit CJK widths", () => {
  const timers = new ManualScheduler();
  const { calls, ctx, line } = harness();
  const controller = new PlanWidgetController(timers);
  const cjk = state(["pending", "pending", "in_progress", "pending"], "確認\x1b[31m長文字顯示正常並且在窄終端保持單行\x1b[0m");
  controller.reconstruct(ctx as never, cjk);
  assert.match(line(0), /Plan · ✓0\/4 · ● #3/);
  for (const width of [1, 24, 92]) {
    const rendered = (calls[0]?.[1] as (tui: unknown, currentTheme: typeof theme) => { render(width: number): string[] })(undefined, theme).render(width);
    assert.equal(rendered.length, 1);
    assert.ok(visibleWidth(rendered[0] ?? "") <= Math.max(1, width));
  }
  controller.update(ctx as never, cjk, { ...cjk, steps: [{ ...cjk.steps[0]!, outcome: "Revised" }, ...cjk.steps.slice(1)] }, { action: "revise_step" });
  controller.shutdown(ctx as never);
  timers.run(0);
  assert.deepEqual(calls.at(-1), [PLAN_WIDGET_ID, undefined, { placement: "aboveEditor" }]);
  controller.reconstruct(ctx as never, state(["done", "done", "done", "done"]));
  assert.deepEqual(calls.at(-1), [PLAN_WIDGET_ID, undefined, { placement: "aboveEditor" }]);
});
