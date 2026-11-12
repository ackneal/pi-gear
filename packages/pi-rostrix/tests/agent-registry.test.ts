import assert from "node:assert/strict";
import test from "node:test";
import { AgentRegistry, AgentValidationError, type AgentDefinition } from "../src/index.ts";

test("AgentRegistry registers and retrieves minimal valid profile", () => {
  const registry = new AgentRegistry();
  const minimal: AgentDefinition = {
    id: "minimal",
    label: "Minimal Agent",
    description: "Performs basic actions",
  };

  registry.register(minimal);
  assert.equal(registry.has("minimal"), true);
  assert.deepEqual(registry.get("minimal"), minimal);
  assert.equal(registry.list().length, 1);
});

test("AgentRegistry registers fully configured profile with all sections", () => {
  const registry = new AgentRegistry();
  const full: AgentDefinition = {
    id: "gear:worker",
    label: "Worker Agent",
    description: "Executes bounded implementation tasks",
    extends: "base",
    prompt: {
      systemPrompt: "You are a senior engineer.",
      appendPrompt: "Focus on surgical changes.",
      guidelines: ["Verify before modifying.", "Follow coding principles."],
    },
    tools: {
      allow: ["read", "edit", "write", "bash"],
      deny: ["dangerous_*"],
    },
    mcpServers: {
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "token" },
        timeout: 15,
      },
    },
    skills: {
      allow: ["coding-principles", "git-workflow"],
      deny: ["destructive-tools"],
    },
    model: {
      preferred: "anthropic/claude-sonnet-4-5",
      fallback: "anthropic/claude-haiku-3-5",
    },
    subagents: {
      allowedAgents: ["gear:researcher", "gear:reviewer"],
      maxDepth: 2,
      maxConcurrent: 3,
    },
    supervision: {
      wakeOn: ["completed", "failed", "needs_input"],
      reviewIntervalSeconds: 300,
      maxDurationSeconds: 1800,
    },
  };

  registry.register(full);
  assert.equal(registry.has("gear:worker"), true);
  const retrieved = registry.get("gear:worker");
  assert.deepEqual(retrieved, full);
  // Profile returned should be frozen
  assert.equal(Object.isFrozen(retrieved), true);
});

test("AgentRegistry rejects invalid definitions with AgentValidationError", () => {
  const registry = new AgentRegistry();

  // Missing id
  assert.throws(() => {
    registry.register({ label: "Missing ID", description: "No ID" } as any);
  }, (err: unknown) => err instanceof AgentValidationError && err.errors.some((e) => e.message.includes("id")));

  // Empty string id
  assert.throws(() => {
    registry.register({ id: "", label: "Empty ID", description: "Empty ID" });
  }, AgentValidationError);

  // Missing description
  assert.throws(() => {
    registry.register({ id: "agent", label: "Agent" } as any);
  }, AgentValidationError);

  // Invalid preferred model
  assert.throws(() => {
    registry.register({
      id: "agent",
      label: "Agent",
      description: "Test",
      model: { preferred: 42 as any },
    });
  }, AgentValidationError);

  // Negative maxDepth
  assert.throws(() => {
    registry.register({
      id: "agent",
      label: "Agent",
      description: "Test",
      subagents: { maxDepth: -1 },
    });
  }, AgentValidationError);

  // Zero maxConcurrent (minimum is 1)
  assert.throws(() => {
    registry.register({
      id: "agent",
      label: "Agent",
      description: "Test",
      subagents: { maxConcurrent: 0 },
    });
  }, AgentValidationError);

  // Non-object
  assert.throws(() => {
    registry.register(null as any);
  }, AgentValidationError);
});

test("AgentRegistry rejects duplicate registration with Error", () => {
  const registry = new AgentRegistry();
  const profile: AgentDefinition = { id: "p1", label: "P1", description: "First" };

  registry.register(profile);
  assert.throws(() => {
    registry.register({ id: "p1", label: "Duplicate", description: "Second" });
  }, /already registered/);
});

test("AgentRegistry unregister, list, and clear manage lifecycle", () => {
  const registry = new AgentRegistry();
  registry.register({ id: "p1", label: "P1", description: "Desc 1" });
  registry.register({ id: "p2", label: "P2", description: "Desc 2" });

  assert.equal(registry.list().length, 2);
  assert.equal(registry.unregister("p1"), true);
  assert.equal(registry.has("p1"), false);
  assert.equal(registry.unregister("p1"), false);
  assert.equal(registry.list().length, 1);

  registry.clear();
  assert.equal(registry.list().length, 0);
  assert.equal(registry.has("p2"), false);
});
