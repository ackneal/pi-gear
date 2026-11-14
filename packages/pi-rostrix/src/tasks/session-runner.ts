import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultPackageManager,
  DefaultResourceLoader,
  getAgentDir,
  loadProjectContextFiles,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionFactory,
  type SessionShutdownEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ContextInheritMode, ExtensionInheritMode } from "../agents/schema.ts";
import {
  isAgentPromptTemplateAllowed,
  isAgentSkillAllowed,
  isAgentToolAllowed,
  type ResolvedAgentDefinition,
} from "../agents/resolver.ts";

export type SubagentUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
  readonly estimated?: boolean | undefined;
};

export interface SubagentSessionOptions {
  readonly agent: ResolvedAgentDefinition;
  readonly cwd?: string | undefined;
  readonly model?: string | undefined;
  readonly thinkingLevel?: import("../agents/schema.ts").ThinkingLevel | undefined;
  readonly parentSession?: AgentSession | undefined;
  readonly modelRuntime?: ModelRuntime | undefined;
  readonly customTools?: ToolDefinition[] | undefined;
  readonly extensionFactories?: readonly ExtensionFactory[] | undefined;
  readonly additionalExtensionPaths?: readonly string[] | undefined;
  readonly excludeExtensionPaths?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onEvent?: ((event: AgentSessionEvent) => void) | undefined;
  readonly onTextDelta?: ((delta: string) => void) | undefined;
  readonly onUsage?: ((usage: SubagentUsage) => void) | undefined;
}

export interface SubagentTaskResult {
  readonly status: "completed" | "failed" | "aborted";
  readonly result?: string | undefined;
  readonly error?: string | undefined;
  readonly usage: SubagentUsage;
  readonly turns: number;
  readonly durationMs: number;
}

type SubagentSession = Pick<AgentSession, "bindExtensions" | "subscribe" | "prompt" | "abort" | "dispose"> & {
  extensionRunner: { emit(event: SessionShutdownEvent): Promise<unknown> };
};

type SessionFactory = (
  options: NonNullable<Parameters<typeof createAgentSession>[0]>,
) => Promise<{ session: SubagentSession }>;

async function disposeSession(session: SubagentSession): Promise<void> {
  try {
    // SDK dispose invalidates extension contexts without running their shutdown handlers.
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    session.dispose();
  }
}

function applyPendingExtensionProviders(
  extRuntime: ReturnType<DefaultResourceLoader["getExtensions"]>["runtime"],
  modelRuntime: ModelRuntime,
): void {
  for (const { name, config } of extRuntime.pendingProviderRegistrations) {
    modelRuntime.registerProvider(name, config);
  }
  extRuntime.pendingProviderRegistrations = [];

  for (const { provider } of extRuntime.pendingNativeProviderRegistrations) {
    modelRuntime.registerNativeProvider(provider);
  }
  extRuntime.pendingNativeProviderRegistrations = [];

  for (const { definition } of extRuntime.pendingVirtualModelRegistrations) {
    modelRuntime.registerVirtualModel(definition);
  }
  extRuntime.pendingVirtualModelRegistrations = [];
}

export class InProcessSubagentRunner {
  private readonly _agent: ResolvedAgentDefinition;
  private readonly _options: SubagentSessionOptions;
  private readonly createSession: SessionFactory;

  constructor(
    options: SubagentSessionOptions,
    createSession: SessionFactory = createAgentSession,
  ) {
    const resolved = options.agent;
    if (!resolved) {
      throw new Error("InProcessSubagentRunner requires an agent option");
    }
    this._agent = resolved;
    this._options = options;
    this.createSession = createSession;
  }

