import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import type { TaskRecord } from "pi-rostrix";
import { EMPTY_GIT_SNAPSHOT, type WorkspaceGitSnapshot } from "./git-status.ts";

export interface ToolStatsSnapshot {
  readonly total: number;
  readonly errors: number;
  readonly activeTools: readonly string[];
}

export interface SessionUsageSnapshot {
  readonly turns: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  readonly cacheHitRate?: number | undefined;
  readonly contextTokens: number | null;
  readonly contextWindow: number;
  readonly contextPercent: number | null;
}

export interface MonitorSnapshot {
  readonly cwd: string;
  readonly home?: string | undefined;
  readonly sessionName?: string | undefined;
  readonly git: WorkspaceGitSnapshot;
  readonly activeAgent: string;
  readonly tasks: readonly TaskRecord[];
  readonly tools: ToolStatsSnapshot;
  readonly sessionUsage: SessionUsageSnapshot;
  readonly model?: {
    readonly id: string;
    readonly provider: string;
    readonly reasoning: boolean;
    readonly thinkingLevel?: string | undefined;
    readonly usingSubscription: boolean;
  } | undefined;
  readonly availableProviderCount: number;
  readonly extensionStatuses: ReadonlyMap<string, string>;
}

export interface ToolStatsTracker {
  recordStart(toolCallId: string, toolName: string): void;
  recordEnd(toolCallId: string, toolName: string, isError: boolean): void;
  resetFromEntries(entries: readonly SessionEntryLike[]): void;
  snapshot(): ToolStatsSnapshot;
}

export interface SessionEntryLike {
  readonly type: string;
  readonly usage?: UsageLike | undefined;
  readonly message?: {
    readonly role?: string | undefined;
    readonly usage?: UsageLike | undefined;
    readonly toolName?: string | undefined;
    readonly isError?: boolean | undefined;
  } | undefined;
}

export interface UsageLike {
  readonly input?: number | undefined;
  readonly output?: number | undefined;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
  readonly cost?: { readonly total?: number | undefined } | undefined;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export function formatCwd(cwd: string, home?: string): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const rel = relative(resolvedHome, resolvedCwd);
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) return cwd;
  return rel === "" ? "~" : `~${sep}${rel}`;
}

export function createToolStatsTracker(): ToolStatsTracker {
  const active = new Map<string, string>();
  let total = 0;
  let errors = 0;

  const recordToolResult = (isError: boolean) => {
    total += 1;
    if (isError) errors += 1;
  };

  return {
    recordStart(toolCallId, toolName) {
      active.set(toolCallId, toolName);
    },
    recordEnd(toolCallId, _toolName, isError) {
      active.delete(toolCallId);
      recordToolResult(isError);
    },
    resetFromEntries(entries) {
      active.clear();
      total = 0;
      errors = 0;

      for (const entry of entries) {
        if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
        if (!entry.message.toolName) continue;
        recordToolResult(Boolean(entry.message.isError));
      }
    },
    snapshot() {
      return {
        total,
        errors,
        activeTools: [...active.values()],
      };
    },
  };
}

export function summarizeSessionUsage(
  entries: readonly SessionEntryLike[],
  contextUsage?: { readonly tokens: number | null; readonly contextWindow: number; readonly percent: number | null } | undefined,
  fallbackContextWindow = 0,
): SessionUsageSnapshot {
  let turns = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let cacheHitRate: number | undefined;

  const add = (usage: UsageLike | undefined) => {
    if (!usage) return;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    cacheRead += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
    cost += usage.cost?.total ?? 0;
  };

  for (const entry of entries) {
    if (entry.type === "usage") {
      add(entry.usage);
    } else if (entry.type === "message" && entry.message?.role === "assistant") {
      turns += 1;
      if (entry.message.usage) {
        const u = entry.message.usage;
        add(u);
        const promptTokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        cacheHitRate = promptTokens > 0 ? ((u.cacheRead ?? 0) / promptTokens) * 100 : undefined;
      }
    } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage) {
      add(entry.message.usage);
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      add(entry.usage);
    }
  }

  return {
    turns,
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    cacheHitRate,
    contextTokens: contextUsage?.tokens ?? null,
    contextWindow: contextUsage?.contextWindow ?? fallbackContextWindow,
    contextPercent: contextUsage?.percent ?? null,
  };
}

export interface MonitorState {
  git: WorkspaceGitSnapshot;
  footerData: ReadonlyFooterDataProvider | undefined;
  readonly toolTracker: ToolStatsTracker;
}

export function createMonitorState(): MonitorState {
  return {
    git: EMPTY_GIT_SNAPSHOT,
    footerData: undefined,
    toolTracker: createToolStatsTracker(),
  };
}
