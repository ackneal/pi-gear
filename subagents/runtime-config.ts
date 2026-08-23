import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export type RuntimeSubagentId = "researcher" | "worker";

const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

const RuntimeSubagentSettingSchema = Type.Union([
  Type.Object({ mode: Type.Literal("inherit") }, { additionalProperties: false }),
  Type.Object({
    mode: Type.Literal("override"),
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    thinkingLevel: ThinkingLevelSchema,
  }, { additionalProperties: false }),
]);

const RuntimeConfigSchema = Type.Object({
  version: Type.Literal(1),
  subagents: Type.Optional(Type.Object({
    researcher: Type.Optional(RuntimeSubagentSettingSchema),
    worker: Type.Optional(RuntimeSubagentSettingSchema),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export type RuntimeSubagentSetting = Static<typeof RuntimeSubagentSettingSchema>;
type RuntimeConfig = Static<typeof RuntimeConfigSchema>;

export function parseRuntimeSubagentSetting(value: unknown): RuntimeSubagentSetting | undefined {
  return Value.Check(RuntimeSubagentSettingSchema, value) ? value : undefined;
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  if (!Value.Check(RuntimeConfigSchema, value)) throw new Error("runtime config does not match version 1 schema");
  return value;
}

export class RuntimeConfigStore {
  public readonly path: string;
  private config: RuntimeConfig = { version: 1 };
  private loaded = false;
  private loadError: string | undefined;

  constructor(path = join(getAgentDir(), "pi-gear", "runtime.json")) {
    this.path = path;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.config = parseRuntimeConfig(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.loadError = error instanceof Error ? error.message : String(error);
    }
  }

  error(): string | undefined {
    return this.loadError;
  }

  get(id: RuntimeSubagentId): RuntimeSubagentSetting | undefined {
    return this.config.subagents?.[id];
  }

  async set(id: RuntimeSubagentId, setting: RuntimeSubagentSetting | undefined): Promise<void> {
    await this.load();
    if (this.loadError) throw new Error(`Invalid runtime config: ${this.loadError}`);

    await withFileMutationQueue(this.path, async () => {
      const subagents = { ...this.config.subagents };
      if (setting) subagents[id] = setting;
      else delete subagents[id];
      const next: RuntimeConfig = { version: 1, ...(Object.keys(subagents).length ? { subagents } : {}) };
      const serialized = `${JSON.stringify(next, null, 2)}\n`;

      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.path);
        this.config = next;
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }
}
