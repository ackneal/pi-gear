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
  assert.ok(resolvedWorker.allowedTools?.includes("read"));
  assert.ok(resolvedWorker.allowedTools?.includes("edit"));

  const resolvedReviewer = resolver.resolve("gear:reviewer");
  assert.equal(resolvedReviewer.id, "gear:reviewer");
  assert.ok(resolvedReviewer.deniedTools.includes("edit"));
  assert.ok(resolvedReviewer.deniedTools.includes("write"));

  const resolvedResearcher = resolver.resolve("gear:researcher");
  assert.equal(resolvedResearcher.id, "gear:researcher");
});
