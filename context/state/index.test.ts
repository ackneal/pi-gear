import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyAction, setupTaskState, TASK_STATE_ENTRY, TaskStateParams, type TaskStateParams as TaskStateParamsType } from "./index.ts";
import { snapshotTaskState } from "./core.ts";
import { TASK_STATE_LIMITS } from "./types.ts";

const plan: TaskStateParamsType = { action: "set_plan", goal: "Ship state core", todos: [
  { text: "Implement state", doneWhen: "State is valid", status: "in_progress" },
  { text: "Test state", doneWhen: "Tests pass" },
] };

test("set_plan is atomic, keeps IDs, and reports missing todos before cardinality", () => {
  const state = applyAction(undefined, plan).state!;
  assert.deepEqual(state.todos.map((todo) => todo.id), [1, 2]);
  assert.equal(applyAction(state, { action: "update_todo", id: 2, status: "done" }).state?.todos[1]?.id, 2);
  const one = applyAction(undefined, { action: "set_plan", goal: "One", todos: [{ text: "Only", doneWhen: "Finished" }] }).state!;
  assert.match(applyAction(one, { action: "remove_todo", id: 99 }).error ?? "", /not found/);
  assert.match(applyAction(one, { action: "remove_todo", id: 1 }).error ?? "", /at least 1/);
});

test("registers a flat object schema and runtime validation preserves atomicity", async () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  const schema = JSON.parse(JSON.stringify(harness.registered?.parameters)) as Record<string, unknown>;
  assert.equal(schema.type, "object");
  assert.equal("anyOf" in schema, false);
  assert.deepEqual(schema.required, ["action"]);
  assert.equal(schema.additionalProperties, false);

  await harness.tool!.execute("call", plan, undefined, undefined, harness.ctx);
  for (const valid of [
    { action: "show" },
    { action: "update_goal", goal: "Updated goal" },
    { action: "add_todo", todo: { text: "Another task", doneWhen: "It is done" } },
    { action: "add_constraint", constraint: "Stay bounded" },
  ]) {
    assert.equal((await harness.tool!.execute("call", valid, undefined, undefined, harness.ctx)).isError, undefined);
  }
  const before = (await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state;
  const widgetCalls = harness.widgetCalls.length;
  for (const invalid of [
    { action: "update_goal" },
    { action: "add_todo", todo: { text: "new", doneWhen: "Done" }, goal: "cross-action" },
    { action: "remove_todo", id: 1, unknown: true },
    { action: "update_todo", id: 1, status: "invalid" },
  ]) {
    const result = await harness.tool!.execute("call", invalid, undefined, undefined, harness.ctx);
    assert.equal(result.isError, true);
    assert.deepEqual(result.details.state, before);
  }
  assert.equal(harness.widgetCalls.length, widgetCalls);
});

test("raw semantic failures retain domain errors and state", async () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  await harness.tool!.execute("call", plan, undefined, undefined, harness.ctx);
  const before = (await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state;
  const over = "x".repeat(TASK_STATE_LIMITS.goal + 1);
  const failures = [
    [{ action: "update_todo", id: 1 }, "Provide text, doneWhen, or status to update a todo."],
    [{ action: "set_plan", goal: "Empty", todos: [] }, "A task state must have 1–10 todos."],
    [{ action: "set_plan", goal: "Many", todos: Array.from({ length: TASK_STATE_LIMITS.todos + 1 }, () => ({ text: "Todo", doneWhen: "Done" })) }, "A task state must have 1–10 todos."],
    [{ action: "update_goal", goal: " " }, "Text values cannot be blank or exceed their limit."],
    [{ action: "update_goal", goal: over }, "Text values cannot be blank or exceed their limit."],
  ] as const;

  for (const [params, error] of failures) {
    const result = await harness.tool!.execute("call", params, undefined, undefined, harness.ctx);
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text?.includes(error), true);
    assert.deepEqual(result.details.state, before);
  }
});

