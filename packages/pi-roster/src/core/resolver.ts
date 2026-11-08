import {
  type ProfileDefinition,
  type ProfileMcpServer,
  type SupervisionWakeTrigger,
  type ThinkingLevel,
} from "./schema.ts";
import type { ProfileRegistry } from "./registry.ts";

export class ProfileInheritanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileInheritanceError";
  }
}

export interface ResolvedProfile {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly systemPrompt?: string | undefined;
  readonly appendPrompt?: string | undefined;
  readonly promptGuidelines: readonly string[];
  readonly allowedTools?: readonly string[] | undefined;
  readonly deniedTools: readonly string[];
  readonly mcpServers: Readonly<Record<string, ProfileMcpServer>>;
  readonly allowedSkills?: readonly string[] | undefined;
  readonly deniedSkills: readonly string[];
  readonly model?: {
    readonly preferred?: string | undefined;
    readonly fallback?: string | undefined;
    readonly thinkingLevel?: ThinkingLevel | undefined;
  } | undefined;
  readonly subagents: {
    readonly allowedProfiles?: readonly string[] | undefined;
    readonly maxDepth: number;
    readonly maxConcurrent: number;
  };
  readonly supervision: {
    readonly wakeOn: ReadonlySet<SupervisionWakeTrigger>;
    readonly reviewIntervalSeconds?: number | undefined;
    readonly maxDurationSeconds?: number | undefined;
  };
}

export interface ParentContextLimits {
  readonly activeTools?: readonly string[] | undefined;
  readonly allowedProfiles?: readonly string[] | undefined;
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

export class ProfileResolver {
  private readonly _registry: ProfileRegistry;

  constructor(registry: ProfileRegistry) {
    this._registry = registry;
  }

  resolve(profileId: string, parentLimits?: ParentContextLimits | undefined): ResolvedProfile {
    const chain = this._resolveInheritanceChain(profileId);
    let resolved = this._mergeChain(chain);

    if (parentLimits) {
      resolved = this._applyParentLimits(resolved, parentLimits);
    }

    return Object.freeze(resolved);
  }

  private _resolveInheritanceChain(profileId: string): ProfileDefinition[] {
    const chain: ProfileDefinition[] = [];
    const visited = new Set<string>();
    let currentId: string | undefined = profileId;

    while (currentId) {
      if (visited.has(currentId)) {
        const cycle = [...Array.from(visited), currentId].join(" -> ");
        throw new ProfileInheritanceError(`Circular profile inheritance detected: ${cycle}`);
      }
      visited.add(currentId);

      const profile = this._registry.get(currentId);
      if (!profile) {
        throw new ProfileInheritanceError(`Profile '${currentId}' not found in registry`);
      }

      chain.unshift(profile);
      currentId = profile.extends;
    }

    return chain;
  }

