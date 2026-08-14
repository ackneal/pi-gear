import assert from "node:assert/strict";
import test from "node:test";
import { formatPlanResult, PlanSnapshotComponent } from "./renderer.ts";
import { visibleWidth } from "./display.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const state = { goal: "Ship the Plan UI", todos: [{ id: 1, text: "Build renderer", doneWhen: "Snapshots are readable", status: "done" as const }, { id: 2, text: "Test lifecycle", doneWhen: "Timers are deterministic", status: "in_progress" as const }], constraints: [], findings: [] };

function result(action: string, params: Record<string, unknown>, next = state) {
  return { content: [{ type: "text" as const, text: "Canonical state remains available to the model." }], details: { tool: "task_state" as const, action, params, version: 1 as const, state: next } } as never;
}

test("status-only updates are silent while text and doneWhen revisions snapshot", () => {
  assert.equal(formatPlanResult(result("update_todo", { id: 2, status: "done" }), { expanded: false, isPartial: false }, theme), "");
  const revisedText = { ...state, todos: [state.todos[0]!, { ...state.todos[1]!, text: "Verify lifecycle" }] };
  const revisedDoneWhen = { ...state, todos: [state.todos[0]!, { ...state.todos[1]!, doneWhen: "Widget hides" }] };
  const textSnapshot = formatPlanResult(result("update_todo", { id: 2, text: "Verify lifecycle" }, revisedText), { expanded: false, isPartial: false }, theme);
  const doneWhenSnapshot = formatPlanResult(result("update_todo", { id: 2, doneWhen: "Widget hides" }, revisedDoneWhen), { expanded: true, isPartial: false }, theme);
  assert.match(textSnapshot, /Verify lifecycle/);
  assert.doesNotMatch(textSnapshot, /Test lifecycle/);
  assert.match(doneWhenSnapshot, /Done when: Widget hides/);
  assert.doesNotMatch(doneWhenSnapshot, /Done when: Timers are deterministic/);
});

test("snapshot components wrap long CJK steps within the actual render width", () => {
  const long = "確認長文字顯示正常並且在非常窄的終端視窗中仍然保持清楚可讀的步驟內容";
  const component = new PlanSnapshotComponent({ ...state, todos: [{ ...state.todos[0]!, text: long }, state.todos[1]!] }, true, theme);
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
