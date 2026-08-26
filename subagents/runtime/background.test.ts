import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { BackgroundRunRegistry } from "./background.ts";
import type { SubagentProfile, SubagentRun } from "./types.ts";

const profile: SubagentProfile = { id: "test", label: "Test", description: "Test", systemPrompt: "Test", capabilities: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function run(status: SubagentRun["status"] = "running", result?: string): SubagentRun {
  return { status, startedAt: 0, items: [], ...(result === undefined ? {} : { result }) };
}

class Timers {
  private next = 1;
  readonly callbacks = new Map<number, () => void>();
  set = ((callback: (...args: unknown[]) => void) => {
    const id = this.next++;
    this.callbacks.set(id, callback);
    return id;
  }) as unknown as typeof setTimeout;
  clear = ((id: number) => { this.callbacks.delete(id); }) as unknown as typeof clearTimeout;
  fire(id: number): void {
    const callback = this.callbacks.get(id);
    assert.ok(callback, `timer ${id} exists`);
    this.callbacks.delete(id);
    callback();
  }
  latest(): number { return Math.max(...this.callbacks.keys()); }
}

function registry(options: ConstructorParameters<typeof BackgroundRunRegistry>[0] = {}) {
  let id = 0;
  return new BackgroundRunRegistry({ createRunId: () => `run-${++id}`, ...options });
}

test("start returns a stable runId before completion", async () => {
  const done = deferred<SubagentRun>();
  const subject = registry();
  const initial = subject.start({ profile, task: "slow", run: () => done.promise });
  assert.equal(initial.runId, "run-1");
  assert.equal(initial.status, "running");
  assert.equal(subject.get(initial.runId).runId, initial.runId);
  done.resolve(run("success", "done"));
  assert.equal((await subject.wait(initial.runId, initial.revision)).snapshot.runId, initial.runId);
});

test("wait reports immediate changes, later changes, timeout, and terminal completion", async () => {
  const timers = new Timers();
  const done = deferred<SubagentRun>();
  let update!: (value: SubagentRun) => void;
  const subject = registry({ setTimer: timers.set, clearTimer: timers.clear });
  const initial = subject.start({ profile, task: "wait", run: (_signal, onUpdate) => { update = onUpdate; return done.promise; } });

  assert.equal((await subject.wait(initial.runId, 0)).reason, "changed");
  const changed = subject.wait(initial.runId, initial.revision);
  update({ ...run(), result: "partial", items: [{ kind: "thinking", text: "progress" }] });
  const changedResult = await changed;
  assert.equal(changedResult.reason, "changed");
  assert.equal(changedResult.snapshot.latestUpdate, "progress");

  const timeout = subject.wait(initial.runId, changedResult.snapshot.revision, 7);
  timers.fire(timers.latest());
  assert.equal((await timeout).reason, "timeout");

  const terminal = subject.wait(initial.runId, changedResult.snapshot.revision);
  done.resolve(run("success", "complete"));
  assert.equal((await terminal).reason, "terminal");
  assert.equal((await subject.wait(initial.runId, 999)).reason, "terminal");
});

test("streaming result updates create one meaningful checkpoint rather than token revisions", async () => {
  const done = deferred<SubagentRun>();
  let update!: (value: SubagentRun) => boolean;
  const subject = registry();
  const started = subject.start({ profile, task: "stream", run: (_signal, onUpdate) => { update = onUpdate; return done.promise; } });

  const checkpoints = ["p", "pa", "partial"].map((partial) => update({ ...run(), result: partial }));

  const snapshot = subject.get(started.runId);
  assert.deepEqual(checkpoints, [true, false, false]);
  assert.equal(snapshot.revision, started.revision + 1);
  assert.equal(snapshot.partialResult, "partial");
  done.resolve(run("success", "complete"));
});

test("wait does not lose an update between its initial check and waiter registration", async () => {
  const done = deferred<SubagentRun>();
  let update!: (value: SubagentRun) => void;
  let timerCalls = 0;
  const subject = registry({
    setTimer: ((callback: (...args: unknown[]) => void) => {
      timerCalls++;
      if (timerCalls === 2) update({ ...run(), result: "raced update" });
      return setTimeout(callback, 60_000);
    }) as typeof setTimeout,
  });
  const initial = subject.start({ profile, task: "race", run: (_signal, onUpdate) => { update = onUpdate; return done.promise; } });
  const result = await subject.wait(initial.runId, initial.revision);
  assert.equal(result.reason, "changed");
  assert.equal(result.snapshot.partialResult, "raced update");
  done.resolve(run("success"));
});

test("cancelling one run is independent and preserves its latest partial state", async () => {
  const first = deferred<SubagentRun>();
  const second = deferred<SubagentRun>();
  let firstSignal!: AbortSignal;
  let firstUpdate!: (value: SubagentRun) => void;
  const subject = registry();
  const a = subject.start({ profile, task: "a", run: (signal, update) => { firstSignal = signal; firstUpdate = update; return first.promise; } });
  const b = subject.start({ profile, task: "b", run: () => second.promise });
  firstUpdate({ ...run(), result: "useful partial", items: [
    { kind: "thinking", text: "kept" },
    { kind: "tool", id: "tool-1", name: "bash", status: "running" },
  ] });
  const cancelling = subject.cancel(a.runId);
  assert.equal(firstSignal.aborted, true);
  assert.equal(subject.get(b.runId).status, "running");
  first.reject(new Error("stopped"));
  const cancelled = await cancelling;
  assert.equal(cancelled.status, "aborted");
  assert.equal(cancelled.partialResult, "useful partial");
  assert.equal(cancelled.run.items[0]?.kind, "thinking");
  assert.deepEqual(cancelled.activeTools, ["bash"]);
  second.resolve(run("success"));
});

test("parent cancellation forwards only to its dedicated child controller", async () => {
  const parent = new AbortController();
  const first = deferred<SubagentRun>();
  const second = deferred<SubagentRun>();
  let firstSignal!: AbortSignal;
  let secondSignal!: AbortSignal;
  const subject = registry();
  const a = subject.start({ profile, task: "a", parentSignal: parent.signal, run: (signal) => { firstSignal = signal; return first.promise; } });
  const b = subject.start({ profile, task: "b", run: (signal) => { secondSignal = signal; return second.promise; } });

  parent.abort();
  assert.equal(firstSignal.aborted, true);
  assert.equal(secondSignal.aborted, false);
  const cancelled = subject.cancel(a.runId);
  first.resolve(run("success", "late success"));
  second.resolve(run("success"));

  assert.equal((await cancelled).status, "aborted");
  assert.equal((await subject.wait(b.runId, b.revision)).snapshot.status, "success");
});

test("cancel on a terminal run is idempotent", async () => {
  let calls = 0;
  const subject = registry();
  const initial = subject.start({ profile, task: "done", run: async () => { calls++; return run("success", "ok"); } });
  const completed = await subject.wait(initial.runId, initial.revision);
  const once = await subject.cancel(initial.runId);
  const twice = await subject.cancel(initial.runId);
  assert.equal(calls, 1);
  assert.equal(once.status, "success");
  assert.equal(twice.revision, once.revision);
  assert.equal(twice.partialResult, "ok");
});

test("get, wait, and cancel reject an unknown runId", async () => {
  const subject = registry();
  assert.throws(() => subject.get("missing"), /Unknown background subagent runId: missing/);
  await assert.rejects(subject.wait("missing"), /Unknown background subagent runId: missing/);
  await assert.rejects(subject.cancel("missing"), /Unknown background subagent runId: missing/);
});

test("active limit rejects excess work and permits work after completion", async () => {
  const pending = deferred<SubagentRun>();
  const subject = registry({ maxActive: 1 });
  const first = subject.start({ profile, task: "one", run: () => pending.promise });
  assert.throws(() => subject.start({ profile, task: "two", run: async () => run("success") }), /limit reached \(1\)/);
  pending.resolve(run("success"));
  await subject.wait(first.runId, first.revision);
  assert.equal(subject.start({ profile, task: "two", run: async () => run("success") }).runId, "run-2");
});

test("writer scopes reject equal, ancestor, and descendant collisions but allow siblings", async () => {
  const pending = deferred<SubagentRun>();
  const subject = registry();
  subject.start({ profile, task: "writer", writerScopes: ["work/src"], run: () => pending.promise });
  for (const scope of ["work/src", "work", "work/src/nested"]) {
    assert.throws(() => subject.start({ profile, task: scope, writerScopes: [scope], run: async () => run("success") }), /Writer scope overlaps/);
  }
  const sibling = subject.start({ profile, task: "sibling", writerScopes: ["work/test"], run: async () => run("success") });
  assert.deepEqual(sibling.writerScopes, [resolve("work/test")]);
  pending.resolve(run("success"));
});

test("retention evicts the oldest terminal runs", async () => {
  let now = 0;
  const subject = registry({ maxRetained: 2, now: () => ++now });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const started = subject.start({ profile, task: `${i}`, run: async () => run("success") });
    ids.push(started.runId);
    await subject.wait(started.runId, started.revision);
  }
  assert.throws(() => subject.get(ids[0]!), /Unknown/);
  assert.equal(subject.get(ids[1]!).status, "success");
  assert.equal(subject.get(ids[2]!).status, "success");
});

