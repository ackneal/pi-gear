import type { TaskSnapshot } from "../../subagents/runtime/types.ts";

export interface SubagentViewEntry {
  task: string;
  run: TaskSnapshot;
}

const MAX_REGISTRY_ENTRIES = 50;
const registry = new Map<string, SubagentViewEntry>();
const subscribers = new Map<string, Set<(run: TaskSnapshot) => void>>();

function notify(entryKey: string, run: TaskSnapshot): void {
  for (const listener of subscribers.get(entryKey) ?? []) {
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
export function recordSubagentLiveStart(entryKey: string, task: string, initialRun?: TaskSnapshot): void {
  if (!entryKey) return;
  const now = Date.now();
  if (!registry.has(entryKey)) evictIfNeeded();
  const existing = registry.get(entryKey);
  const run = initialRun ?? existing?.run ?? { status: "running", startedAt: now, activities: [] };
  registry.set(entryKey, { task, run });
  notify(entryKey, run);
}

/** Updates a run that was explicitly started live; it never invents history. */
export function recordSubagentLiveUpdate(entryKey: string, run: TaskSnapshot): void {
  const entry = registry.get(entryKey);
  if (!entry) return;
  entry.run = run;
  notify(entryKey, run);
}

export const getSubagentEntry = (entryKey: string): SubagentViewEntry | undefined => entryKey ? registry.get(entryKey) : undefined;

export function subscribeSubagent(entryKey: string, listener: (run: TaskSnapshot) => void): () => void {
  if (!entryKey) return () => {};
  let listeners = subscribers.get(entryKey);
  if (!listeners) subscribers.set(entryKey, listeners = new Set());
  listeners.add(listener);
  return () => {
    const set = subscribers.get(entryKey);
    set?.delete(listener);
    if (set?.size === 0) subscribers.delete(entryKey);
  };
}

export function clearSubagentRegistry(): void {
  registry.clear();
  subscribers.clear();
}
