import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, SessionShutdownEvent, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { InProcessSubagentRunner, type SubagentUsage } from "../src/runtime/session-runner.ts";
import { agent, assistant } from "./runtime-fixtures.ts";

test("runner collects SDK usage for every terminal path", async (t) => {
  for (const status of ["completed", "failed", "aborted"] as const) {
    await t.test(status, async () => {
      const controller = new AbortController();
      const updates: SubagentUsage[] = [];
      const deltas: string[] = [];
      let listener: (event: AgentSessionEvent) => void = () => {};
      let disposed = false;
      let unsubscribed = false;
      const session = {
        bindExtensions: async () => {},
        subscribe: (callback) => { listener = callback; return () => { unsubscribed = true; }; },
        prompt: async () => {
          const message = assistant();
          listener({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Done", partial: message } });
          listener({ type: "message_end", message });
          assert.equal(updates.length, 1, "usage is published before prompt settles");
          listener({ type: "message_end", message: assistant({ timestamp: 2 }) });
          if (status === "aborted") controller.abort(new Error("Stopped"));
          if (status !== "completed") throw new Error("Prompt failed");
        },
        abort: async () => {},
        extensionRunner: { emit: async () => {} },
        dispose: () => { disposed = true; },
      } satisfies Pick<AgentSession, "bindExtensions" | "subscribe" | "prompt" | "abort" | "dispose"> & {
        extensionRunner: { emit(event: SessionShutdownEvent): Promise<unknown> };
      };
      // Only the SDK boundary is stubbed; event/message fixtures use the installed SDK types.
      const createSession: NonNullable<ConstructorParameters<typeof InProcessSubagentRunner>[1]> = async (options) => ({
        session,
        extensionsResult: options!.resourceLoader!.getExtensions(),
      });
      const runner = new InProcessSubagentRunner({
        agent: agent(), signal: controller.signal,
        onUsage: (usage) => updates.push(usage), onTextDelta: (delta) => deltas.push(delta),
      }, createSession);

      const result = await runner.run("Work");

      const expected = { inputTokens: 22, outputTokens: 14, cacheReadTokens: 10, cacheWriteTokens: 6, totalTokens: 52, cost: 0.74 };
      assert.equal(result.status, status);
      assert.deepEqual(result.usage, expected);
      assert.deepEqual(updates.at(-1), expected);
      assert.equal(result.turns, 2);
      assert.equal(result.result, "Done");
      assert.deepEqual(deltas, ["Done"]);
      assert.ok(disposed && unsubscribed);
    });
  }
});

test("runner awaits shutdown before disposal on every terminal path", async (t) => {
  for (const scenario of [
    { name: "completed", status: "completed" },
    { name: "prompt failed", status: "failed" },
    { name: "aborted", status: "aborted" },
    { name: "bindExtensions failed", status: "failed" },
    { name: "shutdown rejected", status: "completed" },
  ] as const) {
    await t.test(scenario.name, async () => {
      const controller = new AbortController();
      const order: string[] = [];
      const shutdownError = new Error("Shutdown failed");
      let disposed = false;
      const session = {
        bindExtensions: async () => {
          order.push("bind");
          if (scenario.name === "bindExtensions failed") throw new Error("Binding failed");
        },
        subscribe: () => () => {},
        prompt: async () => {
          order.push("prompt");
          if (scenario.name === "aborted") controller.abort(new Error("Stopped"));
          if (scenario.name === "prompt failed") throw new Error("Prompt failed");
        },
        abort: async () => { order.push("abort"); },
        extensionRunner: {
          emit: async (event) => {
            assert.deepEqual(event, { type: "session_shutdown", reason: "quit" });
            order.push("shutdown started");
            await new Promise<void>((resolve) => setImmediate(resolve));
            order.push("shutdown settled");
            if (scenario.name === "shutdown rejected") throw shutdownError;
          },
        },
        dispose: () => { disposed = true; order.push("dispose"); },
      } satisfies Pick<AgentSession, "bindExtensions" | "subscribe" | "prompt" | "abort" | "dispose"> & {
        extensionRunner: { emit(event: SessionShutdownEvent): Promise<unknown> };
      };
      const runner = new InProcessSubagentRunner({ agent: agent(), signal: controller.signal }, async () => ({ session }));

      if (scenario.name === "shutdown rejected") {
        await assert.rejects(runner.run("Work"), (error) => error === shutdownError);
      } else {
        const result = await runner.run("Work");
        assert.equal(result.status, scenario.status);
        if (scenario.name === "prompt failed") assert.equal(result.error, "Prompt failed");
        if (scenario.name === "bindExtensions failed") assert.match(result.error!, /Binding failed/);
      }

      assert.equal(disposed, true);
      assert.deepEqual(order, [
        "bind",
        ...(scenario.name === "bindExtensions failed" ? [] : ["prompt"]),
        ...(scenario.name === "aborted" ? ["abort"] : []),
        "shutdown started", "shutdown settled", "dispose",
      ]);
    });
  }
});

test("runner isolates discovered resources but retains explicit factories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rostrix-runner-"));
  try {
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(join(cwd, ".pi", "extensions", "host.ts"), 'throw new Error("Host extension must not load");');
    await writeFile(join(cwd, "AGENTS.md"), "Host context must not load");
    const createSession: NonNullable<ConstructorParameters<typeof InProcessSubagentRunner>[1]> = async (options) => {
      const loader = options!.resourceLoader!;
      const extensions = loader.getExtensions();
      assert.deepEqual(extensions.errors, []);
      assert.equal(extensions.extensions.length, 5, "Only explicitly supplied factories load");
      const hostPolicy = extensions.extensions[0]!.handlers.get("tool_call")![0]!;
      const denied: ToolCallEvent = { type: "tool_call", toolCallId: "outside", toolName: "read", input: { path: "/denied" } };
      assert.deepEqual(await hostPolicy(denied), { block: true, reason: "Filesystem policy" });
      const toolNames = extensions.extensions.flatMap((extension) => [...extension.tools.keys()]);
      assert.ok(toolNames.includes("codemode"));
      assert.ok(toolNames.includes("tool_search"));
      assert.deepEqual(extensions.runtime.mcpServers.get("test")?.config, { url: "https://invalid.example/mcp" });
      const policy = extensions.extensions.at(-1)!.handlers.get("tool_call")![0]!;
      for (const [toolName, blocked] of [["read", false], ["mcp__test__search", false], ["mcp__test__write", true], ["bash", true], ["mcp__other__search", true]] as const) {
        const event: ToolCallEvent = { type: "tool_call", toolCallId: "parent/1", parentToolCallId: "parent", toolName, input: {} };
        const response = await policy(event);
        if (blocked) assert.deepEqual(response, { block: true, reason: `Tool ${toolName} is not allowed for agent test:worker` });
        else assert.equal(response, undefined);
      }
      assert.deepEqual(loader.getSkills().skills, []);
      assert.deepEqual(loader.getPrompts().prompts, []);
      assert.deepEqual(loader.getThemes().themes, []);
      assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
      assert.equal(loader.getSystemPrompt(), undefined);
      assert.deepEqual(loader.getAppendSystemPrompt(), []);
      throw new Error("Verified isolated loader");
    };
    const runner = new InProcessSubagentRunner({
      cwd,
      extensionFactories: [(pi) => {
        pi.on("tool_call", (event) => {
          if ("path" in event.input && event.input.path === "/denied") return { block: true, reason: "Filesystem policy" };
        });
      }],
      agent: agent({ allowedTools: ["read", "mcp__test__*"], deniedTools: ["mcp__test__write"], mcpServers: { test: { url: "https://invalid.example/mcp" } } }),
    }, createSession);

    const result = await runner.run("Work");
    assert.equal(result.status, "failed");
    assert.match(result.error!, /Verified isolated loader/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runner resolves requested models with the session runtime", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rostrix-models-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const model = runtime.getModels()[0]!;
  assert.ok(model);
  for (const row of [
    { name: "no injected runtime", injected: false, requested: `${model.provider}/${model.id}`, valid: true },
    { name: "injected runtime", injected: true, requested: `${model.provider}/${model.id}`, valid: true },
    { name: "unknown model without runtime", injected: false, requested: "missing-provider/missing-model", valid: false },
    { name: "unknown model with runtime", injected: true, requested: "missing-provider/missing-model", valid: false },
    { name: "malformed model", injected: false, requested: "missing-provider", valid: false },
    { name: "empty model", injected: true, requested: "", valid: false },
  ]) {
    await t.test(row.name, async (t) => {
      const createRuntime = t.mock.method(ModelRuntime, "create", async (options: Parameters<typeof ModelRuntime.create>[0]) => {
        assert.deepEqual(options, { authPath: join(getAgentDir(), "auth.json"), modelsPath: join(getAgentDir(), "models.json") });
        return runtime;
      });
      let created = false;
      const runner = new InProcessSubagentRunner({
        agent: agent(), model: row.requested, ...(row.injected ? { modelRuntime: runtime } : {}),
      }, async (options) => {
        created = true;
        assert.equal(options.modelRuntime, runtime);
        assert.equal(options.model, model);
        return { session: {
          bindExtensions: async () => {}, subscribe: () => () => {}, prompt: async () => {},
          abort: async () => {}, dispose: () => {}, extensionRunner: { emit: async () => {} },
        } };
      });

      const result = await runner.run("Work");

      assert.equal(result.status, row.valid ? "completed" : "failed");
      assert.equal(created, row.valid);
      if (!row.valid) assert.match(result.error!, /(?:Invalid|Unknown) requested model:/);
      assert.equal(createRuntime.mock.callCount(), !row.injected && row.requested.includes("/") ? 1 : 0);
    });
  }
});

test("pre-aborted runner does not create a session", async () => {
  const controller = new AbortController();
  controller.abort();
  const runner = new InProcessSubagentRunner({ agent: agent(), signal: controller.signal }, async () => {
    assert.fail("No session should be created");
  });
  assert.equal((await runner.run("Work")).status, "aborted");
});
