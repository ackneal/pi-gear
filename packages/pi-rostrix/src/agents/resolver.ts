import {
  type AgentDefinition,
  type AgentMcpServer,
  type SupervisionWakeTrigger,
} from "./schema.ts";
import type { AgentRegistry } from "./registry.ts";

export class AgentInheritanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInheritanceError";
  }
}

export interface ResolvedAgentDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly systemPrompt?: string | undefined;
  readonly appendPrompt?: string | undefined;
  readonly promptGuidelines: readonly string[];
  /** One allow-list; additional lists are conjunctive, not alternative patterns. */
  readonly allowedTools?: readonly string[] | undefined;
  readonly toolAllowConstraints?: readonly (readonly string[])[] | undefined;
  /** Concrete parent tool identities, never glob patterns. */
  readonly parentActiveTools?: readonly string[] | undefined;
  readonly deniedTools: readonly string[];
  readonly mcpServers: Readonly<Record<string, AgentMcpServer>>;
  readonly allowedSkills?: readonly string[] | undefined;
  readonly deniedSkills: readonly string[];
  readonly model?: {
    readonly preferred?: string | undefined;
    readonly fallback?: string | undefined;
  } | undefined;
  readonly subagents: {
    readonly allowedAgents?: readonly string[] | undefined;
    readonly maxDepth: number;
    readonly maxConcurrent: number;
  };
  readonly supervision: {
    readonly wakeOn: ReadonlySet<SupervisionWakeTrigger>;
    readonly reviewIntervalSeconds?: number | undefined;
    readonly maxDurationSeconds?: number | undefined;
  };
}

export interface ParentDelegationLimits {
  readonly activeTools?: readonly string[] | undefined;
  readonly allowedAgents?: readonly string[] | undefined;
  readonly currentDepth?: number | undefined;
}

export function matchesPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return name === pattern;
  const regexStr = "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
  return new RegExp(regexStr).test(name);
}

export function isToolAllowed(name: string, allow?: readonly string[] | undefined, deny?: readonly string[] | undefined): boolean {
  if (deny && deny.some((pat) => matchesPattern(name, pat))) {
    return false;
  }
  if (!allow) {
    return true;
  }
  return allow.some((pat) => matchesPattern(name, pat));
}

/** Complete tool policy: every allow-list must match, denies always win. */
export function isAgentToolAllowed(name: string, agent: ResolvedAgentDefinition): boolean {
  return isToolAllowed(name, agent.allowedTools, agent.deniedTools)
    && (agent.toolAllowConstraints ?? []).every((allow) => isToolAllowed(name, allow))
    && (agent.parentActiveTools === undefined || agent.parentActiveTools.includes(name));
}

export class AgentResolver {
  private readonly _registry: AgentRegistry;

  constructor(registry: AgentRegistry) {
    this._registry = registry;
  }

  resolve(agentId: string, parentLimits?: ParentDelegationLimits | undefined): ResolvedAgentDefinition {
    const chain = this._resolveInheritanceChain(agentId);
    let resolved = this._mergeChain(chain);

    if (parentLimits) {
      resolved = this._applyParentLimits(resolved, parentLimits);
    }

    return Object.freeze(resolved);
  }

  private _resolveInheritanceChain(agentId: string): AgentDefinition[] {
    const chain: AgentDefinition[] = [];
    const visited = new Set<string>();
    let currentId: string | undefined = agentId;

    while (currentId) {
      if (visited.has(currentId)) {
        const cycle = [...Array.from(visited), currentId].join(" -> ");
        throw new AgentInheritanceError(`Circular agent inheritance detected: ${cycle}`);
      }
      visited.add(currentId);

      const agent = this._registry.get(currentId);
      if (!agent) {
        throw new AgentInheritanceError(`Agent '${currentId}' not found in registry`);
      }

      chain.unshift(agent);
      currentId = agent.extends;
    }

    return chain;
  }

