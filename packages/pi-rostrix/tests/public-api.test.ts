import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import * as api from "../src/index.ts";
import type { Runtime, RuntimeOptions, TaskControllerOptions, TaskMonitorOptions, NotificationQueueOptions, TaskToolOptions, AgentControlsOptions, ParentDelegationLimits, ResolvedAgentDefinition } from "../src/index.ts";

// Compile the public type contract as well as checking its runtime exports.
type PublicContract = [Runtime, RuntimeOptions, TaskControllerOptions, TaskMonitorOptions, NotificationQueueOptions, TaskToolOptions, AgentControlsOptions, ParentDelegationLimits, ResolvedAgentDefinition];
const contractArity: PublicContract["length"] = 9;

test("public API exposes responsibility-based names without Profile aliases", () => {
  assert.equal(contractArity, 9);
  for (const name of ["init", "TaskController", "TaskMonitor", "ParentNotifier", "NotificationQueue", "registerTaskTools", "registerAgentControls", "scanAgentDirectory", "AgentRegistry", "AgentResolver", "AgentActivator", "InProcessSubagentRunner"] as const) {
    assert.equal(typeof api[name], "function", name);
  }
  assert.deepEqual(Object.keys(api).filter((name) => name.startsWith("init")), ["init"]);
  assert.strictEqual(api.RUNTIME_SYMBOL, Symbol.for("pi.rostrix.runtime"));
  assert.deepEqual(Object.keys(api).filter((name) => /Profile|Rostrix|ROSTRIX/.test(name)), []);
});

test("published agent schema uses the canonical delegation policy fields", async () => {
  const schema = JSON.parse(await readFile(new URL("../agent.schema.json", import.meta.url), "utf8"));
  const properties = schema.properties.subagents.properties;
  const runtimeProperties = JSON.parse(JSON.stringify(api.AgentSubagentsSchema)).properties;

  assert.deepEqual(Object.keys(properties).sort(), ["allowedAgents", "maxConcurrent", "maxDepth"]);
  assert.deepEqual(Object.keys(properties).sort(), Object.keys(runtimeProperties).sort());
  assert.equal(properties.maxConcurrent.description, runtimeProperties.maxConcurrent.description);
});
