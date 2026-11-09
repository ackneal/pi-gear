import { Value } from "typebox/value";
import { AgentDefinitionSchema, type AgentDefinition } from "./schema.ts";

export class AgentValidationError extends Error {
  readonly agentId?: string | undefined;
  readonly errors: Array<{ path: string; message: string }>;

  constructor(message: string, errors: Array<{ path: string; message: string }> = [], agentId?: string | undefined) {
    super(message);
    this.name = "AgentValidationError";
    this.agentId = agentId;
    this.errors = errors;
  }
}

export class AgentRegistry {
  private readonly _agents = new Map<string, AgentDefinition>();

  register(agent: AgentDefinition): void {
    if (!agent || typeof agent !== "object") {
      throw new AgentValidationError("Agent definition must be a non-null object", [
        { path: "", message: "Expected object" },
      ]);
    }

    const errors = [...Value.Errors(AgentDefinitionSchema, agent)];
    if (errors.length > 0) {
      const formatted = errors.map((e) => ({
        path: (e as any).path ?? "",
        message: e.message,
      }));
      const id = typeof (agent as any).id === "string" ? (agent as any).id : undefined;
      throw new AgentValidationError(
        `Invalid agent definition${id ? ` '${id}'` : ""}: ${formatted.map((e) => `${e.path || "root"}: ${e.message}`).join(", ")}`,
        formatted,
        id,
      );
    }

    if (this._agents.has(agent.id)) {
      throw new Error(`Agent '${agent.id}' is already registered in this registry`);
    }

    this._agents.set(agent.id, Object.freeze({ ...agent }));
  }

  unregister(id: string): boolean {
    return this._agents.delete(id);
  }

  get(id: string): AgentDefinition | undefined {
    return this._agents.get(id);
  }

  has(id: string): boolean {
    return this._agents.has(id);
  }

  list(): AgentDefinition[] {
    return Array.from(this._agents.values());
  }

  clear(): void {
    this._agents.clear();
  }
}

// Aliases for compatibility
export const ProfileValidationError = AgentValidationError;
export type ProfileValidationError = AgentValidationError;
export const ProfileRegistry = AgentRegistry;
export type ProfileRegistry = AgentRegistry;
