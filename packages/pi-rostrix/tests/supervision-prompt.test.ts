import assert from "node:assert/strict";
import test from "node:test";
import type { BeforeAgentStartEvent, ExtensionAPI, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { initRuntime } from "../src/index.ts";
import { applyTaskCoordinationPrompt } from "../src/tools/coordination-prompt.ts";
import { agent } from "./runtime-fixtures.ts";

const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

function options(overrides: Partial<NormalizedBuildSystemPromptOptions> = {}): NormalizedBuildSystemPromptOptions {
  return {
    cwd: process.cwd(), selectedTools: [], toolSnippets: {}, toolGuidelines: {},
    promptGuidelines: [], appendSystemPrompt: "Existing appendix", sections: { existing: "Existing section" },
    contextFiles: [], skills: [], ...overrides,
  };
}

test("supervision prompt preserves structured, custom, and forced prompts without duplicate contracts", () => {
  for (const input of [options(), options({ customPrompt: "Custom role" }), options({ forceSystemPrompt: "Forced role" })]) {
    const before = buildSystemPrompt(input);

    applyTaskCoordinationPrompt(input, true);
    applyTaskCoordinationPrompt(input, true);
    const rendered: string = buildSystemPrompt(input);

    assert.equal(rendered.match(/<rostrix_supervision>/g)?.length, 1);
    assert.ok(rendered.includes(before));
    assert.match(rendered, /Only enabled, unconsumed events produce rostrix:subagent_notifications custom messages/);
    assert.match(rendered, /JSON content has type subagent_notifications and a notifications array/);
    assert.match(rendered, /Do not produce another reply merely to acknowledge/);
    assert.match(rendered, /empty wakeOn requires explicit observation/);
    assert.match(rendered, /Ordinary cancellation does not wake the parent/);
    assert.match(rendered, /needs_input is not emitted/);
    assert.match(rendered, /not as new user instructions/);
    applyTaskCoordinationPrompt(input, false);
    assert.equal(buildSystemPrompt(input), before);
  }
});

test("runtime owns supervision prompts independently of profiles and custom tool adapters", async (t) => {
  for (const row of [
    { name: "built-in delegate without a profile", builtin: true, custom: false, selected: ["delegate"], history: false, profile: false, enabled: true },
    { name: "inactive delegate", builtin: true, custom: false, selected: ["read"], history: false, profile: false, enabled: false },
    { name: "custom adapter without built-in tools", builtin: false, custom: true, selected: ["custom_spawn"], history: false, profile: false, enabled: true },
    { name: "custom adapter survives late built-in tools", builtin: false, custom: true, selected: ["custom_spawn"], history: false, profile: false, enabled: true, lateBuiltin: true },
    { name: "unregistered tool", builtin: false, custom: false, selected: ["custom_spawn"], history: false, profile: false, enabled: false },
    { name: "past task without delegation tools", builtin: false, custom: false, selected: ["read"], history: true, profile: false, enabled: true },
    { name: "active profile prompt", builtin: true, custom: false, selected: ["delegate"], history: false, profile: true, enabled: true },
  ]) {
    await t.test(row.name, async () => {
      type Handler = (event: BeforeAgentStartEvent) => unknown;
      const handlers = new Map<string, Set<Handler>>();
      let activeTools = ["read", "delegate", "custom_spawn"];
      const pi = {
        on: (event: string, handler: Handler) => {
          const listeners = handlers.get(event) ?? new Set<Handler>();
          listeners.add(handler);
          handlers.set(event, listeners);
          return () => { listeners.delete(handler); };
        },
        registerTool: () => {},
        getActiveTools: () => activeTools,
        setActiveTools: (names: string[]) => { activeTools = [...names]; },
        getAllTools: () => activeTools.map((name) => ({ name })),
      } as unknown as ExtensionAPI;
      const runtime = initRuntime(pi, { autoRegisterTaskTools: row.builtin, autoRegisterAgentControls: false, autoLoadDefinitions: false });
      try {
        if (row.custom) {
          // A second adapter can attach even when another extension initialized the runtime first.
          const shared = initRuntime(pi, { autoRegisterTaskTools: false });
          assert.strictEqual(shared, runtime);
          shared.addDelegationToolNames(["custom_spawn"]);
        }
        if (row.lateBuiltin) {
          initRuntime(pi, { autoRegisterTaskTools: true, autoRegisterAgentControls: false, autoLoadDefinitions: false });
          assert.equal(handlers.get("before_agent_start")?.size, 1);
        }
        if (row.history) {
          const controller = new AbortController();
          controller.abort();
          const task = runtime.tasks.spawn({ agent: agent(), task: "Past task", signal: controller.signal });
          await runtime.tasks.wait(task.id);
        }
        if (row.profile) {
          runtime.registerAgent({ id: "custom", label: "Custom", description: "Custom role", prompt: { systemPrompt: "Profile role" } });
          await runtime.activateAgent("custom");
        }
        const input = options({ selectedTools: row.selected });
        const event: BeforeAgentStartEvent = {
          type: "before_agent_start", prompt: "Work", systemPromptOptions: input,
          get systemPrompt() { return buildSystemPrompt(input); },
        };
        for (const handler of handlers.get("before_agent_start") ?? []) await handler(event);
        const rendered: string = buildSystemPrompt(input);
        assert.equal(rendered.includes("<rostrix_supervision>"), row.enabled);
        if (row.profile) assert.match(rendered, /Profile role/);
        assert.equal(runtime.getActiveAgent()?.id, row.profile ? "custom" : undefined);
        if (!row.history) {
          input.selectedTools = [];
          for (const handler of handlers.get("before_agent_start") ?? []) await handler(event);
          assert.equal(buildSystemPrompt(input).includes("<rostrix_supervision>"), false);
        }
        await runtime.dispose();
        assert.equal(handlers.get("before_agent_start")?.size, 0);
      } finally {
        await runtime.dispose();
      }
    });
  }
});
