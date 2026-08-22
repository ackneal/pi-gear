import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setupSubagentSettings, SUBAGENT_MODEL_COMMAND, SUBAGENT_SETTINGS_ENTRY } from "../settings.ts";

function harness(initialBranch: unknown[] = []) {
  let branch = initialBranch;
  const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => void> = {};
  let command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> } | undefined;
  const appended: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => { handlers[event] = handler; },
    registerCommand: (name: string, definition: typeof command) => {
      assert.equal(name, SUBAGENT_MODEL_COMMAND);
      command = definition;
    },
    appendEntry: (customType: string, data: unknown) => {
      const entry = { type: "custom", customType, data };
      appended.push({ customType, data });
      branch.push(entry);
    },
  } as unknown as ExtensionAPI;
  const settings = setupSubagentSettings(pi);

  return {
    settings,
    handlers,
    appended,
    get command() { return command; },
    set branch(next: unknown[]) { branch = next; },
    context(overrides: Record<string, unknown> = {}) {
      return {
        model: { provider: "main", id: "current" },
        thinkingLevel: "low",
        scopedModels: [],
        modelRegistry: { getAvailable: () => [] },
        sessionManager: { getBranch: () => branch },
        ui: { select: async () => undefined, notify: () => {} },
        ...overrides,
      } as unknown as ExtensionCommandContext;
    },
  };
}

test("subagent settings inherit main defaults and restore per-session overrides", () => {
  const restored = {
    type: "custom",
    customType: SUBAGENT_SETTINGS_ENTRY,
    data: { worker: { model: "anthropic/worker-model", thinkingLevel: "high" } },
  };
  const current = harness([restored]);
  const ctx = current.context();

  current.handlers.session_start?.({}, ctx);

  assert.deepEqual(current.settings.resolve("researcher", ctx), { model: "main/current", thinkingLevel: "low" });
  assert.deepEqual(current.settings.resolve("worker", ctx), { model: "anthropic/worker-model", thinkingLevel: "high" });
});

test("subagent model command uses the searchable custom model picker only in TUI mode", async () => {
  const current = harness();
  const selections = ["Choose model"];
  let customCalls = 0;
  const model = { provider: "provider", id: "model-a", name: "Model A", reasoning: true };
  const ctx = current.context({
    mode: "tui",
    scopedModels: [{ model }],
    ui: {
      select: async () => selections.shift(),
      custom: async () => {
        customCalls += 1;
        return { choice: { model }, thinkingLevel: "medium" };
      },
      notify: () => {},
    },
  });

  current.handlers.session_start?.({}, ctx);
  await current.command?.handler("worker", ctx);

  assert.equal(customCalls, 1);
  assert.deepEqual(current.settings.resolve("worker", ctx), { model: "provider/model-a", thinkingLevel: "medium" });
});

test("subagent model command saves and clears a session override", async () => {
  const current = harness();
  const selections = ["Choose model", "model-a [provider]", "Inherit from main"]; 
  const notices: string[] = [];
  const model = { provider: "provider", id: "model-a", reasoning: true };
  const ctx = current.context({
    scopedModels: [{ model }],
    ui: {
      select: async () => selections.shift(),
      notify: (message: string) => { notices.push(message); },
    },
  });

  current.handlers.session_start?.({}, ctx);
  await current.command?.handler("worker", ctx);

  assert.deepEqual(current.settings.resolve("worker", ctx), { model: "provider/model-a", thinkingLevel: "low" });
  assert.equal(current.appended.at(-1)?.customType, SUBAGENT_SETTINGS_ENTRY);

  await current.command?.handler("worker", ctx);

  assert.deepEqual(current.settings.resolve("worker", ctx), { model: "main/current", thinkingLevel: "low" });
  assert.match(notices.at(-1) ?? "", /inherits the main model/);
});
