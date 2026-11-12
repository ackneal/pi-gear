import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentId, SubagentModelSetting } from "../model-settings.ts";
import { setupSubagentSettings, type ModelSettingsStore } from "../settings.ts";

function harness(saved: Partial<Record<SubagentId, SubagentModelSetting>> = {}) {
  const defaults = { ...saved };
  const handlers: Record<string, (event: unknown, ctx: ExtensionContext) => void | Promise<void>> = {};
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => {
      handlers[event] = handler;
    },
  } as unknown as ExtensionAPI;
  const runtime = {
    load: async () => {},
    error: () => undefined,
    get: (id) => defaults[id],
    set: async (id, setting) => { defaults[id] = setting; },
  } satisfies ModelSettingsStore;
  const settings = setupSubagentSettings(pi, runtime);

  return {
    settings,
    handlers,
    context: (overrides: Record<string, unknown> = {}) => ({
      model: { provider: "main", id: "current" },
      thinkingLevel: "low",
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => [
          { provider: "saved", id: "worker" },
          { provider: "provider", id: "model-a" },
        ],
      },
      ui: { select: async () => undefined, notify: () => {} },
      ...overrides,
    }) as unknown as ExtensionCommandContext,
  };
}

test("runtime defaults override main settings and explicit inherit follows main", async () => {
  const current = harness({
    worker: { mode: "override", provider: "saved", model: "worker", thinkingLevel: "high" },
    researcher: { mode: "inherit" },
  });
  const ctx = current.context();
  await current.handlers.session_start?.({}, ctx);

  assert.deepEqual(current.settings.resolve("worker", ctx), { model: "saved/worker", thinkingLevel: "high" });
  assert.deepEqual(current.settings.resolve("researcher", ctx), { model: "main/current", thinkingLevel: "low" });
  assert.equal(current.settings.summaries(ctx)[1]?.source, "runtime");
});

test("dynamic model and thinking settings remain independent for every Gear subagent", async (t) => {
  for (const id of ["researcher", "worker", "reviewer"] as const) {
    for (const mode of ["inherit", "override"] as const) {
      await t.test(`${id}: ${mode}`, async () => {
        const current = harness({ [id]: mode === "inherit" ? { mode } : {
          mode, provider: "saved", model: "worker", thinkingLevel: "high",
        } });
        const before = current.context();
        const after = current.context({ model: { provider: "changed", id: "next" }, thinkingLevel: "off" });
        await current.handlers.session_start?.({}, before);

        assert.deepEqual(current.settings.resolve(id, before), mode === "inherit"
          ? { model: "main/current", thinkingLevel: "low" }
          : { model: "saved/worker", thinkingLevel: "high" });
        assert.deepEqual(current.settings.resolve(id, after), mode === "inherit"
          ? { model: "changed/next", thinkingLevel: "off" }
          : { model: "saved/worker", thinkingLevel: "high" });
      });
    }
  }
});

test("saved models missing from the available registry remain configured but are reported unavailable", async () => {
  const current = harness({
    worker: { mode: "override", provider: "registered", model: "no-auth", thinkingLevel: "low" },
  });
  const ctx = current.context();
  await current.handlers.session_start?.({}, ctx);

  assert.equal(current.settings.resolve("worker", ctx).model, "registered/no-auth");
  assert.equal(current.settings.summaries(ctx)[1]?.available, false);
});

test("subagent model command uses the searchable custom picker and immediately saves the default", async () => {
  const current = harness();
  const selections = ["Choose model"];
  let customCalls = 0;
  const model = { provider: "provider", id: "model-a", name: "Model A", reasoning: true };
  const ctx = current.context({
    scopedModels: [{ model }],
    mode: "tui",
    ui: {
      select: async () => selections.shift(),
      custom: async (_factory: unknown) => {
        customCalls += 1;
        return { choice: { model, source: "scoped" }, thinkingLevel: "high" };
      },
      notify: () => {},
    },
  });
  await current.handlers.session_start?.({}, ctx);
  await current.settings.configure("worker", ctx);

  assert.equal(customCalls, 1);
  assert.deepEqual(current.settings.resolve("worker", current.context()), {
    model: "provider/model-a",
    thinkingLevel: "high",
  });
});

test("inherit and model choices write defaults without a scope prompt", async () => {
  const current = harness();
  const selections = ["Choose model", "model-a [provider]", "Inherit from main"];
  const notices: string[] = [];
  const model = { provider: "provider", id: "model-a", reasoning: true };
  const ctx = current.context({
    scopedModels: [{ model }],
    ui: {
      select: async () => selections.shift(),
      notify: (message: string) => notices.push(message),
    },
  });
  await current.handlers.session_start?.({}, ctx);

  await current.settings.configure("worker", ctx);
  assert.deepEqual(current.settings.resolve("worker", ctx), { model: "provider/model-a", thinkingLevel: "low" });

  await current.settings.configure("worker", ctx);
  assert.deepEqual(current.settings.resolve("worker", ctx), { model: "main/current", thinkingLevel: "low" });
  assert.equal(selections.length, 0);
  assert.match(notices.at(-1) ?? "", /inherit saved as the default/);
});
