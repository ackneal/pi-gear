import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AgentActivationError,
  AgentActivator,
  init,
  type ResolvedAgentDefinition,
  type SupervisionWakeTrigger,
  type ThinkingLevel,
} from "../src/index.ts";

interface MockPiState {
  allTools: Array<{ name: string }>;
  activeTools: string[];
  thinkingLevel: ThinkingLevel;
  mcpServers: Map<string, any>;
  eventHandlers: Map<string, Array<(...args: any[]) => any>>;
}

const emptyWakeOn = (): ReadonlySet<SupervisionWakeTrigger> => Object.freeze(new Set<SupervisionWakeTrigger>());

function createTestProfile(overrides: Partial<ResolvedAgentDefinition> & { id: string; label: string; description: string }): ResolvedAgentDefinition {
  return {
    promptGuidelines: Object.freeze([]),
    deniedTools: Object.freeze([]),
    deniedSkills: Object.freeze([]),
    mcpServers: Object.freeze({}),
    subagents: Object.freeze({ maxDepth: 2, maxConcurrent: 2 }),
    supervision: Object.freeze({ wakeOn: emptyWakeOn() }),
    ...overrides,
  };
}

function createMockPi(initial?: Partial<MockPiState>): { pi: ExtensionAPI; state: MockPiState; triggerBeforeAgentStart: (event: any) => Promise<any> } {
  const state: MockPiState = {
    allTools: [{ name: "read" }, { name: "edit" }, { name: "write" }, { name: "bash" }, { name: "lsp_find" }, { name: "lsp_diag" }],
    activeTools: ["read", "bash"],
    thinkingLevel: "medium",
    mcpServers: new Map(),
    eventHandlers: new Map(),
    ...initial,
  };

  const pi = {
    getAllTools: () => state.allTools,
    getActiveTools: () => state.activeTools,
    setActiveTools: (tools: string[]) => { state.activeTools = [...tools]; },
    getThinkingLevel: () => state.thinkingLevel,
    setThinkingLevel: (level: ThinkingLevel) => { state.thinkingLevel = level; },
    registerMcpServer: (name: string, config: any) => { state.mcpServers.set(name, config); },
    unregisterMcpServer: (name: string) => { state.mcpServers.delete(name); },
    registerTool: () => {},
    on: (event: string, handler: (...args: any[]) => any) => {
      const handlers = state.eventHandlers.get(event) ?? [];
      handlers.push(handler);
      state.eventHandlers.set(event, handlers);
      return () => {
        const current = state.eventHandlers.get(event) ?? [];
        state.eventHandlers.set(event, current.filter((h) => h !== handler));
      };
    },
  } as unknown as ExtensionAPI;

  const triggerBeforeAgentStart = async (event: any) => {
    const handlers = state.eventHandlers.get("before_agent_start") ?? [];
    for (const handler of handlers) {
      await handler(event);
    }
    return event;
  };

  return { pi, state, triggerBeforeAgentStart };
}

test("AgentActivator applies all allow constraints and concrete parent identities", async () => {
  for (const row of [
    { constraints: [["lsp_*"]], parent: undefined, deny: [], expected: ["lsp_find"] },
    { constraints: [["*_find"]], parent: ["lsp_diag"], deny: [], expected: [] },
    { constraints: [["lsp_*"]], parent: ["lsp_find"], deny: ["*_find"], expected: [] },
  ]) {
    const { pi, state } = createMockPi();
    const activator = new AgentActivator(pi);
    await activator.activate(createTestProfile({
      id: "policy", label: "Policy", description: "", allowedTools: ["*_find"],
      toolAllowConstraints: row.constraints, parentActiveTools: row.parent, deniedTools: row.deny,
    }));
    assert.deepEqual(state.activeTools, row.expected);
    activator.dispose();
  }
});

test("AgentActivator activates profile tools and MCP servers without changing thinking", async () => {
  const { pi, state } = createMockPi();
  const activator = new AgentActivator(pi);

  const profile = createTestProfile({
    id: "gear:worker",
    label: "Worker",
    description: "Executes work",
    promptGuidelines: Object.freeze(["Rule 1", "Rule 2"]),
    appendPrompt: "Work surgically.",
    allowedTools: Object.freeze(["read", "edit", "write", "lsp_*"]),
    deniedTools: Object.freeze(["write"]), // Deny overrides allow
    mcpServers: Object.freeze({
      github: { command: "gh-mcp" },
    }),
  });

  await activator.activate(profile);

  assert.strictEqual(activator.activeAgent, profile);
  // Allowed tools: read, lsp_find, lsp_diag (edit/write allowed, but write is denied)
  assert.deepEqual(state.activeTools.sort(), ["edit", "lsp_diag", "lsp_find", "read"].sort());
  assert.equal(state.thinkingLevel, "medium");
  assert.equal(state.mcpServers.has("github"), true);
});

