import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import { isAgentToolAllowed, type ResolvedAgent } from "./resolver.ts";
import type { AgentMcpServer } from "./schema.ts";

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

    this._applyMcpServers({});

    this._removeBeforeAgentStartHook?.();
    this._removeBeforeAgentStartHook = undefined;
    this._activeAgent = undefined;
    this._baselineTools = undefined;
  }

  async activate(agent: ResolvedAgent): Promise<void> {
    const priorTools = [...this._pi.getActiveTools()];

    try {
      this._applyTools(agent);
      this._applyMcpServers(agent.mcpServers);
      this._ensurePromptHook();

      this._baselineTools ??= priorTools;
      this._activeAgent = agent;
    } catch (error) {
      const rollbackSuccess = this._rollback(priorTools);
      throw new AgentActivationError(
        `Failed to activate agent '${agent.id}': ${error instanceof Error ? error.message : String(error)}`,
        rollbackSuccess,
        error,
      );
    }
  }

  private _applyTools(agent: ResolvedAgent): void {
    const available = this._pi.getAllTools().map((t) => t.name);
    const targetTools = available.filter((toolName) =>
      isAgentToolAllowed(toolName, agent),
    );

    this._pi.setActiveTools(targetTools);
  }

  private _applyMcpServers(servers: Readonly<Record<string, AgentMcpServer>>): void {
    for (const current of this._registeredMcpServers) {
      if (!Object.hasOwn(servers, current)) {
        this._pi.unregisterMcpServer(current);
        this._registeredMcpServers.delete(current);
      }
    }

    for (const [name, config] of Object.entries(servers)) {
      // Track attempted registrations so rollback also cleans up partial SDK failures.
      this._registeredMcpServers.add(name);
      // The SDK validates transports and normalizes exposure aliases at this boundary.
      this._pi.registerMcpServer(name, config as McpServerConfig);
    }
  }

  private _ensurePromptHook(): void {
    if (this._removeBeforeAgentStartHook) return;

    this._removeBeforeAgentStartHook = this._pi.on("before_agent_start", async (event) => {
      const agent = this._activeAgent;
      if (!agent) return;

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
  }

  private _rollback(priorTools: string[]): boolean {
    let successful = true;
    try {
      this._applyMcpServers(this._activeAgent?.mcpServers ?? {});
    } catch {
      successful = false;
    }

    try {
      this._pi.setActiveTools(priorTools);
    } catch {
      successful = false;
    }
    return successful;
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
