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

function startAndComplete(state: TaskState, id: number): TaskState {
  const started = applyAction(state, { action: "start_step", id }).state!;
  return applyAction(started, { action: "complete_step", id }).state!;
}

test("step reducers assign pending status and enforce semantic transitions", () => {
  const initial = applyAction(undefined, plan).state!;
  assert.deepEqual(initial.steps.map(({ id, status }) => ({ id, status })), [
    { id: 1, status: "pending" },
    { id: 2, status: "pending" },
  ]);

  const added = applyAction(initial, { action: "add_step", step: { outcome: "Document state", doneWhen: "README is current" } }).state!;
  assert.deepEqual(added.steps.map(({ id, status }) => ({ id, status })), [
    { id: 1, status: "pending" },
    { id: 2, status: "pending" },
    { id: 3, status: "pending" },
  ]);

  const firstStarted = applyAction(added, { action: "start_step", id: 1 }).state!;
  const parallel = applyAction(firstStarted, { action: "start_step", id: 2 }).state!;
  assert.deepEqual(parallel.steps.map((step) => step.status), ["in_progress", "in_progress", "pending"]);

  const firstDone = applyAction(parallel, { action: "complete_step", id: 1 }).state!;
  const reopened = applyAction(firstDone, { action: "start_step", id: 1 }).state!;
  assert.equal(reopened.steps[0]?.status, "in_progress");

  const revised = applyAction(reopened, { action: "revise_step", id: 1, outcome: "Implement semantic state", doneWhen: "Focused reducer tests pass" }).state!;
  assert.deepEqual(revised.steps[0], {
    id: 1,
    outcome: "Implement semantic state",
    doneWhen: "Focused reducer tests pass",
    status: "in_progress",
  });

  const done = applyAction(revised, { action: "complete_step", id: 1 }).state!;
  const failures = [
    [added, { action: "complete_step", id: 1 }, /Start step #1/],
    [firstStarted, { action: "start_step", id: 1 }, /already in progress/],
    [done, { action: "complete_step", id: 1 }, /already complete/],
    [done, { action: "revise_step", id: 1 }, /Provide outcome or doneWhen/],
    [done, { action: "remove_step", id: 99 }, /not found/],
  ] as const;
  for (const [state, params, error] of failures) {
    const result = applyAction(state, params);
    assert.match(result.error ?? "", error);
    assert.equal(result.state, state);
  }

  const only = applyAction(undefined, { action: "set_plan", goal: "One", steps: [{ outcome: "Only", doneWhen: "Finished" }] }).state!;
  assert.match(applyAction(only, { action: "remove_step", id: 1 }).error ?? "", /at least 1 step/);
});

test("revise_step preserves a completed outcome until start_step reopens it", () => {
  const initial = applyAction(undefined, plan).state!;
  const completed = startAndComplete(initial, 1);

  const rejected = applyAction(completed, { action: "revise_step", id: 1, outcome: "Change completed state" });
  assert.equal(rejected.error, "Step #1 is complete; use start_step to reopen it before revising it.");
  assert.equal(rejected.state, completed);
  assert.equal(completed.steps[0]?.outcome, "Implement state");
  assert.equal(completed.steps[0]?.status, "done");

  const reopened = applyAction(completed, { action: "start_step", id: 1 }).state!;
  const revised = applyAction(reopened, { action: "revise_step", id: 1, outcome: "Change reopened state" }).state!;
  assert.equal(revised.steps[0]?.outcome, "Change reopened state");
  assert.equal(revised.steps[0]?.status, "in_progress");
});

test("provider schema is flat, describes outcome and doneWhen, and exposes no status mutation", async () => {
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
    "set_plan", "add_step", "revise_step", "remove_step", "start_step", "complete_step",
    "add_constraint", "remove_constraint", "add_finding", "remove_finding", "show", "clear",
  ]);
  assert.equal(schema.properties?.outcome?.description, "A coherent result, not an individual edit or command.");
  assert.equal(schema.properties?.steps?.items?.properties?.outcome?.description, "A coherent result, not an individual edit or command.");
  assert.equal(schema.properties?.doneWhen?.description, "Observable completion condition.");
  assert.equal(schema.properties?.steps?.items?.properties?.doneWhen?.description, "Observable completion condition.");
  assert.equal(JSON.stringify(schema).includes('"status"'), false);
  for (const oldField of ["todos", "todo", "text"]) assert.equal(Object.hasOwn(schema.properties ?? {}, oldField), false);

  await harness.tool!.execute("call", plan, undefined, undefined, harness.ctx);
  const before = (await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state;
  const widgetCalls = harness.widgetCalls.length;
  const invalid = [
    { action: "set_plan", goal: "Status injection", steps: [{ outcome: "Injected", doneWhen: "Rejected", status: "done" }] },
    { action: "add_step", step: { outcome: "Injected", doneWhen: "Rejected", status: "in_progress" } },
    { action: "revise_step", id: 1, status: "done" },
    { action: "start_step", id: 1, status: "in_progress" },
    { action: "update_todo", id: 1, status: "done" },
    { action: "add_step", step: { outcome: "Cross action", doneWhen: "Rejected" }, goal: "Unexpected" },
  ];
  for (const params of invalid) {
    const result = await harness.tool!.execute("call", params, undefined, undefined, harness.ctx);
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "Invalid task_state parameters.");
    assert.deepEqual(result.details.state, before);
  }
  assert.equal(harness.widgetCalls.length, widgetCalls);
  assert.equal(harness.context, undefined);
  assert.equal(harness.beforeAgentStart, undefined);
});

