import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolAllowed, type ResolvedProfile } from "./resolver.ts";
import type { ThinkingLevel } from "./schema.ts";

export interface ActiveProfileSnapshot {
  readonly profileId: string;
  readonly activeTools: readonly string[];
  readonly thinkingLevel?: ThinkingLevel | undefined;
  readonly registeredMcpServers: readonly string[];
}

export class ProfileActivationError extends Error {
  readonly rollbackSuccessful: boolean;

  constructor(message: string, rollbackSuccessful: boolean, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ProfileActivationError";
    this.rollbackSuccessful = rollbackSuccessful;
  }
}

export class ProfileActivator {
  private readonly _pi: ExtensionAPI;
  private _activeProfile?: ResolvedProfile | undefined;
  private _registeredMcpServers = new Set<string>();
  private _removeBeforeAgentStartHook?: (() => void) | undefined;

  constructor(pi: ExtensionAPI) {
    this._pi = pi;
  }

  get activeProfile(): ResolvedProfile | undefined {
    return this._activeProfile;
  }

  deactivate(): void {
    if (!this._activeProfile) return;

    const allTools = this._pi.getAllTools().map((t) => t.name);
    this._pi.setActiveTools(allTools);

    for (const current of this._registeredMcpServers) {
      if (typeof (this._pi as any).unregisterMcpServer === "function") {
        (this._pi as any).unregisterMcpServer(current);
      }
    }
    this._registeredMcpServers.clear();

    this._removeBeforeAgentStartHook?.();
    this._removeBeforeAgentStartHook = undefined;
    this._activeProfile = undefined;
  }

  async activate(profile: ResolvedProfile): Promise<void> {
    const priorSnapshot = this._createSnapshot();

    try {
      this._applyTools(profile);
      this._applyMcpServers(profile);
      this._applyThinkingLevel(profile);
      this._installPromptHook(profile);

      this._activeProfile = profile;
    } catch (error) {
      const rollbackSuccess = await this._rollback(priorSnapshot);
      throw new ProfileActivationError(
        `Failed to activate profile '${profile.id}': ${error instanceof Error ? error.message : String(error)}`,
        rollbackSuccess,
        error,
      );
    }
  }

  private _createSnapshot(): ActiveProfileSnapshot | undefined {
    if (!this._activeProfile) return undefined;

    return {
      profileId: this._activeProfile.id,
      activeTools: Object.freeze([...this._pi.getActiveTools()]),
      thinkingLevel: this._pi.getThinkingLevel ? this._pi.getThinkingLevel() : undefined,
      registeredMcpServers: Object.freeze(Array.from(this._registeredMcpServers)),
    };
  }

  private _applyTools(profile: ResolvedProfile): void {
    const available = this._pi.getAllTools().map((t) => t.name);
    const targetTools = available.filter((toolName) =>
      isToolAllowed(toolName, profile.allowedTools, profile.deniedTools),
    );

    this._pi.setActiveTools(targetTools);
  }

  private _applyMcpServers(profile: ResolvedProfile): void {
    const desired = new Set(Object.keys(profile.mcpServers));

    for (const current of this._registeredMcpServers) {
      if (!desired.has(current)) {
        if (typeof (this._pi as any).unregisterMcpServer === "function") {
          (this._pi as any).unregisterMcpServer(current);
        }
        this._registeredMcpServers.delete(current);
      }
    }

    for (const [name, config] of Object.entries(profile.mcpServers)) {
      if (typeof (this._pi as any).registerMcpServer === "function") {
        (this._pi as any).registerMcpServer(name, config);
        this._registeredMcpServers.add(name);
      }
    }
  }

  private _applyThinkingLevel(profile: ResolvedProfile): void {
    const level = profile.model?.thinkingLevel;
    if (level && typeof this._pi.setThinkingLevel === "function") {
      this._pi.setThinkingLevel(level);
    }
  }

  private _installPromptHook(profile: ResolvedProfile): void {
    this._removeBeforeAgentStartHook?.();

    if (
      !profile.systemPrompt &&
      !profile.appendPrompt &&
      profile.promptGuidelines.length === 0
    ) {
      this._removeBeforeAgentStartHook = undefined;
      return;
    }

    const unsubscribe = this._pi.on("before_agent_start", async (event) => {
      if (profile.promptGuidelines.length > 0 && event.systemPromptOptions?.promptGuidelines) {
        event.systemPromptOptions.promptGuidelines.push(...profile.promptGuidelines);
      }

      if (profile.appendPrompt) {
        if (event.systemPromptOptions?.appendSystemPrompt) {
          event.systemPromptOptions.appendSystemPrompt += `\n\n${profile.appendPrompt}`;
        } else if (event.systemPromptOptions) {
          event.systemPromptOptions.appendSystemPrompt = profile.appendPrompt;
        }
      }

      if (profile.systemPrompt && event.systemPromptOptions) {
        event.systemPromptOptions.customPrompt = profile.systemPrompt;
      }
    });

    this._removeBeforeAgentStartHook = unsubscribe;
  }

  private async _rollback(snapshot: ActiveProfileSnapshot | undefined): Promise<boolean> {
    if (!snapshot) {
      this._activeProfile = undefined;
      this._removeBeforeAgentStartHook?.();
      this._removeBeforeAgentStartHook = undefined;
      return true;
    }

    try {
      this._pi.setActiveTools([...snapshot.activeTools]);
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
    this._activeProfile = undefined;
    this._registeredMcpServers.clear();
  }
}
