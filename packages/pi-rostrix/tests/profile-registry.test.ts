import assert from "node:assert/strict";
import test from "node:test";
import { ProfileRegistry, ProfileValidationError, type ProfileDefinition } from "../src/index.ts";

test("ProfileRegistry registers and retrieves minimal valid profile", () => {
  const registry = new ProfileRegistry();
  const minimal: ProfileDefinition = {
    id: "minimal",
    label: "Minimal Agent",
    description: "Performs basic actions",
  };

  registry.register(minimal);
  assert.equal(registry.has("minimal"), true);
  assert.deepEqual(registry.get("minimal"), minimal);
  assert.equal(registry.list().length, 1);
});

test("ProfileRegistry registers fully configured profile with all sections", () => {
  const registry = new ProfileRegistry();
  const full: ProfileDefinition = {
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
      allowedProfiles: ["gear:researcher", "gear:reviewer"],
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

test("ProfileRegistry rejects invalid definitions with ProfileValidationError", () => {
  const registry = new ProfileRegistry();

  // Missing id
  assert.throws(() => {
    registry.register({ label: "Missing ID", description: "No ID" } as any);
  }, (err: unknown) => err instanceof ProfileValidationError && err.errors.some((e) => e.message.includes("id")));

  // Empty string id
  assert.throws(() => {
    registry.register({ id: "", label: "Empty ID", description: "Empty ID" });
  }, ProfileValidationError);

  // Missing description
  assert.throws(() => {
    registry.register({ id: "agent", label: "Agent" } as any);
  }, ProfileValidationError);

  // Invalid preferred model
  assert.throws(() => {
    registry.register({
      id: "agent",
      label: "Agent",
      description: "Test",
      model: { preferred: 42 as any },
    });
  }, ProfileValidationError);

  // Negative maxDepth
  assert.throws(() => {
    registry.register({
      id: "agent",
      label: "Agent",
      description: "Test",
      subagents: { maxDepth: -1 },
    });
  }, ProfileValidationError);

  // Zero maxConcurrent (minimum is 1)
  assert.throws(() => {
    registry.register({
      id: "agent",
      label: "Agent",
      description: "Test",
      subagents: { maxConcurrent: 0 },
    });
  }, ProfileValidationError);

  // Non-object
  assert.throws(() => {
    registry.register(null as any);
  }, ProfileValidationError);
});

test("ProfileRegistry rejects duplicate registration with Error", () => {
  const registry = new ProfileRegistry();
  const profile: ProfileDefinition = { id: "p1", label: "P1", description: "First" };

  registry.register(profile);
  assert.throws(() => {
    registry.register({ id: "p1", label: "Duplicate", description: "Second" });
  }, /already registered/);
});

test("ProfileRegistry unregister, list, and clear manage lifecycle", () => {
  const registry = new ProfileRegistry();
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