  async run(taskPrompt: string): Promise<SubagentTaskResult> {
    const startedAt = Date.now();
    if (this._options.signal?.aborted) {
      return {
        status: "aborted",
        error: String(this._options.signal.reason ?? "Aborted"),
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
        turns: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalCost = 0;
    let totalTokens = 0;
    let activeTurnDeltaChars = 0;
    let activeTurnUsage: SubagentUsage | undefined;
    let lastPublishedUsage: SubagentUsage | undefined;
    const collectUsage = (): SubagentUsage => {
      const estimated = activeTurnUsage?.estimated === true;
      return {
        inputTokens: inputTokens + (activeTurnUsage?.inputTokens ?? 0),
        outputTokens: outputTokens + (activeTurnUsage?.outputTokens ?? 0),
        cacheReadTokens: cacheReadTokens + (activeTurnUsage?.cacheReadTokens ?? 0),
        cacheWriteTokens: cacheWriteTokens + (activeTurnUsage?.cacheWriteTokens ?? 0),
        totalTokens: totalTokens + (activeTurnUsage?.totalTokens ?? 0),
        cost: totalCost + (activeTurnUsage?.cost ?? 0),
        ...(estimated ? { estimated: true } : {}),
      };
    };
    const publishUsage = (): void => {
      const next = collectUsage();
      if (
        lastPublishedUsage &&
        lastPublishedUsage.inputTokens === next.inputTokens &&
        lastPublishedUsage.outputTokens === next.outputTokens &&
        lastPublishedUsage.cacheReadTokens === next.cacheReadTokens &&
        lastPublishedUsage.cacheWriteTokens === next.cacheWriteTokens &&
        lastPublishedUsage.totalTokens === next.totalTokens &&
        lastPublishedUsage.cost === next.cost &&
        Boolean(lastPublishedUsage.estimated) === Boolean(next.estimated)
      ) {
        return;
      }
      lastPublishedUsage = next;
      this._options.onUsage?.(next);
    };
    let latestAssistantText = "";
    let lastAssistantError: string | undefined;

    const cwd = this._options.cwd ?? (this._options.parentSession ? (this._options.parentSession as any)._cwd : process.cwd());
    const agentDir = resolve((this._options.parentSession as any)?._agentDir ?? getAgentDir());

    // Use in-memory session manager so no session JSONL files pollute the disk
    const inMemorySessionManager = SessionManager.inMemory();

    let sessionResult;
    try {
      const thinkingLevel = this._options.thinkingLevel;
      const modelStr = this._options.model ?? this._agent.model?.preferred;

      let requestedModel: { providerId: string; modelId: string } | undefined;
      if (modelStr !== undefined) {
        const slashIdx = modelStr.indexOf("/");
        if (slashIdx <= 0 || slashIdx === modelStr.length - 1) {
          throw new Error(`Invalid requested model: ${modelStr}; expected provider/model`);
        }
        requestedModel = {
          providerId: modelStr.slice(0, slashIdx),
          modelId: modelStr.slice(slashIdx + 1),
        };
      }

      const mcpServerEntries = Object.entries(this._agent.mcpServers);
      const hasMcpServers = mcpServerEntries.length > 0;

      const extensionFactories: ExtensionFactory[] = [...(this._options.extensionFactories ?? [])];
      if (hasMcpServers) {
        extensionFactories.push(createCodemodeExtension(), createToolSearchExtension());
        extensionFactories.push(createMcpExtension({
          // Only this agent's registered servers belong to the child.
          loadConfig: () => ({ servers: [], errors: [] }),
        }));
      }

      extensionFactories.push((childPi: ExtensionAPI) => {
        if (hasMcpServers) {
          for (const [name, config] of mcpServerEntries) {
            childPi.registerMcpServer(name, config as any);
          }
        }

        childPi.on("tool_call", async (event) => {
          if (!isAgentToolAllowed(event.toolName, this._agent)) {
            return { block: true, reason: `Tool ${event.toolName} is not allowed for agent ${this._agent.id}` };
          }
        });

        childPi.on("before_agent_start", async () => {
          const allTools = childPi.getAllTools().map((t) => t.name);
          const targetTools = allTools.filter((toolName) =>
            isAgentToolAllowed(toolName, this._agent),
          );
          childPi.setActiveTools(targetTools);
        });
      });

      const additionalExtensionPaths = await resolveInheritedExtensionPaths({
        cwd,
        agentDir,
        agent: this._agent,
        additionalExtensionPaths: this._options.additionalExtensionPaths,
        excludeExtensionPaths: this._options.excludeExtensionPaths,
      });
      const additionalSkillPaths = await resolveInheritedSkillPaths({
        cwd,
        agentDir,
        agent: this._agent,
      });
      const additionalPromptTemplatePaths = await resolveInheritedPromptTemplatePaths({
        cwd,
        agentDir,
        agent: this._agent,
      });
      const resolvedContextFiles = resolveContextFiles({
        cwd,
        agentDir,
        contextFiles: this._agent.contextFiles,
      });
      const resolvedSystemPrompt = resolveSubagentSystemPrompt({
        cwd,
        agentDir,
        agent: this._agent,
      });
      const resolvedAppendSystemPrompt = resolveSubagentAppendSystemPrompt({
        cwd,
        agentDir,
        agent: this._agent,
      });

      const excludedSkillPaths = (this._agent.skills?.exclude ?? []).map((target) => canonicalizePath(cwd, target));
      const hasSkillFilter =
        excludedSkillPaths.length > 0 ||
        this._agent.allowedSkills !== undefined ||
        (this._agent.skillAllowConstraints?.length ?? 0) > 0 ||
        this._agent.deniedSkills.length > 0;

      const excludedPromptPaths = (this._agent.promptTemplates?.exclude ?? []).map((target) => canonicalizePath(cwd, target));
      const hasPromptFilter =
        excludedPromptPaths.length > 0 ||
        this._agent.promptTemplates?.allow !== undefined ||
        (this._agent.promptTemplates?.allowConstraints?.length ?? 0) > 0 ||
        (this._agent.promptTemplates?.deny.length ?? 0) > 0;

      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        extensionFactories,
        ...(additionalExtensionPaths.length > 0 ? { additionalExtensionPaths } : {}),
        ...(additionalSkillPaths.length > 0 ? { additionalSkillPaths } : {}),
        ...(additionalPromptTemplatePaths.length > 0 ? { additionalPromptTemplatePaths } : {}),
        // Keep ambient resources isolated; only resolved inherited/explicit resources load above.
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        ...(resolvedContextFiles !== undefined ? { agentsFilesOverride: () => ({ agentsFiles: resolvedContextFiles }) } : {}),
        ...(hasSkillFilter
          ? {
              skillsOverride: (base) => ({
                ...base,
                skills: base.skills.filter((skill) => {
                  const canonicalFile = canonicalizePath(cwd, skill.filePath);
                  const canonicalBase = canonicalizePath(cwd, skill.baseDir);
                  if (isExcludedPath(canonicalFile, excludedSkillPaths) || isExcludedPath(canonicalBase, excludedSkillPaths)) {
                    return false;
                  }
                  return isAgentSkillAllowed(skill.name, this._agent);
                }),
              }),
            }
          : {}),
        ...(hasPromptFilter
          ? {
              promptsOverride: (base) => ({
                ...base,
                prompts: base.prompts.filter((prompt) => {
                  const canonicalFile = canonicalizePath(cwd, prompt.filePath);
                  if (isExcludedPath(canonicalFile, excludedPromptPaths)) {
                    return false;
                  }
                  return isAgentPromptTemplateAllowed(prompt.name, this._agent);
                }),
              }),
            }
          : {}),
        systemPromptOverride: () => resolvedSystemPrompt,
        appendSystemPrompt: [],
        appendSystemPromptOverride: () => resolvedAppendSystemPrompt,
      });
      await resourceLoader.reload();

      const extRuntime = resourceLoader.getExtensions().runtime;
      const hasPendingProviders =
        extRuntime.pendingProviderRegistrations.length > 0 ||
        extRuntime.pendingNativeProviderRegistrations.length > 0 ||
        extRuntime.pendingVirtualModelRegistrations.length > 0;
      const isolateModelRuntime = additionalExtensionPaths.length > 0 || hasPendingProviders;

      // Child extensions with their own provider lifecycles must not overwrite or close the parent's ModelRuntime.
      let modelRuntime = isolateModelRuntime
        ? undefined
        : (this._options.modelRuntime ?? this._options.parentSession?.modelRuntime);

      if (requestedModel !== undefined || hasPendingProviders) {
        modelRuntime ??= await ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: join(agentDir, "models.json"),
        });
      }

