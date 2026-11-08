import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ProfileActivationError,
  ProfileActivator,
  initRostrix,
  type ResolvedProfile,
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

function createTestProfile(overrides: Partial<ResolvedProfile> & { id: string; label: string; description: string }): ResolvedProfile {
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

test("ProfileActivator activates profile tools, thinking level, and MCP servers", async () => {
  const { pi, state } = createMockPi();
  const activator = new ProfileActivator(pi);

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
    model: Object.freeze({ thinkingLevel: "high" }),
  });

  await activator.activate(profile);

  assert.strictEqual(activator.activeProfile, profile);
  // Allowed tools: read, lsp_find, lsp_diag (edit/write allowed, but write is denied)
  assert.deepEqual(state.activeTools.sort(), ["edit", "lsp_diag", "lsp_find", "read"].sort());
  assert.equal(state.thinkingLevel, "high");
  assert.equal(state.mcpServers.has("github"), true);
});

test("ProfileActivator before_agent_start hook injects guidelines and prompts", async () => {
  const { pi, triggerBeforeAgentStart } = createMockPi();
  const activator = new ProfileActivator(pi);

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

test("ProfileActivator switches cleanly between profiles", async () => {
  const { pi, state } = createMockPi();
  const activator = new ProfileActivator(pi);

  const profile1 = createTestProfile({
    id: "p1",
    label: "P1",
    description: "First",
    allowedTools: Object.freeze(["read", "bash"]),
    mcpServers: Object.freeze({ serverA: { command: "a" } }),
    model: Object.freeze({ thinkingLevel: "low" }),
  });

  const profile2 = createTestProfile({
    id: "p2",
    label: "P2",
    description: "Second",
    allowedTools: Object.freeze(["edit", "write"]),
    mcpServers: Object.freeze({ serverB: { command: "b" } }),
    model: Object.freeze({ thinkingLevel: "high" }),
  });

  await activator.activate(profile1);
  assert.deepEqual(state.activeTools, ["read", "bash"]);
  assert.equal(state.thinkingLevel, "low");
  assert.equal(state.mcpServers.has("serverA"), true);

  // Switch to profile2
  await activator.activate(profile2);
  assert.deepEqual(state.activeTools, ["edit", "write"]);
  assert.equal(state.thinkingLevel, "high");
  assert.equal(state.mcpServers.has("serverA"), false); // Cleaned up
  assert.equal(state.mcpServers.has("serverB"), true);
});

test("ProfileActivator rolls back previous state on activation failure", async () => {
  const { pi, state } = createMockPi();
  const activator = new ProfileActivator(pi);

  const initialProfile = createTestProfile({
    id: "stable",
    label: "Stable",
    description: "Initial stable",
    allowedTools: Object.freeze(["read"]),
    mcpServers: Object.freeze({ stableMcp: { command: "s" } }),
    model: Object.freeze({ thinkingLevel: "medium" }),
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
    assert.equal(err instanceof ProfileActivationError, true);
    assert.equal((err as ProfileActivationError).rollbackSuccessful, true);
    return true;
  });

  // State should be rolled back to initialProfile
  assert.deepEqual(state.activeTools, ["read"]);
  assert.equal(state.thinkingLevel, "medium");
  assert.strictEqual(activator.activeProfile, initialProfile);
});

test("RostrixRuntime activates registered profiles end-to-end", async () => {
  const { pi, state } = createMockPi();
  const runtime = initRostrix(pi);

  try {
    runtime.registerProfile({
      id: "agent:dev",
      label: "Dev",
      description: "Developer profile",
      tools: { allow: ["read", "edit"] },
      model: { thinkingLevel: "high" },
    });

    await runtime.activateProfile("agent:dev");

    const active = runtime.getActiveProfile();
    assert.equal(active?.id, "agent:dev");
    assert.deepEqual(state.activeTools, ["read", "edit"]);
    assert.equal(state.thinkingLevel, "high");
  } finally {
    runtime.dispose();
  }
});
