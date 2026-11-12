import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { TaskController } from "../src/tasks/controller.ts";
import type { ResolvedAgentDefinition } from "../src/agents/resolver.ts";
import type { SubagentTaskResult } from "../src/tasks/session-runner.ts";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

function createMockProfile(id = "worker"): ResolvedAgentDefinition {
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

function registryFixture(t: TestContext): TaskController {
  const registry = new TaskController({
    createRunner: ({ signal }) => ({
      run: async () => new Promise<SubagentTaskResult>((resolve) => {
        assert.ok(signal);
        const finish = () => resolve({
          status: "aborted",
          error: signal.reason instanceof Error ? signal.reason.message : String(signal.reason),
          turns: 0, durationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
        });
        if (signal.aborted) finish();
        else signal.addEventListener("abort", finish, { once: true });
      }),
    }),
  });
  t.after(() => registry.shutdown());
  return registry;
}

test("TaskController snapshots wake settings independently for the same agent", async () => {
  const wakeOn = new Set<"completed" | "failed">(["completed"]);
  const profile = { ...createMockProfile(), supervision: { wakeOn } };
  const registry = new TaskController({ createRunner: () => ({ run: async () => ({
    status: "completed", result: "done", turns: 1, durationMs: 1,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
  }) }) });
  try {
    const tasks = [];
    for (const triggers of [["completed"], ["failed"], []] as const) {
      wakeOn.clear();
      for (const trigger of triggers) wakeOn.add(trigger);
      const task = registry.spawn({ profile, task: "Work" });
      await registry.wait(task.id);
      tasks.push(task);
    }
    wakeOn.add("completed");
    assert.deepEqual(tasks.map((task) => task.wakeOn), [["completed"], ["failed"], []]);
    assert.ok(tasks.every((task) => Object.isFrozen(task.wakeOn) && task.result === "done"));
  } finally {
    await registry.shutdown();
  }
});

test("shutdown waits for cancellation already in progress without replacing its cause", async (t) => {
  for (const cause of ["abort", "stalled"] as const) {
    await t.test(cause, async () => {
      let release!: () => void;
      const registry = new TaskController({
        createRunner: ({ signal }) => ({
          run: async () => new Promise<SubagentTaskResult>((resolve) => {
            release = () => resolve({
              status: "aborted", error: "Original cancellation", turns: 0, durationMs: 0,
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
            });
            assert.ok(signal);
          }),
        }),
      });
      const task = registry.spawn({ profile: createMockProfile(), task: "Wait" });
      let shutDown = false;
      const cancellation = registry.cancel(task.id, "Original cancellation", cause);
      const shutdown = registry.shutdown();
      void shutdown.then(() => { shutDown = true; });
      try {
        // Both shutdown and an explicit repeated cancel must wait for the first cleanup.
        let repeatedSettled = false;
        const repeated = registry.cancel(task.id, "Replacement reason", "abort");
        void repeated.then(() => { repeatedSettled = true; });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(shutDown, false);
        assert.equal(repeatedSettled, false);
        assert.equal(task.cancellationCause, cause);
        release();
        assert.equal(await cancellation, true);
        assert.equal(await repeated, false);
        await shutdown;
        assert.equal(shutDown, true);
        assert.equal(task.cancellationCause, cause);
        assert.equal(task.error, "Original cancellation");
      } finally {
        release();
        await cancellation;
        await shutdown;
      }
    });
  }
});

test("TaskController shutdown cancels all tasks and waits for runner cleanup", async (t) => {
  for (const count of [0, 1, 2]) {
    await t.test(`${count} active tasks`, async () => {
      const aborted: AbortSignal[] = [];
      const cleanups: Array<() => void> = [];
      const registry = new TaskController({
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

test("TaskController spawns task and tracks status", (t) => {
  const registry = registryFixture(t);
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

test("TaskController enforces maxConcurrent limit per profile", (t) => {
  const registry = registryFixture(t);
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

test("TaskController cancels active task", async (t) => {
  const registry = registryFixture(t);
  const profile = createMockProfile();

  const task = registry.spawn({ profile, task: "To be cancelled" });
  assert.equal(task.status, "running");

  const cancelled = await registry.cancel(task.id, "Stop now");
  assert.equal(cancelled, true);

  const updated = registry.getTask(task.id);
  assert.equal(updated?.status, "aborted");
  assert.equal(updated?.error, "Stop now");
});

test("TaskController prevents overlapping targetFiles write scopes across running tasks", (t) => {
  const registry = registryFixture(t);
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

test("TaskController aborts task when caller signal fires", async (t) => {
  const registry = registryFixture(t);
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

test("TaskController wait resolves on revision update or settle", async (t) => {
  const registry = registryFixture(t);
  const profile = createMockProfile();

  const task = registry.spawn({ profile, task: "Wait test" });

  // Cancel to trigger revision bump and completion
  await registry.cancel(task.id, "Completed via cancel");

  const waited = await registry.wait(task.id, { afterRevision: 1, timeoutSeconds: 2 });
  assert.equal(waited.status, "aborted");
  assert.ok(waited.revision > 1);
});

test("TaskController bounds settled history without evicting running tasks", async (t) => {
  for (const row of [
    { name: "default limit", limit: undefined, expected: 100, status: "completed" },
    { name: "completed", limit: 2, expected: 2, status: "completed" },
    { name: "failed", limit: 2, expected: 2, status: "failed" },
    { name: "aborted", limit: 2, expected: 2, status: "aborted" },
  ] as const) {
    await t.test(row.name, async (t) => {
      const registry = new TaskController({
        maxRetainedTasks: row.limit,
        createRunner: ({ signal }) => ({
          run: async (prompt) => {
            if (prompt === "Keep running") {
              await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
            }
            return {
              status: signal?.aborted ? "aborted" : row.status,
              result: prompt, turns: 0, durationMs: 0,
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
            };
          },
        }),
      });
      t.after(() => registry.shutdown());
      const profile = createMockProfile();
      const running = registry.spawn({ profile, task: "Keep running" });
      const completed: string[] = [];
      const delivered: string[] = [];
      registry.subscribe("*", (task) => {
        if (task.status !== "running") delivered.push(task.id);
      });

      for (let i = 0; i < row.expected + 3; i++) {
        const task = registry.spawn({ profile, task: `Work ${i}` });
        const waiting = registry.wait(task.id);
        assert.equal((await waiting).status, row.status);
        completed.push(task.id);
      }

      assert.equal(registry.getTask(running.id)?.status, "running");
      assert.deepEqual(registry.listTasks().map((task) => task.id), [running.id, ...completed.slice(-row.expected)]);
      assert.deepEqual(delivered, completed);
      assert.equal(registry.getTask(completed[0]!), undefined);
      await assert.rejects(registry.wait(completed[0]!), /not found/);
      assert.equal(await registry.cancel(running.id), true);
      assert.equal(running.status, "aborted");
      assert.equal(registry.listTasks().length, row.expected);
    });
  }
});

test("TaskController bounds history when runners throw", async (t) => {
  for (const synchronous of [true, false]) {
    await t.test(synchronous ? "synchronous throw" : "async rejection", async (t) => {
      const registry = new TaskController({
        maxRetainedTasks: 1,
        createRunner: () => ({
          run: () => {
            if (synchronous) throw new Error("Runner failed synchronously");
            return Promise.reject(new Error("Runner rejected asynchronously"));
          },
        }),
      });
      t.after(() => registry.shutdown());
      const records = [];

      for (let i = 0; i < 4; i++) {
        const task = registry.spawn({ profile: createMockProfile(), task: "Fail" });
        const settled = await registry.wait(task.id);
        assert.equal(settled.status, "failed");
        assert.equal(settled.error, synchronous ? "Runner failed synchronously" : "Runner rejected asynchronously");
        records.push(task);
      }

      assert.deepEqual(registry.listTasks(), records.slice(-1));
      assert.equal(registry.getRunningCount(), 0);
      await registry.shutdown();
      assert.deepEqual(registry.listTasks(), records.slice(-1));
    });
  }
});

test("TaskController validates the settled history limit", async (t) => {
  for (const limit of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(String(limit), () => {
      assert.throws(() => new TaskController({ maxRetainedTasks: limit }), /positive safe integer/);
    });
  }
});

test("TaskController forwards modelRuntime and extracts runtime from modelRegistry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rostrix-model-registry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const modelRegistry = new ModelRegistry(modelRuntime);

  for (const row of [
    { name: "explicit modelRuntime", options: { modelRuntime }, expected: modelRuntime },
    { name: "modelRegistry facade", options: { modelRegistry }, expected: modelRuntime },
    { name: "neither supplied", options: {}, expected: undefined },
  ] as const) {
    await t.test(row.name, async () => {
      let forwardedRuntime: ModelRuntime | undefined;
      const registry = new TaskController({
        createRunner: (options) => {
          forwardedRuntime = options.modelRuntime;
          return {
            run: async () => ({
              status: "completed",
              turns: 0,
              durationMs: 0,
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
            }),
          };
        },
      });

      registry.spawn({
        profile: createMockProfile(),
        task: "Verify runtime forwarding",
        ...row.options,
      });

      assert.equal(forwardedRuntime, row.expected);
    });
  }
});
