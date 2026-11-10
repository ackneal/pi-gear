import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ModelRuntime,
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
  readonly signal?: AbortSignal | undefined;
  readonly onEvent?: ((event: AgentSessionEvent) => void) | undefined;
  readonly onTextDelta?: ((delta: string) => void) | undefined;
}

export interface SubagentTaskResult {
  readonly status: "completed" | "failed" | "aborted";
  readonly result?: string | undefined;
  readonly error?: string | undefined;
  readonly usage: SubagentUsage;
  readonly turns: number;
  readonly durationMs: number;
}

export class InProcessSubagentRunner {
  private readonly _agent: ResolvedAgent;
  private readonly _options: SubagentSessionOptions;

  constructor(options: SubagentSessionOptions) {
    const resolved = options.agent ?? options.profile;
    if (!resolved) {
      throw new Error("InProcessSubagentRunner requires an agent or profile option");
    }
    this._agent = resolved;
    this._options = options;
  }

  async run(taskPrompt: string): Promise<SubagentTaskResult> {
    const startedAt = Date.now();
    let turns = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalCost = 0;
    let latestAssistantText = "";

    const cwd = this._options.cwd ?? (this._options.parentSession ? (this._options.parentSession as any)._cwd : process.cwd());
    const agentDir = (this._options.parentSession as any)?._agentDir ?? getAgentDir();

    // Use in-memory session manager so no session JSONL files pollute the disk
    const inMemorySessionManager = SessionManager.inMemory();

    const modelRuntime = this._options.modelRuntime ?? (this._options.parentSession ? this._options.parentSession.modelRuntime : undefined);

    let sessionResult;
    try {
      const thinkingLevel = this._options.thinkingLevel ?? this._agent.model?.thinkingLevel;
      const modelStr = this._options.model ?? this._agent.model?.preferred;

      let resolvedModelInstance: any = undefined;
      if (modelStr && modelRuntime) {
        const slashIdx = modelStr.indexOf("/");
        if (slashIdx > 0) {
          const providerId = modelStr.slice(0, slashIdx);
          const modelId = modelStr.slice(slashIdx + 1);
          resolvedModelInstance = modelRuntime.getModel(providerId, modelId) ?? modelRuntime.getPhysicalModel(providerId, modelId);
        }
      }

      const mcpServerEntries = Object.entries(this._agent.mcpServers);
      const hasMcpServers = mcpServerEntries.length > 0;

      const extensionFactories: any[] = [];
      if (hasMcpServers) {
        extensionFactories.push(createMcpExtension());
      }

      extensionFactories.push((childPi: ExtensionAPI) => {
        if (hasMcpServers) {
          for (const [name, config] of mcpServerEntries) {
            childPi.registerMcpServer(name, config as any);
          }
        }

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
      });
      await resourceLoader.reload();

      sessionResult = await createAgentSession({
        cwd,
        sessionManager: inMemorySessionManager,
        resourceLoader,
        ...(modelRuntime ? { modelRuntime } : {}),
        ...(resolvedModelInstance ? { model: resolvedModelInstance } : {}),
        ...(this._options.customTools ? { customTools: this._options.customTools } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });

      await sessionResult.session.bindExtensions({ mode: "json" });
    } catch (createErr) {
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

      if (event.type === "message_update" && (event as any).assistantMessageEvent) {
        const streamEvent = (event as any).assistantMessageEvent;
        if (streamEvent.type === "text_delta" && typeof streamEvent.delta === "string") {
          latestAssistantText += streamEvent.delta;
          this._options.onTextDelta?.(streamEvent.delta);
        }
      }

      if (event.type === "message_end" && (event as any).message) {
        const msg = (event as any).message;
        if (msg.role === "assistant") {
          turns++;
          if (msg.usage) {
            inputTokens += msg.usage.inputTokens ?? 0;
            outputTokens += msg.usage.outputTokens ?? 0;
            cacheReadTokens += msg.usage.cacheReadTokens ?? 0;
            cacheWriteTokens += msg.usage.cacheWriteTokens ?? 0;
            totalCost += msg.usage.cost?.total ?? 0;
          }
          if (Array.isArray(msg.content)) {
            const texts = msg.content
              .filter((c: any) => c.type === "text" && typeof c.text === "string")
              .map((c: any) => c.text);
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

      const usage: SubagentUsage = {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: inputTokens + outputTokens,
        cost: totalCost,
      };

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
      const usage: SubagentUsage = {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: inputTokens + outputTokens,
        cost: totalCost,
      };

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
      session.dispose();
    }
  }
}
