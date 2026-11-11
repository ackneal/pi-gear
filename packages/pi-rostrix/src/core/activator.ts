import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolAllowed, type ResolvedAgent } from "./resolver.ts";
import type { ThinkingLevel } from "./schema.ts";

export interface ActiveAgentSnapshot {
  readonly agentId: string;
  readonly thinkingLevel?: ThinkingLevel | undefined;
  readonly registeredMcpServers: readonly string[];
}

export class AgentActivationError extends Error {
  readonly rollbackSuccessful: boolean;

  constructor(message: string, rollbackSuccessful: boolean, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "AgentActivationError";
    this.rollbackSuccessful = rollbackSuccessful;
  }
}

export class AgentActivator {
  private readonly _pi: ExtensionAPI;
  private _activeAgent?: ResolvedAgent | undefined;
  private _baselineTools?: string[] | undefined;
  private _registeredMcpServers = new Set<string>();
  private _removeBeforeAgentStartHook?: (() => void) | undefined;

  constructor(pi: ExtensionAPI) {
    this._pi = pi;
  }

  get activeAgent(): ResolvedAgent | undefined {
    return this._activeAgent;
  }

  // Alias for backward compatibility
  get activeProfile(): ResolvedAgent | undefined {
    return this._activeAgent;
  }

  deactivate(): void {
    if (!this._activeAgent) return;

    this._pi.setActiveTools([...this._baselineTools!]);

    for (const current of this._registeredMcpServers) {
      if (typeof (this._pi as any).unregisterMcpServer === "function") {
        (this._pi as any).unregisterMcpServer(current);
      }
    }
    this._registeredMcpServers.clear();

    this._removeBeforeAgentStartHook?.();
    this._removeBeforeAgentStartHook = undefined;
    this._activeAgent = undefined;
    this._baselineTools = undefined;
  }

  async activate(agent: ResolvedAgent): Promise<void> {
    const priorSnapshot = this._createSnapshot();
    const priorTools = [...this._pi.getActiveTools()];

    try {
      this._applyTools(agent);
      this._applyMcpServers(agent);
      this._applyThinkingLevel(agent);
      this._installPromptHook(agent);

      this._baselineTools ??= priorTools;
      this._activeAgent = agent;
    } catch (error) {
      const rollbackSuccess = await this._rollback(priorSnapshot, priorTools);
      throw new AgentActivationError(
        `Failed to activate agent '${agent.id}': ${error instanceof Error ? error.message : String(error)}`,
        rollbackSuccess,
        error,
      );
    }
  }

  private _createSnapshot(): ActiveAgentSnapshot | undefined {
    if (!this._activeAgent) return undefined;

    return {
      agentId: this._activeAgent.id,
      thinkingLevel: this._pi.getThinkingLevel ? this._pi.getThinkingLevel() : undefined,
      registeredMcpServers: Object.freeze(Array.from(this._registeredMcpServers)),
    };
  }

  private _applyTools(agent: ResolvedAgent): void {
    const available = this._pi.getAllTools().map((t) => t.name);
    const targetTools = available.filter((toolName) =>
      isToolAllowed(toolName, agent.allowedTools, agent.deniedTools),
    );

    this._pi.setActiveTools(targetTools);
  }

  private _applyMcpServers(agent: ResolvedAgent): void {
    const desired = new Set(Object.keys(agent.mcpServers));

    for (const current of this._registeredMcpServers) {
      if (!desired.has(current)) {
        if (typeof (this._pi as any).unregisterMcpServer === "function") {
          (this._pi as any).unregisterMcpServer(current);
        }
        this._registeredMcpServers.delete(current);
      }
    }

    for (const [name, config] of Object.entries(agent.mcpServers)) {
      if (typeof (this._pi as any).registerMcpServer === "function") {
        (this._pi as any).registerMcpServer(name, config);
        this._registeredMcpServers.add(name);
      }
    }
  }

  private _applyThinkingLevel(agent: ResolvedAgent): void {
    const level = agent.model?.thinkingLevel;
    if (level && typeof this._pi.setThinkingLevel === "function") {
      this._pi.setThinkingLevel(level);
    }
  }

  private _installPromptHook(agent: ResolvedAgent): void {
    this._removeBeforeAgentStartHook?.();

    if (
      !agent.systemPrompt &&
      !agent.appendPrompt &&
      agent.promptGuidelines.length === 0
    ) {
      this._removeBeforeAgentStartHook = undefined;
      return;
    }

    const unsubscribe = this._pi.on("before_agent_start", async (event) => {
      if (agent.promptGuidelines.length > 0 && event.systemPromptOptions?.promptGuidelines) {
        event.systemPromptOptions.promptGuidelines.push(...agent.promptGuidelines);
      }

      if (agent.appendPrompt) {
        if (event.systemPromptOptions?.appendSystemPrompt) {
          event.systemPromptOptions.appendSystemPrompt += `\n\n${agent.appendPrompt}`;
        } else if (event.systemPromptOptions) {
          event.systemPromptOptions.appendSystemPrompt = agent.appendPrompt;
        }
      }

      if (agent.systemPrompt && event.systemPromptOptions) {
        event.systemPromptOptions.customPrompt = agent.systemPrompt;
      }
    });

    this._removeBeforeAgentStartHook = unsubscribe;
  }

  private async _rollback(snapshot: ActiveAgentSnapshot | undefined, priorTools: string[]): Promise<boolean> {
    try {
      this._pi.setActiveTools(priorTools);

      if (!snapshot) {
        this._activeAgent = undefined;
        this._removeBeforeAgentStartHook?.();
        this._removeBeforeAgentStartHook = undefined;
        return true;
      }

      if (snapshot.thinkingLevel && typeof this._pi.setThinkingLevel === "function") {
        this._pi.setThinkingLevel(snapshot.thinkingLevel);
      }

      for (const mcp of this._registeredMcpServers) {
        if (!snapshot.registeredMcpServers.includes(mcp)) {
          if (typeof (this._pi as any).unregisterMcpServer === "function") {
            (this._pi as any).unregisterMcpServer(mcp);
          }
          this._registeredMcpServers.delete(mcp);
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this._removeBeforeAgentStartHook?.();
    this._removeBeforeAgentStartHook = undefined;
    this._activeAgent = undefined;
    this._registeredMcpServers.clear();
    this._baselineTools = undefined;
  }
}

// Aliases for compatibility
export const ProfileActivationError = AgentActivationError;
export type ProfileActivationError = AgentActivationError;
export const ProfileActivator = AgentActivator;
export type ProfileActivator = AgentActivator;
export type ActiveProfileSnapshot = ActiveAgentSnapshot;
