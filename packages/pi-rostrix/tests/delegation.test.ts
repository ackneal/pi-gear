import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentRegistry } from "../src/core/registry.ts";
import { AgentResolver } from "../src/core/resolver.ts";
import { TaskRegistry, type SpawnTaskOptions } from "../src/runtime/task-registry.ts";
import { registerRostrixTools, type RegisterToolsOptions } from "../src/tools/index.ts";
import { agent } from "./runtime-fixtures.ts";
import type { SupervisionWakeTrigger } from "../src/core/schema.ts";

test("delegate receipts expose each task's actual wake settings", async (t) => {
  const cases: readonly (readonly SupervisionWakeTrigger[])[] = [[], ["completed"], ["failed"], ["stalled"], ["completed", "failed"]];
  for (const wakeOn of cases) {
    await t.test(wakeOn.join(",") || "disabled", async (t) => {
      const registry = new AgentRegistry();
      registry.register({ id: "child", label: "Child", description: "Child agent", supervision: { wakeOn: [...wakeOn] } });
      const tools = new Map<string, ToolDefinition>();
      const pi = {
        registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
        getActiveTools: () => ["read", "delegate"],
      } as unknown as ExtensionAPI;
      const tasks = new TaskRegistry({ createRunner: () => ({ run: async () => ({
        status: "completed", result: "Done", turns: 1, durationMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
      }) }) });
      t.after(() => tasks.shutdown());
      registerRostrixTools({ pi, taskRegistry: tasks, agentResolver: new AgentResolver(registry) });

      const receipt = await tools.get("delegate")!.execute("call", { agent: "child", task: "Work" }, undefined, undefined, { cwd: "/session/project" } as ExtensionToolContext);

      const content = receipt.content[0];
      assert.ok(content?.type === "text");
      const data = JSON.parse(content.text);
      assert.deepEqual(data.wakeOn, wakeOn);
      assert.deepEqual(receipt.details, { taskId: data.taskId, wakeOn });
      assert.deepEqual(tasks.getTask(data.taskId)?.wakeOn, wakeOn);
      assert.match(tools.get("delegate")!.description, /Enabled events notify/);
      assert.match(tools.get("task_wait")!.description, /Optional bounded wait/);
    });
  }
});

test("delegation preserves the parent authorization and execution context", async (t) => {
  for (const row of [
    { name: "workspace and tool ceiling", allowed: undefined, maxDepth: 2, parentDepth: undefined, succeeds: true },
    { name: "allowed target", allowed: ["child"], maxDepth: 2, parentDepth: undefined, succeeds: true },
    { name: "excluded target", allowed: ["other"], maxDepth: 2, parentDepth: undefined, succeeds: false },
    { name: "empty delegation allow list", allowed: [], maxDepth: 2, parentDepth: undefined, succeeds: false },
    { name: "delegation disabled", allowed: undefined, maxDepth: 0, parentDepth: undefined, succeeds: false },
    { name: "nested identity and depth", allowed: undefined, maxDepth: 2, parentDepth: 0, succeeds: true },
    { name: "nested depth exhausted", allowed: undefined, maxDepth: 2, parentDepth: 1, succeeds: false },
  ]) {
    await t.test(row.name, async () => {
      const registry = new AgentRegistry();
      registry.register({ id: "child", label: "Child", description: "Child agent", tools: { allow: ["*"] }, subagents: { maxDepth: 5 } });
      const tools = new Map<string, ToolDefinition>();
      const pi = {
        registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
        getActiveTools: () => ["read", "delegate"],
      } as unknown as ExtensionAPI;
      const tasks = new TaskRegistry();
      const spawns: SpawnTaskOptions[] = [];
      tasks.spawn = (options) => {
        spawns.push(options);
        return {
          id: "spawned", agentId: "child", profileId: "child", task: options.task,
          depth: options.depth ?? 0, targetFiles: options.targetFiles ?? [], wakeOn: [...options.agent!.supervision.wakeOn], status: "running",
          revision: 1, createdAt: 0, lastActivityAt: 0, activities: [],
        };
      };
      const getParentContext: NonNullable<RegisterToolsOptions["getParentContext"]> = () => ({
        agent: agent({ subagents: { allowedAgents: row.allowed, maxDepth: row.maxDepth, maxConcurrent: 2 } }),
        ...(row.parentDepth === undefined ? {} : { task: { id: "parent-task", depth: row.parentDepth } }),
      });
      registerRostrixTools({ pi, taskRegistry: tasks, agentResolver: new AgentResolver(registry), getParentContext });
      const delegate = tools.get("delegate")!;
      const invoke = () => delegate.execute("call", { agent: "child", task: "Inspect", targetFiles: ["src/../file.ts"] }, undefined, undefined, { cwd: "/session/project" } as ExtensionToolContext);

      if (!row.succeeds) {
        await assert.rejects(invoke, /not allowed by the parent|parent maximum delegation depth/);
        assert.equal(spawns.length, 0);
        return;
      }

      const receipt = await invoke();
      assert.deepEqual(receipt.details, { taskId: "spawned", wakeOn: [] });
      assert.deepEqual(JSON.parse(receipt.content[0]!.type === "text" ? receipt.content[0]!.text : "{}").wakeOn, []);
      assert.equal(spawns.length, 1);
      const spawned = spawns[0]!;
      assert.equal(spawned.cwd, "/session/project");
      assert.deepEqual(spawned.targetFiles, ["/session/project/file.ts"]);
      assert.deepEqual(spawned.agent?.allowedTools, ["read", "delegate"]);
      assert.equal(spawned.agent?.subagents.maxDepth, row.maxDepth);
      assert.deepEqual(spawned.agent?.subagents.allowedAgents, row.allowed);
      assert.equal(spawned.depth, row.parentDepth === undefined ? 0 : row.parentDepth + 1);
      assert.equal(spawned.parentTaskId, row.parentDepth === undefined ? undefined : "parent-task");
    });
  }
});

