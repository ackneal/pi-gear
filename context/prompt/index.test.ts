import assert from "node:assert/strict";
import test from "node:test";
import { composePrompt } from "./index.ts";

const base = "Pi base\n<user_append>keep</user_append>\n<other_extension>keep</other_extension>";

test("composes only selected pi-gear capability sections", () => {
  const cases: Array<{ name: string; tools: string[] | undefined; plan: boolean; research: boolean; worker: boolean }> = [
    { name: "undefined", tools: undefined, plan: false, research: false, worker: false },
    { name: "none", tools: [], plan: false, research: false, worker: false },
    { name: "task_state", tools: ["task_state"], plan: true, research: false, worker: false },
    { name: "research", tools: ["researcher"], plan: false, research: true, worker: false },
    { name: "worker", tools: ["worker"], plan: false, research: false, worker: true },
    { name: "both research and plan", tools: ["researcher", "task_state"], plan: true, research: true, worker: false },
    { name: "all three", tools: ["researcher", "task_state", "worker"], plan: true, research: true, worker: true },
    { name: "unrelated tool", tools: ["bash"], plan: false, research: false, worker: false },
  ];
  for (const current of cases) {
    const prompt = composePrompt(base, current.tools);
    assert.equal(prompt.includes("Plan:\n"), current.plan, current.name);
    assert.equal(prompt.includes("Research:\n"), current.research, current.name);
    assert.equal(prompt.includes("Worker:\n"), current.worker, current.name);
    assert.doesNotMatch(prompt, /<task_state_snapshot>/, current.name);
    assert.match(prompt, /<user_append>keep<\/user_append>/, current.name);
    assert.match(prompt, /<other_extension>keep<\/other_extension>/, current.name);
  }
  assert.equal(composePrompt("Pi base  ", undefined), "Pi base  ");
});

test("orders Plan before Research before Worker and replaces only its idempotent block", () => {
  const prompt = composePrompt(base, ["worker", "researcher", "task_state"]);
  assert.ok(prompt.indexOf("Plan:\n") < prompt.indexOf("Research:\n"));
  assert.ok(prompt.indexOf("Research:\n") < prompt.indexOf("Worker:\n"));
  assert.equal((prompt.match(/<pi_gear_context>/g) ?? []).length, 1);
  const replaced = composePrompt(prompt, ["worker", "researcher"]);
  assert.equal((replaced.match(/<pi_gear_context>/g) ?? []).length, 1);
  assert.doesNotMatch(replaced, /Plan:\n/);
  assert.match(replaced, /Research:\n/);
  assert.match(replaced, /Worker:\n/);
  const removed = composePrompt(replaced, []);
  assert.equal(removed, base);
});

test("plan guidance contains planning semantics and recovery instruction", () => {
  const prompt = composePrompt(base, ["task_state"]);
  assert.match(prompt, /externalize and maintain the authoritative state for non-trivial work/);
  assert.match(prompt, /one goal; 3–7 outcome-based todos.*verifiable doneWhen/);
  assert.match(prompt, /requirements and boundaries as constraints/);
  assert.match(prompt, /decision-relevant evidence as findings/);
  assert.match(prompt, /Update the state as work progresses.*replan when evidence changes.*Clear only when starting a new task/);
  assert.match(prompt, /task_state with action=show to recover the authoritative state/);
  assert.doesNotMatch(prompt, /continu|stop|blocker|final response/i);
});

test("delegation guidance limits workers to independent parallel work", () => {
  const prompt = composePrompt(base, ["researcher", "worker"]);
  assert.match(prompt, /Ask one bounded question; require a conclusion, evidence, and uncertainty/);
  assert.match(prompt, /parallelize bounded, independent work/);
  assert.match(prompt, /known context, constraints, expected outcomes, and checks/);
  assert.match(prompt, /Parallelize only disjoint workspace changes/);
  assert.match(prompt, /you own integration and final verification/);
});
