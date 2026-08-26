import assert from "node:assert/strict";
import test from "node:test";
import { composePrompt } from "./index.ts";

const base = "Pi base\n<user_append>keep</user_append>\n<other_extension>keep</other_extension>";

test("composes only selected pi-gear capability sections", () => {
  const cases: Array<{ name: string; tools: string[] | undefined; plan: boolean; research: boolean; worker: boolean; subagents: boolean }> = [
    { name: "undefined", tools: undefined, plan: false, research: false, worker: false, subagents: false },
    { name: "none", tools: [], plan: false, research: false, worker: false, subagents: false },
    { name: "task_state", tools: ["task_state"], plan: true, research: false, worker: false, subagents: false },
    { name: "research", tools: ["researcher"], plan: false, research: true, worker: false, subagents: true },
    { name: "worker", tools: ["worker"], plan: false, research: false, worker: true, subagents: true },
    { name: "both research and plan", tools: ["researcher", "task_state"], plan: true, research: true, worker: false, subagents: true },
    { name: "all three", tools: ["researcher", "task_state", "worker"], plan: true, research: true, worker: true, subagents: true },
    { name: "unrelated tool", tools: ["bash"], plan: false, research: false, worker: false, subagents: false },
  ];
  for (const current of cases) {
    const prompt = composePrompt(base, current.tools);
    assert.equal(prompt.includes("Plan:\n"), current.plan, current.name);
    assert.equal(prompt.includes("Research:\n"), current.research, current.name);
    assert.equal(prompt.includes("Worker:\n"), current.worker, current.name);
    assert.equal(prompt.includes("Subagents:\n"), current.subagents, current.name);
    assert.doesNotMatch(prompt, /<task_state_snapshot>/, current.name);
    assert.match(prompt, /<user_append>keep<\/user_append>/, current.name);
    assert.match(prompt, /<other_extension>keep<\/other_extension>/, current.name);
  }
  assert.equal(composePrompt("Pi base  ", undefined), "Pi base  ");
});

test("orders Plan before Research before Worker before Subagents and replaces only its idempotent block", () => {
  const prompt = composePrompt(base, ["worker", "researcher", "task_state"]);
  assert.ok(prompt.indexOf("Plan:\n") < prompt.indexOf("Research:\n"));
  assert.ok(prompt.indexOf("Research:\n") < prompt.indexOf("Worker:\n"));
  assert.ok(prompt.indexOf("Worker:\n") < prompt.indexOf("Subagents:\n"));
  assert.equal((prompt.match(/<pi_gear_context>/g) ?? []).length, 1);
  const replaced = composePrompt(prompt, ["worker", "researcher"]);
  assert.equal((replaced.match(/<pi_gear_context>/g) ?? []).length, 1);
  assert.doesNotMatch(replaced, /Plan:\n/);
  assert.match(replaced, /Research:\n/);
  assert.match(replaced, /Worker:\n/);
  assert.match(replaced, /Subagents:\n/);
  const removed = composePrompt(replaced, []);
  assert.equal(removed, base);
});

test("plan guidance is concise and completion-oriented", () => {
  const prompt = composePrompt(base, ["task_state"]);
  assert.match(prompt, /Use task_state for non-trivial work/);
  assert.match(prompt, /Complete outcome steps only when their doneWhen is satisfied/);
  assert.match(prompt, /prefer the smallest useful check before dependent work proceeds/);
  assert.match(prompt, /Replan when evidence changes/);
  assert.doesNotMatch(prompt, /authoritative|recover/);
  assert.doesNotMatch(prompt, /continu|stop|blocker|final response/i);
});

test("delegation guidance preserves research terms and explains asynchronous subagent control", () => {
  const prompt = composePrompt(base, ["researcher", "worker"]);
  assert.match(prompt, /Preserve exact identifiers and quoted terms in delegated questions/);
  assert.match(prompt, /Ask one bounded question; require a conclusion, evidence, and uncertainty/);
  assert.match(prompt, /For non-trivial work, use workers to speed up two or more independent ready tasks with disjoint files/);
  assert.match(prompt, /Do not parallelize dependencies or overlapping edits/);
  assert.match(prompt, /Workers should satisfy focused completion checks/);
  assert.match(prompt, /Keep integration and final verification in the main agent/);
  assert.match(prompt, /Researcher and worker calls return a runId immediately/);
  assert.match(prompt, /Do independent work before observing; use bounded subagent_observe calls and avoid repeated polling/);
  assert.match(prompt, /Cancel or redispatch narrower work when stalled, repeatedly failing, unnecessary, or over budget/);
  assert.match(prompt, /Do not edit an active worker's targetFiles/);
});
