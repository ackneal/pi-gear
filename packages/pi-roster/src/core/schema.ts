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

export const ProfilePromptSchema = Type.Object({
  systemPrompt: Type.Optional(Type.String({ description: "Base system prompt or prefix" })),
  appendPrompt: Type.Optional(Type.String({ description: "Appended system instructions" })),
  guidelines: Type.Optional(Type.Array(Type.String(), { description: "Additional rules appended to prompt guidelines" })),
});
export type ProfilePrompt = Static<typeof ProfilePromptSchema>;

export const ProfileToolsSchema = Type.Object({
  allow: Type.Optional(Type.Array(Type.String(), { description: "Allowlist of tool names or wildcard patterns" })),
  deny: Type.Optional(Type.Array(Type.String(), { description: "Denylist of tool names or wildcard patterns (takes precedence over allow)" })),
});
export type ProfileTools = Static<typeof ProfileToolsSchema>;

export const ProfileMcpServerSchema = Type.Object({
  command: Type.Optional(Type.String()),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  cwd: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  timeout: Type.Optional(Type.Number({ minimum: 0 })),
});
export type ProfileMcpServer = Static<typeof ProfileMcpServerSchema>;

export const ProfileSkillsSchema = Type.Object({
  allow: Type.Optional(Type.Array(Type.String())),
  deny: Type.Optional(Type.Array(Type.String())),
});
export type ProfileSkills = Static<typeof ProfileSkillsSchema>;

export const ProfileModelSchema = Type.Object({
  preferred: Type.Optional(Type.String({ description: "Preferred model identifier (e.g. anthropic/claude-sonnet-4-5)" })),
  fallback: Type.Optional(Type.String({ description: "Fallback model identifier" })),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
});
export type ProfileModel = Static<typeof ProfileModelSchema>;

export const ProfileSubagentsSchema = Type.Object({
  allowedProfiles: Type.Optional(Type.Array(Type.String(), { description: "Profiles this agent is permitted to delegate to" })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum nested delegation depth (default 2)" })),
  maxConcurrent: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum concurrent subagents spawned by this agent" })),
});
export type ProfileSubagents = Static<typeof ProfileSubagentsSchema>;

export const SupervisionWakeTriggerSchema = Type.Union([
  Type.Literal("completed"),
  Type.Literal("failed"),
  Type.Literal("stalled"),
  Type.Literal("needs_input"),
]);
export type SupervisionWakeTrigger = Static<typeof SupervisionWakeTriggerSchema>;

export const ProfileSupervisionSchema = Type.Object({
  wakeOn: Type.Optional(Type.Array(SupervisionWakeTriggerSchema)),
  reviewIntervalSeconds: Type.Optional(Type.Number({ minimum: 1 })),
  maxDurationSeconds: Type.Optional(Type.Number({ minimum: 1 })),
});
export type ProfileSupervision = Static<typeof ProfileSupervisionSchema>;

export const ProfileDefinitionSchema = Type.Object({
  id: Type.String({ minLength: 1, description: "Unique identifier for this profile (e.g. 'worker' or 'gear:worker')" }),
  label: Type.String({ minLength: 1, description: "Human-readable display label" }),
  description: Type.String({ minLength: 1, description: "Description for the model when selecting an agent" }),
  extends: Type.Optional(Type.String({ minLength: 1, description: "Parent profile ID for inheritance" })),
  prompt: Type.Optional(ProfilePromptSchema),
  tools: Type.Optional(ProfileToolsSchema),
  mcpServers: Type.Optional(Type.Record(Type.String(), ProfileMcpServerSchema)),
  skills: Type.Optional(ProfileSkillsSchema),
  model: Type.Optional(ProfileModelSchema),
  subagents: Type.Optional(ProfileSubagentsSchema),
  supervision: Type.Optional(ProfileSupervisionSchema),
});
export type ProfileDefinition = Static<typeof ProfileDefinitionSchema>;
