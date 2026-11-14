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

test("published agent schema uses the canonical definition fields", async () => {
  const schema = JSON.parse(await readFile(new URL("../agent.schema.json", import.meta.url), "utf8"));
  const runtimeRoot = JSON.parse(JSON.stringify(api.AgentDefinitionSchema));
  const properties = schema.properties.subagents.properties;
  const runtimeProperties = JSON.parse(JSON.stringify(api.AgentSubagentsSchema)).properties;

  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(runtimeRoot.properties).sort());
  assert.deepEqual(Object.keys(properties).sort(), ["allowedAgents", "maxConcurrent", "maxDepth"]);
  assert.deepEqual(Object.keys(properties).sort(), Object.keys(runtimeProperties).sort());
  assert.equal(properties.maxConcurrent.description, runtimeProperties.maxConcurrent.description);

  for (const [section, runtimeSchema] of [
    ["prompt", api.AgentPromptSchema],
    ["contextFiles", api.AgentContextFilesSchema],
    ["tools", api.AgentToolsSchema],
    ["skills", api.AgentSkillsSchema],
    ["promptTemplates", api.AgentPromptTemplatesSchema],
    ["model", api.AgentModelSchema],
    ["supervision", api.AgentSupervisionSchema],
    ["extensions", api.AgentExtensionsSchema],
  ] as const) {
    assert.deepEqual(
      Object.keys(schema.properties[section].properties).sort(),
      Object.keys(JSON.parse(JSON.stringify(runtimeSchema)).properties).sort(),
      section,
    );
  }

  for (const section of ["prompt", "contextFiles", "skills", "promptTemplates", "supervision", "extensions"] as const) {
    for (const [propName, propDef] of Object.entries<Record<string, unknown>>(schema.properties[section].properties)) {
      const runtimeProp = runtimeRoot.properties[section].properties[propName] as Record<string, unknown>;
      if (propDef.enum) {
        const runtimeEnum = Array.isArray(runtimeProp.anyOf)
          ? (runtimeProp.anyOf as Array<{ const?: unknown }>).map((item) => item.const)
          : runtimeProp.enum;
        assert.deepEqual(propDef.enum, runtimeEnum, `${section}.${propName}.enum`);
      } else {
        assert.equal(propDef.type, runtimeProp.type, `${section}.${propName}.type`);
        assert.equal(propDef.minimum, runtimeProp.minimum, `${section}.${propName}.minimum`);
      }
    }
  }
});
