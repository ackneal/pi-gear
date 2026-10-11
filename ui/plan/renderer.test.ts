import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { applyAction, type TaskStateParams } from "../../context/state/index.ts";
import type { TaskState, TaskStateDetails } from "../../context/state/types.ts";
import { formatPlanResult, PlanSnapshotComponent, renderResult } from "./renderer.ts";
import { visibleWidth } from "./display.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const state = { goal: "Ship the Plan UI", steps: [{ id: 1, outcome: "Build renderer", doneWhen: "Snapshots are readable", status: "done" as const }, { id: 2, outcome: "Test lifecycle", doneWhen: "Timers are deterministic", status: "in_progress" as const }], constraints: [], findings: [] };

function result(action: string, params: Record<string, unknown>, next: TaskState | null = state, feedback = "Canonical state remains available to the model."): AgentToolResult<TaskStateDetails> {
  return { content: [{ type: "text", text: feedback }], details: { tool: "task_state", action, params, version: 2, state: next } };
}

test("semantic status actions are silent while structural actions and show snapshot full details state", () => {
  assert.equal(formatPlanResult(result("advance_step", { id: 2 }), { expanded: false, isPartial: false }, theme), "");

  const revisedOutcome = { ...state, steps: [state.steps[0]!, { ...state.steps[1]!, outcome: "Verify lifecycle" }] };
  const revisedDoneWhen = { ...state, steps: [state.steps[0]!, { ...state.steps[1]!, doneWhen: "Widget hides" }] };
  for (const action of ["set_plan", "add_step", "show"]) {
    assert.match(formatPlanResult(result(action, {}, revisedOutcome), { expanded: false, isPartial: false }, theme), /Verify lifecycle/);
  }
  const outcomeSnapshot = formatPlanResult(result("update_step", { id: 2, outcome: "Verify lifecycle" }, revisedOutcome), { expanded: false, isPartial: false }, theme);
  const doneWhenSnapshot = formatPlanResult(result("update_step", { id: 2, doneWhen: "Widget hides" }, revisedDoneWhen), { expanded: true, isPartial: false }, theme);
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

test("all seven actions render their authoritative results, including idempotent findings", () => {
  const snapshot = "Plan · 1/2 complete\n  Steps\n    ✓ #1 Build renderer\n    ● #2 Test lifecycle";
  const cases: Array<{ name: string; before?: TaskState; params: TaskStateParams; expected: string; snapshot: boolean }> = [
    { name: "set plan", params: { action: "set_plan", goal: state.goal, steps: state.steps.map(({ outcome, doneWhen }) => ({ outcome, doneWhen })) }, expected: snapshot.replace("1/2", "0/2").replace("✓ #1", "○ #1").replace("● #2", "○ #2"), snapshot: true },
    { name: "advance is silent", before: state, params: { action: "advance_step", id: 2 }, expected: "", snapshot: false },
    { name: "status update snapshots", before: state, params: { action: "update_step", id: 2, status: "pending" }, expected: snapshot.replace("● #2", "○ #2"), snapshot: true },
    { name: "outcome update snapshots", before: state, params: { action: "update_step", id: 2, outcome: "Verify lifecycle" }, expected: snapshot.replace("Test lifecycle", "Verify lifecycle"), snapshot: true },
    { name: "add step snapshots", before: state, params: { action: "add_step", outcome: "Ship", doneWhen: "Released" }, expected: snapshot.replace("1/2", "1/3") + "\n    ○ #3 Ship", snapshot: true },
    { name: "new finding", before: state, params: { action: "add_finding", finding: "Useful finding" }, expected: "✓ Finding · Useful finding", snapshot: false },
    { name: "duplicate finding", before: { ...state, findings: ["Useful finding"] }, params: { action: "add_finding", finding: "Useful finding" }, expected: "✓ Finding already recorded · Useful finding", snapshot: false },
    { name: "duplicate at capacity", before: { ...state, findings: ["Useful finding", ...Array.from({ length: 9 }, (_, i) => `Finding ${i}`)] }, params: { action: "add_finding", finding: "Useful finding" }, expected: "✓ Finding already recorded · Useful finding", snapshot: false },
    { name: "show", before: state, params: { action: "show" }, expected: snapshot, snapshot: true },
    { name: "empty show", params: { action: "show" }, expected: "Plan · Empty", snapshot: true },
    { name: "clear", before: state, params: { action: "clear" }, expected: "Plan cleared", snapshot: false },
  ];
  for (const row of cases) {
    const applied = applyAction(row.before, row.params);
    assert.equal(applied.error, undefined, row.name);
    const response = result(row.params.action, row.params, applied.state ?? null, applied.feedback);
    const options = { expanded: false, isPartial: false };

    assert.equal(formatPlanResult(response, options, theme), row.expected, row.name);
    const component = renderResult(response, options, theme, {});
    assert.equal(component instanceof PlanSnapshotComponent, row.snapshot, row.name);
    assert.equal(component instanceof Text, !row.snapshot, row.name);
    assert.equal(component.render(76).join("\n").trim(), row.expected, row.name);
    if (row.params.action === "add_finding") {
      const finding = row.params.finding;
      assert.equal(applied.state?.findings.filter((entry) => entry === finding).length, 1, row.name);
    }
  }
});
