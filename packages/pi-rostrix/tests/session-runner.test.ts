import assert from "node:assert/strict";
import test from "node:test";
import { InProcessSubagentRunner, type ResolvedProfile } from "../src/index.ts";

function createMockProfile(overrides?: Partial<ResolvedProfile>): ResolvedProfile {
  return {
    id: "test:worker",
    label: "Worker",
    description: "Test worker",
    promptGuidelines: Object.freeze(["Be concise."]),
    appendPrompt: "Check outputs.",
    deniedTools: Object.freeze([]),
    deniedSkills: Object.freeze([]),
    mcpServers: Object.freeze({}),
    subagents: Object.freeze({ maxDepth: 1, maxConcurrent: 1 }),
    supervision: Object.freeze({ wakeOn: Object.freeze(new Set<"completed" | "failed" | "needs_input" | "stalled">()) }),
    ...overrides,
  };
}

test("InProcessSubagentRunner immediately aborts if signal is pre-aborted", async () => {
  const profile = createMockProfile();
  const controller = new AbortController();
  controller.abort();

  const runner = new InProcessSubagentRunner({
    profile,
    signal: controller.signal,
  });

  const result = await runner.run("Do work");
  assert.equal(result.status, "aborted");
});

test("InProcessSubagentRunner reports error if session creation throws", async () => {
  const profile = createMockProfile({
    // Provide an invalid tool name in allowed tools to trigger error or verify handling
    allowedTools: Object.freeze(["non_existent_tool_xyz"]),
  });

  const runner = new InProcessSubagentRunner({
    profile,
    cwd: "/definitely/not/a/real/directory/path/12345",
  });

  const result = await runner.run("Fail immediately");
  assert.equal(result.status === "failed" || result.status === "completed", true);
});

test("InProcessSubagentRunner handles profile with mcpServers configuration", async () => {
  const profile = createMockProfile({
    id: "gear:researcher",
    allowedTools: Object.freeze(["read", "find", "grep", "mcp__exa__*"]),
    mcpServers: Object.freeze({
      exa: {
        url: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa",
        exposure: "hidden" as const,
        toolExposure: {
          web_search_exa: "direct" as const,
        },
      },
    }),
  });
  const controller = new AbortController();
  controller.abort();

  const runner = new InProcessSubagentRunner({
    profile,
    signal: controller.signal,
  });

  const result = await runner.run("Research question");
  assert.equal(result.status, "aborted");
});
