import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ResolvedAgent } from "../src/core/resolver.ts";

export type AssistantMessage = Extract<Extract<AgentSessionEvent, { type: "message_end" }>["message"], { role: "assistant" }>;

export function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Done" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: {
      input: 11, output: 7, cacheRead: 5, cacheWrite: 3, totalTokens: 26,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
    },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

export function agent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    id: "test:worker", label: "Worker", description: "Test worker",
    promptGuidelines: [], deniedTools: [], deniedSkills: [], mcpServers: {},
    subagents: { maxDepth: 2, maxConcurrent: 2 },
    supervision: { wakeOn: new Set() },
    ...overrides,
  };
}
