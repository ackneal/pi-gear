import assert from "node:assert/strict";
import test from "node:test";
import { keyText } from "@earendil-works/pi-coding-agent";
import type { StepStatus, TaskState } from "../../context/state/types.ts";
import { visibleWidth } from "./display.ts";
import { formatPlanFinding, formatPlanSnapshot, formatPlanSnapshotLines } from "./format.ts";

const hint = ` (${keyText("app.tools.expand")} to expand)`;
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function state(statuses: StepStatus[]): TaskState {
  return { goal: "Ship plan", steps: statuses.map((status, i) => ({ id: i + 1, outcome: `Outcome ${i + 1}`, doneWhen: `Check ${i + 1}`, status })), constraints: [], findings: [] };
}

test("collapsed selection and counts", () => {
  const cases: { name: string; state: TaskState | undefined; expected: string }[] = [
    { name: "empty", state: undefined, expected: "[plan] Empty" },
    { name: "pending", state: state(["pending", "pending"]), expected: "[plan] #1 Outcome 1 · 0/2 complete" + hint },
    { name: "active wins", state: state(["pending", "in_progress"]), expected: "[plan] #2 Outcome 2 · 0/2 complete" + hint },
    { name: "last done", state: state(["done", "done"]), expected: "[plan] #2 Outcome 2 · 2/2 complete" + hint },
    { name: "multiple active", state: { ...state(["in_progress", "in_progress", "done"]), findings: ["Finding"] }, expected: "[plan] #1 Outcome 1 +1 active · 1/3 complete · 1 finding" + hint },
  ];
  for (const row of cases) assert.deepEqual(formatPlanSnapshotLines(row.state, false, 200), [row.expected], row.name);
});

test("expanded fields and empty sections", () => {
  const cases = [
    { state: undefined, expected: ["[plan] Empty"] },
    { state: state([]), expected: ["[plan]", "Goal", "Ship plan", "", "Progress", "0/0 complete", "", "Steps", "None"] },
    { state: { ...state(["pending", "in_progress", "done"]), constraints: ["Keep safe"], findings: ["Evidence"] }, expected: ["[plan]", "Goal", "Ship plan", "", "Progress", "1/3 complete", "", "Steps", "○ #1 Outcome 1", "  Status: pending", "  Done when: Check 1", "", "● #2 Outcome 2", "  Status: in_progress", "  Done when: Check 2", "", "✓ #3 Outcome 3", "  Status: done", "  Done when: Check 3", "", "Constraints", "• Keep safe", "", "Findings", "• Evidence"] },
  ];
  for (const row of cases) assert.deepEqual(formatPlanSnapshotLines(row.state, true, 200), row.expected);
});

test("bounded wrapping and outcome truncation", () => {
  const value = { ...state(["in_progress"]), goal: "確認".repeat(50) };
  value.steps[0]!.outcome = value.goal;
  for (const width of [0, 1, 2, 5, 12, 80]) {
    for (const expanded of [false, true]) {
      const lines = formatPlanSnapshotLines(value, expanded, width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}, ${expanded}`);
      if (!expanded) assert.equal(lines.length, 1);
    }
  }
  assert.ok(formatPlanSnapshotLines(value, false, 80)[0]!.endsWith(` · 0/1 complete${hint}`));
  assert.equal(formatPlanSnapshotLines(value, true, 20).slice(2, 12).join(""), value.goal);
});

test("expanded findings preserve full text at narrow widths", () => {
  const finding = "Evidence".repeat(12);
  for (const width of [2, 8, 12, 24]) {
    const lines = formatPlanFinding(finding, true, theme, width).split("\n");
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.equal(lines.slice(1).join(""), finding);
  }
});

test("all user fields are sanitized and string formatter preserves lines", () => {
  const dirty = "\x1b[31mHello\x1b[0m\n\tworld\x00";
  const value: TaskState = { goal: dirty, steps: [{ id: 1, status: "pending", outcome: dirty, doneWhen: dirty }], constraints: [dirty], findings: [dirty] };
  for (const expanded of [false, true]) {
    const lines = formatPlanSnapshotLines(value, expanded, 200);
    assert.ok(lines.every((line) => !/[\x00-\x1f\x7f]/.test(line)));
    assert.equal(formatPlanSnapshot(value, expanded, theme, 200), lines.join("\n"));
    assert.match(lines.join("\n"), /Hello world/);
  }
});
