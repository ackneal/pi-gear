import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { SubagentDispatch, SubagentProfile, SubagentRun } from "./types.ts";

export const MAX_ACTIVE_BACKGROUND_RUNS = 4;
export const MAX_BACKGROUND_RUNTIME_MS = 30 * 60_000;
export const MAX_WAIT_SECONDS = 60;
export const MAX_RETAINED_BACKGROUND_RUNS = 20;

export type BackgroundStatus = SubagentRun["status"] | "cancelling";
export type WaitReason = "changed" | "terminal" | "timeout";

export interface BackgroundSnapshot {
  runId: string;
  status: BackgroundStatus;
  revision: number;
  profile: string;
  task: string;
  dispatch?: SubagentDispatch;
  writerScopes?: string[];
  startedAt: number;
  updatedAt: number;
  expiry: number;
  idleSeconds: number;
  noProgressSeconds: number;
  activeTools: string[];
  toolCalls: number;
  toolErrors: number;
  consecutiveToolErrors: number;
  latestUpdate?: string;
  partialResult?: string;
  usage?: SubagentRun["usage"];
  run: SubagentRun;
}

interface Entry {
  runId: string;
  sessionId: string;
  profile: SubagentProfile;
  task: string;
  dispatch?: SubagentDispatch;
  writerScopes?: string[];
  controller: AbortController;
  runner: Promise<SubagentRun>;
  run: SubagentRun;
  status: BackgroundStatus;
  revision: number;
  startedAt: number;
  updatedAt: number;
  lastProgressAt: number;
  expiry: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
}

export interface StartBackgroundOptions {
  profile: SubagentProfile;
  task: string;
  dispatch?: SubagentDispatch;
  writerScopes?: string[];
  parentSignal?: AbortSignal;
  run: (signal: AbortSignal, onUpdate: (run: SubagentRun) => boolean) => Promise<SubagentRun>;
}