test("semantic validation enforces shared text and collection budgets", () => {
  const valid = applyAction(undefined, plan).state!;
  const over = (length: number) => "x".repeat(length + 1);
  const failures: Array<[TaskState | undefined, TaskStateParamsType, RegExp]> = [
    [undefined, { action: "set_plan", goal: "Empty", steps: [] }, /1–10 steps/],
    [undefined, { action: "set_plan", goal: "Many", steps: Array.from({ length: TASK_STATE_LIMITS.steps + 1 }, () => ({ outcome: "Step", doneWhen: "Done" })) }, /1–10 steps/],
    [undefined, { action: "set_plan", goal: over(TASK_STATE_LIMITS.goal), steps: plan.steps }, /limit/],
    [valid, { action: "add_step", step: { outcome: over(TASK_STATE_LIMITS.stepOutcome), doneWhen: "Done" } }, /limit/],
    [valid, { action: "revise_step", id: 1, doneWhen: over(TASK_STATE_LIMITS.doneWhen) }, /limit/],
    [valid, { action: "add_constraint", constraint: over(TASK_STATE_LIMITS.constraint) }, /limit/],
    [valid, { action: "add_finding", finding: over(TASK_STATE_LIMITS.finding) }, /limit/],
  ];
  for (const [state, params, error] of failures) assert.match(applyAction(state, params).error ?? "", error);

  const fullPlan = applyAction(undefined, {
    action: "set_plan",
    goal: "Full",
    steps: Array.from({ length: TASK_STATE_LIMITS.steps }, (_, index) => ({ outcome: `step ${index}`, doneWhen: "Done" })),
  }).state!;
  assert.match(applyAction(fullPlan, { action: "add_step", step: { outcome: "extra", doneWhen: "Done" } }).error ?? "", /at most 10/);

  let constrained = valid;
  for (let index = 0; index < TASK_STATE_LIMITS.constraints; index += 1) {
    constrained = applyAction(constrained, { action: "add_constraint", constraint: `c${index}` }).state!;
  }
  assert.match(applyAction(constrained, { action: "add_constraint", constraint: "extra" }).error ?? "", /at most 10/);

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

  const added = await harness.tool!.execute("call", { action: "add_step", step: { outcome: "Document behavior", doneWhen: "README is current" } }, undefined, undefined, harness.ctx);
  assert.equal(added.content[0]?.text, "Step #3 added\nOutcome: Document behavior\nDone when: README is current");
  assert.doesNotMatch(added.content[0]?.text ?? "", /Goal:|Constraints:|Findings:/);
  assert.equal(added.details?.state?.steps.length, 3);
  const removed = await harness.tool!.execute("call", { action: "remove_step", id: 3 }, undefined, undefined, harness.ctx);
  assert.equal(removed.content[0]?.text, "Step #3 removed");
  assert.equal(removed.details?.state?.steps.length, 2);

  const revised = await harness.tool!.execute("call", { action: "revise_step", id: 1, outcome: "Implement transitions" }, undefined, undefined, harness.ctx);
  assert.equal(revised.content[0]?.text, "Step #1 revised\nOutcome: Implement transitions\nDone when: State is valid");
  const started = await harness.tool!.execute("call", { action: "start_step", id: 1 }, undefined, undefined, harness.ctx);
  assert.equal(started.content[0]?.text, "Step #1 in progress\nOutcome: Implement transitions\nDone when: State is valid");
  const completed = await harness.tool!.execute("call", { action: "complete_step", id: 1 }, undefined, undefined, harness.ctx);
  assert.equal(completed.content[0]?.text, "Step #1 complete");
  const reopened = await harness.tool!.execute("call", { action: "start_step", id: 1 }, undefined, undefined, harness.ctx);
  assert.equal(reopened.content[0]?.text, "Step #1 reopened\nOutcome: Implement transitions\nDone when: State is valid");

  const constraint = await harness.tool!.execute("call", { action: "add_constraint", constraint: "Keep scope narrow" }, undefined, undefined, harness.ctx);
  assert.equal(constraint.content[0]?.text, "Constraint added\nKeep scope narrow");
  const finding = await harness.tool!.execute("call", { action: "add_finding", finding: "Current source confirms lifecycle" }, undefined, undefined, harness.ctx);
  assert.equal(finding.content[0]?.text, "Finding added\nCurrent source confirms lifecycle");

  const shown = await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx);
  assert.match(shown.content[0]?.text ?? "", /^Plan\nGoal: Ship state core/);
  assert.match(shown.content[0]?.text ?? "", /Constraints: Keep scope narrow\nFindings: Current source confirms lifecycle/);
  const findingRemoved = await harness.tool!.execute("call", { action: "remove_finding", finding: "Current source confirms lifecycle" }, undefined, undefined, harness.ctx);
  assert.equal(findingRemoved.content[0]?.text, "Finding removed\nCurrent source confirms lifecycle");
  const constraintRemoved = await harness.tool!.execute("call", { action: "remove_constraint", constraint: "Keep scope narrow" }, undefined, undefined, harness.ctx);
  assert.equal(constraintRemoved.content[0]?.text, "Constraint removed\nKeep scope narrow");

  const failed = await harness.tool!.execute("call", { action: "remove_step", id: 99 }, undefined, undefined, harness.ctx);
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0]?.text, "Step #99 not found.");
  assert.doesNotMatch(failed.content[0]?.text ?? "", /Goal:|Steps:/);

  set.details!.state!.goal = "mutated";
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state?.goal, "Ship state core");
  const cleared = await harness.tool!.execute("call", { action: "clear" }, undefined, undefined, harness.ctx);
  assert.equal(cleared.content[0]?.text, "Plan cleared");
  assert.equal(cleared.details?.state, null);
});