      if (modelRuntime && hasPendingProviders) {
        applyPendingExtensionProviders(extRuntime, modelRuntime);
        await modelRuntime.refresh({ allowNetwork: false });
      }

      let resolvedModelInstance: ReturnType<ModelRuntime["getModel"]>;
      if (requestedModel !== undefined) {
        resolvedModelInstance =
          modelRuntime!.getModel(requestedModel.providerId, requestedModel.modelId) ??
          modelRuntime!.getPhysicalModel(requestedModel.providerId, requestedModel.modelId);
        if (!resolvedModelInstance) {
          throw new Error(`Unknown requested model: ${modelStr}`);
        }
      }

      sessionResult = await this.createSession({
        cwd,
        agentDir,
        sessionManager: inMemorySessionManager,
        resourceLoader,
        ...(modelRuntime ? { modelRuntime } : {}),
        ...(resolvedModelInstance ? { model: resolvedModelInstance } : {}),
        ...(this._options.customTools ? { customTools: this._options.customTools } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });

      await sessionResult.session.bindExtensions({ mode: "json" });
    } catch (createErr) {
      if (sessionResult) await disposeSession(sessionResult.session);
      if (this._options.signal?.aborted) {
        return {
          status: "aborted",
          error: this._options.signal.reason instanceof Error ? this._options.signal.reason.message : String(this._options.signal.reason ?? "Aborted"),
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
          turns: 0,
          durationMs: Date.now() - startedAt,
        };
      }

      return {
        status: "failed",
        error: `Failed to create subagent session: ${createErr instanceof Error ? createErr.message : String(createErr)}`,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
        turns: 0,
        durationMs: Date.now() - startedAt,
      };
    }

