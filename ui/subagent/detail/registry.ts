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

function notifySubscribers(toolCallId: string, run: SubagentRun): void {
  const listeners = subscribers.get(toolCallId);
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener(run);
    } catch {
      // Ignore subscriber errors to avoid breaking callers
    }
  }
}

export function recordSubagentStart(
  toolCallId: string,
  profile: SubagentProfile,
  task: string,
  initialRun?: SubagentRun,
): void {
  const now = Date.now();
  const id = toolCallId || `subagent_${now}_${Math.random().toString(36).slice(2, 6)}`;
  const existing = registry.get(id);
  const run: SubagentRun = initialRun ?? existing?.run ?? {
    status: "running",
    startedAt: now,
    items: [],
  };

  if (registry.has(id)) {
    registry.delete(id);
  } else if (registry.size >= MAX_REGISTRY_ENTRIES) {
    const oldestKey = registry.keys().next().value;
    if (oldestKey !== undefined) {
      registry.delete(oldestKey);
    }
  }

  registry.set(id, {
    toolCallId: id,
    task: task || existing?.task || "Subagent task",
    profile: profile || existing?.profile,
    run,
    updatedAt: now,
  });

  notifySubscribers(id, run);
}

export function recordSubagentUpdate(toolCallId: string, run: SubagentRun): void {
  if (!toolCallId) return;
  const entry = registry.get(toolCallId);
  if (entry) {
    entry.run = run;
    entry.updatedAt = Date.now();
    notifySubscribers(toolCallId, run);
  } else {
    recordSubagentStart(
      toolCallId,
      { id: "subagent", label: "subagent", description: "", systemPrompt: "", capabilities: [] },
      "Subagent task",
      run,
    );
  }
}

export function getSubagentEntry(toolCallId: string): SubagentViewEntry | undefined {
  return registry.get(toolCallId);
}

export function getAllSubagentEntries(): SubagentViewEntry[] {
  return Array.from(registry.values());
}

export function subscribeSubagent(
  toolCallId: string,
  listener: (run: SubagentRun) => void,
): () => void {
  let listeners = subscribers.get(toolCallId);
  if (!listeners) {
    listeners = new Set();
    subscribers.set(toolCallId, listeners);
  }
  listeners.add(listener);

  return () => {
    const set = subscribers.get(toolCallId);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        subscribers.delete(toolCallId);
      }
    }
  };
}

export function clearSubagentRegistry(): void {
  registry.clear();
  subscribers.clear();
}
