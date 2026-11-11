import { join, resolve } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionFactory,
  ModelRuntime,
  type SessionShutdownEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { isToolAllowed, type ResolvedAgent } from "../core/resolver.ts";

export type SubagentUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
};

export interface SubagentSessionOptions {
  readonly agent?: ResolvedAgent | undefined;
  readonly profile?: ResolvedAgent | undefined; // alias
  readonly cwd?: string | undefined;
  readonly model?: string | undefined;
  readonly thinkingLevel?: import("../core/schema.ts").ThinkingLevel | undefined;
  readonly parentSession?: AgentSession | undefined;
  readonly modelRuntime?: ModelRuntime | undefined;
  readonly customTools?: ToolDefinition[] | undefined;
  readonly extensionFactories?: readonly ExtensionFactory[] | undefined;
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

export class InProcessSubagentRunner {
  private readonly _agent: ResolvedAgent;
  private readonly _options: SubagentSessionOptions;
  private readonly createSession: SessionFactory;

  constructor(
    options: SubagentSessionOptions,
    createSession: SessionFactory = createAgentSession,
  ) {
    const resolved = options.agent ?? options.profile;
    if (!resolved) {
      throw new Error("InProcessSubagentRunner requires an agent or profile option");
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
    const collectUsage = (): SubagentUsage => ({
      inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, cost: totalCost,
    });
    let latestAssistantText = "";

    const cwd = this._options.cwd ?? (this._options.parentSession ? (this._options.parentSession as any)._cwd : process.cwd());
    const agentDir = resolve((this._options.parentSession as any)?._agentDir ?? getAgentDir());

    // Use in-memory session manager so no session JSONL files pollute the disk
    const inMemorySessionManager = SessionManager.inMemory();

    let modelRuntime = this._options.modelRuntime ?? this._options.parentSession?.modelRuntime;

    let sessionResult;
    try {
      const thinkingLevel = this._options.thinkingLevel ?? this._agent.model?.thinkingLevel;
      const modelStr = this._options.model ?? this._agent.model?.preferred;

      let resolvedModelInstance: ReturnType<ModelRuntime["getModel"]>;
      if (modelStr !== undefined) {
        const slashIdx = modelStr.indexOf("/");
        if (slashIdx <= 0 || slashIdx === modelStr.length - 1) {
          throw new Error(`Invalid requested model: ${modelStr}; expected provider/model`);
        }

        modelRuntime ??= await ModelRuntime.create({
          authPath: join(agentDir, "auth.json"),
          modelsPath: join(agentDir, "models.json"),
        });
        const providerId = modelStr.slice(0, slashIdx);
        const modelId = modelStr.slice(slashIdx + 1);
        resolvedModelInstance = modelRuntime.getModel(providerId, modelId) ?? modelRuntime.getPhysicalModel(providerId, modelId);
        if (!resolvedModelInstance) {
          throw new Error(`Unknown requested model: ${modelStr}`);
        }
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
          if (!isToolAllowed(event.toolName, this._agent.allowedTools, this._agent.deniedTools)) {
            return { block: true, reason: `Tool ${event.toolName} is not allowed for agent ${this._agent.id}` };
          }
        });

        childPi.on("before_agent_start", async () => {
          const allTools = childPi.getAllTools().map((t) => t.name);
          const targetTools = allTools.filter((toolName) =>
            isToolAllowed(toolName, this._agent.allowedTools, this._agent.deniedTools),
          );
          childPi.setActiveTools(targetTools);
        });
      });

      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        extensionFactories,
        // Child lifecycles must never load the host's UI extensions or ambient resources.
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPromptOverride: () => undefined,
        appendSystemPrompt: [],
      });
      await resourceLoader.reload();

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

      if (event.type === "message_update") {
        const streamEvent = event.assistantMessageEvent;
        if (streamEvent.type === "text_delta" && typeof streamEvent.delta === "string") {
          latestAssistantText += streamEvent.delta;
          this._options.onTextDelta?.(streamEvent.delta);
        }
      }

      if (event.type === "message_end") {
        const msg = event.message;
        if (msg.role === "assistant") {
          turns++;
          if (msg.usage) {
            inputTokens += msg.usage.input;
            outputTokens += msg.usage.output;
            cacheReadTokens += msg.usage.cacheRead;
            cacheWriteTokens += msg.usage.cacheWrite;
            totalTokens += msg.usage.totalTokens;
            totalCost += msg.usage.cost.total;
            this._options.onUsage?.(collectUsage());
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
      // Build prompt prefix if guidelines or appendPrompts are defined
      let promptToSend = taskPrompt;
      const promptAdditions: string[] = [];

      if (this._agent.systemPrompt) {
        promptAdditions.push(this._agent.systemPrompt);
      }
      if (this._agent.appendPrompt) {
        promptAdditions.push(this._agent.appendPrompt);
      }
      if (this._agent.promptGuidelines.length > 0) {
        promptAdditions.push("Guidelines:\n" + this._agent.promptGuidelines.map((g) => `- ${g}`).join("\n"));
      }

      if (promptAdditions.length > 0) {
        promptToSend = `${promptAdditions.join("\n\n")}\n\nTask:\n${taskPrompt}`;
      }

      await session.prompt(promptToSend);

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
