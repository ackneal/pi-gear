import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TaskSupervisor } from "../src/supervision/supervisor.ts";
import { TaskRegistry } from "../src/runtime/task-registry.ts";
import type { SubagentTaskResult } from "../src/runtime/session-runner.ts";
import { ParentInbox } from "../src/supervision/inbox.ts";
import { WakeUpManager } from "../src/supervision/wake-up.ts";

test("ParentInbox coalesces multiple notifications within debounce window", async () => {
  const delivered: string[] = [];
  const inbox = new ParentInbox({
    debounceMs: 50,
    onDeliver: (msg) => {
      delivered.push(msg);
    },
  });

  inbox.enqueue({
    taskId: "task-1",
    profileId: "worker",
    status: "completed",
    result: "Finished step 1",
    timestamp: Date.now(),
  });

  inbox.enqueue({
    taskId: "task-2",
    profileId: "reviewer",
    status: "completed",
    result: "Review passed",
    timestamp: Date.now(),
  });

  assert.equal(delivered.length, 0);

  // Wait for debounce flush
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(delivered.length, 1);
  const first = delivered[0]!;
  assert.ok(first.includes('task_id="task-1"'));
  assert.ok(first.includes('task_id="task-2"'));
  assert.ok(first.includes("Review passed"));
});

function sdkFixture() {
  const messages: string[] = [];
  const handlers = new Map<string, () => void>();
  const api = {
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
      return () => { handlers.delete(event); };
    },
    sendUserMessage: (message: string) => { messages.push(message); },
  };
  // Only the SDK surface used by supervision is supplied by this fixture.
  return { messages, handlers, pi: api as unknown as ExtensionAPI };
}

test("WakeUpManager uses SDK lifecycle hooks and removes them on disposal", async (t) => {
  for (const end of ["agent_settled", "dispose", "session_shutdown"] as const) {
    await t.test(end, async () => {
      const { pi, messages, handlers } = sdkFixture();
      const manager = new WakeUpManager(new ParentInbox(), pi);
      try {
        assert.deepEqual([...handlers.keys()], ["agent_start", "agent_settled", "session_shutdown"]);
        await manager.deliverOrQueue("idle");
        handlers.get("agent_start")!();
        await manager.deliverOrQueue("queued one");
        await manager.deliverOrQueue("queued two");
        assert.deepEqual(messages, ["idle"]);

        if (end === "dispose") manager.dispose();
        else handlers.get(end)!();

        if (end === "agent_settled") {
          assert.deepEqual(messages, ["idle", "queued one\n\nqueued two"]);
        } else {
          manager.setParentIdle(true);
          await manager.deliverOrQueue("after disposal");
          assert.deepEqual(messages, ["idle"]);
          assert.equal(handlers.size, 0);
        }
      } finally {
        manager.dispose();
      }
      assert.equal(handlers.size, 0);
    });
  }
});

test("manual and caller cancellations never wake as failure or stall", async (t) => {
  for (const mode of ["manual", "caller", "already-aborted"] as const) {
    await t.test(mode, async () => {
      const caller = new AbortController();
      if (mode === "already-aborted") caller.abort();
      const registry = new TaskRegistry({ createRunner: ({ signal }) => ({
        run: async () => new Promise<SubagentTaskResult>((resolve) => {
          const finish = () => resolve({ status: "failed", error: "Task stalled: deliberately misleading text",
            turns: 0, durationMs: 0,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 } });
          if (signal!.aborted) finish();
          else signal!.addEventListener("abort", finish, { once: true });
        }),
      }) });
      const { pi, messages } = sdkFixture();
      const supervisor = new TaskSupervisor(registry, pi, { debounceMs: 1 });
      const unsubscribe = registry.subscribe("*", (task) => supervisor.notifyTaskSettled(task));
      try {
        const task = registry.spawn({ task: "Wait", signal: caller.signal, agent: {
          id: "worker", label: "Worker", description: "Test worker", promptGuidelines: [], appendPrompt: "",
          deniedTools: [], deniedSkills: [], mcpServers: {}, subagents: { maxDepth: 2, maxConcurrent: 2 },
          supervision: { wakeOn: new Set(["completed", "failed", "stalled"]) },
        } });
        if (mode === "manual") await registry.cancel(task.id, "Task stalled: manual reason");
        else caller.abort();
        await registry.wait(task.id);
        await new Promise((resolve) => setTimeout(resolve, 15));
        assert.equal(task.status, "aborted");
        assert.equal(task.cancellationCause, "abort");
        assert.deepEqual(messages, []);
      } finally {
        unsubscribe();
        supervisor.dispose();
        await registry.shutdown();
      }
    });
  }
});