test("runtime expiry requests cancellation", async () => {
  const timers = new Timers();
  const done = deferred<SubagentRun>();
  let signal!: AbortSignal;
  const subject = registry({ maxRuntimeMs: 123, setTimer: timers.set, clearTimer: timers.clear });
  const started = subject.start({ profile, task: "expire", run: (value) => { signal = value; return done.promise; } });
  timers.fire(timers.latest());
  assert.equal(signal.aborted, true);
  const cancelling = subject.get(started.runId);
  assert.equal(cancelling.status, "cancelling");
  done.resolve(run("aborted"));
  assert.equal((await subject.wait(started.runId, cancelling.revision)).snapshot.status, "aborted");
});

test("shutdown cancels and awaits every active runner", async () => {
  const a = deferred<SubagentRun>();
  const b = deferred<SubagentRun>();
  const signals: AbortSignal[] = [];
  const subject = registry();
  subject.start({ profile, task: "a", run: (signal) => { signals.push(signal); return a.promise; } });
  subject.start({ profile, task: "b", run: (signal) => { signals.push(signal); return b.promise; } });
  let settled = false;
  const shuttingDown = subject.shutdown().then(() => { settled = true; });
  assert.deepEqual(signals.map((signal) => signal.aborted), [true, true]);
  a.resolve(run("aborted"));
  await Promise.resolve();
  assert.equal(settled, false);
  b.resolve(run("aborted"));
  await shuttingDown;
  assert.equal(settled, true);
});
