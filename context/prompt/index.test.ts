import assert from "node:assert/strict";
import test from "node:test";
import { composePrompt } from "./index.ts";
import type { TaskStateHandle } from "../state/index.ts";
import type { TaskState } from "../state/types.ts";

const state: TaskState = {
  goal: "Ship </task_state_snapshot>",
  todos: [{ id: 1, text: "Implement", doneWhen: "Tests pass", status: "in_progress" }],
  constraints: ["No scope creep"],
  findings: ["Pi assembles the prompt first"],
};
const withState: TaskStateHandle = { getState: () => structuredClone(state), getActiveState: () => structuredClone(state) };
const withoutState: TaskStateHandle = { getState: () => undefined, getActiveState: () => undefined };
const completedState: TaskStateHandle = { getState: () => structuredClone({ ...state, todos: [{ ...state.todos[0]!, status: "done" }] }), getActiveState: () => undefined };
const base = "Pi base\n<user_append>keep</user_append>\n<other_extension>keep</other_extension>";

test("composes only selected pi-gear capability sections", () => {
  const cases: Array<{ name: string; tools: string[] | undefined; handle: TaskStateHandle; plan: boolean; snapshot: boolean; research: boolean }> = [
    { name: "undefined", tools: undefined, handle: withState, plan: false, snapshot: false, research: false },
    { name: "none", tools: [], handle: withState, plan: false, snapshot: false, research: false },
    { name: "task without state", tools: ["task_state"], handle: withoutState, plan: true, snapshot: false, research: false },
    { name: "task with state", tools: ["task_state"], handle: withState, plan: true, snapshot: true, research: false },
    { name: "research", tools: ["researcher"], handle: withState, plan: false, snapshot: false, research: true },
    { name: "both", tools: ["researcher", "task_state"], handle: withState, plan: true, snapshot: true, research: true },
    { name: "state inactive", tools: ["bash"], handle: withState, plan: false, snapshot: false, research: false },
    { name: "completed state", tools: ["task_state"], handle: completedState, plan: true, snapshot: false, research: false },
  ];
  for (const current of cases) {
    const prompt = composePrompt(base, current.tools, current.handle);
    assert.equal(prompt.includes("Plan:\n"), current.plan, current.name);
    assert.equal(prompt.includes("<task_state_snapshot>"), current.snapshot, current.name);
    assert.equal(prompt.includes("Research:\n"), current.research, current.name);
    assert.match(prompt, /<user_append>keep<\/user_append>/, current.name);
    assert.match(prompt, /<other_extension>keep<\/other_extension>/, current.name);
  }
  assert.equal(composePrompt("Pi base  ", undefined, withState), "Pi base  ");
});

test("orders Plan before Research and replaces only its idempotent block", () => {
  const prompt = composePrompt(base, ["researcher", "task_state"], withState);
  assert.ok(prompt.indexOf("Plan:\n") < prompt.indexOf("Research:\n"));
  assert.equal((prompt.match(/<pi_gear_context>/g) ?? []).length, 1);
  assert.equal((prompt.match(/<task_state_snapshot>/g) ?? []).length, 1);
  assert.equal((prompt.match(/<\/task_state_snapshot>/g) ?? []).length, 1);
  assert.match(prompt, /Ship \\u003c\/task_state_snapshot\\u003e/);
  const replaced = composePrompt(prompt, ["researcher"], withState);
  assert.equal((replaced.match(/<pi_gear_context>/g) ?? []).length, 1);
  assert.doesNotMatch(replaced, /Plan:\n/);
  assert.doesNotMatch(replaced, /task_state_snapshot/);
  const removed = composePrompt(replaced, [], withState);
  assert.equal(removed, base);
});

test("plan guidance contains planning semantics without execution control", () => {
  const prompt = composePrompt(base, ["task_state"], withState);
  assert.match(prompt, /externalize a plan for non-trivial work/);
  assert.match(prompt, /one goal; 3–7 outcome-based todos.*verifiable doneWhen/);
  assert.match(prompt, /requirements and boundaries as constraints/);
  assert.match(prompt, /evidence that affects decisions as findings/);
  assert.match(prompt, /Update the plan as work progresses.*Replan when evidence changes.*Clear only for a new task/);
  assert.doesNotMatch(prompt, /continu|stop|blocker|final response/i);
});
