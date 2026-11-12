import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentInheritanceError,
  AgentRegistry,
  AgentResolver,
  matchesPattern,
  isAgentToolAllowed,
  type AgentDefinition,
} from "../src/index.ts";

test("matchesPattern handles exact, wildcard, and prefix patterns", () => {
  assert.equal(matchesPattern("read", "read"), true);
  assert.equal(matchesPattern("read", "write"), false);
  assert.equal(matchesPattern("read", "*"), true);
  assert.equal(matchesPattern("lsp_definitions", "lsp_*"), true);
  assert.equal(matchesPattern("lsp_diagnostics", "lsp_*"), true);
  assert.equal(matchesPattern("bash", "lsp_*"), false);
  assert.equal(matchesPattern("mcp__server__tool", "mcp__*"), true);
});

test("AgentResolver resolves single profile without inheritance", () => {
  const registry = new AgentRegistry();
  registry.register({
    id: "standalone",
    label: "Standalone Agent",
    description: "No inheritance",
    prompt: {
      systemPrompt: "Base prompt",
      guidelines: ["Rule 1"],
    },
    tools: {
      allow: ["read", "bash"],
      deny: ["edit"],
    },
    model: {
      preferred: "anthropic/claude-sonnet-4-5",
    },
  });

  const resolver = new AgentResolver(registry);
  const resolved = resolver.resolve("standalone");

  assert.equal(resolved.id, "standalone");
  assert.equal(resolved.systemPrompt, "Base prompt");
  assert.deepEqual(resolved.promptGuidelines, ["Rule 1"]);
  assert.deepEqual(resolved.allowedTools, ["read", "bash"]);
  assert.deepEqual(resolved.deniedTools, ["edit"]);
  assert.equal(resolved.model?.preferred, "anthropic/claude-sonnet-4-5");
});

test("AgentResolver resolves multi-level inheritance chain with correct merging", () => {
  const registry = new AgentRegistry();

  const base: AgentDefinition = {
    id: "base",
    label: "Base Agent",
    description: "Root capabilities",
    prompt: {
      systemPrompt: "Base system prompt",
      guidelines: ["Base rule 1"],
    },
    tools: {
      allow: ["read", "edit", "write", "bash", "lsp_*"],
      deny: ["bash_rm"],
    },
    model: {
      preferred: "anthropic/claude-haiku-3-5",
      fallback: "openai/gpt-4o-mini",
    },
    subagents: {
      allowedProfiles: ["researcher", "reviewer"],
      maxDepth: 3,
      maxConcurrent: 4,
    },
    supervision: {
      wakeOn: ["completed", "failed"],
      reviewIntervalSeconds: 600,
      maxDurationSeconds: 3600,
    },
  };

  const codingAgent: AgentDefinition = {
    id: "coding",
    extends: "base",
    label: "Coding Agent",
    description: "Specialized for coding",
    prompt: {
      systemPrompt: "Specialized coding prompt",
      appendPrompt: "Code surgically.",
      guidelines: ["Coding rule 2"],
    },
    tools: {
      allow: ["read", "edit", "write", "lsp_*"],
      deny: ["write_temp"],
    },
    model: {
      preferred: "anthropic/claude-sonnet-4-5",
    },
    subagents: {
      maxDepth: 2,
    },
    supervision: {
      wakeOn: ["needs_input"],
      reviewIntervalSeconds: 300,
    },
  };

  registry.register(base);
  registry.register(codingAgent);

  const resolver = new AgentResolver(registry);
  const resolved = resolver.resolve("coding");

  assert.equal(resolved.id, "coding");
  assert.equal(resolved.systemPrompt, "Specialized coding prompt");
  assert.equal(resolved.appendPrompt, "Code surgically.");
  assert.deepEqual(resolved.promptGuidelines, ["Base rule 1", "Coding rule 2"]);

  // Tools: Child allow intersected with parent allow
  assert.deepEqual(resolved.allowedTools, ["read", "edit", "write", "lsp_*"]);
  assert.deepEqual(resolved.deniedTools, ["bash_rm", "write_temp"]);

  // Model: preferred overridden, fallback inherited
  assert.equal(resolved.model?.preferred, "anthropic/claude-sonnet-4-5");
  assert.equal(resolved.model?.fallback, "openai/gpt-4o-mini");

  // Subagents: maxDepth min(3, 2) = 2, maxConcurrent = 4, allowedProfiles inherited
  assert.equal(resolved.subagents.maxDepth, 2);
  assert.equal(resolved.subagents.maxConcurrent, 4);
  assert.deepEqual(resolved.subagents.allowedProfiles, ["researcher", "reviewer"]);

  // Supervision: wakeOn union, reviewInterval min(600, 300) = 300, maxDuration inherited
  assert.equal(resolved.supervision.wakeOn.has("completed"), true);
  assert.equal(resolved.supervision.wakeOn.has("failed"), true);
  assert.equal(resolved.supervision.wakeOn.has("needs_input"), true);
  assert.equal(resolved.supervision.reviewIntervalSeconds, 300);
  assert.equal(resolved.supervision.maxDurationSeconds, 3600);
});