  private _mergeChain(chain: AgentDefinition[]): ResolvedAgentDefinition {
    const target = chain.at(-1)!;
    let systemPrompt: string | undefined;
    const appendPrompts: string[] = [];
    const guidelines: string[] = [];

    let allowedTools: string[] | undefined;
    const toolAllowConstraints: (readonly string[])[] = [];
    const deniedTools: string[] = [];
    const mcpServers: Record<string, AgentMcpServer> = {};

    let allowedSkills: string[] | undefined;
    const deniedSkills: string[] = [];

    let preferredModel: string | undefined;
    let fallbackModel: string | undefined;

    let allowedAgents: string[] | undefined;
    let maxDepth: number | undefined;
    let maxConcurrent: number | undefined;

    const wakeOn = new Set<SupervisionWakeTrigger>();
    let reviewIntervalSeconds: number | undefined;
    let maxDurationSeconds: number | undefined;

    for (const agent of chain) {
      if (agent.prompt?.systemPrompt !== undefined) {
        systemPrompt = agent.prompt.systemPrompt;
      }
      if (agent.prompt?.appendPrompt) {
        appendPrompts.push(agent.prompt.appendPrompt);
      }
      if (agent.prompt?.guidelines) {
        guidelines.push(...agent.prompt.guidelines);
      }

      if (agent.tools?.allow !== undefined) {
        if (allowedTools !== undefined) {
          toolAllowConstraints.push(Object.freeze(allowedTools));
        }
        allowedTools = [...agent.tools.allow];
      }
      if (agent.tools?.deny) {
        deniedTools.push(...agent.tools.deny);
      }

      if (agent.mcpServers) {
        for (const [name, config] of Object.entries(agent.mcpServers)) {
          mcpServers[name] = { ...mcpServers[name], ...config };
        }
      }

      if (agent.skills?.allow !== undefined) {
        if (allowedSkills === undefined) {
          allowedSkills = [...agent.skills.allow];
        } else {
          allowedSkills = allowedSkills.filter((s) => agent.skills!.allow!.includes(s));
        }
      }
      if (agent.skills?.deny) {
        deniedSkills.push(...agent.skills.deny);
      }

      if (agent.model?.preferred !== undefined) {
        preferredModel = agent.model.preferred;
      }
      if (agent.model?.fallback !== undefined) {
        fallbackModel = agent.model.fallback;
      }

      const rawAllowedAgents = agent.subagents?.allowedAgents;
      if (rawAllowedAgents !== undefined) {
        if (allowedAgents === undefined) {
          allowedAgents = [...rawAllowedAgents];
        } else {
          allowedAgents = allowedAgents.filter((p) => rawAllowedAgents.includes(p));
        }
      }
      if (agent.subagents?.maxDepth !== undefined) {
        maxDepth = maxDepth !== undefined ? Math.min(maxDepth, agent.subagents.maxDepth) : agent.subagents.maxDepth;
      }
      if (agent.subagents?.maxConcurrent !== undefined) {
        maxConcurrent = maxConcurrent !== undefined ? Math.min(maxConcurrent, agent.subagents.maxConcurrent) : agent.subagents.maxConcurrent;
      }

      if (agent.supervision?.wakeOn) {
        for (const trigger of agent.supervision.wakeOn) {
          wakeOn.add(trigger);
        }
      }
      if (agent.supervision?.reviewIntervalSeconds !== undefined) {
        reviewIntervalSeconds = reviewIntervalSeconds !== undefined
          ? Math.min(reviewIntervalSeconds, agent.supervision.reviewIntervalSeconds)
          : agent.supervision.reviewIntervalSeconds;
      }
      if (agent.supervision?.maxDurationSeconds !== undefined) {
        maxDurationSeconds = maxDurationSeconds !== undefined
          ? Math.min(maxDurationSeconds, agent.supervision.maxDurationSeconds)
          : agent.supervision.maxDurationSeconds;
      }
    }

    if (allowedSkills !== undefined && deniedSkills.length > 0) {
      allowedSkills = allowedSkills.filter((s) => !deniedSkills.includes(s));
    }

    const modelConfig = (preferredModel || fallbackModel)
      ? {
          ...(preferredModel !== undefined ? { preferred: preferredModel } : {}),
          ...(fallbackModel !== undefined ? { fallback: fallbackModel } : {}),
        }
      : undefined;

    return {
      id: target.id,
      label: target.label,
      description: target.description,
      ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      ...(appendPrompts.length > 0 ? { appendPrompt: appendPrompts.join("\n\n") } : {}),
      promptGuidelines: Object.freeze(guidelines),
      ...(allowedTools !== undefined ? { allowedTools: Object.freeze(allowedTools) } : {}),
      toolAllowConstraints: Object.freeze(toolAllowConstraints),
      deniedTools: Object.freeze(deniedTools),
      mcpServers: Object.freeze(mcpServers),
      ...(allowedSkills !== undefined ? { allowedSkills: Object.freeze(allowedSkills) } : {}),
      deniedSkills: Object.freeze(deniedSkills),
      ...(modelConfig ? { model: Object.freeze(modelConfig) } : {}),
      subagents: Object.freeze({
        ...(allowedAgents !== undefined ? { allowedAgents: Object.freeze(allowedAgents) } : {}),
        maxDepth: maxDepth ?? 2,
        maxConcurrent: maxConcurrent ?? 2,
      }),
      supervision: Object.freeze({
        wakeOn: Object.freeze(wakeOn),
        ...(reviewIntervalSeconds !== undefined ? { reviewIntervalSeconds } : {}),
        ...(maxDurationSeconds !== undefined ? { maxDurationSeconds } : {}),
      }),
    };
  }

  private _applyParentLimits(resolved: ResolvedAgentDefinition, parentLimits: ParentDelegationLimits): ResolvedAgentDefinition {
    let effectiveAllowedTools = resolved.allowedTools;

    if (parentLimits.activeTools !== undefined) {
      effectiveAllowedTools = Object.freeze(
        parentLimits.activeTools.filter((tool) => isAgentToolAllowed(tool, resolved)),
      );
    }

    const parentAllowed = parentLimits.allowedAgents;
    let effectiveAllowedAgents = resolved.subagents.allowedAgents;
    if (parentAllowed !== undefined) {
      if (effectiveAllowedAgents === undefined) {
        effectiveAllowedAgents = Object.freeze([...parentAllowed]);
      } else {
        effectiveAllowedAgents = Object.freeze(
          effectiveAllowedAgents.filter((p) => parentAllowed!.includes(p)),
        );
      }
    }

    let remainingDepth = resolved.subagents.maxDepth;
    if (parentLimits.currentDepth !== undefined) {
      remainingDepth = Math.max(0, remainingDepth - parentLimits.currentDepth);
    }

    return {
      ...resolved,
      ...(parentLimits.activeTools !== undefined ? { parentActiveTools: effectiveAllowedTools } : {}),
      ...(effectiveAllowedTools !== undefined ? { allowedTools: effectiveAllowedTools } : {}),
      subagents: Object.freeze({
        ...resolved.subagents,
        ...(effectiveAllowedAgents !== undefined ? { allowedAgents: effectiveAllowedAgents } : {}),
        maxDepth: remainingDepth,
      }),
    };
  }
}

