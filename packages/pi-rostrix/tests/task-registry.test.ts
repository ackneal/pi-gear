import assert from "node:assert/strict";
import test from "node:test";
import { TaskRegistry } from "../src/runtime/task-registry.ts";
import type { ResolvedProfile } from "../src/core/resolver.ts";
import type { SubagentTaskResult } from "../src/runtime/session-runner.ts";

function createMockProfile(id = "worker"): ResolvedProfile {
  return {
    id,
    label: "Worker",
    description: "Test worker",
    promptGuidelines: Object.freeze([]),
    appendPrompt: "",
    deniedTools: Object.freeze([]),
    deniedSkills: Object.freeze([]),
    mcpServers: Object.freeze({}),
    subagents: Object.freeze({ maxDepth: 2, maxConcurrent: 2 }),
    supervision: Object.freeze({ wakeOn: Object.freeze(new Set<"completed" | "failed" | "needs_input" | "stalled">()) }),
  };
}

test("TaskRegistry shutdown cancels all tasks and waits for runner cleanup", async (t) => {
  for (const count of [0, 1, 2]) {
    await t.test(`${count} active tasks`, async () => {
      const aborted: AbortSignal[] = [];
      const cleanups: Array<() => void> = [];
      const registry = new TaskRegistry({
        createRunner: ({ signal }) => ({
          run: async () => new Promise<SubagentTaskResult>((resolve) => {
            assert.ok(signal);
            signal.addEventListener("abort", () => {
              aborted.push(signal);
              cleanups.push(() => resolve({
                status: "aborted",
                usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
                turns: 0,
                durationMs: 0,
              }));
            }, { once: true });
          }),
        }),
      });
      const tasks = Array.from({ length: count }, () => registry.spawn({ profile: createMockProfile(), task: "Wait" }));
      let settled = false;

      const shutdown = registry.shutdown();
      void shutdown.then(() => { settled = true; });
      assert.strictEqual(registry.shutdown(), shutdown);
      assert.throws(() => registry.spawn({ profile: createMockProfile(), task: "Too late" }), /shut down/);
      await Promise.resolve();
      assert.equal(aborted.length, count);
      if (count > 0) assert.equal(settled, false);
      for (const cleanup of cleanups) cleanup();
      await shutdown;

      assert.equal(settled, true);
      assert.ok(tasks.every((task) => task.status === "aborted"));
      assert.equal(registry.getRunningCount(), 0);
    });
  }
});

test("TaskRegistry spawns task and tracks status", () => {
  const registry = new TaskRegistry();
  const profile = createMockProfile();

  const task = registry.spawn({
    profile,
    task: "Say hello",
    targetFiles: ["test.txt"],
  });

  assert.equal(task.profileId, "worker");
  assert.equal(task.status, "running");
  assert.deepEqual(task.targetFiles, ["test.txt"]);

  const fetched = registry.getTask(task.id);
  assert.equal(fetched?.id, task.id);
});

test("TaskRegistry enforces maxConcurrent limit per profile", () => {
  const registry = new TaskRegistry();
  const profile = createMockProfile("constrained");

  registry.spawn({ profile, task: "Task 1" });
  registry.spawn({ profile, task: "Task 2" });

  assert.throws(
    () => {
      registry.spawn({ profile, task: "Task 3" });
    },
    /concurrent limit of 2 reached/,
  );
});

test("TaskRegistry cancels active task", async () => {
  const registry = new TaskRegistry();
  const profile = createMockProfile();

  const task = registry.spawn({ profile, task: "To be cancelled" });
  assert.equal(task.status, "running");

  const cancelled = await registry.cancel(task.id, "Stop now");
  assert.equal(cancelled, true);

  const updated = registry.getTask(task.id);
  assert.equal(updated?.status, "aborted");
  assert.equal(updated?.error, "Stop now");
});

test("TaskRegistry prevents overlapping targetFiles write scopes across running tasks", () => {
  const registry = new TaskRegistry();
  const profile = createMockProfile();

  registry.spawn({
    profile,
    task: "Modify src/index.ts",
    targetFiles: ["/repo/src/index.ts"],
  });

  assert.throws(
    () => {
      registry.spawn({
        profile,
        task: "Also modify src/index.ts",
        targetFiles: ["/repo/src/index.ts"],
      });
    },
    /Target files overlap with running task/,
  );
});

test("TaskRegistry aborts task when caller signal fires", async () => {
  const registry = new TaskRegistry();
  const profile = createMockProfile();
  const callerController = new AbortController();

  const task = registry.spawn({
    profile,
    task: "Signal abort test",
    signal: callerController.signal,
  });

  assert.equal(task.status, "running");
  callerController.abort();

  const awaited = await registry.wait(task.id, { timeoutSeconds: 2 });
  assert.equal(awaited.status, "aborted");
});

test("TaskRegistry wait resolves on revision update or settle", async () => {
  const registry = new TaskRegistry();
  const profile = createMockProfile();

  const task = registry.spawn({ profile, task: "Wait test" });

  // Cancel to trigger revision bump and completion
  await registry.cancel(task.id, "Completed via cancel");

  const waited = await registry.wait(task.id, { afterRevision: 1, timeoutSeconds: 2 });
  assert.equal(waited.status, "aborted");
  assert.ok(waited.revision > 1);
});
