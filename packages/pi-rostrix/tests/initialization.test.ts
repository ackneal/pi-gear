import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { BeforeAgentStartEvent, ExtensionAPI, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { init, RUNTIME_SYMBOL, TaskController, type RuntimeOptions } from "../src/index.ts";
import { agent } from "./runtime-fixtures.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>;
type Shortcut = Parameters<ExtensionAPI["registerShortcut"]>;
type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Listener = (...args: unknown[]) => unknown;

const noLoad = { autoLoadDefinitions: false } as const;
const disabled = { ...noLoad, autoRegisterTaskTools: false, autoRegisterAgentControls: false } as const;
const toolNames = ["delegate", "task_status", "task_wait", "task_cancel"];

function host() {
  const tools: { caller: string; tool: Pick<Tool, "name"> }[] = [];
  const commands: { caller: string; args: Command }[] = [];
  const shortcuts: { caller: string; args: Shortcut }[] = [];
  let activeTools = ["read", "write"];

  function api(caller: string) {
    const subscriptions: { event: string; handler: Listener; releases: number; active: boolean }[] = [];
    // The SDK overloads on() by event; this mock stores heterogeneous listeners without invoking unrelated events.
    const on = ((event: string, handler: Listener) => {
      const subscription = { event, handler, releases: 0, active: true };
      subscriptions.push(subscription);
      return () => { subscription.releases++; subscription.active = false; };
    }) as ExtensionAPI["on"];
    const implemented: Pick<ExtensionAPI, "on" | "registerTool" | "registerCommand" | "registerShortcut" | "getActiveTools" | "setActiveTools" | "getAllTools"> = {
      on,
      registerTool(tool) { tools.push({ caller, tool }); },
      registerCommand(...args) { commands.push({ caller, args }); },
      registerShortcut(...args) { shortcuts.push({ caller, args }); },
      getActiveTools: () => [...activeTools],
      setActiveTools(names) { activeTools = [...names]; },
      getAllTools: () => ["read", "write"].map((name) => ({ name, description: name, parameters: Type.Object({}), exposure: "direct", sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" } })),
    };
    return {
      // Only the API surface used by these initialization paths is implemented.
      pi: implemented as ExtensionAPI,
      subscriptions,
      async emit(event: string, payload?: unknown) {
        for (const subscription of [...subscriptions]) {
          if (subscription.active && subscription.event === event) await subscription.handler(payload);
        }
      },
    };
  }

  return { api, tools, commands, shortcuts };
}

const gear: RuntimeOptions = { ...noLoad, autoRegisterTaskTools: false, autoRegisterAgentControls: false };
const standalone: RuntimeOptions = { ...noLoad, shortcut: "alt+r" };

test("initialization order registers each bundle once through the enabling caller", async (t) => {
  for (const row of [
    { name: "Gear first", first: gear, later: standalone, command: "rostrix:agents", shortcut: "alt+r", laterTools: true, laterInteractive: true },
    { name: "standalone first", first: standalone, later: gear, command: "rostrix:agents", shortcut: "alt+r" },
    { name: "tools enabled later", first: { ...standalone, autoRegisterTaskTools: false }, later: standalone, command: "rostrix:agents", shortcut: "alt+r", laterTools: true },
    { name: "interactive enabled later", first: { ...standalone, autoRegisterAgentControls: false }, later: standalone, command: "rostrix:agents", shortcut: "alt+r", laterInteractive: true },
  ]) {
    await t.test(row.name, async (t) => {
      const h = host();
      const first = h.api("first");
      const later = h.api("later");
      assert.notStrictEqual(first.pi, later.pi);
      const runtime = init(first.pi, row.first);
      t.after(() => runtime.dispose());

      assert.strictEqual(init(first.pi, row.first), runtime);
      assert.strictEqual(init(later.pi, row.later), runtime);
      assert.strictEqual(init(later.pi, row.later), runtime);

      assert.deepEqual(h.tools.map(({ tool }) => tool.name), toolNames);
      assert.deepEqual(h.tools.map(({ caller }) => caller), Array(4).fill(row.laterTools ? "later" : "first"));
      assert.deepEqual(h.commands.map(({ caller, args }) => [caller, args[0]]), [[row.laterInteractive ? "later" : "first", row.command]]);
      assert.deepEqual(h.shortcuts.map(({ caller, args }) => [caller, args[0]]), [[row.laterInteractive ? "later" : "first", row.shortcut]]);
    });
  }
});

test("interactive initialization retains first enabled configuration and gates the entire bundle", async (t) => {
  for (const row of [
    { name: "late shortcut uses retained status", first: { ...noLoad, autoRegisterAgentControls: true, commandName: "first", statusKey: "first-status" }, initialCommands: 1, initialShortcuts: 0, command: "first", status: "first-status" },
    { name: "existing shortcut and name cannot be replaced", first: { ...noLoad, commandName: "first", statusKey: "first-status", shortcut: "alt+f" }, initialCommands: 1, initialShortcuts: 1, command: "first", status: "first-status" },
    { name: "commandName false suppresses command and shortcut", first: { ...noLoad, commandName: false, statusKey: "ignored", shortcut: "alt+f" }, initialCommands: 0, initialShortcuts: 0, command: "later", status: "later-status" },
  ] satisfies { name: string; first: RuntimeOptions; initialCommands: number; initialShortcuts: number; command: string; status: string }[]) {
    await t.test(row.name, async (t) => {
      const h = host();
      const owner = h.api("owner");
      const later = h.api("later");
      const runtime = init(owner.pi, { ...row.first, autoRegisterTaskTools: false });
      t.after(() => runtime.dispose());
      assert.equal(h.commands.length, row.initialCommands);
      assert.equal(h.shortcuts.length, row.initialShortcuts);

      init(later.pi, { ...noLoad, autoRegisterTaskTools: false, commandName: "later", statusKey: "later-status", shortcut: "alt+l" });
      init(owner.pi, { ...noLoad, autoRegisterTaskTools: false, commandName: "ignored", statusKey: "ignored", shortcut: "alt+i" });
      assert.deepEqual(h.commands.map(({ args }) => args[0]), [row.command]);
      assert.deepEqual(h.shortcuts.map(({ args }) => args[0]), [row.initialShortcuts ? "alt+f" : "alt+l"]);

      const definition = { id: "fixture", label: "Fixture", description: "In-memory interactive fixture" };
      runtime.registerAgent(definition);
      // Supply a discovered-agent view without invoking filesystem discovery.
      Object.defineProperty(runtime, "discoveredAgents", { value: [{ agent: definition, scope: "custom", filePath: "/unused/fixture.md" }] });
      const statuses: [string, string | undefined][] = [];
      const context = { hasUI: true, ui: { notify() {}, setStatus(key: string, value: string | undefined) { statuses.push([key, value]); } } };
      const registeredCommand = h.commands[0];
      const registeredShortcut = h.shortcuts[0];
      assert.ok(registeredCommand);
      assert.ok(registeredShortcut);
      const command = registeredCommand.args[1];
      await command.handler("fixture", context as unknown as Parameters<typeof command.handler>[1]);
      await registeredShortcut.args[1].handler(context as unknown as Parameters<Shortcut[1]["handler"]>[0]);
      assert.deepEqual(statuses, [[row.status, "👤 Fixture"], [row.status, ""]]);
    });
  }
});

test("later initialization preserves services, state, custom prompts, and lifecycle ownership", async (t) => {
  for (const row of [
    { name: "all-false child", options: disabled },
    { name: "feature-enabling child", options: { ...noLoad, shortcut: "alt+c" } },
  ]) {
    await t.test(row.name, async (t) => {
      const h = host();
      const owner = h.api("owner");
      const child = h.api("child");
      const runtime = init(owner.pi, disabled);
      t.after(() => runtime.dispose());
      runtime.registerAgent({ id: "preserved", label: "Preserved", description: "Persistent role", prompt: { appendPrompt: "Preserved prompt" } });
      await runtime.activateAgent("preserved");
      runtime.addDelegationToolNames(["custom_spawn"]);
      const services = [runtime.agents, runtime.resolver, runtime.activator, runtime.tasks, runtime.monitor, runtime.monitor.notificationQueue, runtime.monitor.notifier];
      const active = runtime.getActiveAgent();
      const controller = new AbortController();
      controller.abort();
      const record = runtime.tasks.spawn({ agent: agent(), task: "Preserved task", signal: controller.signal });
      await runtime.tasks.wait(record.id);

      assert.strictEqual(init(child.pi, row.options), runtime);
      assert.deepEqual([runtime.agents, runtime.resolver, runtime.activator, runtime.tasks, runtime.monitor, runtime.monitor.notificationQueue, runtime.monitor.notifier].map((value, i) => value === services[i]), Array(7).fill(true));
      assert.strictEqual(runtime.getActiveAgent(), active);
      assert.strictEqual(runtime.tasks.getTask(record.id), record);
      assert.equal(runtime.getAgent("preserved")?.label, "Preserved");
      const input: NormalizedBuildSystemPromptOptions = { cwd: process.cwd(), selectedTools: ["custom_spawn"], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], contextFiles: [], skills: [], sections: {}, appendSystemPrompt: "" };
      const event: BeforeAgentStartEvent = { type: "before_agent_start", prompt: "Work", systemPrompt: "Base", systemPromptOptions: input };
      await owner.emit("before_agent_start", event);
      assert.match(JSON.stringify(input), /rostrix_supervision/);
      assert.match(input.appendSystemPrompt ?? "", /Preserved prompt/);
      assert.equal(child.subscriptions.filter(({ event }) => event === "session_shutdown").length, 0);
      await child.emit("session_shutdown");
      assert.equal(runtime.isInitialized, true);
      assert.strictEqual(runtime.getActiveAgent(), active);
      await owner.emit("session_shutdown");
      assert.equal(runtime.isInitialized, false);
    });
  }
});

test("disposal awaits shutdown, shares its promise, releases subscriptions once, and rejects init", async (t) => {
  const h = host();
  const owner = h.api("owner");
  const child = h.api("child");
  const releases: number[] = [];
  const subscribe = TaskController.prototype.subscribe;
  t.mock.method(TaskController.prototype, "subscribe", function (this: TaskController, ...args: Parameters<TaskController["subscribe"]>) {
    const unsubscribe = subscribe.apply(this, args);
    const index = releases.push(0) - 1;
    return () => { releases[index] = (releases[index] ?? 0) + 1; unsubscribe(); };
  });
  const runtime = init(owner.pi, disabled);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const shutdown = runtime.tasks.shutdown.bind(runtime.tasks);
  const shutdownMock = t.mock.method(runtime.tasks, "shutdown", async () => { await shutdown(); await gate; });
  t.after(async () => { release(); await runtime.dispose(); });
  runtime.registerAgent({ id: "retained", label: "Retained", description: "Await cleanup" });

  const pending = runtime.dispose();
  assert.throws(() => runtime.tasks.spawn({ agent: agent(), task: "Must not start during disposal" }), /Task controller is shut down/);
  assert.strictEqual(runtime.dispose(), pending);
  await Promise.resolve();
  assert.equal(runtime.isInitialized, true);
  assert.ok(runtime.getAgent("retained"));
  assert.throws(() => init(child.pi, disabled), /dispos/i);
  assert.equal(shutdownMock.mock.callCount(), 1);
  assert.deepEqual(releases, [1]);
  assert.equal(owner.subscriptions.filter(({ event }) => event === "session_shutdown").length, 2);
  assert.ok(owner.subscriptions.every(({ releases, active }) => releases === 1 && !active));

  release();
  await pending;
  assert.strictEqual(runtime.dispose(), pending);
  assert.equal(runtime.isInitialized, false);
  assert.equal(runtime.getAllAgents().length, 0);
  assert.equal(Reflect.get(globalThis, RUNTIME_SYMBOL), undefined);
  assert.deepEqual(releases, [1]);
  assert.ok(owner.subscriptions.every(({ releases }) => releases === 1));
});