    const { session } = sessionResult;

    // Hook to abort if caller signal fires
    const onCallerAbort = () => {
      try {
        session.abort();
      } catch {
        // Ignored if already idle
      }
    };

    if (this._options.signal) {
      this._options.signal.addEventListener("abort", onCallerAbort, { once: true });
      if (this._options.signal.aborted) {
        onCallerAbort();
      }
    }

    // Subscribe to session events
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      this._options.onEvent?.(event);

      if (event.type === "message_start" && event.message.role === "assistant") {
        activeTurnDeltaChars = 0;
        activeTurnUsage = undefined;
      }

      if (event.type === "message_update") {
        const streamEvent = event.assistantMessageEvent;
        if (streamEvent.type === "text_delta" && typeof streamEvent.delta === "string") {
          latestAssistantText += streamEvent.delta;
          this._options.onTextDelta?.(streamEvent.delta);
        }
        if (
          (streamEvent.type === "text_delta" || streamEvent.type === "thinking_delta" || streamEvent.type === "toolcall_delta") &&
          typeof streamEvent.delta === "string"
        ) {
          activeTurnDeltaChars += streamEvent.delta.length;
        }
        if (event.message.role === "assistant") {
          const u = event.message.usage;
          const hasReportedUsage = Boolean(
            u && (u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0 || u.totalTokens > 0 || u.cost.total > 0),
          );
          if (hasReportedUsage && u) {
            activeTurnUsage = {
              inputTokens: u.input,
              outputTokens: u.output,
              cacheReadTokens: u.cacheRead,
              cacheWriteTokens: u.cacheWrite,
              totalTokens: u.totalTokens,
              cost: u.cost.total,
            };
            publishUsage();
          } else if (activeTurnDeltaChars > 0) {
            const estimatedOutput = Math.max(1, Math.ceil(activeTurnDeltaChars / 4));
            activeTurnUsage = {
              inputTokens: 0,
              outputTokens: estimatedOutput,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: estimatedOutput,
              cost: 0,
              estimated: true,
            };
            publishUsage();
          }
        }
      }

