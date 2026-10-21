import assert from "node:assert/strict";
import test from "node:test";
import { keyText, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { applyAction, type TaskStateParams } from "../../context/state/index.ts";
import type { TaskState, TaskStateDetails } from "../../context/state/types.ts";
import { formatPlanResult, PlanSnapshotComponent, renderCall, renderResult } from "./renderer.ts";
import { visibleWidth } from "./display.ts";
import { configureOutputPadding } from "../tools/padding.ts";

const theme = { bg: (_color: string, text: string) => text, fg: (_color: string, text: string) => text, bold: (text: string) => text };
const state: TaskState = { goal: "Ship the Plan UI", steps: [{ id: 1, outcome: "Build renderer", doneWhen: "Snapshots are readable", status: "done" }, { id: 2, outcome: "Test lifecycle", doneWhen: "Timers are deterministic", status: "in_progress" }], constraints: ["Keep tool semantics"], findings: ["Snapshot retains all fields"] };

function result(action: string, params: Record<string, unknown>, next: TaskState | null = state, feedback = "Canonical state remains available to the model."): AgentToolResult<TaskStateDetails> {
  return { content: [{ type: "text", text: feedback }], details: { tool: "task_state", action, params, version: 2, state: next } };
}

function normalized(lines: string[]): string {
  return lines.map((line) => line.trim()).join("\n").trim();
}

test("actions render only approved transcript feedback", () => {
  const cases: TaskStateParams[] = [
    { action: "set_plan", goal: state.goal, steps: state.steps.map(({ outcome, doneWhen }) => ({ outcome, doneWhen })) },
    { action: "advance_step", id: 2 },
    { action: "update_step", id: 2, status: "pending" },
    { action: "update_step", id: 2, outcome: "Verify lifecycle" },
    { action: "update_step", id: 2, doneWhen: "Widget hides" },
    { action: "add_step", outcome: "Ship", doneWhen: "Released" },
    { action: "add_finding", finding: "Useful finding" },
    { action: "add_finding", finding: state.findings[0]! },
    { action: "show" },
    { action: "clear" },
  ];
  for (const params of cases) {
    const applied = applyAction(state, params);
    assert.equal(applied.error, undefined, params.action);
    const response = result(params.action, params, applied.state ?? null, applied.feedback);
    const component = renderResult(response, { expanded: false, isPartial: false }, theme, {});
    if (!["set_plan", "show", "add_finding"].includes(params.action) || (params.action === "add_finding" && params.finding === state.findings[0])) {
      assert.equal(formatPlanResult(response, { expanded: false, isPartial: false }, theme), "");
      assert.deepEqual(component.render(180), [], params.action);
      continue;
    }
    if (params.action === "add_finding") {
      assert.equal(normalized(component.render(180)), "[plan] Finding · Useful finding");
      continue;
    }
    assert.ok(component instanceof PlanSnapshotComponent, params.action);
    assert.match(normalized(component.render(180)), /^\[plan\].*complete.*to expand\)/, params.action);
    const expanded = renderResult(response, { expanded: true, isPartial: false }, theme, { lastComponent: component });
    assert.equal(expanded, component);
    const body = normalized(expanded.render(180));
    assert.ok(body.includes(applied.state!.goal), params.action);
    for (const step of applied.state!.steps) {
      assert.ok(body.includes(`#${step.id} ${step.outcome}`), params.action);
      assert.ok(body.includes(`Status: ${step.status}`), params.action);
      assert.ok(body.includes(`Done when: ${step.doneWhen}`), params.action);
    }
    for (const value of [...applied.state!.constraints, ...applied.state!.findings]) assert.ok(body.includes(value), params.action);
    assert.equal(body.includes("Constraints\n"), applied.state!.constraints.length > 0);
    assert.equal(body.includes("Findings\n"), applied.state!.findings.length > 0);
    assert.ok(!body.includes("to expand"));
  }
});

