import assert from "node:assert/strict";
import test from "node:test";
import type { StepStatus, TaskState } from "../../context/state/types.ts";
import { formatPlanWidgetView, type PlanWidgetView } from "./widget.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const outcomes = ["Prepare policy", "Verify policy", "Implement runtime policy"];

function state(statuses: StepStatus[]): TaskState {
  return {
    goal: "Ship runtime policy",
    steps: statuses.map((status, index) => ({
      id: index + 1,
      outcome: outcomes[index] ?? `Step ${index + 1}`,
      doneWhen: "Verified",
      status,
    })),
    constraints: [],
    findings: [],
  };
}

test("status bar distinguishes completion progress and uses consistent action wording", () => {
  const twoDone = state(["done", "done", "pending"]);
  const cases: Array<{ name: string; view: PlanWidgetView; expected: string }> = [
    {
      name: "steady in-progress step",
      view: { kind: "steady", state: state(["done", "done", "in_progress"]) },
      expected: "Plan · ✓2/3 · ● #3 Implement runtime policy",
    },
    {
      name: "steady pending step",
      view: { kind: "steady", state: twoDone },
      expected: "Plan · ✓2/3 · ○ #3 Implement runtime policy",
    },
    {
      name: "steady completed plan",
      view: { kind: "steady", state: state(["done", "done", "done"]) },
      expected: "Plan · ✓3/3 · Complete",
    },
    {
      name: "plan created",
      view: { kind: "created", state: state(["pending", "pending", "pending"]) },
      expected: "＋ Plan created · 3 steps",
    },
    {
      name: "step started",
      view: {
        kind: "status",
        before: state(["done", "pending", "pending"]),
        state: state(["done", "in_progress", "pending"]),
      },
      expected: "● #2 started · Verify policy",
    },
    {
      name: "step reopened",
      view: {
        kind: "status",
        before: twoDone,
        state: state(["done", "in_progress", "pending"]),
      },
      expected: "↻ #2 reopened · Verify policy",
    },
    {
      name: "step completed",
      view: {
        kind: "status",
        before: state(["done", "in_progress", "pending"]),
        state: twoDone,
      },
      expected: "✓ #2 completed · ✓2/3",
    },
    {
      name: "coalesced completion and start",
      view: {
        kind: "status",
        before: state(["done", "in_progress", "pending"]),
        state: state(["done", "done", "in_progress"]),
      },
      expected: "✓ #2 completed · ✓2/3 → ● #3 started · Implement runtime policy",
    },
    {
      name: "plan completed",
      view: { kind: "complete", state: state(["done", "done", "done"]) },
      expected: "✓ Plan complete · 3/3",
    },
    {
      name: "plan revised",
      view: { kind: "revised", state: twoDone },
      expected: "↻ Plan revised · ✓2/3",
    },
  ];

  for (const current of cases) {
    assert.equal(formatPlanWidgetView(current.view, theme), current.expected, current.name);
  }
});