      if (event.type === "message_end") {
        const msg = event.message;
        if (msg.role === "assistant") {
          turns++;
          activeTurnDeltaChars = 0;
          activeTurnUsage = undefined;
          if (msg.usage) {
            inputTokens += msg.usage.input;
            outputTokens += msg.usage.output;
            cacheReadTokens += msg.usage.cacheRead;
            cacheWriteTokens += msg.usage.cacheWrite;
            totalTokens += msg.usage.totalTokens;
            totalCost += msg.usage.cost.total;
            publishUsage();
          }
          if (msg.stopReason === "error" || msg.stopReason === "aborted") {
            lastAssistantError = msg.errorMessage?.trim() || `Subagent model turn ${msg.stopReason === "aborted" ? "aborted" : "failed"}`;
          } else {
            lastAssistantError = undefined;
          }
          if (Array.isArray(msg.content)) {
            const texts = msg.content
              .filter((c) => c.type === "text")
              .map((c) => c.text);
            if (texts.length > 0) {
              latestAssistantText = texts.join("\n");
            }
          }
        }
      }
    });

    try {
      await session.prompt(taskPrompt);

      const usage = collectUsage();

      if (this._options.signal?.aborted) {
        return {
          status: "aborted",
          result: latestAssistantText || undefined,
          usage,
          turns,
          durationMs: Date.now() - startedAt,
        };
      }

      if (lastAssistantError !== undefined) {
        return {
          status: "failed",
          error: lastAssistantError,
          result: latestAssistantText || undefined,
          usage,
          turns,
          durationMs: Date.now() - startedAt,
        };
      }

      return {
        status: "completed",
        result: latestAssistantText,
        usage,
        turns,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const usage = collectUsage();

      if (this._options.signal?.aborted) {
        return {
          status: "aborted",
          error: this._options.signal.reason instanceof Error ? this._options.signal.reason.message : String(this._options.signal.reason ?? "Aborted"),
          result: latestAssistantText || undefined,
          usage,
          turns,
          durationMs: Date.now() - startedAt,
        };
      }

      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        result: latestAssistantText || undefined,
        usage,
        turns,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      if (this._options.signal) {
        this._options.signal.removeEventListener("abort", onCallerAbort);
      }
      unsubscribe();
      await disposeSession(session);
    }
  }
}

const CONTEXT_FILE_CANDIDATES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

const expandTilde = (target: string): string =>
  target === "~" ? homedir() : target.startsWith("~/") ? join(homedir(), target.slice(2)) : target;

const canonicalizePath = (cwd: string, target: string): string => {
  const resolved = resolve(cwd, expandTilde(target));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
};

const isExcludedPath = (canonical: string, excluded: readonly string[]): boolean =>
  excluded.some((entry) => canonical === entry || canonical.startsWith(`${entry}${sep}`));

const readUtf8StrippingBom = (filePath: string): string | undefined => {
  try {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) return undefined;
    return readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  } catch {
    return undefined;
  }
};