test("AgentActivator before_agent_start hook injects guidelines and prompts", async () => {
  const { pi, triggerBeforeAgentStart } = createMockPi();
  const activator = new AgentActivator(pi);

  const profile = createTestProfile({
    id: "reviewer",
    label: "Reviewer",
    description: "Code review",
    systemPrompt: "You are a code reviewer.",
    appendPrompt: "Check for security.",
    promptGuidelines: Object.freeze(["Be concise.", "Verify types."]),
  });

  await activator.activate(profile);

  const eventPayload = {
    systemPromptOptions: {
      customPrompt: "",
      appendSystemPrompt: "",
      promptGuidelines: ["Initial rule"],
    },
  };

  await triggerBeforeAgentStart(eventPayload);

  assert.equal(eventPayload.systemPromptOptions.customPrompt, "You are a code reviewer.");
  assert.equal(eventPayload.systemPromptOptions.appendSystemPrompt, "Check for security.");
  assert.deepEqual(eventPayload.systemPromptOptions.promptGuidelines, [
    "Initial rule",
    "Be concise.",
    "Verify types.",
  ]);
});

test("AgentActivator switches cleanly between profiles", async () => {
  const { pi, state } = createMockPi();
  const activator = new AgentActivator(pi);

  const profile1 = createTestProfile({
    id: "p1",
    label: "P1",
    description: "First",
    allowedTools: Object.freeze(["read", "bash"]),
    mcpServers: Object.freeze({ serverA: { command: "a" } }),
  });

  const profile2 = createTestProfile({
    id: "p2",
    label: "P2",
    description: "Second",
    allowedTools: Object.freeze(["edit", "write"]),
    mcpServers: Object.freeze({ serverB: { command: "b" } }),
  });

  await activator.activate(profile1);
  assert.deepEqual(state.activeTools, ["read", "bash"]);
  assert.equal(state.thinkingLevel, "medium");
  assert.equal(state.mcpServers.has("serverA"), true);

  // Switch to profile2
  await activator.activate(profile2);
  assert.deepEqual(state.activeTools, ["edit", "write"]);
  assert.equal(state.thinkingLevel, "medium");
  assert.equal(state.mcpServers.has("serverA"), false); // Cleaned up
  assert.equal(state.mcpServers.has("serverB"), true);
});

test("AgentActivator rolls back previous state on activation failure", async () => {
  const { pi, state } = createMockPi();
  const activator = new AgentActivator(pi);

  const initialProfile = createTestProfile({
    id: "stable",
    label: "Stable",
    description: "Initial stable",
    allowedTools: Object.freeze(["read"]),
    mcpServers: Object.freeze({ stableMcp: { command: "s" } }),
  });

  await activator.activate(initialProfile);
  assert.deepEqual(state.activeTools, ["read"]);
  assert.equal(state.thinkingLevel, "medium");

  const failingProfile = createTestProfile({
    id: "broken",
    label: "Broken",
    description: "Triggers error",
    allowedTools: Object.freeze(["edit"]),
  });

  // Poison setActiveTools on the second invocation
  const originalSetActiveTools = pi.setActiveTools;
  let callCount = 0;
  pi.setActiveTools = (tools: string[]) => {
    callCount++;
    if (callCount === 1) {
      throw new Error("Simulated permission error in setActiveTools");
    }
    originalSetActiveTools(tools);
  };

  await assert.rejects(async () => {
    await activator.activate(failingProfile);
  }, (err: unknown) => {
    assert.equal(err instanceof AgentActivationError, true);
    assert.equal((err as AgentActivationError).rollbackSuccessful, true);
    return true;
  });

  // State should be rolled back to initialProfile
  assert.deepEqual(state.activeTools, ["read"]);
  assert.equal(state.thinkingLevel, "medium");
  assert.strictEqual(activator.activeAgent, initialProfile);
});