test("task_status acknowledges individual terminal results but not listings", async (t) => {
  for (const status of ["completed", "failed", "aborted", "running", "pending", "blocked", "missing", "listing"] as const) {
    await t.test(status, async (t) => {
      const tools = new Map<string, ToolDefinition>();
      const pi = { registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
      const tasks = new TaskRegistry();
      t.after(() => tasks.shutdown());
      tasks.getTask = () => status === "missing" ? undefined : {
        id: "observed", agentId: "child", profileId: "child", task: "Work", depth: 0,
        targetFiles: [], wakeOn: [], status: status === "listing" ? "completed" : status,
        revision: 2, createdAt: 0, lastActivityAt: 0, activities: [], result: "Available result",
      };
      const record = tasks.getTask("observed");
      if (record) t.mock.method(tasks, "listTasks", () => [record]);
      const acknowledgments: string[] = [];
      registerRostrixTools({
        pi, taskRegistry: tasks, agentResolver: new AgentResolver(new AgentRegistry()),
        taskSupervisor: { acknowledgeTask: (id) => { acknowledgments.push(id); } },
      });

      const result = await tools.get("task_status")!.execute("call", status === "listing" ? {} : { taskId: "observed" }, undefined, undefined, {} as ExtensionToolContext);

      assert.equal(result.isError, status === "missing" ? true : undefined);
      const content = result.content[0];
      assert.ok(content?.type === "text");
      if (status === "listing") {
        assert.equal(JSON.parse(content.text)[0].status, "completed");
        assert.equal(JSON.parse(content.text)[0].result, undefined);
      } else if (status !== "missing") assert.equal(JSON.parse(content.text).result, "Available result");
      assert.deepEqual(acknowledgments, ["completed", "failed", "aborted"].includes(status) ? ["observed"] : []);
    });
  }
});

test("task_wait acknowledges only delivered terminal results", async (t) => {
  for (const status of ["completed", "failed", "aborted", "running", "pending", "blocked", "error"] as const) {
    await t.test(status, async (t) => {
      const tools = new Map<string, ToolDefinition>();
      const pi = { registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
      const tasks = new TaskRegistry();
      t.after(() => tasks.shutdown());
      tasks.wait = async () => {
        if (status === "error") throw new Error("Wait failed");
        return {
          id: "observed", agentId: "child", profileId: "child", task: "Work", depth: 0,
          targetFiles: [], wakeOn: [], status, revision: 2, createdAt: 0, lastActivityAt: 0, activities: [],
        };
      };
      const acknowledgments: string[] = [];
      const taskSupervisor = {
        acknowledgeTask: (taskId: string) => { acknowledgments.push(taskId); },
      } satisfies NonNullable<RegisterToolsOptions["taskSupervisor"]>;
      registerRostrixTools({ pi, taskRegistry: tasks, taskSupervisor, agentResolver: new AgentResolver(new AgentRegistry()) });

      const result = await tools.get("task_wait")!.execute("call", { taskId: "observed", timeoutSeconds: 0 }, undefined, undefined, {} as ExtensionToolContext);

      assert.equal(result.isError, status === "error" ? true : undefined);
      if (status !== "error") assert.equal((result.details as { status: string }).status, status);
      else assert.match((result.content[0] as { text: string }).text, /Wait failed/);
      assert.deepEqual(acknowledgments, ["completed", "failed", "aborted"].includes(status) ? ["observed"] : []);
    });
  }
});
