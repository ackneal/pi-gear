import assert from "node:assert/strict";
import test from "node:test";
import { TaskRegistry } from "../src/runtime/task-registry.ts";
import type { ResolvedProfile } from "../src/core/resolver.ts";

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

test("TaskRegistry cancels active task", () => {
  const registry = new TaskRegistry();
  const profile = createMockProfile();

  const task = registry.spawn({ profile, task: "To be cancelled" });
  assert.equal(task.status, "running");

  const cancelled = registry.cancel(task.id, "Stop now");
  assert.equal(cancelled, true);

  const updated = registry.getTask(task.id);
  assert.equal(updated?.status, "aborted");
  assert.equal(updated?.error, "Stop now");
});

test("TaskRegistry wait resolves on revision update or settle", async () => {
  const registry = new TaskRegistry();
  const profile = createMockProfile();

  const task = registry.spawn({ profile, task: "Wait test" });

  // Cancel in next tick to trigger revision bump and completion
  setTimeout(() => {
    registry.cancel(task.id, "Completed via cancel");
  }, 20);

  const waited = await registry.wait(task.id, { afterRevision: 1, timeoutSeconds: 2 });
  assert.equal(waited.status, "aborted");
  assert.ok(waited.revision > 1);
});
