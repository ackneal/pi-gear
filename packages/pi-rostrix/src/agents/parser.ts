import YAML from "yaml";
import { Value } from "typebox/value";
import { AgentDefinitionSchema, type AgentDefinition } from "./schema.ts";

const FRONTMATTER_REGEX = /^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n([\s\S]*))?$/;

export class AgentParseError extends Error {
  readonly filePath?: string | undefined;

  constructor(message: string, filePath?: string | undefined) {
    super(filePath ? `${message} (in ${filePath})` : message);
    this.name = "AgentParseError";
    this.filePath = filePath;
  }
}

export interface ParseAgentOptions {
  readonly filePath?: string | undefined;
  readonly fallbackId?: string | undefined;
}

export function parseAgentMarkdown(content: string, options: ParseAgentOptions = {}): AgentDefinition {
  const match = FRONTMATTER_REGEX.exec(content);
  const frontmatterStr = (match && match[1]) ? match[1] : "";
  const bodyText = (match && match[2] ? match[2] : match ? "" : content).trim();

  let data: Record<string, unknown> = {};
  if (frontmatterStr.trim().length > 0) {
    try {
      const parsed = YAML.parse(frontmatterStr);
      if (parsed && typeof parsed === "object") {
        data = parsed as Record<string, unknown>;
      }
    } catch (err) {
      throw new AgentParseError(
        `Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        options.filePath,
      );
    }
  }

  const id = (typeof data.id === "string" && data.id.trim()) || options.fallbackId;
  if (!id) {
    throw new AgentParseError("Missing required field 'id'", options.filePath);
  }

  const label = (typeof data.label === "string" && data.label.trim()) || id;
  const description = (typeof data.description === "string" && data.description.trim()) || label;

  const promptObj = (data.prompt && typeof data.prompt === "object") ? { ...(data.prompt as Record<string, unknown>) } : {};
  if (bodyText.length > 0) {
    promptObj.systemPrompt = bodyText;
  }

  const candidate: Record<string, unknown> = {
    ...data,
    id,
    label,
    description,
    ...(Object.keys(promptObj).length > 0 ? { prompt: promptObj } : {}),
  };

  validateAgentDefinition(candidate, options.filePath);
  return candidate as unknown as AgentDefinition;
}

export function parseAgentJson(content: string, options: ParseAgentOptions = {}): AgentDefinition {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new AgentParseError(
      `Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
      options.filePath,
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new AgentParseError("Agent JSON must be an object", options.filePath);
  }

  const id = (typeof data.id === "string" && data.id.trim()) || options.fallbackId;
  if (!id) {
    throw new AgentParseError("Missing required field 'id'", options.filePath);
  }

  const label = (typeof data.label === "string" && data.label.trim()) || id;
  const description = (typeof data.description === "string" && data.description.trim()) || label;

  const candidate: Record<string, unknown> = {
    ...data,
    id,
    label,
    description,
  };

  validateAgentDefinition(candidate, options.filePath);
  return candidate as unknown as AgentDefinition;
}

function validateAgentDefinition(candidate: Record<string, unknown>, filePath?: string | undefined): void {
  if (Value.Check(AgentDefinitionSchema, candidate)) {
    return;
  }

  const errors = Array.from(Value.Errors(AgentDefinitionSchema, candidate));
  const details = errors.map((e) => `${(e as any).path || "root"}: ${e.message}`).join(", ");
  throw new AgentParseError(`Validation failed: ${details}`, filePath);
}

