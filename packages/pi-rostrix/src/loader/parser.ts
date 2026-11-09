import YAML from "yaml";
import { Value } from "typebox/value";
import { ProfileDefinitionSchema, type ProfileDefinition } from "../core/schema.ts";

const FRONTMATTER_REGEX = /^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n([\s\S]*))?$/;

export class ProfileParseError extends Error {
  readonly filePath?: string | undefined;

  constructor(message: string, filePath?: string | undefined) {
    super(filePath ? `${message} (in ${filePath})` : message);
    this.name = "ProfileParseError";
    this.filePath = filePath;
  }
}

export interface ParseProfileOptions {
  readonly filePath?: string | undefined;
  readonly fallbackId?: string | undefined;
}

export function parseProfileMarkdown(content: string, options: ParseProfileOptions = {}): ProfileDefinition {
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
      throw new ProfileParseError(
        `Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        options.filePath,
      );
    }
  }

  const id = (typeof data.id === "string" && data.id.trim()) || options.fallbackId;
  if (!id) {
    throw new ProfileParseError("Missing required field 'id'", options.filePath);
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

  validateProfileDefinition(candidate, options.filePath);
  return candidate as unknown as ProfileDefinition;
}

export function parseProfileJson(content: string, options: ParseProfileOptions = {}): ProfileDefinition {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content);
  } catch (err) {
    throw new ProfileParseError(
      `Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
      options.filePath,
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ProfileParseError("Profile JSON must be an object", options.filePath);
  }

  const id = (typeof data.id === "string" && data.id.trim()) || options.fallbackId;
  if (!id) {
    throw new ProfileParseError("Missing required field 'id'", options.filePath);
  }

  const label = (typeof data.label === "string" && data.label.trim()) || id;
  const description = (typeof data.description === "string" && data.description.trim()) || label;

  const candidate: Record<string, unknown> = {
    ...data,
    id,
    label,
    description,
  };

  validateProfileDefinition(candidate, options.filePath);
  return candidate as unknown as ProfileDefinition;
}

function validateProfileDefinition(candidate: Record<string, unknown>, filePath?: string | undefined): void {
  if (Value.Check(ProfileDefinitionSchema, candidate)) {
    return;
  }

  const errors = Array.from(Value.Errors(ProfileDefinitionSchema, candidate));
  const details = errors.map((e) => `${(e as any).path || "root"}: ${e.message}`).join(", ");
  throw new ProfileParseError(`Validation failed: ${details}`, filePath);
}