function resolveInheritedPromptFile(options: {
  readonly filename: "SYSTEM.md" | "APPEND_SYSTEM.md";
  readonly inherit: ContextInheritMode;
  readonly cwd: string;
  readonly agentDir: string;
}): string | undefined {
  if (options.inherit === "none") return undefined;

  const projectPath = join(options.cwd, ".pi", options.filename);
  const userPath = join(options.agentDir, options.filename);
  const candidates =
    options.inherit === "project"
      ? [projectPath]
      : options.inherit === "user"
        ? [userPath]
        : [projectPath, userPath];

  for (const candidate of candidates) {
    const content = readUtf8StrippingBom(candidate);
    if (content !== undefined) return content;
  }

  return undefined;
}

function resolveSubagentSystemPrompt(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly agent: ResolvedAgentDefinition;
}): string | undefined {
  const inherited = resolveInheritedPromptFile({
    filename: "SYSTEM.md",
    inherit: options.agent.inheritSystemPrompt ?? "none",
    cwd: options.cwd,
    agentDir: options.agentDir,
  });
  const parts = [inherited, options.agent.systemPrompt].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function resolveSubagentAppendSystemPrompt(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly agent: ResolvedAgentDefinition;
}): string[] {
  const inherited = resolveInheritedPromptFile({
    filename: "APPEND_SYSTEM.md",
    inherit: options.agent.inheritAppendSystemPrompt ?? "none",
    cwd: options.cwd,
    agentDir: options.agentDir,
  });
  const guidelines = options.agent.promptGuidelines.length > 0
    ? `Guidelines:\n${options.agent.promptGuidelines.map((g) => `- ${g}`).join("\n")}`
    : undefined;

  return [inherited, options.agent.appendPrompt, guidelines].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
}

function resolveExplicitContextFile(cwd: string, target: string): { path: string; content: string } | undefined {
  const resolved = resolve(cwd, expandTilde(target));
  if (!existsSync(resolved)) return undefined;

  try {
    if (statSync(resolved).isDirectory()) {
      for (const filename of CONTEXT_FILE_CANDIDATES) {
        const candidate = join(resolved, filename);
        const content = readUtf8StrippingBom(candidate);
        if (content !== undefined) return { path: candidate, content };
      }
      return undefined;
    }
  } catch {
    return undefined;
  }

  const content = readUtf8StrippingBom(resolved);
  return content !== undefined ? { path: resolved, content } : undefined;
}

export function resolveContextFiles(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly contextFiles: ResolvedAgentDefinition["contextFiles"];
}): Array<{ path: string; content: string }> | undefined {
  const inherit = options.contextFiles?.inherit ?? "none";
  const explicitPaths = options.contextFiles?.paths ?? [];
  if (inherit === "none" && explicitPaths.length === 0) {
    return undefined;
  }

  const excluded = (options.contextFiles?.exclude ?? []).map((target) => canonicalizePath(options.cwd, target));
  const canonicalAgentDir = canonicalizePath(options.cwd, options.agentDir);
  const canonicalCwd = canonicalizePath(options.cwd, options.cwd);

  const collected: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();
  const addFile = (entry: { path: string; content: string }): void => {
    const canonical = canonicalizePath(options.cwd, entry.path);
    if (isExcludedPath(canonical, excluded) || seen.has(canonical)) return;
    seen.add(canonical);
    collected.push(entry);
  };

  if (inherit !== "none") {
    for (const file of loadProjectContextFiles({ cwd: options.cwd, agentDir: options.agentDir })) {
      const isUserFile = canonicalizePath(options.cwd, dirname(file.path)) === canonicalAgentDir;
      const include =
        inherit === "all" ||
        (inherit === "user" && isUserFile) ||
        (inherit === "project" && (!isUserFile || canonicalCwd === canonicalAgentDir));
      if (include) addFile(file);
    }
  }

  for (const rawPath of explicitPaths) {
    const file = resolveExplicitContextFile(options.cwd, rawPath);
    if (file) addFile(file);
  }

  return collected;
}

const normalizeResolvedExtensionTarget = (cwd: string, candidate: string): string => {
  const canonical = canonicalizePath(cwd, candidate);
  try {
    if (statSync(canonical).isDirectory()) {
      for (const entry of ["index.ts", "index.js"]) {
        const indexPath = join(canonical, entry);
        if (existsSync(indexPath)) return indexPath;
      }
    }
  } catch {
    return candidate;
  }
  return candidate;
};

