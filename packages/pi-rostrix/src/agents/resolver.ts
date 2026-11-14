import {
  type AgentDefinition,
  type AgentMcpServer,
  type ContextInheritMode,
  type ExtensionInheritMode,
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
  readonly inheritSystemPrompt?: ContextInheritMode | undefined;
  readonly inheritAppendSystemPrompt?: ContextInheritMode | undefined;
  readonly contextFiles?: {
    readonly inherit: ContextInheritMode;
    readonly paths: readonly string[];
    readonly exclude: readonly string[];
  } | undefined;
  /** One allow-list; additional lists are conjunctive, not alternative patterns. */
  readonly allowedTools?: readonly string[] | undefined;
  readonly toolAllowConstraints?: readonly (readonly string[])[] | undefined;
  /** Concrete parent tool identities, never glob patterns. */
  readonly parentActiveTools?: readonly string[] | undefined;
  readonly deniedTools: readonly string[];
  readonly mcpServers: Readonly<Record<string, AgentMcpServer>>;
  readonly skills?: {
    readonly inherit: ExtensionInheritMode;
    readonly paths: readonly string[];
    readonly exclude: readonly string[];
  } | undefined;
  readonly allowedSkills?: readonly string[] | undefined;
  readonly skillAllowConstraints?: readonly (readonly string[])[] | undefined;
  readonly deniedSkills: readonly string[];
  readonly promptTemplates?: {
    readonly inherit: ExtensionInheritMode;
    readonly paths: readonly string[];
    readonly exclude: readonly string[];
    readonly allow?: readonly string[] | undefined;
    readonly allowConstraints?: readonly (readonly string[])[] | undefined;
    readonly deny: readonly string[];
  } | undefined;
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
  readonly extensions?: {
    readonly inherit: ExtensionInheritMode;
    readonly paths: readonly string[];
    readonly exclude: readonly string[];
  } | undefined;
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

function isAllowedByConstraints(
  name: string,
  allow?: readonly string[] | undefined,
  constraints?: readonly (readonly string[])[] | undefined,
  deny?: readonly string[] | undefined,
): boolean {
  return isToolAllowed(name, allow, deny)
    && (constraints ?? []).every((group) => isToolAllowed(name, group));
}

/** Complete tool policy: every allow-list must match, denies always win. */
export function isAgentToolAllowed(name: string, agent: ResolvedAgentDefinition): boolean {
  return isAllowedByConstraints(name, agent.allowedTools, agent.toolAllowConstraints, agent.deniedTools)
    && (agent.parentActiveTools === undefined || agent.parentActiveTools.includes(name));
}

/** Complete skill policy: every allow-list in the inheritance chain must match, denies always win. */
export function isAgentSkillAllowed(name: string, agent: ResolvedAgentDefinition): boolean {
  return isAllowedByConstraints(name, agent.allowedSkills, agent.skillAllowConstraints, agent.deniedSkills);
}

/** Complete prompt-template policy: every allow-list in the inheritance chain must match, denies always win. */
export function isAgentPromptTemplateAllowed(name: string, agent: ResolvedAgentDefinition): boolean {
  return isAllowedByConstraints(name, agent.promptTemplates?.allow, agent.promptTemplates?.allowConstraints, agent.promptTemplates?.deny);
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
    let inheritSystemPrompt: ContextInheritMode | undefined;
    let inheritAppendSystemPrompt: ContextInheritMode | undefined;

    let contextInherit: ContextInheritMode | undefined;
    const contextPaths: string[] = [];
    const contextExclude: string[] = [];

    let allowedTools: string[] | undefined;
    const toolAllowConstraints: (readonly string[])[] = [];
    const deniedTools: string[] = [];
    const mcpServers: Record<string, AgentMcpServer> = {};

    let skillInherit: ExtensionInheritMode | undefined;
    const skillPaths: string[] = [];
    const skillExclude: string[] = [];
    let allowedSkills: string[] | undefined;
    const skillAllowConstraints: (readonly string[])[] = [];
    const deniedSkills: string[] = [];

    let promptTemplateInherit: ExtensionInheritMode | undefined;
    const promptTemplatePaths: string[] = [];
    const promptTemplateExclude: string[] = [];
    let allowedPromptTemplates: string[] | undefined;
    const promptTemplateAllowConstraints: (readonly string[])[] = [];
    const deniedPromptTemplates: string[] = [];

    let preferredModel: string | undefined;
    let fallbackModel: string | undefined;

    let allowedAgents: string[] | undefined;
    let maxDepth: number | undefined;
    let maxConcurrent: number | undefined;

    const wakeOn = new Set<SupervisionWakeTrigger>();
    let reviewIntervalSeconds: number | undefined;
    let maxDurationSeconds: number | undefined;

    let extensionInherit: ExtensionInheritMode | undefined;
    const extensionPaths: string[] = [];
    const extensionExclude: string[] = [];

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
      if (agent.prompt?.inheritSystemPrompt !== undefined) {
        inheritSystemPrompt = agent.prompt.inheritSystemPrompt;
      }
      if (agent.prompt?.inheritAppendSystemPrompt !== undefined) {
        inheritAppendSystemPrompt = agent.prompt.inheritAppendSystemPrompt;
      }

      if (agent.contextFiles?.inherit !== undefined) {
        contextInherit = agent.contextFiles.inherit;
      }
      if (agent.contextFiles?.paths) {
        for (const p of agent.contextFiles.paths) {
          if (!contextPaths.includes(p)) contextPaths.push(p);
        }
      }
      if (agent.contextFiles?.exclude) {
        for (const p of agent.contextFiles.exclude) {
          if (!contextExclude.includes(p)) contextExclude.push(p);
        }
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

      if (agent.skills?.inherit !== undefined) {
        skillInherit = agent.skills.inherit;
      }
      if (agent.skills?.paths) {
        for (const p of agent.skills.paths) {
          if (!skillPaths.includes(p)) skillPaths.push(p);
        }
      }
      if (agent.skills?.exclude) {
        for (const p of agent.skills.exclude) {
          if (!skillExclude.includes(p)) skillExclude.push(p);
        }
      }
      if (agent.skills?.allow !== undefined) {
        if (allowedSkills !== undefined) {
          skillAllowConstraints.push(Object.freeze(allowedSkills));
        }
        allowedSkills = [...agent.skills.allow];
      }
      if (agent.skills?.deny) {
        deniedSkills.push(...agent.skills.deny);
      }

      if (agent.promptTemplates?.inherit !== undefined) {
        promptTemplateInherit = agent.promptTemplates.inherit;
      }
      if (agent.promptTemplates?.paths) {
        for (const p of agent.promptTemplates.paths) {
          if (!promptTemplatePaths.includes(p)) promptTemplatePaths.push(p);
        }
      }
      if (agent.promptTemplates?.exclude) {
        for (const p of agent.promptTemplates.exclude) {
          if (!promptTemplateExclude.includes(p)) promptTemplateExclude.push(p);
        }
      }
      if (agent.promptTemplates?.allow !== undefined) {
        if (allowedPromptTemplates !== undefined) {
          promptTemplateAllowConstraints.push(Object.freeze(allowedPromptTemplates));
        }
        allowedPromptTemplates = [...agent.promptTemplates.allow];
      }
      if (agent.promptTemplates?.deny) {
        deniedPromptTemplates.push(...agent.promptTemplates.deny);
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

      if (agent.extensions?.inherit !== undefined) {
        extensionInherit = agent.extensions.inherit;
      }
      if (agent.extensions?.paths) {
        for (const p of agent.extensions.paths) {
          if (!extensionPaths.includes(p)) extensionPaths.push(p);
        }
      }
      if (agent.extensions?.exclude) {
        for (const p of agent.extensions.exclude) {
          if (!extensionExclude.includes(p)) extensionExclude.push(p);
        }
      }
    }

    if (allowedSkills !== undefined && deniedSkills.length > 0) {
      allowedSkills = allowedSkills.filter((s) => !deniedSkills.some((pat) => matchesPattern(s, pat)));
    }
    if (allowedPromptTemplates !== undefined && deniedPromptTemplates.length > 0) {
      allowedPromptTemplates = allowedPromptTemplates.filter((p) => !deniedPromptTemplates.some((pat) => matchesPattern(p, pat)));
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
      inheritSystemPrompt: inheritSystemPrompt ?? "none",
      inheritAppendSystemPrompt: inheritAppendSystemPrompt ?? "none",
      contextFiles: Object.freeze({
        inherit: contextInherit ?? "none",
        paths: Object.freeze(contextPaths),
        exclude: Object.freeze(contextExclude),
      }),
      ...(allowedTools !== undefined ? { allowedTools: Object.freeze(allowedTools) } : {}),
      toolAllowConstraints: Object.freeze(toolAllowConstraints),
      deniedTools: Object.freeze(deniedTools),
      mcpServers: Object.freeze(mcpServers),
      skills: Object.freeze({
        inherit: skillInherit ?? "none",
        paths: Object.freeze(skillPaths),
        exclude: Object.freeze(skillExclude),
      }),
      ...(allowedSkills !== undefined ? { allowedSkills: Object.freeze(allowedSkills) } : {}),
      skillAllowConstraints: Object.freeze(skillAllowConstraints),
      deniedSkills: Object.freeze(deniedSkills),
      promptTemplates: Object.freeze({
        inherit: promptTemplateInherit ?? "none",
        paths: Object.freeze(promptTemplatePaths),
        exclude: Object.freeze(promptTemplateExclude),
        ...(allowedPromptTemplates !== undefined ? { allow: Object.freeze(allowedPromptTemplates) } : {}),
        allowConstraints: Object.freeze(promptTemplateAllowConstraints),
        deny: Object.freeze(deniedPromptTemplates),
      }),
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
      extensions: Object.freeze({
        inherit: extensionInherit ?? "none",
        paths: Object.freeze(extensionPaths),
        exclude: Object.freeze(extensionExclude),
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