for (const row of [
  { name: "inactive tools stay inactive", initial: ["bash", "read"], switches: 1, fail: false },
  { name: "empty baseline survives switching", initial: [], switches: 2, fail: false },
  { name: "original baseline survives switching", initial: ["bash"], switches: 2, fail: false },
  { name: "first activation failure restores tools", initial: ["bash"], switches: 0, fail: true },
  { name: "failed switch preserves original baseline", initial: ["bash"], switches: 1, fail: true },
]) {
  test(`AgentActivator restores baseline: ${row.name}`, async () => {
    const { pi, state } = createMockPi({ activeTools: [...row.initial] });
    const activator = new AgentActivator(pi);
    const profile = createTestProfile({
      id: "tools", label: "Tools", description: "Tool policy",
      allowedTools: ["edit"],
    });

    try {
      for (let i = 0; i < row.switches; i++) {
        await activator.activate({ ...profile, id: `tools-${i}`, allowedTools: i ? ["write"] : ["edit"] });
        assert.deepEqual(state.activeTools, i ? ["write"] : ["edit"]);
      }

      if (row.fail) {
        const priorTools = [...state.activeTools];
        const registerMcpServer = pi.registerMcpServer;
        pi.registerMcpServer = () => {
          pi.registerMcpServer = registerMcpServer;
          throw new Error("MCP registration failed");
        };
        await assert.rejects(
          activator.activate({ ...profile, mcpServers: { failing: { command: "broken" } } }),
          (error: unknown) => {
            assert.ok(error instanceof AgentActivationError);
            assert.match(error.message, /MCP registration failed/);
            assert.equal(error.rollbackSuccessful, true);
            return true;
          },
        );
        assert.deepEqual(state.activeTools, priorTools);
      }

      activator.deactivate();
      assert.deepEqual(state.activeTools, row.initial);
      assert.equal(activator.activeAgent, undefined);

      // A new activation interval owns a fresh baseline.
      state.activeTools = ["write"];
      await activator.activate(profile);
      activator.deactivate();
      assert.deepEqual(state.activeTools, ["write"]);
    } finally {
      activator.dispose();
    }
  });
}

test("profile lifecycle never reads, changes, or restores runtime thinking", async (t) => {
  for (const level of ["off", "medium", "high"] as const) {
    await t.test(level, async (t) => {
      const { pi, state } = createMockPi({ thinkingLevel: level });
      const activator = new AgentActivator(pi);
      t.after(() => activator.dispose());
      t.mock.method(pi, "getThinkingLevel", () => { throw new Error("Profile must not read thinking"); });
      t.mock.method(pi, "setThinkingLevel", () => { throw new Error("Profile must not set thinking"); });
      const profile = createTestProfile({ id: "first", label: "First", description: "First profile", allowedTools: ["read"] });

      await activator.activate(profile);
      assert.equal(state.thinkingLevel, level);
      state.thinkingLevel = "low";
      await activator.activate({ ...profile, id: "second", allowedTools: ["edit"] });
      assert.equal(state.thinkingLevel, "low");
      activator.deactivate();
      assert.equal(state.thinkingLevel, "low");
    });
  }
});