test("terminal wake filtering preserves results and evidence", async (t) => {
  for (const status of ["completed", "failed", "aborted"] as const) {
    for (const enabled of [false, true]) {
      await t.test(`${status}, opt-in: ${enabled}`, async () => {
        const registry = new TaskRegistry({
          createRunner: ({ onEvent }) => ({ run: async () => {
            onEvent?.({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "evidence.txt" } });
            return { status, result: "observable result", error: status === "completed" ? undefined : "Task stalled: not a structured cause",
              turns: 1, durationMs: 1,
              usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3, cost: 0 } };
          } }),
        });
        const { pi, messages } = sdkFixture();
        const supervisor = new TaskSupervisor(registry, pi, { debounceMs: 1 });
        const unsubscribe = registry.subscribe("*", (task) => supervisor.notifyTaskSettled(task));
        try {
          const task = registry.spawn({ task: "Work", agent: {
            id: "worker", label: "Worker", description: "Test worker", promptGuidelines: [], appendPrompt: "",
            deniedTools: [], deniedSkills: [], mcpServers: {}, subagents: { maxDepth: 2, maxConcurrent: 2 },
            supervision: { wakeOn: new Set(enabled ? ["completed", "failed", "stalled", "needs_input"] : []) },
          } });
          await registry.wait(task.id);
          await new Promise((resolve) => setTimeout(resolve, 15));
          assert.equal(messages.length, enabled && status !== "aborted" ? 1 : 0);
          assert.equal(registry.getTask(task.id), task);
          assert.equal(task.status, status);
          assert.equal(task.result, "observable result");
          assert.equal(task.usage?.totalTokens, 3);
          assert.deepEqual(task.items, [{ kind: "tool", id: "tool-1", name: "read", status: "running", args: { path: "evidence.txt" } }]);
        } finally {
          unsubscribe();
          supervisor.dispose();
          await registry.shutdown();
        }
      });
    }
  }
});

test("stall cancellation leaves notification ownership to the terminal subscription", async (t) => {
  for (const { disposeBeforeCleanup, wake } of [
    { disposeBeforeCleanup: false, wake: true },
    { disposeBeforeCleanup: false, wake: false },
    { disposeBeforeCleanup: true, wake: true },
  ]) {
    await t.test(`dispose before cleanup: ${disposeBeforeCleanup}, wake: ${wake}`, async () => {
      let cleanup: (() => void) | undefined;
      let aborted = false;
      const registry = new TaskRegistry({
        createRunner: ({ signal }) => ({
          run: async () => new Promise<SubagentTaskResult>((resolve) => {
            signal!.addEventListener("abort", () => {
              aborted = true;
              cleanup = () => resolve({ status: "aborted", turns: 0, durationMs: 0,
                usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 } });
            }, { once: true });
          }),
        }),
      });
      const { pi, messages } = sdkFixture();
      const supervisor = new TaskSupervisor(registry, pi, { checkIntervalMs: 5, defaultStallTimeoutMs: 1, debounceMs: 1 });
      const unsubscribe = registry.subscribe("*", (task) => {
        if (["completed", "failed", "aborted"].includes(task.status)) supervisor.notifyTaskSettled(task);
      });
      try {
        const task = registry.spawn({ task: "Wait", profile: {
          id: "worker", label: "Worker", description: "Test worker", promptGuidelines: [], appendPrompt: "",
          deniedTools: [], deniedSkills: [], mcpServers: {}, subagents: { maxDepth: 2, maxConcurrent: 2 },
          supervision: { wakeOn: new Set(wake ? ["stalled"] : []) },
        } });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(aborted, true);
        assert.equal(task.status, "running");
        assert.deepEqual(messages, []);
        if (disposeBeforeCleanup) supervisor.dispose();

        cleanup!();
        await registry.wait(task.id);
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(task.status, "aborted");
        assert.equal(task.cancellationCause, "stalled");
        assert.equal(messages.length, !disposeBeforeCleanup && wake ? 1 : 0);
        if (!disposeBeforeCleanup && wake) assert.match(messages[0]!, /aborted/);
      } finally {
        supervisor.dispose();
        unsubscribe();
        cleanup?.();
        await registry.shutdown();
      }
    });
  }
});