export interface BackgroundRegistryOptions {
  maxActive?: number;
  maxRuntimeMs?: number;
  maxRetained?: number;
  maxWaitSeconds?: number;
  now?: () => number;
  createRunId?: () => string;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

const terminal = (status: BackgroundStatus): boolean => status === "success" || status === "error" || status === "aborted";
const cloneRun = (run: SubagentRun): SubagentRun => ({ ...run, items: run.items.map((item) => ({ ...item })), ...(run.dispatch ? { dispatch: { ...run.dispatch } } : {}) });

function progressKey(run: SubagentRun): string {
  const tools = run.items.filter((item) => item.kind === "tool").map((item) => `${item.id ?? item.name}:${item.status}`).join("|");
  return `${run.status}:${tools}:${run.result === undefined ? "" : "result"}:${run.error ?? ""}`;
}

function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.some((a) => right.some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

export class BackgroundRunRegistry {
  private readonly entries = new Map<string, Entry>();
  private sessionId = randomUUID();
  private readonly maxActive: number;
  private readonly maxRuntimeMs: number;
  private readonly maxRetained: number;
  private readonly maxWaitSeconds: number;
  private readonly now: () => number;
  private readonly createRunId: () => string;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(options: BackgroundRegistryOptions = {}) {
    this.maxActive = options.maxActive ?? MAX_ACTIVE_BACKGROUND_RUNS;
    this.maxRuntimeMs = options.maxRuntimeMs ?? MAX_BACKGROUND_RUNTIME_MS;
    this.maxRetained = options.maxRetained ?? MAX_RETAINED_BACKGROUND_RUNS;
    this.maxWaitSeconds = options.maxWaitSeconds ?? MAX_WAIT_SECONDS;
    this.now = options.now ?? Date.now;
    this.createRunId = options.createRunId ?? randomUUID;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  beginSession(): void {
    if ([...this.entries.values()].some((entry) => !terminal(entry.status))) {
      throw new Error("Cannot replace a session while background subagents are active.");
    }
    this.entries.clear();
    this.sessionId = randomUUID();
  }

  start(options: StartBackgroundOptions): BackgroundSnapshot {
    const active = [...this.entries.values()].filter((entry) => !terminal(entry.status));
    if (active.length >= this.maxActive) throw new Error(`Background subagent limit reached (${this.maxActive}).`);

    const writerScopes = options.writerScopes?.map((scope) => resolve(scope));
    if (writerScopes?.length) {
      const collision = active.find((entry) => entry.writerScopes && scopesOverlap(writerScopes, entry.writerScopes));
      if (collision) throw new Error(`Writer scope overlaps active background run ${collision.runId}: ${collision.writerScopes?.join(", ")}.`);
    }

    const now = this.now();
    const controller = new AbortController();
    const runId = this.createRunId();
    const initial: SubagentRun = { status: "running", startedAt: now, lastActivityAt: now, items: [], ...(options.dispatch ? { dispatch: { ...options.dispatch } } : {}) };
    const entry: Entry = {
      runId, sessionId: this.sessionId, profile: options.profile, task: options.task,
      ...(options.dispatch ? { dispatch: { ...options.dispatch } } : {}),
      ...(writerScopes?.length ? { writerScopes } : {}), controller, run: initial, status: "running",
      revision: 1, startedAt: now, updatedAt: now, lastProgressAt: now, expiry: now + this.maxRuntimeMs,
      runner: Promise.resolve(initial), waiters: new Set(),
    };
    this.entries.set(runId, entry);

    const onParentAbort = (): void => this.requestCancel(entry);
    options.parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    if (options.parentSignal?.aborted) onParentAbort();

    entry.expiryTimer = this.setTimer(() => this.requestCancel(entry), this.maxRuntimeMs);
    entry.runner = options.run(controller.signal, (run) => this.update(entry, run)).then(
      (run) => this.finish(entry, run),
      (error) => this.finish(entry, { ...entry.run, status: controller.signal.aborted ? "aborted" : "error", error: error instanceof Error ? error.message : String(error) }),
    ).finally(() => options.parentSignal?.removeEventListener("abort", onParentAbort));

    return this.snapshot(entry);
  }

  get(runId: string): BackgroundSnapshot {
    return this.snapshot(this.require(runId));
  }

  async wait(runId: string, afterRevision = 0, timeoutSeconds = 30): Promise<{ reason: WaitReason; snapshot: BackgroundSnapshot }> {
    const entry = this.require(runId);
    if (terminal(entry.status)) return { reason: "terminal", snapshot: this.snapshot(entry) };
    if (entry.revision > afterRevision) return { reason: "changed", snapshot: this.snapshot(entry) };

    const milliseconds = Math.max(0, Math.min(timeoutSeconds, this.maxWaitSeconds)) * 1000;
    let timedOut = false;
    await new Promise<void>((resolveWait) => {
      const wake = (): void => { this.clearTimer(timer); entry.waiters.delete(wake); resolveWait(); };
      const timer = this.setTimer(() => { timedOut = true; entry.waiters.delete(wake); resolveWait(); }, milliseconds);
      entry.waiters.add(wake);
      if (terminal(entry.status) || entry.revision > afterRevision) wake();
    });

    return { reason: timedOut ? "timeout" : terminal(entry.status) ? "terminal" : "changed", snapshot: this.snapshot(entry) };
  }

  async cancel(runId: string): Promise<BackgroundSnapshot> {
    const entry = this.require(runId);
    if (terminal(entry.status)) return this.snapshot(entry);

    this.requestCancel(entry);
    await entry.runner;
    return this.snapshot(entry);
  }

  async shutdown(): Promise<void> {
    const active = [...this.entries.values()].filter((entry) => !terminal(entry.status));
    for (const entry of active) this.requestCancel(entry);
    await Promise.allSettled(active.map((entry) => entry.runner));
    for (const entry of this.entries.values()) if (entry.expiryTimer) this.clearTimer(entry.expiryTimer);
    this.entries.clear();
  }

  private requestCancel(entry: Entry): void {
    if (terminal(entry.status) || entry.status === "cancelling") return;
    entry.status = "cancelling";
    entry.updatedAt = this.now();
    entry.revision++;
    this.wake(entry);
    entry.controller.abort();
  }

  private update(entry: Entry, run: SubagentRun): boolean {
    if (terminal(entry.status)) return false;
    const changed = progressKey(entry.run) !== progressKey(run);
    entry.run = cloneRun(run);
    entry.updatedAt = this.now();
    if (changed) {
      entry.lastProgressAt = entry.updatedAt;
      entry.revision++;
      this.wake(entry);
    }
    return changed;
  }

  private finish(entry: Entry, run: SubagentRun): SubagentRun {
    if (terminal(entry.status)) return entry.run;
    const now = this.now();
    const status = entry.controller.signal.aborted
      ? "aborted"
      : run.status === "running" ? "error" : run.status;
    entry.run = cloneRun({ ...run, status, finishedAt: run.finishedAt ?? now });
    entry.status = status;
    entry.updatedAt = now;
    entry.lastProgressAt = now;
    entry.revision++;
    if (entry.expiryTimer) this.clearTimer(entry.expiryTimer);
    this.wake(entry);
    this.evict();
    return entry.run;
  }

  private snapshot(entry: Entry): BackgroundSnapshot {
    const now = this.now();
    const tools = entry.run.items.filter((item) => item.kind === "tool");
    let consecutiveToolErrors = 0;
    for (let index = tools.length - 1; index >= 0 && tools[index]?.status === "error"; index--) consecutiveToolErrors++;
    const latest = entry.run.items[entry.run.items.length - 1];
    const latestUpdate = latest?.kind === "thinking" ? latest.text : latest?.kind === "tool" ? `${latest.name}: ${latest.status}` : undefined;
    return {
      runId: entry.runId, status: entry.status, revision: entry.revision, profile: entry.profile.id, task: entry.task,
      ...(entry.dispatch ? { dispatch: { ...entry.dispatch } } : {}), ...(entry.writerScopes ? { writerScopes: [...entry.writerScopes] } : {}),
      startedAt: entry.startedAt, updatedAt: entry.updatedAt, expiry: entry.expiry,
      idleSeconds: Math.max(0, (now - (entry.run.lastActivityAt ?? entry.startedAt)) / 1000),
      noProgressSeconds: Math.max(0, (now - entry.lastProgressAt) / 1000),
      activeTools: tools.filter((tool) => tool.status === "running").map((tool) => tool.name),
      toolCalls: tools.length, toolErrors: tools.filter((tool) => tool.status === "error").length, consecutiveToolErrors,
      ...(latestUpdate ? { latestUpdate } : {}), ...(entry.run.result ? { partialResult: entry.run.result } : {}),
      ...(entry.run.usage ? { usage: entry.run.usage } : {}), run: cloneRun(entry.run),
    };
  }

  private require(runId: string): Entry {
    const entry = this.entries.get(runId);
    if (!entry || entry.sessionId !== this.sessionId) throw new Error(`Unknown background subagent runId: ${runId}`);
    return entry;
  }

  private wake(entry: Entry): void {
    for (const wake of [...entry.waiters]) wake();
  }

  private evict(): void {
    const completed = [...this.entries.values()].filter((entry) => terminal(entry.status)).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const entry of completed.slice(0, Math.max(0, completed.length - this.maxRetained))) this.entries.delete(entry.runId);
  }
}