test("completion deactivates only after settlement and persists one versioned null snapshot", async () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  await harness.tool!.execute("call", plan, undefined, undefined, harness.ctx);
  for (const id of [1, 2]) {
    await harness.tool!.execute("call", { action: "start_step", id }, undefined, undefined, harness.ctx);
    const result = await harness.tool!.execute("call", { action: "complete_step", id }, undefined, undefined, harness.ctx);
    if (id === 2) {
      assert.equal(result.content[0]?.text, "Step #2 complete");
      assert.equal(result.details?.state?.steps.every((step: { status: string }) => step.status === "done"), true);
    }
  }
  assert.equal(harness.appended.length, 0);

  harness.agentSettled!({} as never, harness.ctx);
  const afterSettled = await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx);
  assert.equal(afterSettled.details?.state, null);
  assert.deepEqual(harness.appended, [{ customType: TASK_STATE_ENTRY, data: { version: TASK_STATE_VERSION, state: null } }]);
  harness.agentSettled!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 1);
});

test("replanning preserves active knowledge but completed plans start fresh", () => {
  const active = applyAction(undefined, plan).state!;
  const constrained = applyAction(active, { action: "add_constraint", constraint: "Keep scope narrow" }).state!;
  const informed = applyAction(constrained, { action: "add_finding", finding: "Keep evidence" }).state!;
  const replanned = applyAction(informed, { action: "set_plan", goal: "Follow up", steps: [{ outcome: "Continue", doneWhen: "Done" }] }).state!;
  assert.deepEqual(replanned.constraints, ["Keep scope narrow"]);
  assert.deepEqual(replanned.findings, ["Keep evidence"]);
  assert.equal(replanned.steps[0]?.status, "pending");

  const firstDone = startAndComplete(informed, 1);
  const fullyComplete = startAndComplete(firstDone, 2);
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
    state: { goal: "Legacy", todos: [{ id: 1, text: "Old", doneWhen: "Done", status: "pending" }], constraints: [], findings: [] },
  };

  harness.branch = [toolResult("task_state", current), toolResult("task_state", legacy)];
  harness.sessionStart!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state, null);

  harness.branch = [toolResult("task_state", current), toolResult("task_state", { ...current, version: 999 })];
  harness.sessionTree!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state, null);

  const invalidVersion2States = [
    { ...active, todos: [] },
    { ...active, steps: [{ ...active.steps[0]!, text: "Legacy" }, ...active.steps.slice(1)] },
  ];
  for (const state of invalidVersion2States) {
    harness.branch = [toolResult("task_state", current), toolResult("task_state", { ...current, state })];
    harness.sessionTree!({} as never, harness.ctx);
    assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state, null);
  }

  harness.branch = [toolResult("task_state", current)];
  harness.sessionTree!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state?.goal, "Ship state core");

  harness.branch = [toolResult("task_state", current), { type: "custom", customType: TASK_STATE_ENTRY, data: snapshotTaskState(undefined) }];
  harness.sessionTree!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state, null);
});

