import assert from "node:assert/strict";
import test from "node:test";
import { composePrompt } from "./index.ts";

const base = "Pi base\n<user_append>keep</user_append>\n<other_extension>keep</other_extension>";

test("composes only selected pi-gear capability sections", () => {
  const cases: Array<{ name: string; tools: string[] | undefined; plan: boolean; research: boolean }> = [
    { name: "undefined", tools: undefined, plan: false, research: false },
    { name: "none", tools: [], plan: false, research: false },
    { name: "task_state", tools: ["task_state"], plan: true, research: false },
    { name: "research", tools: ["researcher"], plan: false, research: true },
    { name: "both", tools: ["researcher", "task_state"], plan: true, research: true },
    { name: "unrelated tool", tools: ["bash"], plan: false, research: false },
  ];
  for (const current of cases) {
    const prompt = composePrompt(base, current.tools);
    assert.equal(prompt.includes("Plan:\n"), current.plan, current.name);
    assert.equal(prompt.includes("Research:\n"), current.research, current.name);
    assert.doesNotMatch(prompt, /<task_state_snapshot>/, current.name);
    assert.match(prompt, /<user_append>keep<\/user_append>/, current.name);
    assert.match(prompt, /<other_extension>keep<\/other_extension>/, current.name);
  }
  assert.equal(composePrompt("Pi base  ", undefined), "Pi base  ");
});

test("orders Plan before Research and replaces only its idempotent block", () => {
  const prompt = composePrompt(base, ["researcher", "task_state"]);
  assert.ok(prompt.indexOf("Plan:\n") < prompt.indexOf("Research:\n"));
  assert.equal((prompt.match(/<pi_gear_context>/g) ?? []).length, 1);
  const replaced = composePrompt(prompt, ["researcher"]);
  assert.equal((replaced.match(/<pi_gear_context>/g) ?? []).length, 1);
  assert.doesNotMatch(replaced, /Plan:\n/);
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
