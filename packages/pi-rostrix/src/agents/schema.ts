import { type Static, Type } from "typebox";

export const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

export const ExtensionInheritModeSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("user"),
  Type.Literal("all"),
]);
export type ExtensionInheritMode = Static<typeof ExtensionInheritModeSchema>;

export const ContextInheritModeSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("user"),
  Type.Literal("project"),
  Type.Literal("all"),
]);
export type ContextInheritMode = Static<typeof ContextInheritModeSchema>;

export const AgentPromptSchema = Type.Object({
  systemPrompt: Type.Optional(Type.String({ description: "Base system prompt or prefix" })),
  appendPrompt: Type.Optional(Type.String({ description: "Appended system instructions" })),
  guidelines: Type.Optional(Type.Array(Type.String(), { description: "Additional rules appended to prompt guidelines" })),
  inheritSystemPrompt: Type.Optional(ContextInheritModeSchema),
  inheritAppendSystemPrompt: Type.Optional(ContextInheritModeSchema),
});
export type AgentPrompt = Static<typeof AgentPromptSchema>;

export const AgentToolsSchema = Type.Object({
  allow: Type.Optional(Type.Array(Type.String(), { description: "Allowlist of tool names or wildcard patterns" })),
  deny: Type.Optional(Type.Array(Type.String(), { description: "Denylist of tool names or wildcard patterns (takes precedence over allow)" })),
});
export type AgentTools = Static<typeof AgentToolsSchema>;

export const AgentMcpServerSchema = Type.Object({
  command: Type.Optional(Type.String()),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  cwd: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  timeout: Type.Optional(Type.Number({ minimum: 0 })),
  exposure: Type.Optional(Type.Union([
    Type.Literal("direct"),
    Type.Literal("model-only"),
    Type.Literal("codemode"),
    Type.Literal("deferred"),
    Type.Literal("hidden"),
  ])),
  toolExposure: Type.Optional(Type.Record(Type.String(), Type.Union([
    Type.Literal("direct"),
    Type.Literal("model-only"),
    Type.Literal("codemode"),
    Type.Literal("deferred"),
    Type.Literal("hidden"),
  ]))),
  enabled: Type.Optional(Type.Boolean()),
});
export type AgentMcpServer = Static<typeof AgentMcpServerSchema>;

export const AgentSkillsSchema = Type.Object({
  inherit: Type.Optional(ExtensionInheritModeSchema),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Additional skill file or directory paths to load in the subagent",
  })),
  exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Skill file or directory paths to exclude from inherited or explicit paths",
  })),
  allow: Type.Optional(Type.Array(Type.String())),
  deny: Type.Optional(Type.Array(Type.String())),
});
export type AgentSkills = Static<typeof AgentSkillsSchema>;

export const AgentModelSchema = Type.Object({
  preferred: Type.Optional(Type.String({ description: "Preferred model identifier (e.g. anthropic/claude-sonnet-4-5)" })),
  fallback: Type.Optional(Type.String({ description: "Fallback model identifier" })),
});
export type AgentModel = Static<typeof AgentModelSchema>;

export const AgentSubagentsSchema = Type.Object({
  allowedAgents: Type.Optional(Type.Array(Type.String(), { description: "Agents this agent is permitted to delegate to" })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum nested delegation depth (default 2)" })),
  maxConcurrent: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum active tasks for this agent ID (default 2)" })),
});
export type AgentSubagents = Static<typeof AgentSubagentsSchema>;

export const SupervisionWakeTriggerSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("stalled"),
  Type.Literal("needs_input"),
]);
export type SupervisionWakeTrigger = Static<typeof SupervisionWakeTriggerSchema>;

export const AgentSupervisionSchema = Type.Object({
  wakeOn: Type.Optional(Type.Array(SupervisionWakeTriggerSchema, {
    description: "Events that wake the parent. Inherited triggers are combined; no resolved triggers disables automatic wake-ups. Results remain queryable. needs_input is reserved and is not emitted by the current runtime.",
  })),
  reviewIntervalSeconds: Type.Optional(Type.Number({ minimum: 1 })),
  maxDurationSeconds: Type.Optional(Type.Number({ minimum: 1 })),
});
export type AgentSupervision = Static<typeof AgentSupervisionSchema>;

export const AgentContextFilesSchema = Type.Object({
  inherit: Type.Optional(ContextInheritModeSchema),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Additional context file or directory paths (AGENTS.md / CLAUDE.md) to load in the subagent",
  })),
  exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Context file or directory paths to exclude from inherited or explicit paths",
  })),
});
export type AgentContextFiles = Static<typeof AgentContextFilesSchema>;

export const AgentPromptTemplatesSchema = Type.Object({
  inherit: Type.Optional(ExtensionInheritModeSchema),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Additional prompt template file or directory paths to load in the subagent",
  })),
  exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Prompt template file or directory paths to exclude from inherited or explicit paths",
  })),
  allow: Type.Optional(Type.Array(Type.String())),
  deny: Type.Optional(Type.Array(Type.String())),
});
export type AgentPromptTemplates = Static<typeof AgentPromptTemplatesSchema>;

export const AgentExtensionsSchema = Type.Object({
  inherit: Type.Optional(ExtensionInheritModeSchema),
  paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Additional extension file or directory paths to load in the subagent",
  })),
  exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: "Extension file or directory paths to exclude from inherited or explicit paths",
  })),
});
export type AgentExtensions = Static<typeof AgentExtensionsSchema>;

export const AgentDefinitionSchema = Type.Object({
  id: Type.String({ minLength: 1, description: "Unique identifier for this agent (e.g. 'worker' or 'gear:worker')" }),
  label: Type.String({ minLength: 1, description: "Human-readable display label" }),
  description: Type.String({ minLength: 1, description: "Description for the model when selecting an agent" }),
  extends: Type.Optional(Type.String({ minLength: 1, description: "Parent agent ID for inheritance" })),
  prompt: Type.Optional(AgentPromptSchema),
  contextFiles: Type.Optional(AgentContextFilesSchema),
  tools: Type.Optional(AgentToolsSchema),
  mcpServers: Type.Optional(Type.Record(Type.String(), AgentMcpServerSchema)),
  skills: Type.Optional(AgentSkillsSchema),
  promptTemplates: Type.Optional(AgentPromptTemplatesSchema),
  model: Type.Optional(AgentModelSchema),
  subagents: Type.Optional(AgentSubagentsSchema),
  supervision: Type.Optional(AgentSupervisionSchema),
  extensions: Type.Optional(AgentExtensionsSchema),
});
export type AgentDefinition = Static<typeof AgentDefinitionSchema>;