test("compaction persists only changed version 2 snapshots on the active branch", async () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  await harness.tool!.execute("call", plan, undefined, undefined, harness.ctx);
  harness.sessionCompact!({} as never, harness.ctx);
  assert.deepEqual(harness.appended, [{ customType: TASK_STATE_ENTRY, data: { version: TASK_STATE_VERSION, state: applyAction(undefined, plan).state } }]);
  harness.sessionCompact!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 1);

  await harness.tool!.execute("call", { action: "revise_step", id: 1, outcome: "Ship compact dedupe" }, undefined, undefined, harness.ctx);
  harness.sessionCompact!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 2);
  assert.equal((harness.appended[1]?.data as { state: TaskState }).state.steps[0]?.outcome, "Ship compact dedupe");

  await harness.tool!.execute("call", { action: "clear" }, undefined, undefined, harness.ctx);
  harness.sessionCompact!({} as never, harness.ctx);
  assert.deepEqual(harness.appended[2]?.data, { version: TASK_STATE_VERSION, state: null });
  harness.sessionCompact!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 3);

  harness.branch = [{ type: "custom", customType: TASK_STATE_ENTRY, data: harness.appended[0]?.data }];
  harness.sessionTree!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state?.goal, "Ship state core");
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
  let branch: unknown[] = [];
  let registered: Record<string, any> | undefined;
  const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => any> = {};
  const widgetCalls: Array<[string, unknown, { placement: "aboveEditor" }]> = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const ctx = { hasUI: true, mode: "tui", ui: { setWidget: (key: string, content: unknown, options: { placement: "aboveEditor" }) => widgetCalls.push([key, content, options]) }, sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  const pi = { on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => any) => { handlers[event] = handler; }, registerTool: (tool: Record<string, any>) => { registered = tool; }, appendEntry: (customType: string, data: unknown) => { appended.push({ customType, data }); branch.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
  const tool = () => registered as { execute: (...args: any[]) => Promise<any> } | undefined;
  return { pi, ctx, appended, widgetCalls, get branch() { return branch; }, set branch(value: unknown[]) { branch = value; }, get registered() { return registered; }, get tool() { return tool(); }, get sessionStart() { return handlers.session_start; }, get sessionTree() { return handlers.session_tree; }, get sessionCompact() { return handlers.session_compact; }, get agentSettled() { return handlers.agent_settled; }, get sessionShutdown() { return handlers.session_shutdown; }, get beforeAgentStart() { return handlers.before_agent_start; }, get context() { return handlers.context; } };
}
