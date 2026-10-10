import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyAction, setupTaskState, TASK_STATE_ENTRY, TaskStateParams, type TaskStateParams as TaskStateParamsType } from "./index.ts";
import { snapshotTaskState } from "./core.ts";
import { TASK_STATE_LIMITS, TASK_STATE_VERSION, type TaskState } from "./types.ts";

const plan = {
  action: "set_plan",
  goal: "Ship state core",
  steps: [
    { outcome: "Implement state", doneWhen: "State is valid" },
    { outcome: "Test state", doneWhen: "Tests pass" },
  ],
} satisfies TaskStateParamsType;

test("step reducers assign pending status, advance steps, and update steps", () => {
  const initial = applyAction(undefined, plan).state!;
  assert.deepEqual(initial.steps.map(({ id, status }) => ({ id, status })), [
    { id: 1, status: "pending" },
    { id: 2, status: "pending" },
  ]);

  const added = applyAction(initial, { action: "add_step", outcome: "Document state", doneWhen: "README is current" }).state!;
  assert.deepEqual(added.steps.map(({ id, status }) => ({ id, status })), [
    { id: 1, status: "pending" },
    { id: 2, status: "pending" },
    { id: 3, status: "pending" },
  ]);

  // Start step 1 via advance_step when no step is in progress
  const started = applyAction(added, { action: "advance_step" }).state!;
  assert.equal(started.steps[0]?.status, "in_progress");

  // Advance step: completes step 1, starts step 2, optionally adds finding
  const advanced = applyAction(started, { action: "advance_step", finding: "Step 1 passed" }).state!;
  assert.equal(advanced.steps[0]?.status, "done");
  assert.equal(advanced.steps[1]?.status, "in_progress");
  assert.deepEqual(advanced.findings, ["Step 1 passed"]);

  // Update step 2 outcome and doneWhen
  const updated = applyAction(advanced, {
    action: "update_step",
    id: 2,
    outcome: "Implement semantic state",
    doneWhen: "Focused reducer tests pass",
  }).state!;
  assert.deepEqual(updated.steps[1], {
    id: 2,
    outcome: "Implement semantic state",
    doneWhen: "Focused reducer tests pass",
    status: "in_progress",
  });

  // Advance step: completes step 2, starts step 3
  const advanced2 = applyAction(updated, { action: "advance_step" }).state!;
  assert.equal(advanced2.steps[1]?.status, "done");
  assert.equal(advanced2.steps[2]?.status, "in_progress");

  // Advance final step: completes step 3, no more pending steps
  const completed = applyAction(advanced2, { action: "advance_step" }).state!;
  assert.equal(completed.steps[2]?.status, "done");

  // Advance step with duplicate finding: succeeds as a no-op for finding, does not duplicate
  const dupFindingAdvance = applyAction(advanced, { action: "advance_step", finding: "Step 1 passed" });
  assert.equal(dupFindingAdvance.error, undefined);
  assert.equal(dupFindingAdvance.state!.steps[1]?.status, "done");
  assert.equal(dupFindingAdvance.state!.steps[2]?.status, "in_progress");
  assert.deepEqual(dupFindingAdvance.state!.findings, ["Step 1 passed"]);

  // add_finding with duplicate finding succeeds idempotently without duplicating
  const dupFindingAdd = applyAction(advanced, { action: "add_finding", finding: "Step 1 passed" });
  assert.equal(dupFindingAdd.error, undefined);
  assert.match(dupFindingAdd.feedback ?? "", /already recorded/);
  assert.deepEqual(dupFindingAdd.state!.findings, ["Step 1 passed"]);

  // Reopen completed step via update_step
  const reopened = applyAction(completed, { action: "update_step", id: 1, status: "in_progress" }).state!;
  assert.equal(reopened.steps[0]?.status, "in_progress");
  assert.equal(reopened.steps[2]?.status, "done");

  // Multiple steps in progress: update step 2 to in_progress as well
  const multiActive = applyAction(reopened, { action: "update_step", id: 2, status: "in_progress" }).state!;
  assert.equal(multiActive.steps[0]?.status, "in_progress");
  assert.equal(multiActive.steps[1]?.status, "in_progress");

  // advance_step without id fails when multiple steps are in progress
  const multiFail = applyAction(multiActive, { action: "advance_step" });
  assert.match(multiFail.error ?? "", /Multiple steps are in progress; provide an id/);
  assert.equal(multiFail.state, multiActive);

  // advance_step with id completes only the targeted step
  const multiResolved = applyAction(multiActive, { action: "advance_step", id: 1 }).state!;
  assert.equal(multiResolved.steps[0]?.status, "done");
  assert.equal(multiResolved.steps[1]?.status, "in_progress");

  // advance_step with nextId starts specific pending step
  const stepReset = applyAction(multiResolved, { action: "update_step", id: 3, status: "pending" }).state!;
  const nextTargeted = applyAction(stepReset, { action: "advance_step", id: 2, nextId: 3 }).state!;
  assert.equal(nextTargeted.steps[1]?.status, "done");
  assert.equal(nextTargeted.steps[2]?.status, "in_progress");

  // Finding capacity limit: cannot add 11th distinct finding, but duplicate finding passes at capacity
  let fullFindingsState = advanced;
  for (let i = 2; i <= 10; i++) {
    fullFindingsState = applyAction(fullFindingsState, { action: "add_finding", finding: `Finding ${i}` }).state!;
  }
  assert.equal(fullFindingsState.findings.length, 10);
  const eleventhFinding = applyAction(fullFindingsState, { action: "add_finding", finding: "Finding 11" });
  assert.match(eleventhFinding.error ?? "", /at most 10 findings/);
  assert.equal(eleventhFinding.state, fullFindingsState);
  const dupAtCapacity = applyAction(fullFindingsState, { action: "add_finding", finding: "Step 1 passed" });
  assert.equal(dupAtCapacity.error, undefined);
  assert.equal(dupAtCapacity.state!.findings.length, 10);

  // Error cases
  const failures = [
    [completed, { action: "advance_step" } as const, /All steps are complete/],
    [completed, { action: "update_step", id: 99, status: "pending" as const }, /Step #99 not found/],
    [completed, { action: "update_step", id: 1 } as const, /at least one of/],
    [advanced, { action: "advance_step", id: 99 } as const, /Step #99 not found/],
    [advanced, { action: "advance_step", id: 1 } as const, /Step #1 is not in progress/],
    [advanced, { action: "advance_step", nextId: 99 } as const, /Step #99 not found/],
  ] as const;
  for (const [state, params, error] of failures) {
    const result = applyAction(state, params as never);
    assert.match(result.error ?? "", error);
    assert.equal(result.state, state);
  }
});

test("provider schema is flat, describes outcome and doneWhen, and exposes 7 actions", async () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  const schema = JSON.parse(JSON.stringify(harness.registered?.parameters)) as {
    type?: string;
    required?: string[];
    additionalProperties?: boolean;
    properties?: Record<string, any>;
  };
  assert.equal(schema.type, "object");
  assert.equal("anyOf" in schema, false);
  assert.deepEqual(schema.required, ["action"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties?.action?.enum, [
    "set_plan", "advance_step", "update_step", "add_step", "add_finding", "show", "clear",
  ]);
  assert.equal(schema.properties?.outcome?.description, "A coherent result, not an individual edit or command.");
  assert.equal(schema.properties?.steps?.items?.properties?.outcome?.description, "A coherent result, not an individual edit or command.");
  assert.equal(schema.properties?.doneWhen?.description, "Observable completion condition.");
  assert.equal(schema.properties?.steps?.items?.properties?.doneWhen?.description, "Observable completion condition.");
  assert.equal(schema.properties?.id?.description, "Step ID to complete (for advance_step) or update (for update_step). Defaults to the active in-progress step for advance_step; only needed if multiple steps are in progress.");
  assert.equal(schema.properties?.nextId?.description, "Specific next step ID to start (for advance_step). Defaults to the next pending step. Only needed for non-linear workflows.");
  for (const oldField of ["todos", "todo", "text"]) assert.equal(Object.hasOwn(schema.properties ?? {}, oldField), false);

  await harness.tool!.execute("call", plan, undefined, undefined, harness.ctx);
  const before = (await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state;
  const widgetCalls = harness.widgetCalls.length;
  const invalid = [
    { action: "unknown_action" },
    { action: "set_plan", goal: "Missing steps" },
    { action: "add_step", outcome: "Missing doneWhen" },
    { action: "update_step" },
  ];
  for (const params of invalid) {
    const result = await harness.tool!.execute("call", params as never, undefined, undefined, harness.ctx);
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /^Invalid task_state parameters/);
    assert.deepEqual(result.details.state, before);
  }
  assert.equal(harness.widgetCalls.length, widgetCalls);
});

test("semantic validation enforces shared text and collection budgets", () => {
  const valid = applyAction(undefined, plan).state!;
  const over = (length: number) => "x".repeat(length + 1);
  const failures: Array<[TaskState | undefined, TaskStateParamsType, RegExp]> = [
    [undefined, { action: "set_plan", goal: "Empty", steps: [] }, /1–10 steps/],
    [undefined, { action: "set_plan", goal: "Many", steps: Array.from({ length: TASK_STATE_LIMITS.steps + 1 }, () => ({ outcome: "Step", doneWhen: "Done" })) }, /1–10 steps/],
    [undefined, { action: "set_plan", goal: over(TASK_STATE_LIMITS.goal), steps: plan.steps }, /limit/],
    [undefined, { action: "set_plan", goal: "Over constraints", steps: plan.steps, constraints: Array.from({ length: TASK_STATE_LIMITS.constraints + 1 }, () => "c") }, /at most 10 constraints/],
    [valid, { action: "add_step", outcome: over(TASK_STATE_LIMITS.stepOutcome), doneWhen: "Done" }, /limit/],
    [valid, { action: "update_step", id: 1, doneWhen: over(TASK_STATE_LIMITS.doneWhen) }, /limit/],
    [valid, { action: "add_finding", finding: over(TASK_STATE_LIMITS.finding) }, /limit/],
  ];
  for (const [state, params, error] of failures) assert.match(applyAction(state, params).error ?? "", error);

  const fullPlan = applyAction(undefined, {
    action: "set_plan",
    goal: "Full",
    steps: Array.from({ length: TASK_STATE_LIMITS.steps }, (_, index) => ({ outcome: `step ${index}`, doneWhen: "Done" })),
  }).state!;
  assert.match(applyAction(fullPlan, { action: "add_step", outcome: "extra", doneWhen: "Done" }).error ?? "", /at most 10/);

  let found = valid;
  for (let index = 0; index < TASK_STATE_LIMITS.findings; index += 1) {
    found = applyAction(found, { action: "add_finding", finding: `f${index}` }).state!;
  }
  assert.match(applyAction(found, { action: "add_finding", finding: "extra" }).error ?? "", /at most 10/);
});

test("tool results give local feedback while details retain immutable full snapshots", async () => {
  const harness = createHarness();
  setupTaskState(harness.pi);

  const set = await harness.tool!.execute("call", plan, undefined, undefined, harness.ctx);
  assert.match(set.content[0]?.text ?? "", /^Plan set\nGoal: Ship state core/);
  assert.match(set.content[0]?.text ?? "", /#1 \[pending\] Implement state \(done when: State is valid\)/);

  const added = await harness.tool!.execute("call", { action: "add_step", outcome: "Document behavior", doneWhen: "README is current" }, undefined, undefined, harness.ctx);
  assert.equal(added.content[0]?.text, "Step #3 added\nOutcome: Document behavior\nDone when: README is current");
  assert.doesNotMatch(added.content[0]?.text ?? "", /Goal:|Constraints:|Findings:/);
  assert.equal(added.details?.state?.steps.length, 3);

  const updated = await harness.tool!.execute("call", { action: "update_step", id: 1, status: "in_progress" }, undefined, undefined, harness.ctx);
  assert.match(updated.content[0]?.text ?? "", /Step #1 updated/);

  const advanced = await harness.tool!.execute("call", { action: "advance_step", finding: "Current source confirms lifecycle" }, undefined, undefined, harness.ctx);
  assert.match(advanced.content[0]?.text ?? "", /Step #1 complete/);
  assert.match(advanced.content[0]?.text ?? "", /Finding added\nCurrent source confirms lifecycle/);
  assert.match(advanced.content[0]?.text ?? "", /Step #2 in progress/);

  const shown = await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx);
  assert.match(shown.content[0]?.text ?? "", /^Plan\nGoal: Ship state core/);
  assert.match(shown.content[0]?.text ?? "", /Findings: Current source confirms lifecycle/);

  const failed = await harness.tool!.execute("call", { action: "update_step", id: 99, outcome: "Missing" }, undefined, undefined, harness.ctx);
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0]?.text, "Step #99 not found.");
  assert.doesNotMatch(failed.content[0]?.text ?? "", /Goal:|Steps:/);

  set.details!.state!.goal = "mutated";
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state?.goal, "Ship state core");
  const cleared = await harness.tool!.execute("call", { action: "clear" }, undefined, undefined, harness.ctx);
  assert.equal(cleared.content[0]?.text, "Task state cleared.");
  assert.equal(cleared.details?.state, null);
  const emptyShow = await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx);
  assert.equal(emptyShow.content[0]?.text, "Task state is empty.");
});

test("completion deactivates only after settlement and persists one versioned null snapshot", async () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  await harness.tool!.execute("call", plan, undefined, undefined, harness.ctx);
  await harness.tool!.execute("call", { action: "advance_step" }, undefined, undefined, harness.ctx);
  await harness.tool!.execute("call", { action: "advance_step" }, undefined, undefined, harness.ctx);
  const result = await harness.tool!.execute("call", { action: "advance_step" }, undefined, undefined, harness.ctx);
  assert.equal(result.details?.state?.steps.every((step: { status: string }) => step.status === "done"), true);
  assert.equal(harness.appended.length, 0);

  harness.agentSettled!({} as never, harness.ctx);
  const afterSettled = await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx);
  assert.equal(afterSettled.details?.state, null);
  assert.deepEqual(harness.appended, [{ customType: TASK_STATE_ENTRY, data: { version: TASK_STATE_VERSION, state: null } }]);
  harness.agentSettled!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 1);
});