test("semantic validation and reconstruction enforce every shared budget", () => {
  const valid = applyAction(undefined, plan).state!;
  const over = (length: number) => "x".repeat(length + 1);
  assert.match(applyAction(undefined, { action: "set_plan", goal: over(TASK_STATE_LIMITS.goal), todos: plan.todos }).error ?? "", /limit/);
  assert.match(applyAction(valid, { action: "add_todo", todo: { text: over(TASK_STATE_LIMITS.todoText), doneWhen: "Done" } }).error ?? "", /limit/);
  assert.match(applyAction(valid, { action: "update_todo", id: 1, doneWhen: over(TASK_STATE_LIMITS.doneWhen) }).error ?? "", /limit/);
  const fullPlan = applyAction(undefined, { action: "set_plan", goal: "Full", todos: Array.from({ length: TASK_STATE_LIMITS.todos }, (_, index) => ({ text: `todo ${index}`, doneWhen: "Done" })) }).state!;
  assert.match(applyAction(fullPlan, { action: "add_todo", todo: { text: "extra", doneWhen: "Done" } }).error ?? "", /at most 10/);
  let constrained = valid;
  for (let index = 0; index < TASK_STATE_LIMITS.constraints; index += 1) constrained = applyAction(constrained, { action: "add_constraint", constraint: `c${index}` }).state!;
  assert.match(applyAction(constrained, { action: "add_constraint", constraint: "extra" }).error ?? "", /at most 10/);
  assert.match(applyAction(valid, { action: "add_constraint", constraint: over(TASK_STATE_LIMITS.constraint) }).error ?? "", /limit/);
  let found = valid;
  for (let index = 0; index < TASK_STATE_LIMITS.findings; index += 1) found = applyAction(found, { action: "add_finding", finding: `f${index}` }).state!;
  assert.match(applyAction(found, { action: "add_finding", finding: "extra" }).error ?? "", /at most 10/);
  assert.match(applyAction(valid, { action: "add_finding", finding: over(TASK_STATE_LIMITS.finding) }).error ?? "", /limit/);
  assert.equal(applyAction(undefined, { action: "set_plan", goal: " ", todos: [{ text: "Todo", doneWhen: "Done" }] }).error !== undefined, true);
});

test("Task State registers no prompt mutator", () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  assert.equal(harness.context, undefined);
  assert.equal(harness.beforeAgentStart, undefined);
});

test("every result contains the latest complete state and immutable details", async () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  const result = await harness.tool!.execute("call", plan, undefined, undefined, harness.ctx);
  assert.match(result.content[0]?.text ?? "", /^Plan set\nGoal: Ship state core/);
  assert.match(result.content[0]?.text ?? "", /#1 \[in_progress\] Implement state \(done when: State is valid\)/);
  assert.match(result.content[0]?.text ?? "", /Constraints: none\nFindings: none/);
  const constraint = await harness.tool!.execute("call", { action: "add_constraint", constraint: "Keep scope narrow" }, undefined, undefined, harness.ctx);
  assert.match(constraint.content[0]?.text ?? "", /Constraints: Keep scope narrow/);
  const finding = await harness.tool!.execute("call", { action: "add_finding", finding: "Tests prove continuation" }, undefined, undefined, harness.ctx);
  assert.match(finding.content[0]?.text ?? "", /Findings: Tests prove continuation/);
  const updated = await harness.tool!.execute("call", { action: "update_todo", id: 1, status: "done" }, undefined, undefined, harness.ctx);
  assert.match(updated.content[0]?.text ?? "", /#1 \[done\] Implement state \(done when: State is valid\)/);
  const failed = await harness.tool!.execute("call", { action: "remove_todo", id: 99 }, undefined, undefined, harness.ctx);
  assert.equal(failed.isError, true);
  assert.match(failed.content[0]?.text ?? "", /Todo #99 not found/);
  assert.match(failed.content[0]?.text ?? "", /Goal: Ship state core/);
  assert.match(failed.content[0]?.text ?? "", /Constraints: Keep scope narrow/);
  const details = result.details!;
  details.state!.goal = "mutated";
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state?.goal, "Ship state core");
  const cleared = await harness.tool!.execute("call", { action: "clear" }, undefined, undefined, harness.ctx);
  assert.equal(cleared.content[0]?.text, "Plan cleared\nTask state: empty.");
});

test("completion deactivates only after settlement and persists one null snapshot", async () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  await harness.tool!.execute("call", plan, undefined, undefined, harness.ctx);
  await harness.tool!.execute("call", { action: "update_todo", id: 1, status: "done" }, undefined, undefined, harness.ctx);
  const completed = await harness.tool!.execute("call", { action: "update_todo", id: 2, status: "done" }, undefined, undefined, harness.ctx);
  assert.match(completed.content[0]?.text ?? "", /#1 \[done\].*#2 \[done\]/);
  assert.equal(completed.details?.state?.todos.every((todo: { status: string }) => todo.status === "done"), true);
  assert.equal(harness.appended.length, 0);

  harness.agentSettled!({} as never, harness.ctx);
  const afterSettled = await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx);
  assert.equal(afterSettled.details?.state, null);
  assert.deepEqual(harness.appended, [{ customType: TASK_STATE_ENTRY, data: { version: 1, state: null } }]);
  harness.agentSettled!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 1);
});

