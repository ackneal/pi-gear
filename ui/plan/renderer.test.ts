import assert from "node:assert/strict";
import test from "node:test";
import { formatPlanResult, PlanSnapshotComponent } from "./renderer.ts";
import { visibleWidth } from "./display.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const state = { goal: "Ship the Plan UI", steps: [{ id: 1, outcome: "Build renderer", doneWhen: "Snapshots are readable", status: "done" as const }, { id: 2, outcome: "Test lifecycle", doneWhen: "Timers are deterministic", status: "in_progress" as const }], constraints: [], findings: [] };

function result(action: string, params: Record<string, unknown>, next = state) {
  return { content: [{ type: "text" as const, text: "Canonical state remains available to the model." }], details: { tool: "task_state" as const, action, params, version: 2 as const, state: next } } as never;
}

test("semantic status actions are silent while structural actions and show snapshot full details state", () => {
  for (const action of ["start_step", "complete_step"]) {
    assert.equal(formatPlanResult(result(action, { id: 2 }), { expanded: false, isPartial: false }, theme), "");
  }

  const revisedOutcome = { ...state, steps: [state.steps[0]!, { ...state.steps[1]!, outcome: "Verify lifecycle" }] };
  const revisedDoneWhen = { ...state, steps: [state.steps[0]!, { ...state.steps[1]!, doneWhen: "Widget hides" }] };
  for (const action of ["set_plan", "add_step", "remove_step", "show"]) {
    assert.match(formatPlanResult(result(action, {}, revisedOutcome), { expanded: false, isPartial: false }, theme), /Verify lifecycle/);
  }
  const outcomeSnapshot = formatPlanResult(result("revise_step", { id: 2, outcome: "Verify lifecycle" }, revisedOutcome), { expanded: false, isPartial: false }, theme);
  const doneWhenSnapshot = formatPlanResult(result("revise_step", { id: 2, doneWhen: "Widget hides" }, revisedDoneWhen), { expanded: true, isPartial: false }, theme);
  assert.match(outcomeSnapshot, /Verify lifecycle/);
  assert.doesNotMatch(outcomeSnapshot, /Test lifecycle/);
  assert.match(doneWhenSnapshot, /Done when: Widget hides/);
  assert.doesNotMatch(doneWhenSnapshot, /Done when: Timers are deterministic/);
});

test("snapshot components wrap long CJK steps within the actual render width", () => {
  const long = "確認長文字顯示正常並且在非常窄的終端視窗中仍然保持清楚可讀的步驟內容";
  const component = new PlanSnapshotComponent({ ...state, steps: [{ ...state.steps[0]!, outcome: long }, state.steps[1]!] }, true, theme);
  const lines = component.render(24);
  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
  assert.match(lines.join("\n"), /✓ #1/);
  assert.match(lines.join("\n"), /Done when:[\s\S]*Snapshots are[\s\S]*readable/);
});

test("changes and errors sanitize terminal controls", () => {
  const injected = "Useful\n\t\x1b[31mtext\x1b[0m\u0007";
  assert.equal(formatPlanResult(result("add_finding", { finding: injected }), { expanded: false, isPartial: false }, theme), "✓ Finding · Useful text");
  const error = formatPlanResult({ content: [{ type: "text", text: "Useful\t\x1b[31mtext\x1b[0m\u0007\nCanonical state" }], details: undefined } as never, { expanded: false, isPartial: false }, theme, true);
  assert.equal(error, "✗ Plan · Useful text");
});
