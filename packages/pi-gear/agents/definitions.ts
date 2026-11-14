import type { AgentDefinition } from "pi-rostrix";
import { WORKER_SYSTEM_PROMPT } from "../subagents/agents/worker/prompt.ts";
import { RESEARCHER_SYSTEM_PROMPT } from "../subagents/agents/researcher/prompt.ts";
import { REVIEWER_SYSTEM_PROMPT } from "../subagents/agents/reviewer/prompt.ts";

export const WORKER_DEFINITION: AgentDefinition = {
  id: "gear:worker",
  label: "Gear Worker",
  description: "Bounded worker subagent for parallel execution with targetFiles scopes.",
  prompt: {
    inheritSystemPrompt: "all",
    appendPrompt: WORKER_SYSTEM_PROMPT,
  },
  contextFiles: {
    inherit: "all",
  },
  skills: {
    inherit: "user",
  },
  tools: {
    allow: ["read", "find", "grep", "edit", "write", "bash", "fff_*"],
  },
  subagents: {
    maxDepth: 1,
    maxConcurrent: 4,
  },
  supervision: {
    wakeOn: ["completed", "failed", "stalled"],
  },
  extensions: {
    inherit: "user",
  },
};

export const RESEARCHER_DEFINITION: AgentDefinition = {
  id: "gear:researcher",
  label: "Gear Researcher",
  description: "Focused read-only researcher for workspace, GitHub and web search.",
  prompt: {
    systemPrompt: RESEARCHER_SYSTEM_PROMPT,
  },
  contextFiles: {
    inherit: "user",
  },
  tools: {
    allow: ["read", "find", "grep", "fff_*", "github_*", "exa_*", "mcp__exa__*", "mcp__gh_grep__*"],
  },
  mcpServers: {
    exa: {
      url: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa",
      exposure: "hidden",
      toolExposure: {
        web_search_exa: "direct",
        web_fetch_exa: "direct",
      },
    },
    gh_grep: {
      url: "https://mcp.grep.app",
      exposure: "hidden",
      toolExposure: {
        searchGitHub: "direct",
      },
    },
  },
  subagents: {
    maxDepth: 1,
    maxConcurrent: 2,
  },
  supervision: {
    wakeOn: ["completed", "failed", "stalled"],
  },
  extensions: {
    inherit: "user",
  },
};

export const REVIEWER_DEFINITION: AgentDefinition = {
  id: "gear:reviewer",
  label: "Gear Reviewer",
  description: "Focused read-only code reviewer.",
  prompt: {
    inheritSystemPrompt: "all",
    appendPrompt: REVIEWER_SYSTEM_PROMPT,
  },
  contextFiles: {
    inherit: "all",
  },
  skills: {
    inherit: "user",
  },
  tools: {
    allow: ["read", "find", "grep", "bash", "fff_*"],
    deny: ["edit", "write"],
  },
  subagents: {
    maxDepth: 1,
    maxConcurrent: 2,
  },
  supervision: {
    wakeOn: ["completed", "failed", "stalled"],
  },
  extensions: {
    inherit: "user",
  },
};

export const BUILTIN_AGENT_DEFINITIONS = [
  WORKER_DEFINITION,
  RESEARCHER_DEFINITION,
  REVIEWER_DEFINITION,
] as const;
