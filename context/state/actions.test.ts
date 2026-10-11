import assert from "node:assert/strict";
import test from "node:test";
import { applyAction, type TaskStateParams } from "./index.ts";
import { type StepStatus, type TaskState } from "./types.ts";

const statuses: StepStatus[] = ["pending", "in_progress", "done"];
const fixture = (steps: StepStatus[]): TaskState => ({
  goal: "Original goal",
  steps: steps.map((status, index) => ({ id: index + 1, outcome: `Outcome ${index + 1}`, doneWhen: "Tests pass", status })),
  constraints: ["Keep scope"],
  findings: ["Evidence"],
});

test("set_plan replaces steps but preserves knowledge until clear", () => {
  for (const previousStatus of ["in_progress", "done"] as const) {
    for (const constraints of [undefined, [], ["New constraint"]]) {
      const current = fixture([previousStatus]);
      const before = structuredClone(current);
      const params: TaskStateParams = { action: "set_plan", goal: "Replanned", steps: [{ outcome: "New outcome", doneWhen: "Verified" }], ...(constraints === undefined ? {} : { constraints }) };
      const result = applyAction(current, params);
      assert.equal(result.error, undefined);
      assert.deepEqual(result.state, { goal: "Replanned", steps: [{ id: 1, outcome: "New outcome", doneWhen: "Verified", status: "pending" }], constraints: constraints ?? before.constraints, findings: before.findings });
      assert.deepEqual(current, before);
      result.state!.findings.push("New evidence");
      result.state!.constraints.push("Extra constraint");
      assert.deepEqual(current, before);
      assert.deepEqual(params.constraints, constraints);
    }
  }
  const cleared = applyAction(fixture(["done"]), { action: "clear" });
  const fresh = applyAction(cleared.state, { action: "set_plan", goal: "Fresh", steps: [{ outcome: "Start", doneWhen: "Verified" }] });
  assert.deepEqual(fresh.state?.constraints, []);
  assert.deepEqual(fresh.state?.findings, []);
});

test("advance_step preserves parallel work and selects pending steps in plan order", () => {
  const cases: Array<{ name: string; before: StepStatus[]; params: TaskStateParams; after?: StepStatus[]; error?: RegExp }> = [
    { name: "start first pending", before: ["pending", "pending"], params: { action: "advance_step" }, after: ["in_progress", "pending"] },
    { name: "non-linear initial start", before: ["pending", "pending"], params: { action: "advance_step", nextId: 2 }, after: ["pending", "in_progress"] },
    { name: "parallel requires id", before: ["in_progress", "in_progress", "pending"], params: { action: "advance_step" }, error: /Multiple steps/ },
    { name: "nextId does not disambiguate", before: ["in_progress", "in_progress", "pending"], params: { action: "advance_step", nextId: 3 }, error: /Multiple steps/ },
    { name: "parallel automatic replacement", before: ["pending", "in_progress", "in_progress", "pending"], params: { action: "advance_step", id: 3 }, after: ["in_progress", "in_progress", "done", "pending"] },
    { name: "parallel non-linear replacement", before: ["pending", "in_progress", "in_progress", "pending"], params: { action: "advance_step", id: 2, nextId: 4 }, after: ["pending", "done", "in_progress", "in_progress"] },
    { name: "parallel no pending", before: ["in_progress", "in_progress"], params: { action: "advance_step", id: 1 }, after: ["done", "in_progress"] },
    { name: "final completion", before: ["done", "in_progress"], params: { action: "advance_step" }, after: ["done", "done"] },
    { name: "invalid active id", before: ["pending", "in_progress"], params: { action: "advance_step", id: 1, finding: "New evidence" }, error: /not in progress/ },
    { name: "missing next id", before: ["in_progress", "pending"], params: { action: "advance_step", nextId: 99, finding: "New evidence" }, error: /not found/ },
    { name: "active next id", before: ["in_progress", "in_progress"], params: { action: "advance_step", id: 1, nextId: 2, finding: "New evidence" }, error: /not pending/ },
    { name: "completed next id", before: ["in_progress", "done"], params: { action: "advance_step", nextId: 2 }, error: /not pending/ },
  ];
  for (const row of cases) {
    const current = fixture(row.before);
    const before = structuredClone(current);
    const result = applyAction(current, row.params);
    if (row.error) {
      assert.match(result.error ?? "", row.error, row.name);
      assert.equal(result.state, current, row.name);
    } else {
      assert.equal(result.error, undefined, row.name);
      assert.deepEqual(result.state?.steps.map(step => step.status), row.after, row.name);
      assert.deepEqual(result.state?.findings, before.findings, row.name);
    }
    assert.deepEqual(current, before, row.name);
  }
});