test("replanning preserves active knowledge but completed plans start fresh", () => {
  const active = applyAction(undefined, { ...plan, constraints: ["Keep scope narrow"] }).state!;
  const informed = applyAction(active, { action: "add_finding", finding: "Keep evidence" }).state!;
  const replanned = applyAction(informed, { action: "set_plan", goal: "Follow up", steps: [{ outcome: "Continue", doneWhen: "Done" }] }).state!;
  assert.deepEqual(replanned.constraints, ["Keep scope narrow"]);
  assert.deepEqual(replanned.findings, ["Keep evidence"]);
  assert.equal(replanned.steps[0]?.status, "pending");

  const started = applyAction(informed, { action: "update_step", id: 1, status: "in_progress" }).state!;
  const advanced1 = applyAction(started, { action: "advance_step" }).state!;
  const fullyComplete = applyAction(advanced1, { action: "advance_step" }).state!;
  const fresh = applyAction(fullyComplete, { action: "set_plan", goal: "New task", steps: [{ outcome: "Start", doneWhen: "Done" }] }).state!;
  assert.deepEqual(fresh.constraints, []);
  assert.deepEqual(fresh.findings, []);
});

test("reconstruction accepts only the newest valid version 2 snapshot and drops version 1 state", async () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  const active = applyAction(undefined, plan).state!;
  const current = { tool: "task_state", action: "set_plan", params: {}, ...snapshotTaskState(active) };
  const legacy = {
    tool: "task_state",
    action: "set_plan",
    params: {},
    version: 1,
    state: {
      goal: "Old goal",
      steps: [{ id: 1, text: "Old step", done: false }],
    },
  };

  harness.branch = [
    { type: "custom", customType: TASK_STATE_ENTRY, data: legacy },
    toolResult("task_state", legacy),
    { type: "custom", customType: TASK_STATE_ENTRY, data: current },
  ];
  harness.sessionStart!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state?.goal, "Ship state core");

  harness.branch = [
    { type: "custom", customType: TASK_STATE_ENTRY, data: legacy },
    toolResult("task_state", legacy),
  ];
  harness.sessionStart!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state, null);

  const historicalLegacyAction = {
    tool: "task_state",
    action: "complete_step",
    params: { id: 1 },
    ...snapshotTaskState(active),
  };
  harness.branch = [toolResult("task_state", historicalLegacyAction)];
  harness.sessionStart!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state?.goal, "Ship state core");
});

