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
  if (!toolCallId) return;
  const now = Date.now();
  const existing = registry.get(toolCallId);
  const run: SubagentRun = initialRun ?? existing?.run ?? {
    status: "running",
    startedAt: now,
    items: [],
  };

  if (registry.has(toolCallId)) {
    registry.delete(toolCallId);
  } else if (registry.size >= MAX_REGISTRY_ENTRIES) {
    const oldestKey = registry.keys().next().value;
    if (oldestKey !== undefined) {
      registry.delete(oldestKey);
    }
  }

  registry.set(toolCallId, {
    toolCallId,
    // Keep an already-recorded task (the formatted brief) over a later plain
    // re-registration from the result renderer.
    task: (existing?.task ?? task) || "Subagent task",
    profile: profile || existing?.profile,
    run,
    updatedAt: now,
  });

  notifySubscribers(toolCallId, run);
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
  if (!toolCallId) return undefined;
  return registry.get(toolCallId);
}

export function getAllSubagentEntries(): SubagentViewEntry[] {
  return Array.from(registry.values());
}

export function subscribeSubagent(
  toolCallId: string,
  listener: (run: SubagentRun) => void,
): () => void {
  if (!toolCallId) return () => {};
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
