import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_AGENT_DEFINITIONS, WORKER_DEFINITION, RESEARCHER_DEFINITION, REVIEWER_DEFINITION } from "./definitions.ts";
import { AgentRegistry, AgentResolver } from "pi-rostrix";

test("Gear profiles are valid and can be registered and resolved by Rostrix", () => {
  const registry = new AgentRegistry();

  for (const profile of BUILTIN_AGENT_DEFINITIONS) {
    registry.register(profile);
  }

  assert.equal(registry.list().length, 3);

  const resolver = new AgentResolver(registry);
  const resolvedWorker = resolver.resolve("gear:worker");
  assert.equal(resolvedWorker.id, "gear:worker");
  assert.equal(resolvedWorker.inheritSystemPrompt, "all");
  assert.equal(resolvedWorker.systemPrompt, undefined);
  assert.match(resolvedWorker.appendPrompt ?? "", /only the delegated scope/);
  assert.equal(resolvedWorker.contextFiles?.inherit, "all");
  assert.equal(resolvedWorker.skills?.inherit, "user");
  assert.ok(resolvedWorker.allowedTools?.includes("read"));
  assert.ok(resolvedWorker.allowedTools?.includes("edit"));
  assert.deepEqual([...resolvedWorker.supervision.wakeOn], ["completed", "failed", "stalled"]);
  assert.equal(resolvedWorker.extensions?.inherit, "user");

  const resolvedReviewer = resolver.resolve("gear:reviewer");
  assert.equal(resolvedReviewer.id, "gear:reviewer");
  assert.equal(resolvedReviewer.inheritSystemPrompt, "all");
  assert.equal(resolvedReviewer.systemPrompt, undefined);
  assert.match(resolvedReviewer.appendPrompt ?? "", /only the requested scope/);
  assert.equal(resolvedReviewer.contextFiles?.inherit, "all");
  assert.equal(resolvedReviewer.skills?.inherit, "user");
  assert.ok(resolvedReviewer.deniedTools.includes("edit"));
  assert.ok(resolvedReviewer.deniedTools.includes("write"));
  assert.deepEqual([...resolvedReviewer.supervision.wakeOn], ["completed", "failed", "stalled"]);
  assert.equal(resolvedReviewer.extensions?.inherit, "user");

  const resolvedResearcher = resolver.resolve("gear:researcher");
  assert.equal(resolvedResearcher.id, "gear:researcher");
  assert.equal(resolvedResearcher.inheritSystemPrompt, "none");
  assert.match(resolvedResearcher.systemPrompt ?? "", /only the delegated question/);
  assert.equal(resolvedResearcher.appendPrompt, undefined);
  assert.equal(resolvedResearcher.contextFiles?.inherit, "user");
  assert.equal(resolvedResearcher.skills?.inherit, "none");
  assert.deepEqual([...resolvedResearcher.supervision.wakeOn], ["completed", "failed", "stalled"]);
  assert.equal(resolvedResearcher.extensions?.inherit, "user");
});
