import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, SessionShutdownEvent, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { InProcessSubagentRunner, resolveContextFiles, resolveInheritedExtensionPaths, type SubagentUsage } from "../src/tasks/session-runner.ts";
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
      for (const [toolName, blocked] of [["read", false], ["mcp__test__search", false], ["mcp__test__write", true], ["bash", true], ["mcp__other__search", true], ["mcp__test__outside", true], ["mcp__test__othersearch", true]] as const) {
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
      agent: agent({ allowedTools: ["read", "mcp__test__*"], toolAllowConstraints: [["read", "*search", "*write"]], parentActiveTools: ["read", "mcp__test__search", "mcp__test__write", "mcp__test__outside"], deniedTools: ["mcp__test__write"], mcpServers: { test: { url: "https://invalid.example/mcp" } } }),
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

test("runner forwards only per-run thinking levels", async (t) => {
  for (const thinkingLevel of [undefined, "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    await t.test(thinkingLevel ?? "omitted", async () => {
      let created = false;
      const runner = new InProcessSubagentRunner({
        agent: agent(), ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      }, async (options) => {
        created = true;
        assert.equal(options.thinkingLevel, thinkingLevel);
        assert.equal(Object.hasOwn(options, "thinkingLevel"), thinkingLevel !== undefined);
        return { session: {
          bindExtensions: async () => {}, subscribe: () => () => {}, prompt: async () => {},
          abort: async () => {}, dispose: () => {}, extensionRunner: { emit: async () => {} },
        } };
      });

      const result = await runner.run("Work");

      assert.equal(result.status, "completed");
      assert.equal(created, true);
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

test("runner reports assistant error and aborted stopReasons as failed instead of completed", async (t) => {
  const cases = [
    {
      name: "assistant turn fails with errorMessage",
      messages: [assistant({ content: [{ type: "text", text: "Partial" }], stopReason: "toolUse" }), assistant({ content: [], stopReason: "error", errorMessage: "Provider rate limited" })],
      expectedStatus: "failed",
      expectedError: "Provider rate limited",
      expectedResult: "Partial",
    },
    {
      name: "assistant turn fails without errorMessage",
      messages: [assistant({ content: [], stopReason: "error" })],
      expectedStatus: "failed",
      expectedError: "Subagent model turn failed",
      expectedResult: undefined,
    },
    {
      name: "assistant turn ends with internal aborted stopReason",
      messages: [assistant({ content: [], stopReason: "aborted", errorMessage: "Stream closed unexpectedly" })],
      expectedStatus: "failed",
      expectedError: "Stream closed unexpectedly",
      expectedResult: undefined,
    },
    {
      name: "later successful turn clears earlier transient error",
      messages: [assistant({ content: [], stopReason: "error", errorMessage: "Transient" }), assistant({ content: [{ type: "text", text: "Recovered" }], stopReason: "stop" })],
      expectedStatus: "completed",
      expectedError: undefined,
      expectedResult: "Recovered",
    },
  ];

  for (const row of cases) {
    await t.test(row.name, async () => {
      let listener: (event: AgentSessionEvent) => void = () => {};
      const runner = new InProcessSubagentRunner({ agent: agent() }, async () => ({
        session: {
          bindExtensions: async () => {},
          subscribe: (callback) => { listener = callback; return () => {}; },
          prompt: async () => {
            for (const message of row.messages) {
              listener({ type: "message_end", message });
            }
          },
          abort: async () => {},
          extensionRunner: { emit: async () => {} },
          dispose: () => {},
        },
      }));

      const result = await runner.run("Work");

      assert.equal(result.status, row.expectedStatus);
      assert.equal(result.error, row.expectedError);
      assert.equal(result.result, row.expectedResult);
    });
  }
});

test("resolveInheritedExtensionPaths applies inherit modes, explicit paths, and exclusions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rostrix-ext-inherit-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "workspace");
  const userExt = join(agentDir, "extensions", "user-ext.ts");
  const projectExt = join(cwd, ".pi", "extensions", "project-ext.ts");
  const pkgDir = join(dir, "custom-pkg");
  const pkgEntry = join(pkgDir, "index.ts");
  const explicitFile = join(dir, "explicit-ext.ts");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await mkdir(pkgDir, { recursive: true });
  const stub = "export default function () {}\n";
  await writeFile(userExt, stub);
  await writeFile(projectExt, stub);
  await writeFile(pkgEntry, stub);
  await writeFile(explicitFile, stub);

  const cases = [
    {
      name: "none isolates user and project extensions",
      extensions: { inherit: "none" as const, paths: [], exclude: [] },
      additionalExtensionPaths: undefined,
      excludeExtensionPaths: undefined,
      expected: [],
    },
    {
      name: "user loads agentDir extensions only",
      extensions: { inherit: "user" as const, paths: [], exclude: [] },
      additionalExtensionPaths: undefined,
      excludeExtensionPaths: undefined,
      expected: [userExt],
    },
    {
      name: "all loads both user and project extensions",
      extensions: { inherit: "all" as const, paths: [], exclude: [] },
      additionalExtensionPaths: undefined,
      excludeExtensionPaths: undefined,
      expected: [projectExt, userExt],
    },
    {
      name: "exclude filters out matching user extension and package dir",
      extensions: { inherit: "all" as const, paths: [pkgDir], exclude: [projectExt] },
      additionalExtensionPaths: [explicitFile, pkgEntry],
      excludeExtensionPaths: [pkgEntry],
      expected: [userExt, explicitFile],
    },
  ];

  try {
    for (const row of cases) {
      await t.test(row.name, async () => {
        const resolved = await resolveInheritedExtensionPaths({
          cwd,
          agentDir,
          agent: agent({ extensions: row.extensions }),
          additionalExtensionPaths: row.additionalExtensionPaths,
          excludeExtensionPaths: row.excludeExtensionPaths,
        });
        assert.deepEqual(resolved, row.expected);
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runner loads additionalExtensionPaths into child resourceLoader when enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rostrix-runner-ext-"));
  const extPath = join(dir, "inherited.ts");
  await writeFile(extPath, "export default function (pi) { pi.on('session_start', async () => {}); }\n");

  try {
    let loadedPaths: string[] = [];
    const runner = new InProcessSubagentRunner(
      {
        agent: agent(),
        cwd: dir,
        additionalExtensionPaths: [extPath],
      },
      async (options) => {
        loadedPaths = options.resourceLoader?.getExtensions().extensions.map((ext) => ext.path) ?? [];
        return {
          session: {
            bindExtensions: async () => {},
            subscribe: () => () => {},
            prompt: async () => {},
            abort: async () => {},
            extensionRunner: { emit: async () => {} },
            dispose: () => {},
          },
        };
      },
    );

    const result = await runner.run("Work");

    assert.equal(result.status, "completed");
    assert.ok(loadedPaths.includes(extPath), `expected ${extPath} in ${JSON.stringify(loadedPaths)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runner isolates ModelRuntime when child extensions register providers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rostrix-runner-isolate-runtime-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const extPath = join(dir, "bridge-ext.ts");
  await writeFile(
    extPath,
    `export default function (pi) {
      let closed = false;
      pi.registerProvider("custom-bridge", {
        baseUrl: "https://child.example",
        apiKey: "child-key",
        api: "openai-completions",
        models: [{ id: "child-model", name: "Child Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
      });
      pi.on("session_shutdown", async () => { closed = true; });
    }\n`,
  );

  const parentRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  parentRuntime.registerProvider("custom-bridge", {
    baseUrl: "https://parent.example",
    apiKey: "parent-key",
    api: "openai-completions",
    models: [{ id: "parent-model", name: "Parent Model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
  });

  try {
    let childRuntime: ModelRuntime | undefined;
    let childResolvedModelId: string | undefined;
    const runner = new InProcessSubagentRunner(
      {
        agent: agent(),
        cwd,
        model: "custom-bridge/child-model",
        modelRuntime: parentRuntime,
        parentSession: { _cwd: cwd, _agentDir: agentDir, modelRuntime: parentRuntime } as any,
        additionalExtensionPaths: [extPath],
      },
      async (options) => {
        childRuntime = options.modelRuntime;
        childResolvedModelId = options.model?.id;
        return {
          session: {
            bindExtensions: async () => {},
            subscribe: () => () => {},
            prompt: async () => {},
            abort: async () => {},
            extensionRunner: { emit: async () => {} },
            dispose: () => {},
          },
        };
      },
    );

    const result = await runner.run("Work");

    assert.equal(result.status, "completed");
    assert.notEqual(childRuntime, parentRuntime);
    assert.equal(childResolvedModelId, "child-model");
    assert.ok(childRuntime?.getModel("custom-bridge", "child-model"));
    assert.ok(parentRuntime.getModel("custom-bridge", "parent-model"));
    assert.equal(parentRuntime.getModel("custom-bridge", "child-model"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runner publishes streaming usage on message_update without duplicating unchanged message_end", async () => {
  const updates: SubagentUsage[] = [];
  let listener: (event: AgentSessionEvent) => void = () => {};
  const session = {
    bindExtensions: async () => {},
    subscribe: (callback: (event: AgentSessionEvent) => void) => { listener = callback; return () => {}; },
    prompt: async () => {
      const partial1 = assistant({
        usage: { input: 10, output: 2, cacheRead: 5, cacheWrite: 3, totalTokens: 20, cost: { input: 0.1, output: 0.02, cacheRead: 0.01, cacheWrite: 0.01, total: 0.14 } },
      });
      const partial2 = assistant({
        usage: { input: 10, output: 7, cacheRead: 5, cacheWrite: 3, totalTokens: 25, cost: { input: 0.1, output: 0.07, cacheRead: 0.01, cacheWrite: 0.01, total: 0.19 } },
      });
      listener({ type: "message_update", message: partial1, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi", partial: partial1 } });
      listener({ type: "message_update", message: partial1, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!", partial: partial1 } });
      assert.equal(updates.length, 1);
      listener({ type: "message_update", message: partial2, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " there", partial: partial2 } });
      assert.equal(updates.length, 2);
      listener({ type: "message_end", message: partial2 });
      assert.equal(updates.length, 2);
    },
    abort: async () => {},
    extensionRunner: { emit: async () => {} },
    dispose: () => {},
  } satisfies Pick<AgentSession, "bindExtensions" | "subscribe" | "prompt" | "abort" | "dispose"> & {
    extensionRunner: { emit(event: SessionShutdownEvent): Promise<unknown> };
  };

  const runner = new InProcessSubagentRunner(
    { agent: agent(), onUsage: (usage) => updates.push(usage) },
    async () => ({ session }),
  );
  const result = await runner.run("Work");

  assert.equal(result.status, "completed");
  assert.deepEqual(updates, [
    { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 3, totalTokens: 20, cost: 0.14 },
    { inputTokens: 10, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3, totalTokens: 25, cost: 0.19 },
  ]);
  assert.deepEqual(result.usage, updates[1]);
});

test("runner publishes estimated streaming usage when provider leaves interim usage at zero and reconciles on message_end", async () => {
  const updates: SubagentUsage[] = [];
  let listener: (event: AgentSessionEvent) => void = () => {};
  const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const session = {
    bindExtensions: async () => {},
    subscribe: (callback: (event: AgentSessionEvent) => void) => { listener = callback; return () => {}; },
    prompt: async () => {
      const partial1 = assistant({ usage: zeroUsage });
      listener({ type: "message_start", message: partial1 });
      // 4 chars -> 1 est. token
      listener({ type: "message_update", message: partial1, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd", partial: partial1 } });
      // +8 chars (12 total) -> 3 est. tokens
      listener({ type: "message_update", message: partial1, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "12345678", partial: partial1 } });
      // Final SDK usage replaces (does not add to) the estimate
      const final1 = assistant({
        usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, totalTokens: 130, cost: { input: 0.01, output: 0.002, cacheRead: 0.001, cacheWrite: 0, total: 0.013 } },
      });
      listener({ type: "message_end", message: final1 });

      // Turn 2: settled turn 1 + turn 2 estimate
      const partial2 = assistant({ usage: zeroUsage });
      listener({ type: "message_start", message: partial2 });
      listener({ type: "message_update", message: partial2, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "12345678", partial: partial2 } });
      const final2 = assistant({
        usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { input: 0.005, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.006 } },
      });
      listener({ type: "message_end", message: final2 });
    },
    abort: async () => {},
    extensionRunner: { emit: async () => {} },
    dispose: () => {},
  } satisfies Pick<AgentSession, "bindExtensions" | "subscribe" | "prompt" | "abort" | "dispose"> & {
    extensionRunner: { emit(event: SessionShutdownEvent): Promise<unknown> };
  };

  const runner = new InProcessSubagentRunner(
    { agent: agent(), onUsage: (usage) => updates.push(usage) },
    async () => ({ session }),
  );
  const result = await runner.run("Work");

  assert.equal(result.status, "completed");
  assert.deepEqual(updates, [
    { inputTokens: 0, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1, cost: 0, estimated: true },
    { inputTokens: 0, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3, cost: 0, estimated: true },
    { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0, totalTokens: 130, cost: 0.013 },
    { inputTokens: 100, outputTokens: 22, cacheReadTokens: 10, cacheWriteTokens: 0, totalTokens: 132, cost: 0.013, estimated: true },
    { inputTokens: 150, outputTokens: 30, cacheReadTokens: 10, cacheWriteTokens: 0, totalTokens: 190, cost: 0.019 },
  ]);
  assert.deepEqual(result.usage, updates[4]);
});

test("runner configures system prompt and append overrides instead of prefixing the task prompt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rostrix-runner-prompts-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "workspace");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(join(agentDir, "SYSTEM.md"), "User system prompt");
  await writeFile(join(cwd, ".pi", "SYSTEM.md"), "Project system prompt");
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "User append prompt");
  await writeFile(join(cwd, ".pi", "APPEND_SYSTEM.md"), "Project append prompt");

  const cases = [
    {
      name: "none isolates ambient prompt files and leaves custom prompt unset",
      overrides: {},
      expectedSystem: undefined,
      expectedAppend: [],
    },
    {
      name: "agent systemPrompt, appendPrompt, and guidelines apply to resourceLoader without touching user prompt",
      overrides: {
        systemPrompt: "Role system",
        appendPrompt: "Role addendum",
        promptGuidelines: ["Rule A", "Rule B"],
      },
      expectedSystem: "Role system",
      expectedAppend: ["Role addendum", "Guidelines:\n- Rule A\n- Rule B"],
    },
    {
      name: "inherit user SYSTEM.md and APPEND_SYSTEM.md combines with agent prompt",
      overrides: {
        inheritSystemPrompt: "user" as const,
        inheritAppendSystemPrompt: "user" as const,
        systemPrompt: "Role system",
        appendPrompt: "Role addendum",
      },
      expectedSystem: "User system prompt\n\nRole system",
      expectedAppend: ["User append prompt", "Role addendum"],
    },
    {
      name: "inherit project overrides user for SYSTEM.md and APPEND_SYSTEM.md",
      overrides: {
        inheritSystemPrompt: "all" as const,
        inheritAppendSystemPrompt: "project" as const,
      },
      expectedSystem: "Project system prompt",
      expectedAppend: ["Project append prompt"],
    },
    {
      name: "directory collision at SYSTEM.md skips directory instead of failing",
      setup: async () => {
        await rm(join(cwd, ".pi", "SYSTEM.md"), { force: true });
        await mkdir(join(cwd, ".pi", "SYSTEM.md"), { recursive: true });
      },
      overrides: {
        inheritSystemPrompt: "all" as const,
      },
      expectedSystem: "User system prompt",
      expectedAppend: [],
    },
  ];

  try {
    for (const row of cases) {
      await t.test(row.name, async () => {
        if (row.setup) await row.setup();
        let loaderSystemPrompt: string | undefined;
        let loaderAppendPrompt: string[] = [];
        let sentPrompt: string | undefined;

        const runner = new InProcessSubagentRunner(
          {
            agent: agent(row.overrides),
            cwd,
            parentSession: { _cwd: cwd, _agentDir: agentDir } as any,
          },
          async (options) => {
            loaderSystemPrompt = options.resourceLoader?.getSystemPrompt();
            loaderAppendPrompt = options.resourceLoader?.getAppendSystemPrompt() ?? [];
            return {
              session: {
                bindExtensions: async () => {},
                subscribe: () => () => {},
                prompt: async (prompt) => { sentPrompt = prompt; },
                abort: async () => {},
                extensionRunner: { emit: async () => {} },
                dispose: () => {},
              },
            };
          },
        );

        const result = await runner.run("Actual user task");
        assert.equal(result.status, "completed");
        assert.equal(loaderSystemPrompt, row.expectedSystem);
        assert.deepEqual(loaderAppendPrompt, row.expectedAppend);
        assert.equal(sentPrompt, "Actual user task");
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveContextFiles and runner enforce contextFiles inherit modes, explicit paths, and exclusions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rostrix-runner-context-"));
  const agentDir = join(dir, "agent");
  const parentRepo = join(dir, "repo");
  const cwd = join(parentRepo, "sub");
  const explicitDir = join(dir, "explicit-dir");
  const explicitFile = join(dir, "extra-context.md");
  const tildeIncluded = join(dir, "tilde-included.md");
  const tildeExcluded = join(dir, "tilde-excluded.md");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(explicitDir, { recursive: true });
  await writeFile(join(agentDir, "AGENTS.md"), "User context");
  await writeFile(join(parentRepo, "AGENTS.md"), "Repo parent context");
  await writeFile(join(cwd, "AGENTS.md"), "Workspace context");
  await writeFile(join(explicitDir, "AGENTS.override.md"), "Explicit override dir context");
  await writeFile(explicitFile, "Explicit file context");
  await writeFile(tildeIncluded, "Tilde file context");
  await writeFile(tildeExcluded, "Tilde excluded context");

  const previousHome = process.env.HOME;
  process.env.HOME = dir;

  const cases = [
    {
      name: "none without paths returns undefined and keeps loader isolated",
      contextFiles: { inherit: "none" as const, paths: [], exclude: [] },
      expectedContents: [],
    },
    {
      name: "user loads only global agentDir context file",
      contextFiles: { inherit: "user" as const, paths: [], exclude: [] },
      expectedContents: ["User context"],
    },
    {
      name: "project loads ancestor context files without user file",
      contextFiles: { inherit: "project" as const, paths: [], exclude: [] },
      expectedContents: ["Repo parent context", "Workspace context"],
    },
    {
      name: "all with explicit dir, file, and exclude drops excluded and appends explicit",
      contextFiles: {
        inherit: "all" as const,
        paths: [explicitDir, explicitFile, "~/tilde-included.md", "~/tilde-excluded.md"],
        exclude: [join(parentRepo, "AGENTS.md"), "~/tilde-excluded.md"],
      },
      expectedContents: ["User context", "Workspace context", "Explicit override dir context", "Explicit file context", "Tilde file context"],
    },
  ];

  try {
    for (const row of cases) {
      await t.test(row.name, async () => {
        const direct = resolveContextFiles({ cwd, agentDir, contextFiles: row.contextFiles });
        if (row.contextFiles.inherit === "none" && row.contextFiles.paths.length === 0) {
          assert.equal(direct, undefined);
        } else {
          assert.deepEqual(direct?.map((f) => f.content), row.expectedContents);
        }

        let loadedContents: string[] = [];
        const runner = new InProcessSubagentRunner(
          {
            agent: agent({ contextFiles: row.contextFiles }),
            cwd,
            parentSession: { _cwd: cwd, _agentDir: agentDir } as any,
          },
          async (options) => {
            loadedContents = options.resourceLoader?.getAgentsFiles().agentsFiles.map((f) => f.content) ?? [];
            return {
              session: {
                bindExtensions: async () => {},
                subscribe: () => () => {},
                prompt: async () => {},
                abort: async () => {},
                extensionRunner: { emit: async () => {} },
                dispose: () => {},
              },
            };
          },
        );

        const result = await runner.run("Work");
        assert.equal(result.status, "completed");
        assert.deepEqual(loadedContents, row.expectedContents);
      });
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("runner filters inherited and explicit skills and promptTemplates", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rostrix-runner-skills-prompts-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "workspace");
  const userSkillDir = join(agentDir, "skills", "user-skill");
  const projectSkillDir = join(cwd, ".pi", "skills", "project-skill");
  const blockedSkillDir = join(cwd, ".pi", "skills", "blocked-skill");
  const extraSkillDir = join(dir, "extra-skills", "extra-skill");
  const userPromptDir = join(agentDir, "prompts");
  const projectPromptDir = join(cwd, ".pi", "prompts");
  const extraPromptFile = join(dir, "extra-template.md");

  for (const d of [userSkillDir, projectSkillDir, blockedSkillDir, extraSkillDir, userPromptDir, projectPromptDir]) {
    await mkdir(d, { recursive: true });
  }
  await writeFile(join(userSkillDir, "SKILL.md"), "---\nname: user-skill\ndescription: User skill\n---\nUser body\n");
  await writeFile(join(projectSkillDir, "SKILL.md"), "---\nname: project-skill\ndescription: Project skill\n---\nProject body\n");
  await writeFile(join(blockedSkillDir, "SKILL.md"), "---\nname: blocked-skill\ndescription: Blocked skill\n---\nBlocked body\n");
  await writeFile(join(extraSkillDir, "SKILL.md"), "---\nname: extra-skill\ndescription: Extra skill\n---\nExtra body\n");
  await writeFile(join(userPromptDir, "user-tpl.md"), "---\ndescription: User template\n---\nHello\n");
  await writeFile(join(projectPromptDir, "project-tpl.md"), "---\ndescription: Project template\n---\nWorld\n");
  await writeFile(extraPromptFile, "---\ndescription: Extra template\n---\nExtra\n");

  const cases = [
    {
      name: "none isolates both skills and prompt templates",
      overrides: {},
      expectedSkills: [],
      expectedPrompts: [],
    },
    {
      name: "user inherits only user skills and templates",
      overrides: {
        skills: { inherit: "user" as const, paths: [], exclude: [] },
        promptTemplates: { inherit: "user" as const, paths: [], exclude: [], deny: [] },
      },
      expectedSkills: ["user-skill"],
      expectedPrompts: ["user-tpl"],
    },
    {
      name: "all with explicit paths, exclude, allow, allowConstraints, and deny filters cleanly",
      overrides: {
        skills: { inherit: "all" as const, paths: [extraSkillDir], exclude: [userSkillDir] },
        allowedSkills: ["extra-*", "project-*"],
        skillAllowConstraints: [["*-skill"]],
        deniedSkills: ["blocked-skill"],
        promptTemplates: {
          inherit: "all" as const,
          paths: [extraPromptFile],
          exclude: [join(userPromptDir, "user-tpl.md")],
          allow: ["project-*", basename(extraPromptFile, ".md")],
          deny: [basename(extraPromptFile, ".md")],
        },
      },
      expectedSkills: ["extra-skill", "project-skill"],
      expectedPrompts: ["project-tpl"],
    },
  ];

  try {
    for (const row of cases) {
      await t.test(row.name, async () => {
        let skillNames: string[] = [];
        let promptNames: string[] = [];
        const runner = new InProcessSubagentRunner(
          {
            agent: agent(row.overrides),
            cwd,
            parentSession: { _cwd: cwd, _agentDir: agentDir } as any,
          },
          async (options) => {
            skillNames = (options.resourceLoader?.getSkills().skills.map((s) => s.name) ?? []).sort();
            promptNames = (options.resourceLoader?.getPrompts().prompts.map((p) => p.name) ?? []).sort();
            return {
              session: {
                bindExtensions: async () => {},
                subscribe: () => () => {},
                prompt: async () => {},
                abort: async () => {},
                extensionRunner: { emit: async () => {} },
                dispose: () => {},
              },
            };
          },
        );

        const result = await runner.run("Work");
        assert.equal(result.status, "completed");
        assert.deepEqual(skillNames, row.expectedSkills);
        assert.deepEqual(promptNames, row.expectedPrompts);
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

