import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TaskSupervisor } from "../src/supervision/supervisor.ts";
import { TaskRegistry } from "../src/runtime/task-registry.ts";
import type { SubagentTaskResult } from "../src/runtime/session-runner.ts";
import { ParentInbox, type InboxNotification } from "../src/supervision/inbox.ts";
import { agent } from "./runtime-fixtures.ts";
import { WakeUpManager } from "../src/supervision/wake-up.ts";

const { convertToLlm } = await import(new URL("./core/messages.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

test("ParentInbox coalesces multiple notifications within debounce window", async (t) => {
  const delivered: Array<readonly InboxNotification[]> = [];
  const inbox = new ParentInbox({
    debounceMs: 50,
    onDeliver: (msg) => {
      delivered.push(msg);
      return true;
    },
  });
  t.after(() => inbox.clear());

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
  assert.deepEqual(first.map((notification) => notification.taskId), ["task-1", "task-2"]);
  assert.equal(first[1]?.result, "Review passed");
});

function sdkFixture(failures = 0) {
  const messages: string[] = [];
  const sent: Array<{ message: Parameters<ExtensionAPI["sendMessage"]>[0]; options: Parameters<ExtensionAPI["sendMessage"]>[1] }> = [];
  const handlers = new Map<string, () => void>();
  let attempts = 0;
  const api = {
    on: (event: string, handler: () => void) => {
      handlers.set(event, handler);
      return () => { handlers.delete(event); };
    },
    sendMessage: (message: Parameters<ExtensionAPI["sendMessage"]>[0], options: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
      attempts++;
      if (attempts <= failures) throw new Error("Delivery failed");
      assert.equal(typeof message.content, "string");
      messages.push(String(message.content));
      sent.push({ message, options });
    },
    sendUserMessage: () => { assert.fail("Internal notifications must not be user messages"); },
  };
  return { messages, sent, handlers, attempts: () => attempts, pi: api as unknown as ExtensionAPI };
}

function notification(taskId: string): InboxNotification {
  return { taskId, profileId: "worker", status: "completed", result: `<result>${taskId} & \"data\"</result>`, timestamp: 0 };
}

test("WakeUpManager uses SDK lifecycle hooks and removes them on disposal", async (t) => {
  for (const end of ["agent_settled", "dispose", "session_shutdown"] as const) {
    await t.test(end, async () => {
      const { pi, messages, sent, handlers } = sdkFixture();
      const inbox = new ParentInbox({ onDeliver: (batch) => manager.deliver(batch) });
      const manager = new WakeUpManager(inbox, pi);
      try {
        assert.deepEqual([...handlers.keys()], ["agent_start", "agent_settled", "session_shutdown"]);
        inbox.enqueue(notification("idle"));
        inbox.flush();
        handlers.get("agent_start")!();
        inbox.enqueue(notification("queued one"));
        inbox.enqueue(notification("queued two"));
        inbox.flush();
        assert.deepEqual(JSON.parse(messages[0]!).notifications, [notification("idle")]);
        assert.equal(messages.length, 1);

        if (end === "dispose") manager.dispose();
        else handlers.get(end)!();

        if (end === "agent_settled") {
          assert.equal(messages.length, 2);
          assert.deepEqual(JSON.parse(messages[1]!).notifications, [notification("queued one"), notification("queued two")]);
        } else {
          manager.setParentIdle(true);
          assert.equal(manager.deliver([notification("after disposal")]), false);
          assert.equal(messages.length, 1);
          assert.equal(handlers.size, 0);
        }
        for (const { message, options } of sent) {
          assert.equal(message.customType, "rostrix:subagent_notifications");
          assert.equal(message.display, false);
          assert.deepEqual(message.details, JSON.parse(String(message.content)));
          assert.equal(JSON.parse(String(message.content)).type, "subagent_notifications");
          assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
          const [modelMessage] = convertToLlm([{ ...message, role: "custom", timestamp: 0 }]);
          assert.deepEqual(modelMessage.content, [{ type: "text", text: message.content }]);
        }
      } finally {
        manager.dispose();
      }
      assert.equal(handlers.size, 0);
    });
  }
});

test("acknowledged terminal results cannot produce a delayed duplicate wake-up", async (t) => {
  for (const phase of ["debounce", "busy", "retry", "before-notify"] as const) {
    await t.test(phase, async () => {
      const registry = new TaskRegistry({ createRunner: () => ({ run: async () => ({
        status: "completed", result: "Result stays available", turns: 1, durationMs: 1,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
      }) }) });
      const { pi, messages, attempts } = sdkFixture(phase === "retry" ? 1 : 0);
      const supervisor = new TaskSupervisor(registry, pi, { debounceMs: 10_000 });
      const unsubscribe = registry.subscribe("*", (task) => {
        if (phase !== "before-notify") supervisor.notifyTaskSettled(task);
      });
      try {
        if (phase !== "retry") supervisor.wakeUpManager.setParentIdle(false);
        const task = registry.spawn({ task: "Work", agent: agent({ supervision: { wakeOn: new Set(["completed"]) } }) });
        await registry.wait(task.id);
        if (phase === "busy" || phase === "retry") supervisor.inbox.flush();
        assert.deepEqual(messages, []);

        supervisor.acknowledgeTask(task.id);
        supervisor.notifyTaskSettled(task);
        supervisor.wakeUpManager.setParentIdle(true);
        supervisor.inbox.flush();

        assert.deepEqual(messages, []);
        assert.equal(attempts(), phase === "retry" ? 1 : 0);
        assert.equal(registry.getTask(task.id)?.result, "Result stays available");
      } finally {
        unsubscribe();
        supervisor.dispose();
        await registry.shutdown();
      }
    });
  }
});

test("pending notifications survive eviction and can still be acknowledged", async (t) => {
  for (const phase of ["debounce", "busy", "retry"] as const) {
    for (const acknowledge of [false, true]) {
      await t.test(`${phase}, acknowledge evicted: ${acknowledge}`, async () => {
        const registry = new TaskRegistry({
          maxRetainedTasks: 1,
          createRunner: () => ({ run: async (prompt) => ({
            status: "completed", result: `Result: ${prompt}`, turns: 1, durationMs: 1,
            usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
          }) }),
        });
        const { pi, messages, attempts } = sdkFixture(phase === "retry" ? 1 : 0);
        const supervisor = new TaskSupervisor(registry, pi, { debounceMs: 10_000 });
        const unsubscribe = registry.subscribe("*", (task) => supervisor.notifyTaskSettled(task));
        try {
          if (phase === "busy") supervisor.wakeUpManager.setParentIdle(false);
          const worker = agent({ supervision: { wakeOn: new Set(["completed"]) } });
          const evicted = registry.spawn({ task: "First", agent: worker });
          await registry.wait(evicted.id);
          const snapshot = {
            taskId: evicted.id, profileId: evicted.profileId, status: evicted.status,
            result: evicted.result, durationMs: evicted.finishedAt! - evicted.startedAt!,
          };
          if (phase !== "debounce") supervisor.inbox.flush();
          assert.deepEqual(messages, []);

          const retained = registry.spawn({ task: "Second", agent: worker });
          await registry.wait(retained.id);
          assert.equal(registry.getTask(evicted.id), undefined);
          assert.equal(registry.getTask(retained.id), retained);
          if (acknowledge) supervisor.acknowledgeTask(evicted.id);
          supervisor.wakeUpManager.setParentIdle(true);
          supervisor.inbox.flush();

          assert.equal(messages.length, 1);
          const delivered = JSON.parse(messages[0]!).notifications as InboxNotification[];
          assert.deepEqual(delivered.map((item) => item.taskId), acknowledge ? [retained.id] : [evicted.id, retained.id]);
          if (!acknowledge) {
            const { timestamp, ...actual } = delivered[0]!;
            assert.deepEqual(actual, snapshot);
            assert.equal(typeof timestamp, "number");
          }
          assert.equal(attempts(), phase === "retry" ? 2 : 1);

          supervisor.notifyTaskSettled(evicted);
          supervisor.notifyTaskSettled(retained);
          supervisor.inbox.flush();
          assert.equal(messages.length, 1);
        } finally {
          unsubscribe();
          supervisor.dispose();
          await registry.shutdown();
        }
      });
    }
  }
});

test("consuming one result preserves other pending tasks and delivery retry", async () => {
  const registry = new TaskRegistry({ createRunner: () => ({ run: async () => ({
    status: "completed", result: "Done", turns: 1, durationMs: 1,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 },
  }) }) });
  const { pi, messages, attempts } = sdkFixture(1);
  const supervisor = new TaskSupervisor(registry, pi, { debounceMs: 10_000 });
  const unsubscribe = registry.subscribe("*", (task) => supervisor.notifyTaskSettled(task));
  try {
    supervisor.wakeUpManager.setParentIdle(false);
    const tasks = ["First", "Second"].map((task) => registry.spawn({ task, agent: agent({ supervision: { wakeOn: new Set(["completed"]) } }) }));
    await Promise.all(tasks.map((task) => registry.wait(task.id)));
    supervisor.inbox.flush();
    supervisor.acknowledgeTask(tasks[0]!.id);
    supervisor.wakeUpManager.setParentIdle(true);
    assert.equal(attempts(), 1);
    assert.deepEqual(messages, []);
    supervisor.inbox.flush();

    assert.equal(messages.length, 1);
    assert.deepEqual(JSON.parse(messages[0]!).notifications.map((item: InboxNotification) => item.taskId), [tasks[1]!.id]);
    for (const task of tasks) supervisor.notifyTaskSettled(task);
    supervisor.inbox.flush();
    assert.equal(messages.length, 1);
    assert.ok(tasks.every((task) => registry.getTask(task.id)?.result === "Done"));
  } finally {
    unsubscribe();
    supervisor.dispose();
    await registry.shutdown();
  }
});

test("acknowledging progress does not consume a future terminal notification", async () => {
  let finish!: () => void;
  const registry = new TaskRegistry({ createRunner: () => ({ run: async () => new Promise<SubagentTaskResult>((resolve) => {
    finish = () => resolve({ status: "completed", result: "Done", turns: 1, durationMs: 1,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0 } });
  }) }) });
  const { pi, messages } = sdkFixture();
  const supervisor = new TaskSupervisor(registry, pi, { debounceMs: 10_000 });
  const unsubscribe = registry.subscribe("*", (task) => supervisor.notifyTaskSettled(task));
  try {
    const task = registry.spawn({ task: "Work", agent: agent({ supervision: { wakeOn: new Set(["completed"]) } }) });
    assert.equal(task.status, "running");
    supervisor.acknowledgeTask(task.id);
    supervisor.acknowledgeTask("unknown");
    finish();
    await registry.wait(task.id);
    supervisor.inbox.flush();

    assert.equal(messages.length, 1);
    assert.equal(JSON.parse(messages[0]!).notifications[0].taskId, task.id);
  } finally {
    finish();
    unsubscribe();
    supervisor.dispose();
    await registry.shutdown();
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
          assert.deepEqual(task.activities, [{ kind: "tool", id: "tool-1", name: "read", status: "running", args: { path: "evidence.txt" } }]);
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
