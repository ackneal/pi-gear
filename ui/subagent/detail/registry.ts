import type { SubagentProfile, SubagentRun } from "../../../subagents/runtime/types.ts";

export interface SubagentViewEntry {
  toolCallId: string;
  task: string;
  profile: SubagentProfile;
  run: SubagentRun;
  updatedAt: number;
}

const MAX_REGISTRY_ENTRIES = 50;
const registry = new Map<string, SubagentViewEntry>();
const subscribers = new Map<string, Set<(run: SubagentRun) => void>>();

function notify(toolCallId: string, run: SubagentRun): void {
  for (const listener of subscribers.get(toolCallId) ?? []) {
    try { listener(run); } catch { /* A view must not break the run. */ }
  }
}

function evictIfNeeded(): void {
  if (registry.size < MAX_REGISTRY_ENTRIES) return;
  const oldest = registry.keys().next().value;
  if (oldest !== undefined) {
    registry.delete(oldest);
    subscribers.delete(oldest);
  }
}

/** Starts a new live run. This is the only operation which affects retention order. */
export function recordSubagentLiveStart(toolCallId: string, profile: SubagentProfile, task: string, initialRun?: SubagentRun): void {
  if (!toolCallId) return;
  const now = Date.now();
  if (!registry.has(toolCallId)) evictIfNeeded();
  const existing = registry.get(toolCallId);
  const run = initialRun ?? existing?.run ?? { status: "running", startedAt: now, items: [] };
  registry.set(toolCallId, { toolCallId, task, profile, run, updatedAt: now });
  notify(toolCallId, run);
}

/** Updates a run that was explicitly started live; it never invents history. */
export function recordSubagentLiveUpdate(toolCallId: string, run: SubagentRun): void {
  const entry = registry.get(toolCallId);
  if (!entry) return;
  entry.run = run;
  entry.updatedAt = Date.now();
  notify(toolCallId, run);
}

/** Adds transcript history without moving or replacing an existing entry. */
export function hydrateSubagentHistory(toolCallId: string, profile: SubagentProfile, task: string, run: SubagentRun): void {
  if (!toolCallId || !task || registry.has(toolCallId)) return;
  evictIfNeeded();
  registry.set(toolCallId, { toolCallId, profile, task, run, updatedAt: Date.now() });
}

export const getSubagentEntry = (toolCallId: string): SubagentViewEntry | undefined => toolCallId ? registry.get(toolCallId) : undefined;
export const getAllSubagentEntries = (): SubagentViewEntry[] => Array.from(registry.values());

export function subscribeSubagent(toolCallId: string, listener: (run: SubagentRun) => void): () => void {
  if (!toolCallId) return () => {};
  let listeners = subscribers.get(toolCallId);
  if (!listeners) subscribers.set(toolCallId, listeners = new Set());
  listeners.add(listener);
  return () => {
    const set = subscribers.get(toolCallId);
    set?.delete(listener);
    if (set?.size === 0) subscribers.delete(toolCallId);
  };
}

export function clearSubagentRegistry(): void {
  registry.clear();
  subscribers.clear();
}
