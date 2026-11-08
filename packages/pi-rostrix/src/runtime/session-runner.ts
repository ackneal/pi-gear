import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ResolvedProfile } from "../core/resolver.ts";

export type SubagentUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
};

export interface SubagentSessionOptions {
  readonly profile: ResolvedProfile;
  readonly cwd?: string | undefined;
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
  private readonly _profile: ResolvedProfile;
  private readonly _options: SubagentSessionOptions;

  constructor(options: SubagentSessionOptions) {
    this._profile = options.profile;
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

    // Resolve tools allowlist
    const toolsAllowlist = this._profile.allowedTools
      ? Array.from(this._profile.allowedTools)
      : undefined;

    // Use in-memory session manager so no session JSONL files pollute the disk
    const inMemorySessionManager = SessionManager.inMemory();

    const modelRuntime = this._options.modelRuntime ?? (this._options.parentSession ? this._options.parentSession.modelRuntime : undefined);

    let sessionResult;
    try {
      sessionResult = await createAgentSession({
        cwd,
        sessionManager: inMemorySessionManager,
        ...(modelRuntime ? { modelRuntime } : {}),
        ...(toolsAllowlist ? { tools: toolsAllowlist } : {}),
        ...(this._profile.deniedTools.length > 0 ? { excludeTools: Array.from(this._profile.deniedTools) } : {}),
        ...(this._options.customTools ? { customTools: this._options.customTools } : {}),
        ...(this._profile.model?.thinkingLevel ? { thinkingLevel: this._profile.model.thinkingLevel } : {}),
      });
    } catch (createErr) {
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

      if (this._profile.systemPrompt) {
        promptAdditions.push(this._profile.systemPrompt);
      }
      if (this._profile.appendPrompt) {
        promptAdditions.push(this._profile.appendPrompt);
      }
      if (this._profile.promptGuidelines.length > 0) {
        promptAdditions.push("Guidelines:\n" + this._profile.promptGuidelines.map((g) => `- ${g}`).join("\n"));
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
