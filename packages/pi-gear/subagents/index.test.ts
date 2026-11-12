import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RostrixRuntime, TaskRecord, TaskStatus } from "pi-rostrix";
import { setupSubagents } from "./index.ts";
import { composePrompt } from "../context/prompt/index.ts";
import { clearSubagentRegistry, getSubagentEntry } from "../ui/subagent/registry.ts";
import { SubagentResultComponent } from "../ui/subagent/component.ts";

function harness(sessionManager?: SessionManager) {
  const tools = new Map<string, ToolDefinition>();
  const entries: SessionEntry[] = [];
  const listeners = new Set<(task: TaskRecord) => void>();
  let sessionId = "session-1";
  let available = true;
  let contextValid = true;
  const record: TaskRecord = {
    id: "test-run", agentId: "gear:worker", profileId: "gear:worker", task: "Inspect code",
    depth: 0, targetFiles: [], wakeOn: ["completed", "failed"], status: "running", revision: 1, createdAt: 10,
    startedAt: 20, lastActivityAt: 30,
    activities: [
      { kind: "thinking", text: "Inspect the implementation", contentIndex: 0, messageId: 1 },
      { kind: "message", role: "assistant", text: "Not an activity item" },
      { kind: "tool", id: "read-1", name: "read", args: { path: "index.ts" }, status: "success", result: "actual source" },
    ],
    usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 2, cacheWrite1h: 1, reasoning: 3, totalTokens: 131, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 } },
    activitiesTruncated: false,
  };
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionToolContext) => unknown>>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionToolContext) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    appendEntry(customType: string, data: unknown) {
      if (sessionManager) {
        sessionManager.appendCustomEntry(customType, data);
        return;
      }
      entries.push({ type: "custom", customType, data, id: `entry-${entries.length}`, parentId: null, timestamp: new Date().toISOString() });
    },
  } as unknown as ExtensionAPI;
  let lastSpawnOptions: unknown;
  const tasks = {
    spawn: (options: unknown) => {
      lastSpawnOptions = options;
      return record;
    },
    subscribe: (_id: string, listener: (task: TaskRecord) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    cancel: async (_taskId: string): Promise<boolean> => {
      if (!available || record.status === "completed" || record.status === "failed" || record.status === "aborted") return false;
      Object.assign(record, { status: "aborted", finishedAt: 50 });
      for (const listener of [...listeners]) listener(record);
      return true;
    },
    getTask: () => available ? record : undefined,
    wait: async () => {
      if (!available) throw new Error("Unknown task");
      return record;
    },
  };
  const delegationTools: string[] = [];
  const acknowledgments: string[] = [];
  const supervisor = {
    acknowledgeTask: (taskId: string) => { acknowledgments.push(taskId); },
  } satisfies Pick<RostrixRuntime["supervisor"], "acknowledgeTask">;
  const runtime = {
    supervisor,
    tasks, resolveProfile: () => ({ id: "gear:worker" }),
    registerDelegationTools: (names: readonly string[]) => { delegationTools.push(...names); },
  } as unknown as RostrixRuntime;
  const fakeModelRegistry = { getAvailable: () => [] };
  const ctx = {
    cwd: "/tmp",
    modelRegistry: fakeModelRegistry,
    get sessionManager() {
      if (!contextValid) throw new Error("Extension context is invalid");
      return sessionManager ?? {
        getSessionId: () => sessionId,
        getSessionFile: () => undefined,
        getBranch: () => [...entries],
        getEntries: () => [...entries],
      };
    },
  } as unknown as ExtensionToolContext;
  setupSubagents(pi, undefined, runtime);

  return {
    record, entries, listeners, tools, delegationTools, acknowledgments,
    getLastSpawnOptions: () => lastSpawnOptions,
    emit: async (event: string) => {
      for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
    },
    switchSession: () => { sessionId = "session-2"; },
    invalidateContext: () => { contextValid = false; },
    forgetTask: () => { available = false; },
    update: (patch: Partial<TaskRecord>) => {
      Object.assign(record, patch);
      for (const listener of [...listeners]) listener(record);
    },
    execute: (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("call-1", params, undefined, undefined, ctx),
  };
}

test("completion persistence survives branch changes and invalidated session contexts", async (t) => {
  for (const scenario of ["branch", "switched session"] as const) {
    await t.test(scenario, async (t) => {
      clearSubagentRegistry();
      t.after(clearSubagentRegistry);
      const dir = await mkdtemp(join(tmpdir(), "gear-completion-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      const manager = SessionManager.create(dir, dir);
      const originLeaf = manager.appendMessage({ role: "user", content: "Inspect", timestamp: 1 });
      const file = manager.getSessionFile()!;
      const h = harness(manager);
      await h.execute("worker", { task: "Inspect" });
      if (scenario === "switched session") {
        await h.emit("session_shutdown");
        h.invalidateContext();
      }
      h.update({ status: "completed", finishedAt: 50, result: "Durable result" });
      assert.equal(h.listeners.size, 0);
      const restored = SessionManager.open(file);
      assert.ok(restored.getEntries().some((entry) => entry.type === "custom" && entry.customType === "gear:subagent-completion"));
      if (scenario === "branch") {
        restored.branch(originLeaf);
        restored.appendMessage({ role: "user", content: "New branch", timestamp: 2 });
        assert.ok(!restored.getBranch().some((entry) => entry.type === "custom" && entry.customType === "gear:subagent-completion"));
      }
      clearSubagentRegistry();
      const reopened = harness(restored);
      reopened.forgetTask();
      const observed = await reopened.execute("subagent_observe", { runId: h.record.id });
      assert.equal(observed.isError, undefined);
      const details = observed.details as { status: string; result: string; usage: unknown };
      assert.equal(details.status, "success");
      assert.equal(details.result, "Durable result");
      assert.deepEqual(details.usage, h.record.usage);
    });
  }
});

test("saved completion histories migrate only at the read boundary", async (t) => {
  for (const format of ["legacy", "current", "mixed", "malformed"] as const) {
    await t.test(format, async (t) => {
      clearSubagentRegistry();
      t.after(clearSubagentRegistry);
      const manager = SessionManager.inMemory();
      const activity = { kind: "tool", name: "read", status: "success", args: { path: "legacy.ts" } };
      const saved = {
        runId: "saved-task", status: "success", revision: 3, startedAt: 20, finishedAt: 50,
        result: "Saved answer",
        ...(format !== "current" ? { items: format === "malformed" ? [null] : [activity], itemsTruncated: true } : {}),
        ...(format === "current" || format === "mixed" ? { activities: format === "mixed" ? [] : [activity], activitiesTruncated: format !== "mixed" } : {}),
      };
      manager.appendCustomEntry("gear:subagent-completion", saved);
      const h = harness(manager);
      h.forgetTask();
      await h.emit("session_start");

      const observed = await h.execute("subagent_observe", { runId: "saved-task" });

      const details = observed.details as Record<string, unknown>;
      const content = JSON.parse((observed.content[0] as { text: string }).text);
      for (const result of [details, content]) {
        assert.equal(Object.hasOwn(result, "items"), false);
        assert.equal(Object.hasOwn(result, "itemsTruncated"), false);
        assert.equal(result.activitiesTruncated, format !== "mixed");
      }
      assert.deepEqual(details.activities, format === "mixed" || format === "malformed" ? [] : [activity]);
      assert.equal(details.result, "Saved answer");
      assert.equal(Object.hasOwn(saved, "items"), format !== "current");
      assert.deepEqual(h.acknowledgments, ["saved-task"]);
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      const component = h.tools.get("worker")!.renderResult!({ content: [], details: {
        runId: "saved-task", status: "running", startedAt: 20, items: [],
      } }, { expanded: true, isPartial: false }, theme as never, {
        args: { task: "Inspect saved history" }, invalidate() {}, toolCallId: "old-call",
      } as never);
      assert.ok(component instanceof SubagentResultComponent);
      t.after(() => component.dispose());
      const rendered = component.render(160).join("\n");
      assert.match(rendered, /Saved answer/);
      if (format === "legacy" || format === "current") assert.match(rendered, /Read · success · legacy\.ts/);
      else assert.doesNotMatch(rendered, /legacy\.ts/);
    });
  }
});

test("completed evidence survives a session reload in the original agent card", async (t) => {
  clearSubagentRegistry();
  t.after(clearSubagentRegistry);
  const h = harness();
  const initial = await h.execute("worker", { task: "Inspect code" });
  h.update({ status: "completed", finishedAt: 50, result: "Persisted answer" });
  h.forgetTask();
  clearSubagentRegistry();
  await h.emit("session_start");
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const component = h.tools.get("worker")!.renderResult!(initial, { expanded: true, isPartial: false }, theme as never, {
    args: { task: "Inspect code" }, invalidate() {}, toolCallId: "call-1",
  } as never);
  assert.ok(component instanceof SubagentResultComponent);
  t.after(() => component.dispose());
  const output = component.render(160).join("\n");
  assert.match(output, /● Agent\(worker\)/);
  assert.match(output, /Read · success · index\.ts/);
  assert.match(output, /↑107 ↓20 · \$0\.330 · 30ms/);
  assert.match(output, /Persisted answer/);
  assert.doesNotMatch(output, /aborted|Status unavailable/);
});

const agents = [
  { name: "researcher", params: { question: "Inspect code" } },
  { name: "worker", params: { task: "Inspect code" } },
  { name: "reviewer", params: { scope: "Inspect code" } },
];

test("spawn receipts preserve actual task wakeOn for every agent", async (t) => {
  const cases: { name: string; wakeOn: TaskRecord["wakeOn"] }[] = [
    { name: "disabled", wakeOn: [] },
    { name: "stalled only", wakeOn: ["stalled"] },
    { name: "completed only", wakeOn: ["completed"] },
    { name: "failed only", wakeOn: ["failed"] },
    { name: "input only", wakeOn: ["needs_input"] },
    { name: "all triggers", wakeOn: ["completed", "failed", "stalled", "needs_input"] },
  ];
  for (const agent of agents) {
    for (const scenario of cases) {
      await t.test(`${agent.name}: ${scenario.name}`, async (t) => {
        clearSubagentRegistry();
        t.after(clearSubagentRegistry);
        const h = harness();
        Object.assign(h.record, { wakeOn: scenario.wakeOn });

        const result = await h.execute(agent.name, agent.params);

        assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), {
          runId: h.record.id, status: h.record.status, revision: h.record.revision, wakeOn: scenario.wakeOn,
        });
        const details = result.details as Record<string, unknown>;
        assert.deepEqual(details.wakeOn, scenario.wakeOn);
        assert.equal(details.runId, h.record.id);
        assert.equal(details.revision, h.record.revision);
        assert.deepEqual(details.activities, h.record.activities.filter((activity) => activity.kind !== "message"));
        assert.equal(Object.hasOwn(details, "items"), false);
      });
    }
  }
});

test("tool descriptions and prompt agree on conditional notification workflow", () => {
  const h = harness();
  assert.deepEqual(h.delegationTools, ["researcher", "worker", "reviewer"]);
  const cases = [...agents.map(({ name }) => name), "subagent_observe"];
  for (const name of cases) {
    const description = h.tools.get(name)!.description;
    const prompt = composePrompt("", [name === "subagent_observe" ? "worker" : name]);
    for (const text of [description, prompt]) {
      assert.match(text, /wakeOn/);
      assert.match(text, /For independent work with completion notification enabled/);
      assert.match(text, /continue other useful work or end the turn/);
      assert.match(text, /only for a current-step dependency or diagnosing progress/);
      assert.match(text, /bounded waits without polling/);
      assert.doesNotMatch(text, /Observe healthy runs again|use subagent_observe for progress or completion/);
    }
  }
});

for (const agent of agents) {
  for (const terminal of [
    { status: "completed", mapped: "success" },
    { status: "failed", mapped: "error" },
    { status: "aborted", mapped: "aborted" },
  ] satisfies { status: TaskStatus; mapped: string }[]) {
    test(`${agent.name}: ${terminal.status} preserves live, observe, and persisted evidence`, async () => {
      clearSubagentRegistry();
      try {
        const h = harness();
        const initial = await h.execute(agent.name, agent.params);
        const expectedActivities = h.record.activities.filter((activity) => activity.kind !== "message");
        assert.deepEqual((initial.details as { activities: unknown }).activities, expectedActivities);
        for (const key of ["call-1", h.record.id]) {
          assert.deepEqual(getSubagentEntry(key)?.run.activities, expectedActivities);
          assert.deepEqual(getSubagentEntry(key)?.run.usage, h.record.usage);
        }

        h.update({ status: terminal.status, revision: 2, finishedAt: 50, lastActivityAt: 50, result: "Evidence-backed answer", activitiesTruncated: true });
        for (const key of ["call-1", h.record.id]) {
          const run = getSubagentEntry(key)?.run;
          assert.equal(run?.status, terminal.mapped);
          assert.equal(run?.finishedAt, 50);
          assert.equal(run?.activitiesTruncated, true);
          assert.deepEqual(run?.activities, expectedActivities);
          assert.deepEqual(run?.usage, h.record.usage);
        }
        assert.equal(h.listeners.size, 0);
        assert.equal(h.entries.length, 1);
        const savedEntry = h.entries[0]!;
        assert.ok(savedEntry.type === "custom");
        assert.equal(Object.hasOwn(savedEntry.data as object, "items"), false);
        assert.equal(Object.hasOwn(savedEntry.data as object, "itemsTruncated"), false);
        assert.ok(Object.hasOwn(savedEntry.data as object, "activities"));

        const observed = await h.execute("subagent_observe", { runId: h.record.id });
        const details = observed.details as Record<string, unknown>;
        assert.equal(details.status, terminal.mapped);
        assert.equal(details.finishedAt, 50);
        assert.equal(details.activitiesTruncated, true);
        assert.deepEqual(details.activities, expectedActivities);
        assert.equal(Object.hasOwn(details, "items"), false);
        assert.equal(Object.hasOwn(details, "itemsTruncated"), false);
        assert.deepEqual(details.usage, h.record.usage);
        const content = JSON.parse((observed.content[0] as { text: string }).text);
        assert.deepEqual(content.activities, expectedActivities.filter((activity) => activity.kind === "tool").map((activity) => ({ ...activity, resultTruncated: false })));
        assert.equal(Object.hasOwn(content, "items"), false);
        assert.equal(Object.hasOwn(content, "itemsTruncated"), false);
        assert.deepEqual(content.usage, h.record.usage);
        assert.equal(content.finishedAt, 50);

        h.forgetTask();
        clearSubagentRegistry();
        const restored = await h.execute("subagent_observe", { runId: h.record.id });
        assert.deepEqual(restored.details, { ...details, dispatch: {} });
      } finally {
        clearSubagentRegistry();
      }
    });
  }
}

for (const scenario of ["bounded evidence", "changed session", "unknown run", "already finished", "running observation", "optional fields"] as const) {
  test(`observe/persistence: ${scenario}`, async () => {
    clearSubagentRegistry();
    try {
      const h = harness();
      if (scenario === "already finished") h.update({ status: "completed", finishedAt: 50 });
      if (scenario === "optional fields") h.update({ startedAt: undefined, usage: undefined, activitiesTruncated: undefined });
      await h.execute("worker", { task: "Inspect code" });
      if (scenario === "bounded evidence") {
        h.update({ activities: Array.from({ length: 10 }, (_, i) => ({ kind: "tool", name: `tool-${i}`, status: "success", args: { text: "y".repeat(3000) }, result: "x".repeat(3000) })) });
        const observed = await h.execute("subagent_observe", { runId: h.record.id });
        const content = JSON.parse((observed.content[0] as { text: string }).text);
        assert.equal(content.activities.length, 8);
        assert.equal(content.activities[0].name, "tool-2");
        assert.equal(content.activities[0].result.length, 2000);
        assert.equal(content.activities[0].resultTruncated, true);
        assert.equal(content.activities[0].argsTruncated, true);
        assert.equal(content.activities[0].args.length, 2000);
        assert.equal(content.activitiesTruncated, true);
        assert.equal((observed.details as { activities: unknown[] }).activities.length, 10);
      } else if (scenario === "changed session") {
        h.switchSession();
        h.update({ status: "completed", finishedAt: 50 });
        assert.equal(h.entries.length, 0);
        assert.equal(h.listeners.size, 0);
      } else if (scenario === "already finished") {
        assert.equal(h.entries.length, 1);
        assert.equal(h.listeners.size, 0);
        assert.equal(getSubagentEntry("call-1")?.run.finishedAt, 50);
      } else if (scenario === "running observation" || scenario === "optional fields") {
        const observed = await h.execute("subagent_observe", { runId: h.record.id });
        const details = observed.details as Record<string, unknown>;
        assert.equal(details.status, "running");
        assert.equal(details.finishedAt, undefined);
        assert.deepEqual(details.activities, h.record.activities.filter((activity) => activity.kind !== "message"));
        assert.deepEqual(details.usage, h.record.usage);
        assert.equal(details.startedAt, h.record.startedAt ?? h.record.createdAt);
        assert.equal(h.entries.length, 0);
      } else {
        h.forgetTask();
        const observed = await h.execute("subagent_observe", { runId: "missing" });
        assert.equal(observed.isError, true);
        assert.match((observed.content[0] as { text: string }).text, /Unknown task/);
      }
    } finally {
      clearSubagentRegistry();
    }
  });
}


test("observe acknowledges only delivered terminal results", async (t) => {
  for (const status of ["completed", "failed", "aborted", "running", "pending", "blocked", "error", "persisted"] as const) {
    await t.test(status, async (t) => {
      clearSubagentRegistry();
      t.after(clearSubagentRegistry);
      const h = harness();
      await h.execute("worker", { task: "Inspect" });
      assert.deepEqual(h.acknowledgments, []);
      if (status === "persisted") {
        h.update({ status: "completed", result: "Saved answer", finishedAt: 50 });
        h.forgetTask();
      } else if (status === "error") {
        h.forgetTask();
      } else {
        h.update({ status });
      }

      const result = await h.execute("subagent_observe", { runId: h.record.id, timeoutSeconds: 0 });

      assert.equal(result.isError, status === "error" ? true : undefined);
      const details = result.details as { status: string; result?: string };
      const mapped = status === "completed" || status === "persisted" ? "success"
        : status === "failed" || status === "error" ? "error" : status === "aborted" ? "aborted" : "running";
      assert.equal(details.status, mapped);
      if (status === "persisted") assert.equal(details.result, "Saved answer");
      if (status === "error") assert.match((result.content[0] as { text: string }).text, /Unknown task/);
      assert.deepEqual(h.acknowledgments, ["completed", "failed", "aborted", "persisted"].includes(status) ? [h.record.id] : []);
    });
  }
});

test("terminal observe and cancel preserve saved status and revision after eviction", async (t) => {
  for (const { status, mapped } of [
    { status: "completed", mapped: "success" },
    { status: "failed", mapped: "error" },
    { status: "aborted", mapped: "aborted" },
  ] as const) {
    for (const tool of ["subagent_observe", "subagent_cancel"] as const) {
      for (const forgotten of [false, true]) {
        await t.test(`${tool}: ${status}, forgotten=${forgotten}`, async (t) => {
          clearSubagentRegistry();
          t.after(clearSubagentRegistry);
          const h = harness();
          await h.execute("worker", { task: "Inspect" });
          h.update({ status, revision: 7, finishedAt: 50, result: "Saved evidence", error: status === "failed" ? "Failure evidence" : undefined });
          const liveRun = getSubagentEntry(h.record.id)?.run;
          const saved = h.entries.find((entry) => entry.type === "custom" && entry.customType === "gear:subagent-completion");
          assert.ok(saved?.type === "custom");
          if (forgotten) h.forgetTask();

          const result = await h.execute(tool, { runId: h.record.id });

          assert.equal(result.isError, undefined);
          const details = result.details as { status: string; revision: number };
          assert.equal(details.status, mapped);
          assert.equal(details.revision, 7);
          const text = JSON.parse((result.content[0] as { text: string }).text);
          assert.equal(text.status, mapped);
          if (forgotten) {
            assert.deepEqual(result.details, saved.data);
            assert.equal(text.revision, 7);
          }
          if (forgotten) {
            assert.deepEqual(getSubagentEntry(h.record.id)?.run, liveRun);
          }
          assert.deepEqual(h.acknowledgments, tool === "subagent_observe" ? [h.record.id] : []);
        });
      }
    }
  }
});

test("Gear subagent dispatch passes context modelRegistry to tasks.spawn", async (t) => {
  for (const tool of ["researcher", "worker", "reviewer"] as const) {
    await t.test(tool, async () => {
      clearSubagentRegistry();
      t.after(clearSubagentRegistry);
      const h = harness();
      const params = tool === "researcher" ? { question: "Why?" }
        : tool === "worker" ? { task: "Do it" }
        : { scope: "Changes" };
      await h.execute(tool, params);
      const options = h.getLastSpawnOptions() as { modelRegistry?: unknown };
      assert.ok(options.modelRegistry);
    });
  }
});