test("compaction persists only changed version 2 snapshots on the active branch", () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  const initial = applyAction(undefined, plan).state!;
  harness.branch = [{ type: "custom", customType: TASK_STATE_ENTRY, data: snapshotTaskState(initial) }];
  harness.sessionStart!({} as never, harness.ctx);

  harness.sessionCompact!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 0);

  const updated = applyAction(initial, { action: "add_finding", finding: "Discovered fast path" }).state!;
  harness.branch.push({ type: "custom", customType: TASK_STATE_ENTRY, data: snapshotTaskState(updated) });
  harness.sessionStart!({} as never, harness.ctx);
  harness.sessionCompact!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 0);
});

test("compaction dedupe is branch-aware and ignores malformed latest custom snapshots", () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  const active = applyAction(undefined, plan).state!;
  const details = { tool: "task_state", action: "set_plan", params: {}, ...snapshotTaskState(active) };
  harness.branch = [toolResult("task_state", details)];
  harness.sessionStart!({} as never, harness.ctx);
  harness.sessionCompact!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 1);

  harness.branch = [toolResult("task_state", details)];
  harness.sessionTree!({} as never, harness.ctx);
  harness.sessionCompact!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 2);

  harness.branch = [
    { type: "custom", customType: TASK_STATE_ENTRY, data: snapshotTaskState(active) },
    { type: "custom", customType: TASK_STATE_ENTRY, data: { version: 999, state: active } },
  ];
  harness.sessionCompact!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 3);
});