test("empty, clear, and failed plans share the plan label and sanitize output", () => {
  const cases = [
    { response: result("show", {}, null), error: false, expected: "[plan] Empty" },
    { response: result("clear", {}, null), error: false, expected: "" },
    { response: { content: [{ type: "text", text: "Useful\t\x1b[31mtext\x1b[0m\u0007\nCanonical state" }] } as AgentToolResult<TaskStateDetails>, error: true, expected: "[plan] ✗ Useful text" },
  ];
  for (const row of cases) {
    const options = { expanded: false, isPartial: false };
    assert.equal(formatPlanResult(row.response, options, theme, row.error), row.expected);
    const component = renderResult(row.response, options, theme, { isError: row.error });
    assert.equal(normalized(component.render(160)), row.expected);
  }
});

test("every plan card uses native background and exactly one inset regardless of tool padding", () => {
  try {
    for (const outputPad of [0, 1]) {
      configureOutputPadding({ getSettings: () => ({ outputPad }) } as Parameters<typeof configureOutputPadding>[0]);
      for (const action of ["show", "add_finding", "error"]) {
        const painted: string[] = [];
        const nativeTheme = { ...theme, bg: (token: string, text: string) => { painted.push(token); return text; } };
        const response = result(action, { finding: "Finding text" });
        const context = { isError: action === "error" };
        const component = renderResult(response, { expanded: false, isPartial: false }, nativeTheme, context);
        const lines = component.render(90);
        assert.ok(lines.every((line) => visibleWidth(line) === 90));
        assert.equal(lines[0]!.trim(), "");
        assert.match(lines[1]!, /^ \[plan\]/);
        assert.equal(lines.at(-1)!.trim(), "");
        assert.ok(painted.length > 0 && painted.every((token) => token === "customMessageBg"));
        assert.equal(renderResult(response, { expanded: true, isPartial: false }, nativeTheme, { ...context, lastComponent: component }), component);
        for (const width of [0, 1, 2, 12]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
      }
    }
    assert.deepEqual(renderCall({}, theme, {}).render(32), []);
  } finally {
    configureOutputPadding({ getSettings: () => ({ outputPad: 1 }) } as Parameters<typeof configureOutputPadding>[0]);
  }
});

test("expanded CJK content wraps without losing fields", () => {
  const long = "確認長文字顯示正常並且在非常窄的終端視窗中仍然保持清楚可讀的步驟內容";
  const component = new PlanSnapshotComponent({ ...state, steps: [{ ...state.steps[0]!, outcome: long }] }, true, theme);
  const lines = component.render(24);
  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
  assert.match(lines.join("\n"), /✓ #1/);
  assert.match(lines.join("\n"), /Done when:[\s\S]*Snapshots[\s\S]*are readable/);
});

test("findings collapse independently and expand only their text", () => {
  for (const finding of ["Short", "Evidence ".repeat(40)]) {
    const response = result("add_finding", { finding });
    const component = renderResult(response, { expanded: false, isPartial: false }, theme, {});
    const collapsed = normalized(component.render(90));
    assert.equal(collapsed.includes("to expand"), finding.length > 90);
    const expanded = renderResult(response, { expanded: true, isPartial: false }, theme, { lastComponent: component });
    assert.equal(expanded, component);
    const body = normalized(expanded.render(90));
    assert.equal(body.replace(/\s+/g, " "), `[plan] Finding · ${finding.trim()}`);
    assert.doesNotMatch(body, /Goal|Progress|to expand/);
  }
});

test("errors remain visible for every action", () => {
  for (const action of ["set_plan", "show", "update_step", "advance_step", "add_step", "add_finding", "clear"]) {
    const response = result(action, {}, state, "Operation failed");
    assert.equal(normalized(renderResult(response, { expanded: false, isPartial: false }, theme, { isError: true }).render(90)), "[plan] ✗ Operation failed");
  }
});