async function resolveInheritedPackageResourcePaths(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly kind: "extensions" | "skills" | "prompts";
  readonly inherit: ExtensionInheritMode;
  readonly paths: readonly string[];
  readonly exclude: readonly string[];
  readonly normalizeTarget?: ((cwd: string, candidate: string) => string) | undefined;
}): Promise<string[]> {
  if (options.inherit === "none" && options.paths.length === 0) {
    return [];
  }

  const excluded = options.exclude.map((target) => canonicalizePath(options.cwd, target));

  const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
  settingsManager.setProjectTrusted(options.inherit === "all");
  await settingsManager.reload();
  const packageManager = new DefaultPackageManager({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
  });

  const seen = new Set<string>();
  const collected: string[] = [];
  const addPath = (candidate: string): void => {
    const normalized = options.normalizeTarget ? options.normalizeTarget(options.cwd, candidate) : candidate;
    const canonical = canonicalizePath(options.cwd, normalized);
    if (isExcludedPath(canonical, excluded) || seen.has(canonical)) return;
    seen.add(canonical);
    collected.push(normalized);
  };

  if (options.inherit === "user" || options.inherit === "all") {
    const resolved = await packageManager.resolve();
    for (const resource of resolved[options.kind]) {
      if (!resource.enabled) continue;
      if (options.inherit === "user" && resource.metadata.scope !== "user") continue;
      addPath(resource.path);
    }
  }

  for (const rawPath of options.paths) {
    const canonical = canonicalizePath(options.cwd, rawPath);
    if (isExcludedPath(canonical, excluded)) continue;

    const resolvedExtra = await packageManager.resolveExtensionSources([rawPath], { temporary: true });
    if (resolvedExtra[options.kind].length > 0) {
      for (const resource of resolvedExtra[options.kind]) {
        if (resource.enabled) addPath(resource.path);
      }
      continue;
    }

    addPath(rawPath);
  }

  return collected;
}

export async function resolveInheritedExtensionPaths(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly agent: ResolvedAgentDefinition;
  readonly additionalExtensionPaths?: readonly string[] | undefined;
  readonly excludeExtensionPaths?: readonly string[] | undefined;
}): Promise<string[]> {
  return resolveInheritedPackageResourcePaths({
    cwd: options.cwd,
    agentDir: options.agentDir,
    kind: "extensions",
    inherit: options.agent.extensions?.inherit ?? "none",
    paths: [
      ...(options.agent.extensions?.paths ?? []),
      ...(options.additionalExtensionPaths ?? []),
    ],
    exclude: [
      ...(options.agent.extensions?.exclude ?? []),
      ...(options.excludeExtensionPaths ?? []),
    ],
    normalizeTarget: normalizeResolvedExtensionTarget,
  });
}

export async function resolveInheritedSkillPaths(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly agent: ResolvedAgentDefinition;
}): Promise<string[]> {
  return resolveInheritedPackageResourcePaths({
    cwd: options.cwd,
    agentDir: options.agentDir,
    kind: "skills",
    inherit: options.agent.skills?.inherit ?? "none",
    paths: options.agent.skills?.paths ?? [],
    exclude: options.agent.skills?.exclude ?? [],
  });
}

export async function resolveInheritedPromptTemplatePaths(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly agent: ResolvedAgentDefinition;
}): Promise<string[]> {
  return resolveInheritedPackageResourcePaths({
    cwd: options.cwd,
    agentDir: options.agentDir,
    kind: "prompts",
    inherit: options.agent.promptTemplates?.inherit ?? "none",
    paths: options.agent.promptTemplates?.paths ?? [],
    exclude: options.agent.promptTemplates?.exclude ?? [],
  });
}