test("update_step supports every status transition without changing other steps", () => {
  for (const from of statuses) {
    for (const to of statuses) {
      const current = fixture([from, "in_progress"]);
      const before = structuredClone(current);
      const result = applyAction(current, { action: "update_step", id: 1, status: to });
      assert.equal(result.error, undefined);
      assert.equal(result.state?.steps[0]?.status, to);
      assert.deepEqual(result.state?.steps[1], before.steps[1]);
      assert.deepEqual(current, before);
    }
  }
});

test("finding idempotency works at capacity in both advancement branches", () => {
  for (const action of ["add_finding", "advance_step"] as const) {
    for (const status of ["pending", "in_progress"] as const) {
      for (const finding of ["Evidence", "New evidence", " ", "x".repeat(501)]) {
        const current = fixture([status, "pending"]);
        current.findings = ["Evidence", ...Array.from({ length: 9 }, (_, i) => `Evidence ${i}`)];
        const before = structuredClone(current);
        const result = applyAction(current, { action, finding });
        if (finding === "Evidence") {
          assert.equal(result.error, undefined);
          assert.deepEqual(result.state?.findings, before.findings);
          assert.doesNotMatch(result.feedback ?? "", /Finding added/);
          if (action === "advance_step") assert.deepEqual(result.state?.steps.map(step => step.status), status === "pending" ? ["in_progress", "pending"] : ["done", "in_progress"]);
        } else {
          assert.match(result.error ?? "", finding === "New evidence" ? /at most 10 findings/ : /blank or exceed/);
          assert.equal(result.state, current);
        }
        assert.deepEqual(current, before);
      }
    }
  }
});

test("all actions return local feedback without mutating their inputs", () => {
  const cases: Array<{ params: TaskStateParams; feedback: RegExp }> = [
    { params: { action: "set_plan", goal: "New", steps: [{ outcome: "New", doneWhen: "Verified" }] }, feedback: /^Plan set$/ },
    { params: { action: "advance_step" }, feedback: /^Step #1 complete\nStep #2 in progress/ },
    { params: { action: "update_step", id: 1, outcome: "Revised", doneWhen: "Verified", status: "done" }, feedback: /^Step #1 updated\nOutcome: Revised\nDone when: Verified$/ },
    { params: { action: "add_step", outcome: "New", doneWhen: "Verified" }, feedback: /^Step #3 added\nOutcome: New\nDone when: Verified$/ },
    { params: { action: "add_finding", finding: "New evidence" }, feedback: /^Finding added\nNew evidence$/ },
    { params: { action: "add_finding", finding: "Evidence" }, feedback: /^Finding already recorded\nEvidence$/ },
    { params: { action: "show" }, feedback: /^Plan$/ },
    { params: { action: "clear" }, feedback: /^Task state cleared\.$/ },
  ];
  for (const row of cases) {
    const current = fixture(["in_progress", "pending"]);
    const before = structuredClone(current);
    const paramsBefore = structuredClone(row.params);
    const result = applyAction(current, row.params);
    assert.equal(result.error, undefined);
    assert.match(result.feedback ?? "", row.feedback);
    assert.deepEqual(current, before);
    assert.deepEqual(row.params, paramsBefore);
  }
  for (const action of ["advance_step", "update_step", "add_step", "add_finding"] as const) {
    const params = cases.find(row => row.params.action === action)!.params;
    const result = applyAction(undefined, params);
    assert.equal(result.state, undefined);
    assert.match(result.error ?? "", /Call set_plan first/);
  }
});

test("all actions validate shape and retain original state on invalid inputs", () => {
  const cases: unknown[] = [
    { action: "set_plan", goal: "Valid", steps: [{ outcome: "Missing doneWhen" }] },
    { action: "advance_step", id: 0 },
    { action: "advance_step", nextId: 1.5 },
    { action: "advance_step", finding: 42 },
    { action: "update_step", id: 1, status: "invalid" },
    { action: "update_step", id: 1 },
    { action: "add_step", outcome: "Valid", doneWhen: null },
    { action: "add_finding", finding: false },
    { action: "show", id: 1 },
    { action: "clear", goal: "Unexpected" },
  ];
  for (const raw of cases) {
    const current = fixture(["in_progress"]);
    const before = structuredClone(current);
    const result = applyAction(current, raw as TaskStateParams);
    assert.match(result.error ?? "", /Invalid task_state parameters/);
    assert.equal(result.state, current);
    assert.deepEqual(current, before);
  }
});