function toolResult(toolName: string, details: unknown) {
  return { type: "message", message: { role: "toolResult", toolName, details } };
}

function createHarness() {
  let sessionStart: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  let sessionCompact: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  let sessionTree: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  let agentSettled: ((event: unknown, ctx: ExtensionContext) => void) | undefined;
  let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
  let registered: any;
  const appended: Array<{ customType: string; data: unknown }> = [];
  const widgetCalls: Array<{ key: string; content: unknown; options: unknown }> = [];
  let branch: any[] = [];

  const pi: ExtensionAPI = {
    on(event: string, handler: any) {
      if (event === "session_start") sessionStart = handler;
      if (event === "session_tree") sessionTree = handler;
      if (event === "session_compact") sessionCompact = handler;
      if (event === "agent_settled") agentSettled = handler;
      return pi;
    },
    registerTool(definition: any) {
      registered = definition;
      tool = definition;
      return pi;
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
  } as unknown as ExtensionAPI;

  const ctx: ExtensionContext = {
    hasUI: true,
    mode: "tui",
    sessionManager: {
      getBranch: () => branch,
    },
    ui: {
      setWidget(key: string, content: unknown, options: unknown) {
        widgetCalls.push({ key, content, options });
      },
    },
  } as unknown as ExtensionContext;

  return {
    pi,
    ctx,
    get sessionStart() { return sessionStart; },
    get sessionTree() { return sessionTree; },
    get sessionCompact() { return sessionCompact; },
    get agentSettled() { return agentSettled; },
    get tool() { return tool; },
    get registered() { return registered; },
    get appended() { return appended; },
    get widgetCalls() { return widgetCalls; },
    get branch() { return branch; },
    set branch(val: any[]) { branch = val; },
  };
}