  private _mergeChain(chain: ProfileDefinition[]): ResolvedProfile {
    const target = chain.at(-1)!;
    let systemPrompt: string | undefined;
    const appendPrompts: string[] = [];
    const guidelines: string[] = [];

    let allowedTools: string[] | undefined;
    const deniedTools: string[] = [];
    const mcpServers: Record<string, ProfileMcpServer> = {};

    let allowedSkills: string[] | undefined;
    const deniedSkills: string[] = [];

    let preferredModel: string | undefined;
    let fallbackModel: string | undefined;
    let thinkingLevel: ThinkingLevel | undefined;

    let allowedProfiles: string[] | undefined;
    let maxDepth: number | undefined;
    let maxConcurrent: number | undefined;

    const wakeOn = new Set<SupervisionWakeTrigger>();
    let reviewIntervalSeconds: number | undefined;
    let maxDurationSeconds: number | undefined;

    for (const profile of chain) {
      if (profile.prompt?.systemPrompt !== undefined) {
        systemPrompt = profile.prompt.systemPrompt;
      }
      if (profile.prompt?.appendPrompt) {
        appendPrompts.push(profile.prompt.appendPrompt);
      }
      if (profile.prompt?.guidelines) {
        guidelines.push(...profile.prompt.guidelines);
      }

      if (profile.tools?.allow !== undefined) {
        if (allowedTools === undefined) {
          allowedTools = [...profile.tools.allow];
        } else {
          allowedTools = allowedTools.filter((t) => profile.tools!.allow!.some((pat) => matchesPattern(t, pat)));
        }
      }
      if (profile.tools?.deny) {
        deniedTools.push(...profile.tools.deny);
      }

      if (profile.mcpServers) {
        for (const [name, config] of Object.entries(profile.mcpServers)) {
          mcpServers[name] = { ...mcpServers[name], ...config };
        }
      }

      if (profile.skills?.allow !== undefined) {
        if (allowedSkills === undefined) {
          allowedSkills = [...profile.skills.allow];
        } else {
          allowedSkills = allowedSkills.filter((s) => profile.skills!.allow!.includes(s));
        }
      }
      if (profile.skills?.deny) {
        deniedSkills.push(...profile.skills.deny);
      }

      if (profile.model?.preferred !== undefined) {
        preferredModel = profile.model.preferred;
      }
      if (profile.model?.fallback !== undefined) {
        fallbackModel = profile.model.fallback;
      }
      if (profile.model?.thinkingLevel !== undefined) {
        thinkingLevel = profile.model.thinkingLevel;
      }

      if (profile.subagents?.allowedProfiles !== undefined) {
        if (allowedProfiles === undefined) {
          allowedProfiles = [...profile.subagents.allowedProfiles];
        } else {
          allowedProfiles = allowedProfiles.filter((p) => profile.subagents!.allowedProfiles!.includes(p));
        }
      }
      if (profile.subagents?.maxDepth !== undefined) {
        maxDepth = maxDepth !== undefined ? Math.min(maxDepth, profile.subagents.maxDepth) : profile.subagents.maxDepth;
      }
      if (profile.subagents?.maxConcurrent !== undefined) {
        maxConcurrent = maxConcurrent !== undefined ? Math.min(maxConcurrent, profile.subagents.maxConcurrent) : profile.subagents.maxConcurrent;
      }

      if (profile.supervision?.wakeOn) {
        for (const trigger of profile.supervision.wakeOn) {
          wakeOn.add(trigger);
        }
      }
      if (profile.supervision?.reviewIntervalSeconds !== undefined) {
        reviewIntervalSeconds = reviewIntervalSeconds !== undefined
          ? Math.min(reviewIntervalSeconds, profile.supervision.reviewIntervalSeconds)
          : profile.supervision.reviewIntervalSeconds;
      }
      if (profile.supervision?.maxDurationSeconds !== undefined) {
        maxDurationSeconds = maxDurationSeconds !== undefined
          ? Math.min(maxDurationSeconds, profile.supervision.maxDurationSeconds)
          : profile.supervision.maxDurationSeconds;
      }
    }

    if (allowedTools !== undefined && deniedTools.length > 0) {
      allowedTools = allowedTools.filter((t) => !deniedTools.some((denyPat) => matchesPattern(t, denyPat)));
    }
    if (allowedSkills !== undefined && deniedSkills.length > 0) {
      allowedSkills = allowedSkills.filter((s) => !deniedSkills.includes(s));
    }

    const modelConfig = (preferredModel || fallbackModel || thinkingLevel)
      ? {
          ...(preferredModel !== undefined ? { preferred: preferredModel } : {}),
          ...(fallbackModel !== undefined ? { fallback: fallbackModel } : {}),
          ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
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
      deniedTools: Object.freeze(deniedTools),
      mcpServers: Object.freeze(mcpServers),
      ...(allowedSkills !== undefined ? { allowedSkills: Object.freeze(allowedSkills) } : {}),
      deniedSkills: Object.freeze(deniedSkills),
      ...(modelConfig ? { model: Object.freeze(modelConfig) } : {}),
      subagents: Object.freeze({
        ...(allowedProfiles !== undefined ? { allowedProfiles: Object.freeze(allowedProfiles) } : {}),
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

  private _applyParentLimits(resolved: ResolvedProfile, parentLimits: ParentContextLimits): ResolvedProfile {
    let effectiveAllowedTools = resolved.allowedTools;

    if (parentLimits.activeTools !== undefined) {
      const parentSet = new Set(parentLimits.activeTools);
      if (effectiveAllowedTools === undefined) {
        effectiveAllowedTools = Object.freeze(
          parentLimits.activeTools.filter((tool) => isToolAllowed(tool, undefined, resolved.deniedTools)),
        );
      } else {
        effectiveAllowedTools = Object.freeze(
          effectiveAllowedTools.filter((tool) => {
            const matchesParent = parentLimits.activeTools!.some((pTool) => matchesPattern(pTool, tool));
            return matchesParent && isToolAllowed(tool, undefined, resolved.deniedTools);
          }),
        );
      }
    }

    let effectiveAllowedProfiles = resolved.subagents.allowedProfiles;
    if (parentLimits.allowedProfiles !== undefined) {
      if (effectiveAllowedProfiles === undefined) {
        effectiveAllowedProfiles = Object.freeze([...parentLimits.allowedProfiles]);
      } else {
        effectiveAllowedProfiles = Object.freeze(
          effectiveAllowedProfiles.filter((p) => parentLimits.allowedProfiles!.includes(p)),
        );
      }
    }

    let remainingDepth = resolved.subagents.maxDepth;
    if (parentLimits.currentDepth !== undefined) {
      remainingDepth = Math.max(0, remainingDepth - parentLimits.currentDepth);
    }

    return {
      ...resolved,
      ...(effectiveAllowedTools !== undefined ? { allowedTools: effectiveAllowedTools } : {}),
      subagents: Object.freeze({
        ...resolved.subagents,
        ...(effectiveAllowedProfiles !== undefined ? { allowedProfiles: effectiveAllowedProfiles } : {}),
        maxDepth: remainingDepth,
      }),
    };
  }
}