test("activation failure restores tools, MCP configurations, and the original prompt hook", async (t) => {
  for (const row of [
    { name: "initial hook registration", initial: false, fault: "hook", mutate: false, rollbackFailure: undefined },
    { name: "new MCP registration", initial: true, fault: "register", mutate: false, rollbackFailure: undefined },
    { name: "partial MCP registration", initial: true, fault: "register", mutate: true, rollbackFailure: undefined },
    { name: "MCP removal", initial: true, fault: "unregister", mutate: false, rollbackFailure: undefined },
    { name: "partial MCP removal", initial: true, fault: "unregister", mutate: true, rollbackFailure: undefined },
    { name: "tool application", initial: true, fault: "tools", mutate: true, rollbackFailure: undefined },
    { name: "MCP rollback failure is reported", initial: true, fault: "register", mutate: false, rollbackFailure: "register" },
    { name: "tool rollback failure still restores MCP", initial: true, fault: "register", mutate: false, rollbackFailure: "tools" },
  ]) {
    await t.test(row.name, async (t) => {
      const { pi, state, triggerBeforeAgentStart } = createMockPi();
      const activator = new AgentActivator(pi);
      t.after(() => activator.dispose());
      const initial = createTestProfile({
        id: "stable", label: "Stable", description: "Stable profile", allowedTools: ["read"],
        mcpServers: { serverA: { command: "server-a", args: ["old"] }, shared: { url: "https://old.example/mcp", headers: { token: "old" } } },
        systemPrompt: "Original role", appendPrompt: "Original appendix", promptGuidelines: ["Original guideline"],
      });
      if (row.initial) await activator.activate(initial);
      const priorTools = [...state.activeTools];
      const priorServers = [...state.mcpServers];
      const priorHooks = [...(state.eventHandlers.get("before_agent_start") ?? [])];
      let failed = false;
      const fail = () => { failed = true; throw new Error("Activation fault"); };
      const register = pi.registerMcpServer;
      t.mock.method(pi, "registerMcpServer", (name: string, config: Parameters<ExtensionAPI["registerMcpServer"]>[1]) => {
        if (failed && row.rollbackFailure === "register" && name === "serverA") throw new Error("MCP rollback fault");
        if (!failed && row.fault === "register" && name === "serverB") {
          if (row.mutate) register(name, config);
          fail();
        }
        register(name, config);
      });
      const unregister = pi.unregisterMcpServer;
      t.mock.method(pi, "unregisterMcpServer", (name: string) => {
        if (!failed && row.fault === "unregister" && name === "serverA") {
          if (row.mutate) unregister(name);
          fail();
        }
        unregister(name);
      });
      const setTools = pi.setActiveTools;
      t.mock.method(pi, "setActiveTools", (tools: string[]) => {
        if (failed && row.rollbackFailure === "tools") throw new Error("Tool rollback fault");
        setTools(tools);
        if (!failed && row.fault === "tools") fail();
      });
      const on = pi.on;
      pi.on = ((...args: Parameters<typeof on>) => {
        if (row.fault === "hook") fail();
        return on(...args);
      }) as typeof on;
      t.after(() => { pi.on = on; });

      await assert.rejects(activator.activate(createTestProfile({
        id: "broken", label: "Broken", description: "Broken profile", allowedTools: ["edit"],
        mcpServers: { shared: { url: "https://new.example/mcp" }, serverB: { command: "server-b" } },
        systemPrompt: "New role", appendPrompt: "New appendix", promptGuidelines: ["New guideline"],
      })), (error: unknown) => {
        assert.ok(error instanceof AgentActivationError);
        assert.match(error.message, /Activation fault/);
        assert.equal(error.rollbackSuccessful, row.rollbackFailure === undefined);
        return true;
      });

      assert.equal(failed, true);
      assert.strictEqual(activator.activeAgent, row.initial ? initial : undefined);
      if (row.rollbackFailure !== "tools") assert.deepEqual(state.activeTools, priorTools);
      if (row.rollbackFailure !== "register") assert.deepEqual(new Map(state.mcpServers), new Map(priorServers));
      assert.deepEqual(state.eventHandlers.get("before_agent_start") ?? [], priorHooks);
      const event = await triggerBeforeAgentStart({ systemPromptOptions: { customPrompt: "Default role", appendSystemPrompt: "", promptGuidelines: [] } });
      assert.equal(event.systemPromptOptions.customPrompt, row.initial ? "Original role" : "Default role");
      assert.equal(event.systemPromptOptions.appendSystemPrompt, row.initial ? "Original appendix" : "");
      assert.deepEqual(event.systemPromptOptions.promptGuidelines, row.initial ? ["Original guideline"] : []);
    });
  }
});

test("successful profile switches keep one prompt hook using only the current profile", async (t) => {
  const { pi, state, triggerBeforeAgentStart } = createMockPi();
  const activator = new AgentActivator(pi);
  t.after(() => activator.dispose());
  for (const prompt of ["First", "Second", undefined, "Fourth"]) {
    await activator.activate(createTestProfile({ id: prompt ?? "no-prompt", label: "Profile", description: "Profile", systemPrompt: prompt }));
    assert.equal(state.eventHandlers.get("before_agent_start")?.length, 1);
    const event = await triggerBeforeAgentStart({ systemPromptOptions: { customPrompt: "Default" } });
    assert.equal(event.systemPromptOptions.customPrompt, prompt ?? "Default");
  }
  activator.deactivate();
  assert.equal(state.eventHandlers.get("before_agent_start")?.length, 0);
});

test("Runtime activates registered profiles end-to-end", async () => {
  const { pi, state } = createMockPi();
  const runtime = init(pi);

  try {
    runtime.registerAgent({
      id: "agent:dev",
      label: "Dev",
      description: "Developer profile",
      tools: { allow: ["read", "edit"] },
    });

    await runtime.activateAgent("agent:dev");

    const active = runtime.getActiveAgent();
    assert.equal(active?.id, "agent:dev");
    assert.deepEqual(state.activeTools, ["read", "edit"]);
    assert.equal(state.thinkingLevel, "medium");
  } finally {
    await runtime.dispose();
  }
});