test("replanning preserves unfinished knowledge but completed plans start fresh", () => {
  const active = applyAction(undefined, plan).state!;
  const informed = applyAction(applyAction(active, { action: "add_constraint", constraint: "Keep scope narrow" }).state!, { action: "add_finding", finding: "Keep evidence" }).state!;
  const replanned = applyAction(informed, { action: "set_plan", goal: "Follow up", todos: [{ text: "Continue", doneWhen: "Done" }] }).state!;
  assert.deepEqual(replanned.constraints, ["Keep scope narrow"]);
  assert.deepEqual(replanned.findings, ["Keep evidence"]);
  const complete = applyAction(informed, { action: "update_todo", id: 1, status: "done" }).state!;
  const fullyComplete = applyAction(complete, { action: "update_todo", id: 2, status: "done" }).state!;
  const fresh = applyAction(fullyComplete, { action: "set_plan", goal: "New task", todos: [{ text: "Start", doneWhen: "Done" }] }).state!;
  assert.deepEqual(fresh.constraints, []);
  assert.deepEqual(fresh.findings, []);
});

test("reconstruction follows only the newest task_state result and fails closed", async () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  const active = applyAction(undefined, plan).state!;
  const failed = { tool: "task_state", action: "update_goal", params: {}, ...snapshotTaskState(active) };
  harness.branch = [toolResult("task_state", failed), toolResult("task_state", { tool: "task_state", action: "set_plan", params: {}, version: 999, state: active })];
  harness.sessionStart!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state, null);
  harness.branch = [toolResult("task_state", { tool: "task_state", action: "set_plan", params: {}, version: 1, state: { ...active, goal: "x".repeat(TASK_STATE_LIMITS.goal + 1) } })];
  harness.sessionTree!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state, null);
  harness.branch = [toolResult("task_state", failed), toolResult("task_state", { tool: "task_state", action: "clear", params: {}, ...snapshotTaskState(undefined) })];
  harness.sessionTree!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state, null);
  harness.branch = [toolResult("task_state", failed)];
  harness.sessionTree!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state?.goal, "Ship state core");
  harness.branch = [toolResult("task_state", { tool: "task_state", action: "update_todo", params: {}, ...snapshotTaskState({ ...active, todos: active.todos.map((todo) => ({ ...todo, status: "done" as const })) }) }), { type: "custom", customType: TASK_STATE_ENTRY, data: snapshotTaskState(undefined) }];
  harness.sessionTree!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state, null);
});

test("compaction appends only a changed snapshot on the active branch", async () => {
  const harness = createHarness();
  setupTaskState(harness.pi);
  await harness.tool!.execute("call", plan, undefined, undefined, harness.ctx);
  harness.sessionCompact!({} as never, harness.ctx);
  assert.deepEqual(harness.appended, [{ customType: TASK_STATE_ENTRY, data: { version: 1, state: applyAction(undefined, plan).state } }]);
  harness.sessionCompact!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 1);

  await harness.tool!.execute("call", { action: "update_goal", goal: "Ship compact dedupe" }, undefined, undefined, harness.ctx);
  harness.sessionCompact!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 2);
  assert.equal((harness.appended[1]?.data as { state: { goal: string } }).state.goal, "Ship compact dedupe");

  await harness.tool!.execute("call", { action: "clear" }, undefined, undefined, harness.ctx);
  harness.sessionCompact!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 3);
  assert.deepEqual(harness.appended[2]?.data, { version: 1, state: null });
  harness.sessionCompact!({} as never, harness.ctx);
  assert.equal(harness.appended.length, 3);

  harness.branch = [{ type: "custom", customType: TASK_STATE_ENTRY, data: harness.appended[0]?.data }];
  harness.sessionTree!({} as never, harness.ctx);
  assert.equal((await harness.tool!.execute("call", { action: "show" }, undefined, undefined, harness.ctx)).details?.state?.goal, "Ship state core");
});

test("compaction dedupe is branch-aware and ignores malformed latest custom snapshots", async () => {
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
  let registered: Record<string, unknown> | undefined;
  const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => any> = {};
  const widgetCalls: Array<[string, unknown, { placement: "aboveEditor" }]> = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const ctx = { hasUI: true, mode: "tui", ui: { setWidget: (key: string, content: unknown, options: { placement: "aboveEditor" }) => widgetCalls.push([key, content, options]) }, sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext;
  const pi = { on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => any) => { handlers[event] = handler; }, registerTool: (tool: Record<string, unknown>) => { registered = tool; }, appendEntry: (customType: string, data: unknown) => { appended.push({ customType, data }); branch.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
  const tool = () => registered as { execute: (...args: any[]) => Promise<any> } | undefined;
  return { pi, ctx, appended, widgetCalls, get branch() { return branch; }, set branch(value: unknown[]) { branch = value; }, get registered() { return registered; }, get tool() { return tool(); }, get sessionStart() { return handlers.session_start; }, get sessionTree() { return handlers.session_tree; }, get sessionCompact() { return handlers.session_compact; }, get agentSettled() { return handlers.agent_settled; }, get sessionShutdown() { return handlers.session_shutdown; }, get beforeAgentStart() { return handlers.before_agent_start; }, get context() { return handlers.context; } };
}