test("AgentResolver detects circular inheritance and throws AgentInheritanceError", () => {
  const registry = new AgentRegistry();
  registry.register({ id: "loopA", extends: "loopB", label: "A", description: "A" });
  registry.register({ id: "loopB", extends: "loopC", label: "B", description: "B" });
  registry.register({ id: "loopC", extends: "loopA", label: "C", description: "C" });

  const resolver = new AgentResolver(registry);
  assert.throws(() => {
    resolver.resolve("loopA");
  }, AgentInheritanceError);

  // Self loop
  registry.register({ id: "self", extends: "self", label: "Self", description: "Self" });
  assert.throws(() => {
    resolver.resolve("self");
  }, AgentInheritanceError);
});

test("AgentResolver throws when parent profile is not in registry", () => {
  const registry = new AgentRegistry();
  registry.register({ id: "orphan", extends: "missing_parent", label: "Orphan", description: "No parent" });

  const resolver = new AgentResolver(registry);
  assert.throws(() => {
    resolver.resolve("orphan");
  }, /not found in registry/);
});

test("AgentResolver enforces ParentDelegationLimits capability containment", () => {
  const registry = new AgentRegistry();
  registry.register({
    id: "untrusted_child",
    label: "Child",
    description: "Child asking for wide access",
    tools: {
      allow: ["read", "write", "bash", "network_call"],
    },
    subagents: {
      allowedProfiles: ["agentA", "agentB", "agentC"],
      maxDepth: 3,
    },
  });

  const resolver = new AgentResolver(registry);

  // Parent only has read and bash active
  const resolved = resolver.resolve("untrusted_child", {
    activeTools: ["read", "bash"],
    allowedProfiles: ["agentA"],
    currentDepth: 1,
  });

  // Write and network_call are strictly stripped because parent doesn't have them
  assert.deepEqual(resolved.allowedTools, ["read", "bash"]);

  // Subagents allowed profiles constrained to intersection with parent allowed profiles
  assert.deepEqual(resolved.subagents.allowedProfiles, ["agentA"]);

  // Max depth decremented by parent's current depth
  assert.equal(resolved.subagents.maxDepth, 2);
});


test("tool inheritance preserves complete glob conjunction and concrete parent limits", () => {
  for (const row of [
    { base: ["*"], child: ["prefix*"], deny: [], names: ["prefixsuffix", "other"], expected: [true, false] },
    { base: ["prefix*"], child: ["*"], deny: [], names: ["prefixsuffix", "other"], expected: [true, false] },
    { base: ["prefix*"], child: ["prefixnarrow*"], deny: [], names: ["prefixnarrowtool", "prefixother"], expected: [true, false] },
    { base: ["prefixnarrow*"], child: ["prefix*"], deny: [], names: ["prefixnarrowtool", "prefixother"], expected: [true, false] },
    { base: ["prefix*"], child: ["*suffix"], deny: [], names: ["prefixsuffix", "prefixother", "othersuffix"], expected: [true, false, false] },
    { base: ["*suffix"], child: ["prefix*"], deny: ["prefixbad*"], names: ["prefixsuffix", "prefixbadsuffix", "prefixother"], expected: [true, false, false] },
    { base: ["*"], child: [], deny: [], names: ["read"], expected: [false] },
    { base: ["prefix*"], child: ["*suffix"], deny: ["prefixbad*"], parent: ["prefixsuffix", "prefixbadsuffix", "prefixother"], names: ["prefixsuffix", "prefixbadsuffix", "prefixother", "prefixnewsuffix"], expected: [true, false, false, false] },
    { base: ["*"], child: ["*"], deny: [], parent: [], names: ["read"], expected: [false] },
    { base: ["*"], child: ["*"], deny: [], parent: ["literal*"], names: ["literal*", "literalname"], expected: [true, false] },
  ]) {
    const registry = new AgentRegistry();
    registry.register({ id: "base", label: "Base", description: "Base policy", tools: { allow: row.base, deny: row.deny } });
    registry.register({ id: "child", label: "Child", description: "Child policy", extends: "base", tools: { allow: row.child } });
    const resolved = new AgentResolver(registry).resolve("child", { activeTools: row.parent });
    assert.deepEqual(row.names.map((name) => isAgentToolAllowed(name, resolved)), row.expected, JSON.stringify(row));
    if (row.parent) assert.deepEqual(resolved.allowedTools, row.parent.filter((name) => isAgentToolAllowed(name, resolved)));
  }
});

test("parent currentDepth subtracts from inherited maxDepth and clamps at zero", () => {
  for (const [currentDepth, expected] of [[undefined, 3], [0, 3], [1, 2], [3, 0], [4, 0]] as const) {
    const registry = new AgentRegistry();
    registry.register({ id: "agent", label: "Agent", description: "Depth policy", subagents: { maxDepth: 3 } });
    assert.equal(new AgentResolver(registry).resolve("agent", { currentDepth }).subagents.maxDepth, expected);
  }
});
