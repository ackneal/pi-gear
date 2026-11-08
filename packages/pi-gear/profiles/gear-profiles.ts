import type { ProfileDefinition } from "pi-rostrix";
import { WORKER_SYSTEM_PROMPT } from "../subagents/agents/worker/prompt.ts";
import { RESEARCHER_SYSTEM_PROMPT } from "../subagents/agents/researcher/prompt.ts";
import { REVIEWER_SYSTEM_PROMPT } from "../subagents/agents/reviewer/prompt.ts";

export const GEAR_WORKER_PROFILE: ProfileDefinition = {
  id: "gear:worker",
  label: "Gear Worker",
  description: "Bounded worker subagent for parallel execution with targetFiles scopes.",
  prompt: {
    systemPrompt: WORKER_SYSTEM_PROMPT,
  },
  tools: {
    allow: ["read", "find", "grep", "edit", "write", "bash", "fff_*"],
  },
  subagents: {
    maxDepth: 1,
    maxConcurrent: 4,
  },
  supervision: {
    wakeOn: ["completed", "failed"],
  },
};

export const GEAR_RESEARCHER_PROFILE: ProfileDefinition = {
  id: "gear:researcher",
  label: "Gear Researcher",
  description: "Focused read-only researcher for workspace, GitHub and web search.",
  prompt: {
    systemPrompt: RESEARCHER_SYSTEM_PROMPT,
  },
  tools: {
    allow: ["read", "find", "grep", "fff_*", "github_*", "exa_*"],
  },
  subagents: {
    maxDepth: 1,
    maxConcurrent: 2,
  },
  supervision: {
    wakeOn: ["completed", "failed"],
  },
};

export const GEAR_REVIEWER_PROFILE: ProfileDefinition = {
  id: "gear:reviewer",
  label: "Gear Reviewer",
  description: "Focused read-only code reviewer.",
  prompt: {
    systemPrompt: REVIEWER_SYSTEM_PROMPT,
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
    wakeOn: ["completed", "failed"],
  },
};

export const ALL_GEAR_PROFILES = [
  GEAR_WORKER_PROFILE,
  GEAR_RESEARCHER_PROFILE,
  GEAR_REVIEWER_PROFILE,
] as const;
